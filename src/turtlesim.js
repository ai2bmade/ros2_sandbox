// Built-in turtlesim (node + 2D renderer) and turtle_teleop_key, implemented in JS.
import { defaultMsg } from './msgutil.js';

const WORLD = 11.088889;
const PX = 500;
const SCALE = PX / WORLD;
const CENTER = 5.544445;

export function logLine(term, level, name, text) {
  const color = level === 'WARN' ? '\x1b[33m' : level === 'ERROR' ? '\x1b[31m' : '';
  term.writeOutput(`${color}[${level}] [${(Date.now() / 1000).toFixed(9)}] [${name}]: ${text}${color ? '\x1b[0m' : ''}\n`);
}

const normAngle = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

export class Turtlesim {
  constructor(graph, canvas) {
    this.graph = graph;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.trail = document.createElement('canvas');
    this.trail.width = PX; this.trail.height = PX;
    this.running = false;
    this.draw();
  }

  start(term) {
    if (this.running) {
      logLine(term, 'WARN', 'sandbox', '이 샌드박스에서는 turtlesim을 하나만 실행할 수 있습니다. 이미 다른 터미널에서 실행 중입니다.');
      return null;
    }
    this.term = term;
    this.running = true;
    this.turtles = new Map();
    this.count = 0;
    this.node = this.graph.addNode({ name: 'turtlesim' });
    const p = this.node.params;
    p.set('background_r', { type: 'INTEGER', value: 69 });
    p.set('background_g', { type: 'INTEGER', value: 86 });
    p.set('background_b', { type: 'INTEGER', value: 255 });
    p.set('holonomic', { type: 'BOOL', value: false });
    this.node.setParam = (name, value, t, cb) => {
      const cur = p.get(name);
      if (!cur) return cb(false, 'parameter not declared');
      if (t !== cur.type) return cb(false, `Wrong parameter type, parameter {${name}} is of type {${cur.type.toLowerCase()}}, setting it to {${t.toLowerCase()}} is not allowed.`);
      if (name.startsWith('background_') && (value < 0 || value > 255)) return cb(false, 'Parameter {' + name + '} doesn\'t comply with integer range.');
      p.set(name, { type: t, value });
      cb(true, '');
    };
    this.node.warn = (text) => logLine(term, 'WARN', 'turtlesim', text);
    const srv = (name, type, fn) => this.graph.addEndpoint({
      nodeId: this.node.id, kind: 'srv', name, type,
      handle: (callId, data) => this.graph.respond(callId, fn(data) || {}),
    });
    srv('/clear', 'std_srvs/srv/Empty', () => { logLine(term, 'INFO', 'turtlesim', 'Clearing turtlesim.'); this.clearTrails(); });
    srv('/reset', 'std_srvs/srv/Empty', () => {
      logLine(term, 'INFO', 'turtlesim', 'Resetting turtlesim.');
      for (const n of [...this.turtles.keys()]) this.killTurtle(n);
      this.count = 0;
      this.clearTrails();
      this.spawn('turtle1', CENTER, CENTER, 0);
    });
    srv('/spawn', 'turtlesim/srv/Spawn', (req) => {
      let name = req.name || `turtle${this.count + 1}`;
      if (this.turtles.has(name)) {
        logLine(term, 'ERROR', 'turtlesim', `A turtle named [${name}] already exists`);
        return { name: '' };
      }
      this.spawn(name, req.x, req.y, req.theta);
      return { name };
    });
    srv('/kill', 'turtlesim/srv/Kill', (req) => {
      if (!this.turtles.has(req.name)) { logLine(term, 'ERROR', 'turtlesim', `Tried to kill turtle [${req.name}], which does not exist`); return {}; }
      this.killTurtle(req.name);
    });
    logLine(term, 'INFO', 'turtlesim', 'Starting turtlesim with node name /turtlesim');
    this.clearTrails();
    this.spawn('turtle1', CENTER, CENTER, 0);
    this.last = performance.now();
    this.interval = setInterval(() => this.update(), 16);
    this.anim = requestAnimationFrame(() => this.loop());
    return { interrupt: () => this.stop(), onKey: () => {} };
  }

