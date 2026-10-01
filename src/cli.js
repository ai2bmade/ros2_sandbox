// `ros2` command-line tool, reproduced against the virtual graph.
import YAML from 'yaml';
import { SPEC, normalizeType, isMsgType, isSrvType, fillMsg, toYaml, reprMsg, interfaceText, allTypes } from './msgutil.js';
import { startTeleop } from './turtlesim.js';

const USAGE = `usage: ros2 [-h] Call \`ros2 <command> -h\` for more detailed usage. ...

ros2 is an extensible command-line tool for ROS 2.

Commands:
  interface  Show information about ROS interfaces
  node       Various node related sub-commands
  param      Various param related sub-commands
  run        Run a package specific executable
  service    Various service related sub-commands
  topic      Various topic related sub-commands

  Call \`ros2 <command> -h\` for more detailed usage.
`;

export const ROS2_COMMANDS = {
  node: ['list', 'info'],
  topic: ['list', 'info', 'echo', 'hz', 'pub', 'type'],
  service: ['list', 'type', 'call'],
  param: ['list', 'get', 'set'],
  interface: ['list', 'show'],
  run: ['turtlesim'],
};

let cliSeq = 0;

function finishJob(job, code) {
  if (job.finish) job.finish(code);
  else job.doneEarly = code ?? 0;
}

function parseFlags(args) {
  const pos = [], flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--once' || a === '-1') flags.once = true;
    else if (a === '-t' || a === '--show-types') flags.types = true;
    else if (a === '-r' || a === '--rate') flags.rate = parseFloat(args[++i]);
    else if (a === '--times') flags.times = parseInt(args[++i], 10);
    else if (a === '-w' || a === '--wait-matching-subscriptions') i++;
    else if (a === '--qos-reliability') flags.reliability = args[++i];
    else if (a === '--qos-durability') flags.durability = args[++i];
    else if (a === '-h' || a === '--help') flags.help = true;
    else pos.push(a);
  }
  return { pos, flags };
}

function cliNode(graph) {
  return graph.addNode({ name: `_ros2cli_${++cliSeq}`, hidden: true });
}

function topicType(graph, topic) {
  const types = graph.topics().get(topic);
  return types && types.size ? [...types][0] : null;
}

