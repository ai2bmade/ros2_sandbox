// A small bash-like shell on top of xterm.js: line editing, history, Tab completion, jobs, Ctrl+C.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { runRos2, ROS2_COMMANDS } from './cli.js';
import { PyProcess, MAX_PROCESSES } from './process.js';
import { allTypes } from './msgutil.js';

const PROMPT = '\x1b[1;32muser@ros2-sandbox\x1b[0m:\x1b[1;34m~/ws\x1b[0m$ ';
const SHELL_CMDS = ['ros2', 'python3', 'ls', 'cat', 'clear', 'pwd', 'help', 'echo'];

const HELP = `\x1b[1mROS2-Web-Sandbox 터미널\x1b[0m
  python3 <파일>.py [--ros-args -p 이름:=값]   내가 쓴 노드 실행 (Ctrl+C로 종료)
  ros2 run turtlesim turtlesim_node            거북이 시뮬레이터 실행
  ros2 run turtlesim turtle_teleop_key         방향키로 거북이 조종
  ros2 node list | info <노드>
  ros2 topic list [-t] | info | echo | hz | pub [--once] <토픽> <타입> '<YAML>'
  ros2 service list | type | call <서비스> <타입> '<YAML>'
  ros2 param list | get | set <노드> <이름> <값>
  ros2 interface list | show <타입>
  ls, cat <파일>, clear, pwd
  Tab: 자동완성   ↑/↓: 이전 명령   Ctrl+C: 실행 중인 프로그램 종료
`;

