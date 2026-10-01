// Workspace files (saved in the browser) and the CodeMirror editor with tabs.
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { EXAMPLES } from './examples.js';

const KEY = 'ros2-sandbox.files.v1';

export class Files {
  constructor() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
    this.data = saved && typeof saved === 'object' ? saved : { ...EXAMPLES };
    this.listeners = new Set();
  }
  all() { return { ...this.data }; }
  get(name) { return Object.prototype.hasOwnProperty.call(this.data, name) ? this.data[name] : null; }
  set(name, content) { this.data[name] = content; this.save(); }
  remove(name) { delete this.data[name]; this.save(); this.emit(); }
  create(name, content = '') { this.data[name] = content; this.save(); this.emit(); }
  restoreExamples() { this.data = { ...this.data, ...EXAMPLES }; this.save(); this.emit(); }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch {} }
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
      x.title = '닫기';
      x.onclick = (e) => { e.stopPropagation(); this.closeFile(n); };
      tab.append(label, x);
      this.tabsEl.append(tab);
    }
  }
}