  stop() {
    if (!this.running) return;
    clearInterval(this.interval);
    cancelAnimationFrame(this.anim);
    for (const n of [...this.turtles.keys()]) this.killTurtle(n, true);
    this.graph.removeNode(this.node.id);
    this.running = false;
    this.draw();
    this.onStop?.();
  }

  spawn(name, x, y, theta) {
    this.count++;
    logLine(this.term, 'INFO', 'turtlesim', `Spawning turtle [${name}] at x=[${x.toFixed(6)}], y=[${y.toFixed(6)}], theta=[${theta.toFixed(6)}]`);
    const t = {
      name, x, y, theta, lin: 0, linY: 0, ang: 0, lastCmd: 0,
      pen: { r: 179, g: 184, b: 255, width: 3, off: false }, eps: [],
    };
    const G = this.graph, nid = this.node.id;
    t.eps.push(G.addEndpoint({
      nodeId: nid, kind: 'sub', name: `/${name}/cmd_vel`, type: 'geometry_msgs/msg/Twist', qos: { depth: 1 },
      deliver: (m) => { t.lin = m.linear.x; t.linY = m.linear.y; t.ang = m.angular.z; t.lastCmd = performance.now(); },
    }));
    t.pose = G.addEndpoint({ nodeId: nid, kind: 'pub', name: `/${name}/pose`, type: 'turtlesim/msg/Pose', qos: { depth: 1 } });
    t.eps.push(t.pose);
    t.eps.push(G.addEndpoint({ nodeId: nid, kind: 'pub', name: `/${name}/color_sensor`, type: 'turtlesim/msg/Color', qos: { depth: 1 } }));
    const srv = (s, type, fn) => t.eps.push(G.addEndpoint({ nodeId: nid, kind: 'srv', name: `/${name}/${s}`, type, handle: (id, d) => G.respond(id, fn(d) || {}) }));
    srv('set_pen', 'turtlesim/srv/SetPen', (r) => { t.pen = { r: r.r, g: r.g, b: r.b, width: r.width, off: !!r.off }; });
    srv('teleport_absolute', 'turtlesim/srv/TeleportAbsolute', (r) => this.moveTo(t, r.x, r.y, r.theta));
    srv('teleport_relative', 'turtlesim/srv/TeleportRelative', (r) => {
      const th = normAngle(t.theta + r.angular);
      this.moveTo(t, t.x + Math.cos(th) * r.linear, t.y + Math.sin(th) * r.linear, th);
    });
    this.turtles.set(name, t);
  }

  killTurtle(name) {
    const t = this.turtles.get(name);
    if (!t) return;
    for (const ep of t.eps) this.graph.removeEndpoint(ep.id);
    this.turtles.delete(name);
  }

  moveTo(t, x, y, theta) {
    const nx = Math.min(Math.max(x, 0), WORLD), ny = Math.min(Math.max(y, 0), WORLD);
    this.line(t, t.x, t.y, nx, ny);
    t.x = nx; t.y = ny; t.theta = normAngle(theta);
  }

  clearTrails() {
    this.trail.getContext('2d').clearRect(0, 0, PX, PX);
  }

  line(t, x0, y0, x1, y1) {
    if (t.pen.off) return;
    const c = this.trail.getContext('2d');
    c.strokeStyle = `rgb(${t.pen.r},${t.pen.g},${t.pen.b})`;
    c.lineWidth = t.pen.width;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(x0 * SCALE, PX - y0 * SCALE);
    c.lineTo(x1 * SCALE, PX - y1 * SCALE);
    c.stroke();
  }