// split a command line into args, honoring quotes
export function splitArgs(line) {
  const out = [];
  let cur = '', q = null, has = false;
  for (const ch of line) {
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

export class Shell {
  constructor(el, app, index) {
    this.app = app;
    this.index = index;
    this.term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      convertEol: false,
      scrollback: 5000,
      theme: { background: '#11141b', foreground: '#d7dae0', cursor: '#d7dae0', selectionBackground: '#3a4252' },
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(el);
    this.line = '';
    this.cursor = 0;
    this.history = [];
    this.hIndex = 0;
    this.job = null;
    new ResizeObserver(() => { try { this.fit.fit(); } catch {} }).observe(el);
    this.term.onData((d) => this.onData(d));
    this.term.write(`\x1b[2m터미널 ${index}. help 를 입력하면 사용 가능한 명령을 볼 수 있습니다.\x1b[0m\r\n`);
    this.prompt();
  }

  focus() { this.term.focus(); }

  writeOutput(text) { this.term.write(text.replace(/\r?\n/g, '\r\n')); }
  writeHint(text) { this.writeOutput(`\x1b[36m[힌트] ${text}\x1b[0m\n`); }

  prompt() { this.line = ''; this.cursor = 0; this.term.write(PROMPT); }

  redraw() {
    this.term.write('\r\x1b[2K' + PROMPT + this.line);
    const back = this.line.length - this.cursor;
    if (back > 0) this.term.write(`\x1b[${back}D`);
  }

  // type text into the prompt (used by the sidebar's quick commands)
  typeCommand(cmd, run = false) {
    if (this.job) return;
    this.line = cmd; this.cursor = cmd.length; this.redraw();
    if (run) this.onData('\r');
    this.focus();
  }

  onData(d) {
    if (this.job) {
      if (d === '\x03') { const j = this.job; this.term.write('^C\r\n'); j.interrupt(); if (!j.waitExit && this.job === j) this.endJob(130); return; }
      if (this.job.onKey) this.job.onKey(d);
      return;
    }
    if (d === '\r') {
      this.term.write('\r\n');
      const line = this.line.trim();
      if (line) { this.history.push(line); this.hIndex = this.history.length; }
      this.execute(line);
      return;
    }
    if (d === '\x03') { this.term.write('^C\r\n'); this.prompt(); return; }
    if (d === '\x7f' || d === '\b') {
      if (this.cursor > 0) { this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor); this.cursor--; this.redraw(); }
      return;
    }
    if (d === '\t') { this.complete(); return; }
    if (d === '\x1b[A') { if (this.hIndex > 0) { this.hIndex--; this.line = this.history[this.hIndex]; this.cursor = this.line.length; this.redraw(); } return; }
    if (d === '\x1b[B') {
      if (this.hIndex < this.history.length) { this.hIndex++; this.line = this.history[this.hIndex] || ''; this.cursor = this.line.length; this.redraw(); }
      return;
    }
    if (d === '\x1b[D') { if (this.cursor > 0) { this.cursor--; this.term.write(d); } return; }
    if (d === '\x1b[C') { if (this.cursor < this.line.length) { this.cursor++; this.term.write(d); } return; }
    if (d === '\x1b[H' || d === '\x01') { this.cursor = 0; this.redraw(); return; }
    if (d === '\x1b[F' || d === '\x05') { this.cursor = this.line.length; this.redraw(); return; }
    if (d === '\x0c') { this.term.clear(); this.redraw(); return; }
    if (d.startsWith('\x1b')) return;
    const text = d.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f]/g, '');
    this.line = this.line.slice(0, this.cursor) + text + this.line.slice(this.cursor);
    this.cursor += text.length;
    this.redraw();
  }

  candidates(words, idx) {
    const g = this.app.graph;
    if (idx === 0) return SHELL_CMDS;
    const [c0, c1, c2] = words;
    if (c0 === 'python3' || c0 === 'python' || c0 === 'cat') return Object.keys(this.app.files.all());
    if (c0 !== 'ros2') return [];
    if (idx === 1) return Object.keys(ROS2_COMMANDS);
    if (idx === 2) return ROS2_COMMANDS[c1] || [];
    if (c1 === 'run') return idx === 3 ? ['turtlesim_node', 'turtle_teleop_key'] : [];
    if (c1 === 'node') return g.visibleNodes().map((n) => n.fqn);
    if (c1 === 'topic') {
      if (idx === 3) return [...g.topics().keys()];
      if (idx === 4 && c2 === 'pub') {
        const t = g.topics().get(words[3]);
        return t && t.size ? [...t] : allTypes().filter((x) => x.includes('/msg/'));
      }
      return [];
    }
    if (c1 === 'service') {
      if (idx === 3) return [...g.services().keys()];
      if (idx === 4 && c2 === 'call') { const t = g.services().get(words[3]); return t ? [...t] : allTypes().filter((x) => x.includes('/srv/')); }
      return [];
    }
    if (c1 === 'param') {
      if (idx === 3) return g.visibleNodes().map((n) => n.fqn);
      if (idx === 4) { const n = g.nodeByName(words[3]); return n ? [...n.params.keys()] : []; }
      return [];
    }
    if (c1 === 'interface' && idx === 3) return allTypes();
    return [];
  }

  complete() {
    const before = this.line.slice(0, this.cursor);
    const words = before.split(/\s+/);
    const idx = words.length - 1;
    const partial = words[idx];
    const cands = [...new Set(this.candidates(words, idx))].filter((c) => c.startsWith(partial)).sort();
    if (!cands.length) return;
    if (cands.length === 1) {
      const add = cands[0].slice(partial.length) + ' ';
      this.line = before + add + this.line.slice(this.cursor);
      this.cursor += add.length;
      this.redraw();
      return;
    }
    let common = cands[0];
    for (const c of cands) while (!c.startsWith(common)) common = common.slice(0, -1);
    if (common.length > partial.length) {
      const add = common.slice(partial.length);
      this.line = before + add + this.line.slice(this.cursor);
      this.cursor += add.length;
      this.redraw();
      return;
    }
    this.term.write('\r\n' + cands.join('  ') + '\r\n');
    this.redraw();
  }

  startJob(job) {
    this.job = job;
    job.finish = (code) => { if (this.job === job) this.endJob(code); };
    this.app.onJobsChanged?.();
    if (job.doneEarly !== undefined) this.endJob(job.doneEarly);
  }

  endJob() {
    this.job = null;
    this.prompt();
    this.app.onJobsChanged?.();
  }

  execute(line) {
    if (!line) { this.prompt(); return; }
    const args = splitArgs(line);
    const cmd = args[0];
    const out = (s) => this.writeOutput(s.endsWith('\n') ? s : s + '\n');
    const files = this.app.files;
    switch (cmd) {
      case 'help': out(HELP); break;
      case 'clear': this.term.clear(); break;
      case 'pwd': out('/home/user/ws'); break;
      case 'ls': out(Object.keys(files.all()).sort().join('  ')); break;
      case 'echo': out(args.slice(1).join(' ')); break;
      case 'cat': {
        for (const f of args.slice(1)) {
          const c = files.get(f);
          if (c == null) out(`cat: ${f}: No such file or directory`); else out(c);
        }
        break;
      }
      case 'cd': break;
      case 'python': case 'python3': {
        const file = args[1];
        if (!file) { out('이 터미널에서는 대화형 파이썬을 지원하지 않습니다. python3 파일이름.py 로 실행하세요.'); break; }
        if (files.get(file) == null) {
          out(`python3: can't open file '/home/user/ws/${file}': [Errno 2] No such file or directory`);
          break;
        }
        if (this.app.processes.size >= MAX_PROCESSES) {
          out(`\x1b[31m동시에 실행할 수 있는 Python 프로그램은 ${MAX_PROCESSES}개까지입니다. 다른 터미널에서 Ctrl+C로 하나를 종료하세요.\x1b[0m`);
          break;
        }
        this.runPython(args.slice(1));
        return;
      }
      case 'ros2': {
        let res;
        try { res = runRos2(args.slice(1), { graph: this.app.graph, term: this, turtlesim: this.app.turtlesim }); }
        catch (e) { out(`\x1b[31m${e.message || e}\x1b[0m`); res = 1; }
        if (res && typeof res === 'object') { this.startJob(res); return; }
        break;
      }
      default:
        out(`${cmd}: command not found`);
        if (/^(sudo|apt|pip|colcon|source|cd|nano|vim)$/.test(cmd)) this.writeHint('이 샌드박스는 설치와 빌드가 필요 없습니다. 왼쪽 에디터에서 파일을 만들고 python3 파일이름.py 로 실행하세요.');
    }
    this.prompt();
  }

  runPython(argv) {
    const app = this.app;
    if (!app.pool.loadedOnce) this.writeOutput('\x1b[2m(Python 엔진 준비 중... 첫 실행은 몇 초 걸릴 수 있습니다)\x1b[0m\n');
    const proc = new PyProcess({
      graph: app.graph, term: this, pool: app.pool, files: app.files.all(), argv,
      onExit: () => { app.processes.delete(proc); if (this.job === job) this.endJob(); },
    });
    const job = { interrupt: () => proc.interrupt(), waitExit: true, proc };
    app.processes.add(proc);
    this.startJob(job);
    proc.start().catch((e) => {
      this.writeOutput(`\x1b[31mPython 엔진을 시작하지 못했습니다: ${e.message}\x1b[0m\n`);
      app.processes.delete(proc);
      this.endJob();
    });
  }
}
