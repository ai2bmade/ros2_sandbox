// Python processes: each `python3 file.py` runs in its own Web Worker with Pyodide.
import { SPEC } from './msgutil.js';
import { hintsForExit } from './hints.js';

const INBOX_BYTES = 4 * 1024 * 1024;
const enc = new TextEncoder();
export const MAX_PROCESSES = 4;

let shimSource = null;
async function getShim() {
  if (!shimSource) shimSource = await (await fetch('./py/ros_shim.py')).text();
  return shimSource;
}

class WarmWorker {
  constructor() {
    this.inbox = new SharedArrayBuffer(16 + INBOX_BYTES);
    this.interrupt = new SharedArrayBuffer(1);
    this.ctrl = new Int32Array(this.inbox, 0, 4);
    this.data = new Uint8Array(this.inbox, 16);
    this.worker = new Worker(new URL('./py-worker.js', document.baseURI), { type: 'module' });
    this.early = [];
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        if (e.data.t === 'ready') resolve(this);
        else if (e.data.t === 'fatal') reject(new Error(e.data.text));
        else this.early.push(e.data);
      };
      this.worker.onerror = (e) => reject(new Error(e.message || 'worker failed to start'));
    });
    getShim().then((shim) => this.worker.postMessage({ type: 'init', inbox: this.inbox, interrupt: this.interrupt, spec: JSON.stringify(SPEC), shim }));
  }
}

export class WorkerPool {
  constructor(onStatus) {
    this.warm = null;
    this.onStatus = onStatus;
    this.loadedOnce = false;
  }

  prewarm() {
    if (this.warm) return;
    this.onStatus?.('loading');
    this.warm = new WarmWorker();
    this.warm.ready.then(() => { this.loadedOnce = true; this.onStatus?.('ready'); }, (e) => this.onStatus?.('error', e));
  }

  async acquire() {
    if (!this.warm) this.prewarm();
    const w = this.warm;
    this.warm = null;
    await w.ready;
    setTimeout(() => this.prewarm(), 200);
    return w;
  }
}

let procSeq = 1;

export class PyProcess {
  constructor({ graph, term, pool, files, argv, onExit }) {
    this.pid = procSeq++;
    this.graph = graph;
    this.term = term;
    this.pool = pool;
    this.files = files;
    this.argv = argv;
    this.onExit = onExit;
    this.nodeMap = new Map();  // local node id -> graph node
    this.epMap = new Map();    // local endpoint id -> graph endpoint
    this.pendingParam = new Map();
    this.alive = true;
    this.dropped = 0;
    this.unsub = graph.onChange(() => this.sendGraph());
  }

  async start() {
    this.w = await this.pool.acquire();
    if (!this.alive) { this.w.worker.terminate(); return; }
    this.w.worker.onmessage = (e) => this.onMessage(e.data);
    this.w.worker.postMessage({ type: 'run', files: this.files, argv: this.argv });
    this.sendGraph();
  }

  send(obj) {
    if (!this.w) return false;
    const { ctrl, data } = this.w;
    const N = data.length;
    const bytes = enc.encode(JSON.stringify(obj));
    const w = Atomics.load(ctrl, 1);
    const r = Atomics.load(ctrl, 2);
    if (w - r + bytes.length + 4 > N) { this.dropped++; return false; }
    const len = bytes.length;
    data[w % N] = len & 255; data[(w + 1) % N] = (len >> 8) & 255; data[(w + 2) % N] = (len >> 16) & 255; data[(w + 3) % N] = (len >> 24) & 255;
    for (let i = 0; i < len; i++) data[(w + 4 + i) % N] = bytes[i];
    Atomics.store(ctrl, 1, w + 4 + len);
    Atomics.add(ctrl, 0, 1);
    Atomics.notify(ctrl, 0);
    return true;
  }

  sendGraph() {
    if (this.alive && this.w) this.send({ t: 'graph', graph: this.graph.snapshot() });
  }

  interrupt() {
    if (!this.w) { this.kill(); return; }
    const buf = new Uint8Array(this.w.interrupt);
    if (buf[0] === 2) { this.kill(); return; }   // second Ctrl+C: force kill
    buf[0] = 2;
  }

  kill(code = 130) {
    if (!this.alive) return;
    this.cleanup();
    this.onExit?.(code, null, {});
  }

  cleanup() {
    this.alive = false;
    this.unsub();
    this.w?.worker.terminate();
    for (const n of this.nodeMap.values()) this.graph.removeNode(n.id);
    this.nodeMap.clear();
  }

  onMessage(m) {
    if (m.t === 'out' || m.t === 'err') { this.term.writeOutput(m.text); return; }
    if (m.t !== 'json') return;
    const msg = JSON.parse(m.s);
    const g = this.graph;
    switch (msg.t) {
      case 'node_add': {
        const node = g.addNode({ name: msg.name, ns: msg.ns, owner: this.pid });
        node.warn = (text) => this.term.writeOutput(`\x1b[33m[WARN] [${(Date.now() / 1000).toFixed(9)}] [${msg.name}]: ${text}\x1b[0m\n`);
        node.hint = (text) => this.term.writeHint(text);
        node.setParam = (name, value, vtype, cb) => {
          const id = Math.floor(Math.random() * 1e9);
          this.pendingParam.set(id, cb);
          this.send({ t: 'param_set', id, nid: msg.lid, name, value, vtype });
        };
        this.nodeMap.set(msg.lid, node);
        break;
      }
      case 'node_remove': {
        const node = this.nodeMap.get(msg.lid);
        if (node) { g.removeNode(node.id); this.nodeMap.delete(msg.lid); }
        break;
      }
      case 'ep_add': {
        const node = this.nodeMap.get(msg.nid);
        if (!node) break;
        const opts = { nodeId: node.id, kind: msg.kind, name: msg.name, type: msg.type, qos: msg.qos };
        if (msg.kind === 'sub') opts.deliver = (data) => this.send({ t: 'msg', sid: msg.lid, data });
        if (msg.kind === 'srv') opts.handle = (callId, data) => this.send({ t: 'srv_req', sid: msg.lid, id: callId, data });
        this.epMap.set(msg.lid, g.addEndpoint(opts));
        break;
      }
      case 'ep_remove': {
        const ep = this.epMap.get(msg.lid);
        if (ep) { g.removeEndpoint(ep.id); this.epMap.delete(msg.lid); }
        break;
      }
      case 'publish': {
        const ep = this.epMap.get(msg.lid);
        if (ep) g.publish(ep.id, msg.data);
        break;
      }
      case 'srv_call': {
        const ep = this.epMap.get(msg.lid);
        if (!ep) break;
        const tryCall = () => {
          if (!this.alive) return;
          const ok = g.callService(ep.name, msg.data, (resp) => this.send({ t: 'srv_resp', id: msg.id, data: resp }));
          if (!ok) setTimeout(tryCall, 100);   // like DDS: request waits until a server shows up
        };
        tryCall();
        break;
      }
      case 'srv_resp':
        g.respond(msg.id, msg.data);
        break;
      case 'param': {
        const node = this.nodeMap.get(msg.nid);
        if (node) node.params.set(msg.name, { type: msg.ptype, value: msg.value });
        break;
      }
      case 'param_resp': {
        const cb = this.pendingParam.get(msg.id);
        if (cb) { this.pendingParam.delete(msg.id); cb(msg.ok, msg.reason); }
        break;
      }
      case 'exit': {
        const code = msg.code;
        for (const h of hintsForExit(msg, this)) this.term.writeHint(h);
        this.cleanup();
        this.onExit?.(code, msg.error, msg.info);
        break;
      }
    }
  }
}
