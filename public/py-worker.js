// One Python "process" = one module worker running Pyodide + the rclpy shim.
import { loadPyodide } from './pyodide/pyodide.mjs';

let pyodide, ctrl, data, N, intBuf, sleepArr;
const dec = new TextDecoder();

function readAll() {
  const out = [];
  let r = Atomics.load(ctrl, 2);
  const w = Atomics.load(ctrl, 1);
  while (r < w) {
    const len = data[r % N] | (data[(r + 1) % N] << 8) | (data[(r + 2) % N] << 16) | (data[(r + 3) % N] << 24);
    r += 4;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = data[(r + i) % N];
    r += len;
    out.push(dec.decode(bytes));
  }
  Atomics.store(ctrl, 2, r);
  return out;
}

const sandbox = {
  spec: () => self.__spec,
  post: (s) => postMessage({ t: 'json', s }),
  now_ms: () => performance.timeOrigin + performance.now(),
  interrupted: () => {
    if (intBuf[0] !== 0) { intBuf[0] = 0; return true; }
    return false;
  },
  wait: (ms) => {
    const deadline = performance.now() + ms;
    for (;;) {
      if (intBuf[0] !== 0) return '[]';
      const msgs = readAll();
      if (msgs.length) return '[' + msgs.join(',') + ']';
      const rem = deadline - performance.now();
      if (rem <= 0) return '[]';
      const seq = Atomics.load(ctrl, 0);
      if (Atomics.load(ctrl, 1) !== Atomics.load(ctrl, 2)) continue;
      Atomics.wait(ctrl, 0, seq, Math.min(rem, 50));
    }
  },
  sleep: (ms) => {
    const deadline = performance.now() + ms;
    for (;;) {
      if (intBuf[0] !== 0) return true;
      const rem = deadline - performance.now();
      if (rem <= 0) return false;
      Atomics.wait(sleepArr, 0, 0, Math.min(rem, 50));
    }
  },
};

function write(kind) {
  return {
    write: (buf) => { postMessage({ t: kind, text: dec.decode(buf) }); return buf.length; },
  };
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      ctrl = new Int32Array(m.inbox, 0, 4);
      data = new Uint8Array(m.inbox, 16);
      N = data.length;
      intBuf = new Uint8Array(m.interrupt);
      sleepArr = new Int32Array(new SharedArrayBuffer(4));
      self.__spec = m.spec;
      pyodide = await loadPyodide({ indexURL: new URL('./pyodide/', self.location.href).href });
      pyodide.setStdout(write('out'));
      pyodide.setStderr(write('err'));
      pyodide.registerJsModule('_sandbox', sandbox);
      pyodide.FS.mkdirTree('/home/user/ws');
      pyodide.FS.writeFile('/home/user/ros_shim.py', m.shim);
      pyodide.runPython(`
import sys
sys.path.insert(0, '/home/user')
import ros_shim
`);
      pyodide.setInterruptBuffer(intBuf);
      postMessage({ t: 'ready' });
    } catch (err) {
      postMessage({ t: 'fatal', text: String(err && err.message || err) });
    }
  } else if (m.type === 'run') {
    const FS = pyodide.FS;
    for (const [name, content] of Object.entries(m.files)) {
      const path = '/home/user/ws/' + name;
      const dir = path.slice(0, path.lastIndexOf('/'));
      FS.mkdirTree(dir);
      FS.writeFile(path, content);
    }
    pyodide.runPython(`
import os, sys
os.chdir('/home/user/ws')
if '/home/user/ws' not in sys.path:
    sys.path.insert(0, '/home/user/ws')
`);
    try {
      pyodide.globals.set('__argv', pyodide.toPy(m.argv));
      pyodide.runPython(`ros_shim._run_main(__argv[0], __argv)`);
    } catch (err) {
      postMessage({ t: 'err', text: String(err && err.message || err) + '\n' });
      postMessage({ t: 'json', s: JSON.stringify({ t: 'exit', code: 1, error: null, info: {} }) });
    }
  }
};
