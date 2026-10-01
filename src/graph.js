// The virtual ROS 2 graph: every node, publisher, subscription, service and client lives here.
// Python processes (Web Workers) and built-in JS nodes all register through this object.

let nextId = 1;

export class Graph {
  constructor() {
    this.nodes = new Map();      // id -> node
    this.endpoints = new Map();  // id -> endpoint
    this.calls = new Map();      // call id -> { onResponse }
    this.listeners = new Set();
    this.latched = new Map();    // pub endpoint id -> [msgs]
    this._timer = null;
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  _changed() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      for (const fn of this.listeners) fn();
    }, 20);
  }

  addNode({ name, ns = '/', owner = 'js', hidden = false }) {
    const id = nextId++;
    const fqn = (ns === '/' ? '' : ns.replace(/\/$/, '')) + '/' + name;
    const node = { id, name, ns, fqn, owner, hidden, params: new Map(), setParam: null, warnings: [] };
    node.params.set('use_sim_time', { type: 'BOOL', value: false });
    this.nodes.set(id, node);
    this._changed();
    return node;
  }

  removeNode(id) {
    for (const ep of [...this.endpoints.values()]) if (ep.nodeId === id) this.removeEndpoint(ep.id);
    this.nodes.delete(id);
    this._changed();
  }

  // kind: pub | sub | srv | cli
  addEndpoint({ nodeId, kind, name, type, qos = {}, deliver = null, handle = null }) {
    const id = nextId++;
    const ep = {
      id, nodeId, kind, name, type, deliver, handle,
      qos: { depth: qos.depth ?? 10, reliability: qos.reliability || 'reliable', durability: qos.durability || 'volatile' },
      count: 0,
    };
    this.endpoints.set(id, ep);
    if (kind === 'sub') this._checkQos(ep);
    if (kind === 'pub') this._checkQos(ep);
    if (kind === 'sub' && ep.qos.durability === 'transient_local') {
      for (const pub of this.endpointsOf('pub', name)) {
        const latched = this.latched.get(pub.id);
        if (latched && pub.type === type && this.compatible(pub, ep)) for (const m of latched) queueMicrotask(() => ep.deliver?.(m, pub));
      }
    }
    this._changed();
    return ep;
  }

  removeEndpoint(id) {
    this.endpoints.delete(id);
    this.latched.delete(id);
    this._changed();
  }

  endpointsOf(kind, name) {
    const out = [];
    for (const ep of this.endpoints.values()) if (ep.kind === kind && (name === undefined || ep.name === name)) out.push(ep);
    return out;
  }

  compatible(pub, sub) {
    if (pub.qos.reliability === 'best_effort' && sub.qos.reliability === 'reliable') return false;
    if (pub.qos.durability === 'volatile' && sub.qos.durability === 'transient_local') return false;
    return true;
  }

  // Emit the same warnings real ROS 2 prints when QoS policies don't match.
  _checkQos(ep) {
    const others = this.endpointsOf(ep.kind === 'pub' ? 'sub' : 'pub', ep.name);
    for (const o of others) {
      const pub = ep.kind === 'pub' ? ep : o;
      const sub = ep.kind === 'pub' ? o : ep;
      if (pub.type !== sub.type || this.compatible(pub, sub)) continue;
      const policy = (pub.qos.reliability === 'best_effort' && sub.qos.reliability === 'reliable') ? 'RELIABILITY_QOS_POLICY' : 'DURABILITY_QOS_POLICY';
      const subNode = this.nodes.get(sub.nodeId);
      const pubNode = this.nodes.get(pub.nodeId);
      subNode?.warn?.(`New publisher discovered on topic '${ep.name}', offering incompatible QoS. No messages will be received from it. Last incompatible policy: ${policy}`);
      pubNode?.warn?.(`New subscription discovered on topic '${ep.name}', requesting incompatible QoS. No messages will be sent to it. Last incompatible policy: ${policy}`);
    }
  }

  publish(pubId, data) {
    const pub = this.endpoints.get(pubId);
    if (!pub) return;
    pub.count++;
    if (pub.qos.durability === 'transient_local') {
      const arr = this.latched.get(pub.id) || [];
      arr.push(data);
      while (arr.length > Math.max(1, pub.qos.depth)) arr.shift();
      this.latched.set(pub.id, arr);
    }
    for (const sub of this.endpoints.values()) {
      if (sub.kind !== 'sub' || sub.name !== pub.name || sub.type !== pub.type) continue;
      if (!this.compatible(pub, sub)) continue;
      sub.deliver?.(data, pub);
    }
  }

  // Calls a service. onResponse(data) is called once the server answers.
  callService(name, data, onResponse) {
    const srv = this.endpointsOf('srv', name)[0];
    if (!srv) return false;
    const id = nextId++;
    this.calls.set(id, { onResponse });
    srv.handle(id, data);
    return true;
  }

  respond(callId, data) {
    const c = this.calls.get(callId);
    if (!c) return;
    this.calls.delete(callId);
    queueMicrotask(() => c.onResponse(data));
  }

  // ---- queries used by the CLI and the views ----
  visibleNodes() { return [...this.nodes.values()].filter((n) => !n.hidden); }

  nodeByName(fqn) {
    const want = fqn.startsWith('/') ? fqn : '/' + fqn;
    return [...this.nodes.values()].find((n) => n.fqn === want && !n.hidden);
  }

  topics() {
    const map = new Map([
      ['/parameter_events', new Set(['rcl_interfaces/msg/ParameterEvent'])],
      ['/rosout', new Set(['rcl_interfaces/msg/Log'])],
    ]);
    for (const ep of this.endpoints.values()) {
      if (ep.kind !== 'pub' && ep.kind !== 'sub') continue;
      if (!map.has(ep.name)) map.set(ep.name, new Set());
      map.get(ep.name).add(ep.type);
    }
    return map;
  }

  services() {
    const map = new Map();
    for (const node of this.visibleNodes()) {
      for (const s of ['describe_parameters', 'get_parameter_types', 'get_parameters', 'get_type_description', 'list_parameters', 'set_parameters', 'set_parameters_atomically']) {
        map.set(`${node.fqn}/${s}`, new Set([`rcl_interfaces/srv/${s.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('')}`]));
      }
    }
    for (const ep of this.endpoints.values()) {
      if (ep.kind !== 'srv') continue;
      if (!map.has(ep.name)) map.set(ep.name, new Set());
      map.get(ep.name).add(ep.type);
    }
    return map;
  }

  userServices() {
    const map = new Map();
    for (const ep of this.endpoints.values()) {
      if (ep.kind !== 'srv') continue;
      if (!map.has(ep.name)) map.set(ep.name, new Set());
      map.get(ep.name).add(ep.type);
    }
    return map;
  }

  snapshot() {
    const topics = {};
    for (const [k, v] of this.topics()) topics[k] = [...v];
    const services = {};
    for (const [k, v] of this.userServices()) services[k] = [...v];
    const pubs = {}, subs = {};
    for (const ep of this.endpoints.values()) {
      if (ep.kind === 'pub') pubs[ep.name] = (pubs[ep.name] || 0) + 1;
      if (ep.kind === 'sub') subs[ep.name] = (subs[ep.name] || 0) + 1;
    }
    return { topics, services, pubs, subs, nodes: this.visibleNodes().map((n) => n.fqn) };
  }
}