export function runRos2(args, ctx) {
  const { graph, term } = ctx;
  const out = (s) => term.writeOutput(s.endsWith('\n') ? s : s + '\n');
  const [cmd, sub, ...rest] = args;
  if (!cmd || cmd === '-h' || cmd === '--help') { out(USAGE); return; }
  const { pos, flags } = parseFlags(rest);

  if (cmd === 'node') {
    if (sub === 'list') {
      graph.visibleNodes().map((n) => n.fqn).sort().forEach((n) => out(n));
      return;
    }
    if (sub === 'info') {
      const node = pos[0] && graph.nodeByName(pos[0]);
      if (!node) { out(`Unable to find node '${pos[0] || ''}'`); return 1; }
      const eps = [...graph.endpoints.values()].filter((e) => e.nodeId === node.id);
      const section = (title, kind, extra = []) => {
        out(`  ${title}:`);
        const items = eps.filter((e) => e.kind === kind).map((e) => `    ${e.name}: ${e.type}`).concat(extra).sort();
        items.forEach((l) => out(l));
        out('');
      };
      out(node.fqn);
      section('Subscribers', 'sub');
      section('Publishers', 'pub', ['    /parameter_events: rcl_interfaces/msg/ParameterEvent', '    /rosout: rcl_interfaces/msg/Log']);
      const paramSrvs = ['describe_parameters', 'get_parameter_types', 'get_parameters', 'get_type_description', 'list_parameters', 'set_parameters', 'set_parameters_atomically']
        .map((s) => `    ${node.fqn}/${s}: rcl_interfaces/srv/${s.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('')}`);
      section('Service Servers', 'srv', paramSrvs);
      section('Service Clients', 'cli');
      out('  Action Servers:\n\n  Action Clients:\n');
      return;
    }
  }

  if (cmd === 'topic') {
    if (sub === 'list') {
      for (const [name, types] of [...graph.topics()].sort((a, b) => a[0].localeCompare(b[0]))) {
        out(flags.types ? `${name} [${[...types].join(', ')}]` : name);
      }
      return;
    }
    if (sub === 'type') {
      const t = topicType(graph, pos[0]);
      if (!t) { out('Unknown topic: ' + pos[0]); return 1; }
      out(t); return;
    }
    if (sub === 'info') {
      const topic = pos[0];
      const t = topicType(graph, topic);
      if (!t) { out(`Unknown topic '${topic}'`); return 1; }
      out(`Type: ${t}`);
      out(`Publisher count: ${graph.endpointsOf('pub', topic).length}`);
      out(`Subscription count: ${graph.endpointsOf('sub', topic).length}`);
      return;
    }
    if (sub === 'echo') return topicEcho(pos, flags, ctx, out);
    if (sub === 'hz') return topicHz(pos, ctx, out);
    if (sub === 'pub') return topicPub(pos, flags, ctx, out);
  }

  if (cmd === 'service') {
    if (sub === 'list') {
      for (const [name, types] of [...graph.services()].sort((a, b) => a[0].localeCompare(b[0]))) {
        out(flags.types ? `${name} [${[...types].join(', ')}]` : name);
      }
      return;
    }
    if (sub === 'type') {
      const t = graph.services().get(pos[0]);
      if (!t) { out(`Unknown service '${pos[0]}'`); return 1; }
      out([...t][0]); return;
    }
    if (sub === 'call') return serviceCall(pos, ctx, out);
  }

  if (cmd === 'param') {
    if (sub === 'list') {
      const nodes = pos[0] ? [graph.nodeByName(pos[0])].filter(Boolean) : graph.visibleNodes().sort((a, b) => a.fqn.localeCompare(b.fqn));
      if (pos[0] && !nodes.length) { out(`Node not found`); return 1; }
      for (const n of nodes) {
        out(`${n.fqn}:`);
        [...n.params.keys()].sort().forEach((k) => out(`  ${k}`));
      }
      return;
    }
    if (sub === 'get') {
      const n = graph.nodeByName(pos[0] || '');
      if (!n) { out('Node not found'); return 1; }
      const p = n.params.get(pos[1]);
      if (!p) { out('Parameter not set.'); return 1; }
      const label = { BOOL: 'Boolean', INTEGER: 'Integer', DOUBLE: 'Double', STRING: 'String' }[p.type] || p.type;
      let v = p.value;
      if (p.type === 'BOOL') v = v ? 'True' : 'False';
      if (p.type === 'DOUBLE' && Number.isInteger(v)) v = v.toFixed(1);
      out(`${label} value is: ${Array.isArray(v) ? '[' + v.join(', ') + ']' : v}`);
      return;
    }
    if (sub === 'set') {
      const n = graph.nodeByName(pos[0] || '');
      if (!n) { out('Node not found'); return 1; }
      if (pos.length < 3) { out('usage: ros2 param set <node_name> <parameter_name> <value>'); return 2; }
      const raw = pos.slice(2).join(' ');
      let value;
      try { value = YAML.parse(raw); } catch { value = raw; }
      let vtype = 'STRING';
      if (typeof value === 'boolean') vtype = 'BOOL';
      else if (typeof value === 'number') vtype = (/[.eE]/.test(raw) || !Number.isInteger(value)) ? 'DOUBLE' : 'INTEGER';
      else if (Array.isArray(value)) vtype = 'ARRAY';
      else value = String(value ?? raw);
      if (!n.params.has(pos[1])) { out(`Setting parameter failed: parameter '${pos[1]}' is not declared`); return 1; }
      let finished = false;
      const job = { interrupt() { finished = true; } };
      const done = (ok, reason) => {
        if (finished) return;
        finished = true;
        out(ok ? 'Set parameter successful' : `Setting parameter failed: ${reason}`);
        finishJob(job, ok ? 0 : 1);
      };
      n.setParam(pos[1], value, vtype, done);
      setTimeout(() => done(false, 'node did not respond (is the node spinning? parameter requests are handled inside rclpy.spin())'), 5000);
      return job;
    }
  }

  if (cmd === 'interface') {
    if (sub === 'list') {
      const kinds = { msg: 'Messages', srv: 'Services' };
      for (const [k, label] of Object.entries(kinds)) {
        out(`${label}:`);
        allTypes().filter((t) => t.split('/')[1] === k).sort().forEach((t) => out(`    ${t}`));
      }
      return;
    }
    if (sub === 'show') {
      const t = SPEC[pos[0]] ? pos[0] : SPEC[normalizeType(pos[0])] ? normalizeType(pos[0]) : SPEC[normalizeType(pos[0], 'srv')] ? normalizeType(pos[0], 'srv') : null;
      if (!t) { out(`Unknown interface '${pos[0] || ''}'. Try 'ros2 interface list'.`); return 1; }
      out(interfaceText(t));
      return;
    }
  }

  if (cmd === 'run') {
    const [pkg, exe] = [sub, pos[0]];
    if (pkg === 'turtlesim' && exe === 'turtlesim_node') {
      const job = ctx.turtlesim.start(term);
      if (!job) return 1;
      ctx.turtlesim.onStop = () => finishJob(job, 0);
      return job;
    }
    if (pkg === 'turtlesim' && exe === 'turtle_teleop_key') return startTeleop(graph, term);
    if (!pkg) { out('usage: ros2 run <package> <executable>'); return 2; }
    out(`Package '${pkg}' not found` + (pkg === 'turtlesim' ? '' : ''));
    term.writeHint("이 샌드박스에서 ros2 run으로 실행할 수 있는 것: turtlesim turtlesim_node, turtlesim turtle_teleop_key. 직접 작성한 파일은 python3 파일이름.py 로 실행하세요.");
    return 1;
  }

  out(`ros2: error: argument Call \`ros2 <command> -h\` for more detailed usage.: invalid choice: '${[cmd, sub].filter(Boolean).join(' ')}'`);
  term.writeHint('지원하는 명령: ros2 node | topic | service | param | interface | run. 자세한 내용은 help 를 입력하세요.');
  return 2;
}

