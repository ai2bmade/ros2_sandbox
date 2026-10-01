import '@xterm/xterm/css/xterm.css';
import './style.css';
import { loadSpec } from './msgutil.js';
import { Graph } from './graph.js';
import { Files, Editor } from './editor.js';
import { Shell } from './shell.js';
import { WorkerPool } from './process.js';
import { Turtlesim } from './turtlesim.js';
import { GraphView } from './graphview.js';
import { checkTopicTypos } from './hints.js';

const QUICK = [
  'ros2 run turtlesim turtlesim_node',
  'ros2 run turtlesim turtle_teleop_key',
  'python3 talker.py',
  'python3 listener.py',
  'python3 turtle_circle.py',
  'ros2 node list',
  'ros2 topic list -t',
  'ros2 topic echo /chatter',
  'ros2 topic hz /turtle1/pose',
  'ros2 topic pub --once /turtle1/cmd_vel geometry_msgs/msg/Twist "{linear: {x: 2.0}, angular: {z: 1.8}}"',
  'ros2 service call /spawn turtlesim/srv/Spawn "{x: 2.0, y: 2.0, theta: 0.2, name: \'\'}"',
  'ros2 service call /clear std_srvs/srv/Empty',
  'ros2 param set /turtlesim background_r 150',
  'ros2 interface show geometry_msgs/msg/Twist',
];

async function boot() {
  const banner = document.getElementById('coi-banner');
  if (!window.crossOriginIsolated) {
    banner.hidden = false;
    banner.textContent = '이 페이지는 HTTPS와 COOP/COEP 헤더가 있어야 Python 노드를 실행할 수 있습니다 (현재 crossOriginIsolated = false). ros2 CLI와 turtlesim은 그대로 쓸 수 있습니다.';
  }

  await loadSpec();
  const graph = new Graph();
  const files = new Files();

  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('status-text');
  const pool = new WorkerPool((s, err) => {
    statusEl.className = 'status ' + (s === 'ready' ? 'ready' : s === 'error' ? 'error' : '');
    statusText.textContent = s === 'ready' ? 'Python 엔진 준비됨' : s === 'error' ? 'Python 엔진 오류: ' + (err?.message || '') : 'Python 엔진 준비 중…';
  });

  const app = { graph, files, pool, processes: new Set(), turtlesim: null };
  app.turtlesim = new Turtlesim(graph, document.getElementById('turtle-canvas'));
  graph.onChange(() => checkTopicTypos(graph));

  // editor + file list
  const editor = new Editor(document.getElementById('editor'), document.getElementById('tabs'), files);
  const fileList = document.getElementById('file-list');
  const renderFiles = () => {
    fileList.innerHTML = '';
    for (const name of Object.keys(files.all()).sort()) {
      const li = document.createElement('li');
      if (name === editor.current) li.className = 'active';
      const label = document.createElement('span');
      label.textContent = name;
      const del = document.createElement('button');
      del.className = 'del'; del.textContent = '🗑'; del.title = '삭제';
      del.onclick = (e) => {
        e.stopPropagation();
        if (confirm(`${name} 파일을 삭제할까요?`)) { editor.closeFile(name); files.remove(name); }
      };
      li.onclick = () => editor.openFile(name);
      li.append(label, del);
      fileList.append(li);
    }
  };
  files.onChange(renderFiles);
  editor.onOpen = renderFiles;
  document.getElementById('new-file').onclick = () => {
    let name = prompt('새 파일 이름 (예: my_node.py)', 'my_node.py');
    if (!name) return;
    name = name.trim();
    if (!/^[\w.-]+$/.test(name)) { alert('파일 이름에는 영문, 숫자, _, -, . 만 쓸 수 있습니다.'); return; }
    if (files.get(name) != null) { editor.openFile(name); return; }
    files.create(name, name.endsWith('.py') ? 'import rclpy\nfrom rclpy.node import Node\n\n' : '');
    editor.openFile(name);
  };
  document.getElementById('restore').onclick = () => {
    if (confirm('예제 파일을 처음 상태로 복원할까요? (같은 이름의 파일은 덮어씁니다)')) {
      for (const n of [...editor.open]) editor.closeFile(n);
      files.restoreExamples();
      editor.openFile('talker.py');
    }
  };
  renderFiles();
  editor.openFile(files.get('talker.py') != null ? 'talker.py' : Object.keys(files.all())[0]);

  // terminals
  const termsEl = document.getElementById('terms');
  const shells = [];
  let lastShell = null;
  let termCount = 0;
  const addTerminal = () => {
    if (shells.length >= 4) return;
    termCount++;
    const box = document.createElement('div');
    box.className = 'term-box';
    const head = document.createElement('div');
    head.className = 'term-head';
    head.innerHTML = `<span>터미널 ${termCount}</span>`;
    const close = document.createElement('button');
    close.textContent = '×'; close.title = '터미널 닫기';
    head.append(close);
    const body = document.createElement('div');
    body.className = 'term-body';
    box.append(head, body);
    termsEl.append(box);
    const sh = new Shell(body, app, termCount);
    sh.box = box; sh.head = head;
    shells.push(sh);
    const focusMark = () => { lastShell = sh; shells.forEach((s) => s.head.classList.toggle('focused', s === sh)); };
    sh.term.textarea?.addEventListener('focus', focusMark);
    box.addEventListener('mousedown', focusMark);
    close.onclick = () => {
      if (shells.length <= 1) return;
      sh.job?.interrupt();
      if (sh.job?.proc) sh.job.proc.kill();
      sh.term.dispose();
      box.remove();
      shells.splice(shells.indexOf(sh), 1);
      if (lastShell === sh) lastShell = shells[0];
      updateAddBtn();
    };
    if (!lastShell) focusMark();
    updateAddBtn();
    return sh;
  };
  const addBtn = document.getElementById('add-term');
  const updateAddBtn = () => { addBtn.disabled = shells.length >= 4; };
  addBtn.onclick = () => addTerminal().focus();
  addTerminal();
  addTerminal();

  // quick commands
  const quick = document.getElementById('quick');
  for (const cmd of QUICK) {
    const li = document.createElement('li');
    li.textContent = cmd;
    li.onclick = () => {
      let sh = lastShell && !lastShell.job ? lastShell : shells.find((s) => !s.job);
      if (!sh) { sh = shells.length < 4 ? addTerminal() : lastShell; }
      sh.typeCommand(cmd);
    };
    quick.append(li);
  }

  // right panel views
  const graphView = new GraphView(document.getElementById('graph-canvas'), graph);
  for (const b of document.querySelectorAll('.vtab')) {
    b.onclick = () => {
      document.querySelectorAll('.vtab').forEach((x) => x.classList.toggle('active', x === b));
      document.getElementById('view-turtle').hidden = b.dataset.view !== 'turtle';
      document.getElementById('view-graph').hidden = b.dataset.view !== 'graph';
      if (b.dataset.view === 'graph') graphView.draw();
    };
  }
  window.addEventListener('resize', () => graphView.draw());

  if (window.crossOriginIsolated) pool.prewarm();
  else {
    statusEl.className = 'status error';
    statusText.textContent = 'Python 실행 불가 (헤더 설정 필요)';
  }
  app.shells = shells;
  window.__app = app;
}

boot();
