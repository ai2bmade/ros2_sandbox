// Workspace files (saved in the browser) and the CodeMirror editor with tabs.
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { EXAMPLES } from './examples.js';

// Files written by the pre-login version (kept only to import them into the account once).
const LEGACY_KEY = 'ros2-sandbox.files.v1';
const SAVE_DELAY = 1000;

// Saves to the user's account through /api/files, one debounced PUT per file.
class RemoteStore {
  constructor(onState) {
    this.pending = new Map();   // name -> content not yet sent
    this.timers = new Map();
    this.inflight = 0;
    this.onState = onState;
    window.addEventListener('pagehide', () => this.flush(true));
  }
  save(name, content, now = false) {
    this.pending.set(name, content);
    clearTimeout(this.timers.get(name));
    this.timers.set(name, setTimeout(() => this.send(name), now ? 0 : SAVE_DELAY));
    this.onState?.('saving');
  }
  async send(name, keepalive = false) {
    this.timers.delete(name);
    if (!this.pending.has(name)) return;
    const content = this.pending.get(name);
    this.pending.delete(name);
    this.inflight++;
    try {
      const res = await fetch(`/api/files/${encodeURIComponent(name)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content }), keepalive,
      });
      if (res.status === 401) { location.href = '/welcome/'; return; }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
      this.inflight--;
      if (!this.inflight && !this.pending.size) this.onState?.('saved');
    } catch (e) {
      this.inflight--;
      if (!this.pending.has(name)) this.pending.set(name, content);
      this.onState?.('error', e);
      clearTimeout(this.timers.get(name));
      this.timers.set(name, setTimeout(() => this.send(name), 5000));
    }
  }
  async remove(name) {
    clearTimeout(this.timers.get(name));
    this.pending.delete(name);
    await fetch(`/api/files/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {});
  }
  flush(keepalive = false) { for (const name of [...this.pending.keys()]) this.send(name, keepalive); }
}

export class Files {
  constructor(data, store) {
    this.data = data;
    this.store = store;
    this.listeners = new Set();
  }

  // Load the account's files; on the first visit, seed them with the examples plus any files
  // this browser still has from before login existed.
  static async load(onState) {
    let res = await fetch('/api/files');
    if (res.status === 401 || res.status === 403) { location.href = '/welcome/'; return new Promise(() => {}); }
    let { files } = await res.json();
    if (!Object.keys(files).length) {
      let legacy = {};
      try { legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || '{}') || {}; } catch {}
      res = await fetch('/api/files/seed', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ files: { ...EXAMPLES, ...legacy } }),
      });
      ({ files } = await res.json());
    }
    return new Files(files, new RemoteStore(onState));
  }

  all() { return { ...this.data }; }
  get(name) { return Object.prototype.hasOwnProperty.call(this.data, name) ? this.data[name] : null; }
  set(name, content) { this.data[name] = content; this.store.save(name, content); }
  remove(name) { delete this.data[name]; this.store.remove(name); this.emit(); }
  create(name, content = '') { this.data[name] = content; this.store.save(name, content, true); this.emit(); }
  restoreExamples() {
    this.data = { ...this.data, ...EXAMPLES };
    for (const [name, content] of Object.entries(EXAMPLES)) this.store.save(name, content, true);
    this.emit();
  }
  onChange(fn) { this.listeners.add(fn); }
  emit() { for (const fn of this.listeners) fn(); }
}

export class Editor {
  constructor(el, tabsEl, files) {
    this.files = files;
    this.tabsEl = tabsEl;
    this.open = [];
    this.current = null;
    this.states = new Map();
    this.view = new EditorView({ parent: el, state: this.makeState('') });
  }

  makeState(doc, name) {
    return EditorState.create({
      doc,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab, { key: 'Mod-s', run: () => true, preventDefault: true }]),
        python(),
        oneDark,
        EditorView.updateListener.of((u) => { if (u.docChanged && name) this.files.set(name, u.state.doc.toString()); }),
        EditorView.theme({ '&': { height: '100%', fontSize: '13px' }, '.cm-scroller': { fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace' } }),
      ],
    });
  }

  openFile(name) {
    if (this.files.get(name) == null) return;
    if (this.current) this.states.set(this.current, this.view.state);
    if (!this.open.includes(name)) this.open.push(name);
    const st = this.states.get(name) || this.makeState(this.files.get(name), name);
    this.view.setState(st);
    this.current = name;
    this.renderTabs();
    this.onOpen?.(name);
  }

  closeFile(name) {
    this.open = this.open.filter((n) => n !== name);
    this.states.delete(name);
    if (this.current === name) {
      this.current = null;
      if (this.open.length) this.openFile(this.open[this.open.length - 1]);
      else { this.view.setState(this.makeState('')); this.renderTabs(); this.onOpen?.(null); }
    } else this.renderTabs();
  }

  renderTabs() {
    this.tabsEl.innerHTML = '';
    for (const n of this.open) {
      const tab = document.createElement('div');
      tab.className = 'tab' + (n === this.current ? ' active' : '');
      const label = document.createElement('span');
      label.textContent = n;
      label.onclick = () => this.openFile(n);
      const x = document.createElement('button');
      x.className = 'tab-x';
      x.textContent = '×';
      x.title = 'Close';
      x.onclick = (e) => { e.stopPropagation(); this.closeFile(n); };
      tab.append(label, x);
      this.tabsEl.append(tab);
    }
  }
}