function topicEcho(pos, flags, ctx, out) {
  const { graph } = ctx;
  const topic = pos[0];
  if (!topic) { out('usage: ros2 topic echo <topic_name> [message_type]'); return 2; }
  let job = null;
  let ep = null;
  const node = cliNode(graph);
  let remaining = flags.once ? 1 : Infinity;
  const attach = (type) => {
    ep = graph.addEndpoint({
      nodeId: node.id, kind: 'sub', name: topic, type,
      qos: { depth: 10, reliability: flags.reliability || 'best_effort', durability: flags.durability || 'volatile' },
      deliver: (data) => {
        if (remaining <= 0) return;
        out(toYaml(type, data));
        out('---');
        if (--remaining <= 0) { cleanup(); finishJob(job, 0); }
      },
    });
  };
  let poll = null;
  const cleanup = () => { clearInterval(poll); graph.removeNode(node.id); };
  const given = pos[1] ? normalizeType(pos[1]) : null;
  if (given && !isMsgType(given)) { cleanup(); out(`The passed message type '${pos[1]}' is invalid`); return 1; }
  const t = given || topicType(graph, topic);
  if (t) attach(t);
  else {
    out(`WARNING: topic [${topic}] does not appear to be published yet`);
    poll = setInterval(() => { const tt = topicType(graph, topic); if (tt && !ep) { clearInterval(poll); attach(tt); } }, 200);
  }
  job = { interrupt() { cleanup(); } };
  return job;
}

function topicHz(pos, ctx, out) {
  const { graph } = ctx;
  const topic = pos[0];
  if (!topic) { out('usage: ros2 topic hz <topic_name>'); return 2; }
  const node = cliNode(graph);
  let stamps = [];
  let ep = null;
  const attach = (type) => {
    ep = graph.addEndpoint({ nodeId: node.id, kind: 'sub', name: topic, type, qos: { depth: 10, reliability: 'best_effort' }, deliver: () => { stamps.push(performance.now() / 1000); if (stamps.length > 10000) stamps.shift(); } });
  };
  const t = topicType(graph, topic);
  if (t) attach(t);
  else out(`WARNING: topic [${topic}] does not appear to be published yet`);
  const iv = setInterval(() => {
    if (!ep) { const tt = topicType(graph, topic); if (tt) attach(tt); return; }
    if (stamps.length < 2) { return; }
    const d = [];
    for (let i = 1; i < stamps.length; i++) d.push(stamps[i] - stamps[i - 1]);
    const mean = d.reduce((a, b) => a + b, 0) / d.length;
    const std = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length);
    out(`average rate: ${(1 / mean).toFixed(3)}\n\tmin: ${Math.min(...d).toFixed(3)}s max: ${Math.max(...d).toFixed(3)}s std dev: ${std.toFixed(5)}s window: ${stamps.length}`);
  }, 1000);
  return { interrupt() { clearInterval(iv); graph.removeNode(node.id); } };
}

