// A lightweight rqt_graph: nodes (ellipses) and topics (boxes) with publish/subscribe arrows.
export class GraphView {
  constructor(canvas, graph) {
    this.canvas = canvas;
    this.graph = graph;
    graph.onChange(() => this.draw());
    this.draw();
  }

  draw() {
    const c = this.canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = this.canvas.clientWidth || 500, H = this.canvas.clientHeight || 500;
    this.canvas.width = W * dpr; this.canvas.height = H * dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#161a23';
    c.fillRect(0, 0, W, H);
    const g = this.graph;
    const eps = [...g.endpoints.values()].filter((e) => (e.kind === 'pub' || e.kind === 'sub') && !g.nodes.get(e.nodeId)?.hidden);
    const nodes = g.visibleNodes();
    if (!nodes.length) {
      c.fillStyle = '#8b93a7'; c.font = '14px system-ui, sans-serif'; c.textAlign = 'center';
      c.fillText('No nodes running', W / 2, H / 2);
      return;
    }
    // like rqt_graph's default "hide leaf topics": only show topics that connect a publisher and a subscriber
    const allTopics = [...new Set(eps.map((e) => e.name))];
    const topics = allTopics.filter((t) => eps.some((e) => e.name === t && e.kind === 'pub') && eps.some((e) => e.name === t && e.kind === 'sub'));
    const shownEps = eps.filter((e) => topics.includes(e.name));
    const pubs = new Set(shownEps.filter((e) => e.kind === 'pub').map((e) => e.nodeId));
    const left = nodes.filter((n) => pubs.has(n.id));
    const right = nodes.filter((n) => !pubs.has(n.id));
    const pos = new Map();
    const place = (list, x, key) => list.forEach((item, i) => pos.set(key(item), { x, y: ((i + 1) * H) / (list.length + 1) }));
    place(left, W * 0.17, (n) => 'n' + n.id);
    place(right, W * 0.83, (n) => 'n' + n.id);
    // order topics by the average height of the nodes they connect (fewer crossings)
    const bary = (t) => {
      const ys = shownEps.filter((e) => e.name === t).map((e) => pos.get('n' + e.nodeId)?.y).filter((y) => y !== undefined);
      return ys.reduce((a, b) => a + b, 0) / (ys.length || 1);
    };
    topics.sort((a, b) => bary(a) - bary(b) || a.localeCompare(b));
    place(topics, W * 0.5, (t) => 't' + t);

    c.lineWidth = 1.5;
    for (const e of shownEps) {
      const a = pos.get('n' + e.nodeId), b = pos.get('t' + e.name);
      if (!a || !b) continue;
      const from = e.kind === 'pub' ? a : b, to = e.kind === 'pub' ? b : a;
      c.strokeStyle = e.kind === 'pub' ? '#7aa2f7' : '#9ece6a';
      arrow(c, from, to, e.kind === 'pub' ? 60 : 50);
    }
    c.font = '12px ui-monospace, Menlo, monospace';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const t of topics) {
      const p = pos.get('t' + t);
      const w = Math.min(c.measureText(t).width + 16, W * 0.3);
      c.fillStyle = '#2a3142'; c.strokeStyle = '#7f8aa8';
      c.fillRect(p.x - w / 2, p.y - 12, w, 24); c.strokeRect(p.x - w / 2, p.y - 12, w, 24);
      c.fillStyle = '#e0e4ef'; c.fillText(t, p.x, p.y, w - 8);
    }
    for (const n of nodes) {
      const p = pos.get('n' + n.id);
      if (!p) continue;
      const w = Math.min(c.measureText(n.fqn).width + 24, W * 0.3);
      c.fillStyle = '#3b2f4a'; c.strokeStyle = '#bb9af7';
      c.beginPath(); c.ellipse(p.x, p.y, w / 2, 16, 0, 0, Math.PI * 2); c.fill(); c.stroke();
      c.fillStyle = '#f0e9ff'; c.fillText(n.fqn, p.x, p.y, w - 10);
    }
    c.textAlign = 'left'; c.fillStyle = '#8b93a7'; c.font = '11px system-ui, sans-serif';
    c.fillText('Blue: publish   Green: subscribe   ·   Only topics with both a publisher and a subscriber are shown', 10, H - 12);
  }
}

function arrow(c, a, b, pad) {
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  const sx = a.x + ux * pad, sy = a.y + uy * pad * 0.3;
  const ex = b.x - ux * pad, ey = b.y - uy * pad * 0.3;
  c.beginPath(); c.moveTo(sx, sy); c.lineTo(ex, ey); c.stroke();
  const ang = Math.atan2(ey - sy, ex - sx);
  c.beginPath();
  c.moveTo(ex, ey);
  c.lineTo(ex - 8 * Math.cos(ang - 0.4), ey - 8 * Math.sin(ang - 0.4));
  c.lineTo(ex - 8 * Math.cos(ang + 0.4), ey - 8 * Math.sin(ang + 0.4));
  c.closePath();
  c.fillStyle = c.strokeStyle; c.fill();
}