  update() {
    const dt = 0.016;
    const now = performance.now();
    for (const t of this.turtles.values()) {
      if (now - t.lastCmd > 1000) { t.lin = 0; t.linY = 0; t.ang = 0; }
      const ox = t.x, oy = t.y;
      t.theta = normAngle(t.theta + t.ang * dt);
      let nx = t.x + Math.cos(t.theta) * t.lin * dt - Math.sin(t.theta) * t.linY * dt;
      let ny = t.y + Math.sin(t.theta) * t.lin * dt + Math.cos(t.theta) * t.linY * dt;
      if (nx < 0 || nx > WORLD || ny < 0 || ny > WORLD) {
        logLine(this.term, 'WARN', 'turtlesim', `Oh no! I hit the wall! (Clamping from [x=${nx.toFixed(6)}, y=${ny.toFixed(6)}])`);
        nx = Math.min(Math.max(nx, 0), WORLD); ny = Math.min(Math.max(ny, 0), WORLD);
      }
      t.x = nx; t.y = ny;
      if (ox !== nx || oy !== ny) this.line(t, ox, oy, nx, ny);
      this.graph.publish(t.pose.id, { x: t.x, y: t.y, theta: t.theta, linear_velocity: t.lin, angular_velocity: t.ang });
    }
  }

  loop() {
    this.draw();
    if (this.running) this.anim = requestAnimationFrame(() => this.loop());
  }

  draw() {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (!this.running) {
      c.fillStyle = '#1b1f2a';
      c.fillRect(0, 0, PX, PX);
      c.fillStyle = '#8b93a7';
      c.font = '16px system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText('turtlesim이 실행되고 있지 않습니다', PX / 2, PX / 2 - 12);
      c.font = '14px ui-monospace, monospace';
      c.fillStyle = '#c6cbe0';
      c.fillText('$ ros2 run turtlesim turtlesim_node', PX / 2, PX / 2 + 16);
      return;
    }
    const p = this.node.params;
    c.fillStyle = `rgb(${p.get('background_r').value},${p.get('background_g').value},${p.get('background_b').value})`;
    c.fillRect(0, 0, PX, PX);
    c.drawImage(this.trail, 0, 0);
    for (const t of this.turtles.values()) drawTurtle(c, t.x * SCALE, PX - t.y * SCALE, t.theta);
  }
}

function drawTurtle(c, x, y, theta) {
  c.save();
  c.translate(x, y);
  c.rotate(-theta);
  c.fillStyle = '#3f7d3a';
  for (const [lx, ly] of [[7, 9], [7, -9], [-7, 9], [-7, -9]]) {
    c.beginPath(); c.ellipse(lx, ly, 4, 3, 0, 0, Math.PI * 2); c.fill();
  }
  c.beginPath(); c.ellipse(14, 0, 5, 4, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#6aa84f';
  c.strokeStyle = '#2d5a29';
  c.lineWidth = 1.5;
  c.beginPath(); c.ellipse(0, 0, 11, 9, 0, 0, Math.PI * 2); c.fill(); c.stroke();
  c.beginPath(); c.moveTo(-5, 0); c.lineTo(5, 0); c.moveTo(0, -6); c.lineTo(0, 6); c.stroke();
  c.restore();
}

// ros2 run turtlesim turtle_teleop_key
export function startTeleop(graph, term) {
  const node = graph.addNode({ name: 'teleop_turtle' });
  const pub = graph.addEndpoint({ nodeId: node.id, kind: 'pub', name: '/turtle1/cmd_vel', type: 'geometry_msgs/msg/Twist', qos: { depth: 1 } });
  term.writeOutput('Reading from keyboard\n---------------------------\nUse arrow keys to move the turtle.\n\'Q\' to quit.\n');
  const send = (lin, ang) => {
    const m = defaultMsg('geometry_msgs/msg/Twist');
    m.linear.x = lin; m.angular.z = ang;
    graph.publish(pub.id, m);
  };
  let done = false;
  const stop = () => { if (done) return; done = true; graph.removeNode(node.id); };
  return {
    onKey(data) {
      if (data === '\x1b[A') send(2.0, 0);
      else if (data === '\x1b[B') send(-2.0, 0);
      else if (data === '\x1b[D') send(0, 2.0);
      else if (data === '\x1b[C') send(0, -2.0);
      else if (data === 'q' || data === 'Q') { term.writeOutput('quit\n'); stop(); this.finish?.(0); }
    },
    interrupt() { stop(); },
    wantsKeys: true,
  };
}