function topicPub(pos, flags, ctx, out) {
  const { graph } = ctx;
  const [topic, rawType, ...valueParts] = pos;
  if (!topic || !rawType) { out('usage: ros2 topic pub <topic_name> <message_type> [values]'); return 2; }
  const type = normalizeType(rawType);
  if (!isMsgType(type)) {
    out(`The passed message type is invalid`);
    ctx.term.writeHint(`'${rawType}' 타입을 찾을 수 없습니다. 예: geometry_msgs/msg/Twist. 목록은 ros2 interface list`);
    return 1;
  }
  let msg;
  try {
    const parsed = valueParts.length ? YAML.parse(valueParts.join(' ')) : {};
    msg = fillMsg(type, parsed);
  } catch (e) {
    out(String(e.message || e));
    if (/YAML|Implicit|Flow|Nested|Unexpected/i.test(String(e.name) + String(e.message))) {
      ctx.term.writeHint("값은 YAML 형식으로 따옴표 안에 넣습니다. 예: \"{linear: {x: 2.0}, angular: {z: 1.8}}\"  (콜론 뒤에 공백이 필요합니다)");
    }
    return 1;
  }
  const node = cliNode(graph);
  const ep = graph.addEndpoint({ nodeId: node.id, kind: 'pub', name: topic, type, qos: { depth: 10, reliability: flags.reliability || 'reliable', durability: flags.durability || 'volatile' } });
  out('publisher: beginning loop');
  let n = 0;
  const limit = flags.once ? 1 : (flags.times || Infinity);
  const rate = flags.rate || 1;
  let iv = null;
  const job = {
    interrupt() { clearInterval(iv); clearTimeout(first); graph.removeNode(node.id); },
  };
  const tick = () => {
    n++;
    out(`publishing #${n}: ${reprMsg(type, msg)}\n`);
    graph.publish(ep.id, structuredClone(msg));
    if (n >= limit) { clearInterval(iv); setTimeout(() => { graph.removeNode(node.id); finishJob(job, 0); }, 100); }
  };
  // small delay so subscribers can "discover" the new publisher, like real DDS
  const first = setTimeout(() => { tick(); if (n < limit) iv = setInterval(tick, 1000 / rate); }, 300);
  return job;
}

function serviceCall(pos, ctx, out) {
  const { graph } = ctx;
  const [name, rawType, ...valueParts] = pos;
  if (!name || !rawType) { out('usage: ros2 service call <service_name> <service_type> [values]'); return 2; }
  const type = normalizeType(rawType, 'srv');
  if (!isSrvType(type)) { out(`The passed service type is invalid`); return 1; }
  let req;
  try {
    req = fillMsg(type + '_Request', valueParts.length ? YAML.parse(valueParts.join(' ')) : {});
  } catch (e) { out(String(e.message || e)); return 1; }
  let done = false, iv = null;
  const job = { interrupt() { done = true; clearInterval(iv); } };
  const attempt = () => {
    const srvs = graph.endpointsOf('srv', name);
    if (!srvs.length) return false;
    if (srvs[0].type !== type) {
      out(`Service '${name}' has type ${srvs[0].type}, not ${type}`);
      done = true; clearInterval(iv); setTimeout(() => finishJob(job, 1));
      return true;
    }
    out(`requester: making request: ${reprMsg(type + '_Request', req)}\n`);
    graph.callService(name, req, (resp) => {
      if (done) return;
      done = true;
      out(`response:\n${reprMsg(type + '_Response', resp)}\n`);
      finishJob(job, 0);
    });
    return true;
  };
  if (!attempt()) {
    out('waiting for service to become available...');
    iv = setInterval(() => { if (!done && attempt()) clearInterval(iv); }, 200);
  }
  return job;
}
