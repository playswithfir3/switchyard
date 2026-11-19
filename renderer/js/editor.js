import { sy, h, icon, iconBtn, ctx, hostName, baseName, toast, fail, errMsg, modal } from './util.js';

let monacoP = null;
export function loadMonaco() {
  if (!monacoP) {
    monacoP = new Promise((resolve, reject) => {
      const base = new URL('../../node_modules/monaco-editor/min/vs', import.meta.url).href;
      window.MonacoEnvironment = { getWorkerUrl: () => `${base}/base/worker/workerMain.js` };
      const s = document.createElement('script');
      s.src = `${base}/loader.js`;
      s.onload = () => {
        window.require.config({ paths: { vs: base } });
        window.require(['vs/editor/editor.main'], () => {
          const m = window.monaco;
          m.editor.defineTheme('switchyard', {
            base: 'vs-dark',
            inherit: true,
            rules: [],
            colors: {
              'editor.background': '#0f1115',
              'editor.lineHighlightBackground': '#161a22',
              'editorLineNumber.foreground': '#454b5c',
              'editorLineNumber.activeForeground': '#9aa1b3',
              'editorWidget.background': '#1a1e27',
              'editorWidget.border': '#353c4e',
              'editorGutter.background': '#0f1115',
              'scrollbarSlider.background': '#2b304080',
              'minimap.background': '#0f1115',
            },
          });
          resolve(m);
        }, reject);
      };
      s.onerror = () => reject(new Error('Failed to load the editor'));
      document.head.append(s);
    });
  }
  return monacoP;
}

// One Monaco model per (host, path), shared by every pane that shows the file.
const docs = new Map();
const keyOf = (hostId, path) => `${hostId}\n${path}`;

async function openDoc(hostId, path) {
  const key = keyOf(hostId, path);
  let doc = docs.get(key);
  if (doc) {
    doc.refs++;
    return doc;
  }
  const monaco = await loadMonaco();
  const res = await sy.invoke('fs.read', hostId, path);
  if (res.binary) throw new Error(`${baseName(path)} is ${res.encoding ? 'not UTF-8 text, so it cannot be edited safely' : 'a binary file'}`);
  if (res.tooLarge) throw new Error(`${baseName(path)} is too large to edit (${(res.size / 1048576).toFixed(1)} MB)`);
  doc = docs.get(key);
  if (doc) {
    doc.refs++;
    return doc;
  }
  const uri = monaco.Uri.from({ scheme: 'sy', authority: hostId, path: `/${path.replace(/\\/g, '/').replace(/^\/+/, '')}` });
  const model = monaco.editor.getModel(uri) || monaco.editor.createModel(res.content, undefined, uri);
  doc = { key, hostId, path, model, mtime: res.mtime, saved: model.getAlternativeVersionId(), refs: 1 };
  docs.set(key, doc);
  return doc;
}

function releaseDoc(doc) {
  if (--doc.refs > 0) return;
  docs.delete(doc.key);
  doc.model.dispose();
}

const isDirty = (doc) => doc.model.getAlternativeVersionId() !== doc.saved;

export function anyDirty() {
  return [...docs.values()].some(isDirty);
}

export class EditorPane {
  constructor() {
    this.kind = 'editor';
    this.id = `ed${Math.random().toString(36).slice(2, 8)}`;
    this.tabs = [];
    this.active = null;
    this.editor = null;

    this.tabsEl = h('div', { class: 'etabs' });
    this.host = h('div', { class: 'editor-host' });
    this.msg = h('div', { class: 'pane-msg' }, 'Loading editor…');
    this.pos = h('span', { class: 'tag' });
    this.titleEl = h('span', { class: 'ptitle' });
    this.hostEl = h('span', { class: 'phost' }, 'Editor');
    this.body = h('div', { class: 'pane-body' }, this.host, this.msg);
    this.el = h('div', { class: 'pane', onmousedown: () => ctx.focusPane(this) },
      h('div', { class: 'pane-head', ondblclick: () => ctx.toggleZoom(this) },
        h('span', { class: 'fic' }, icon('file')), this.hostEl, this.titleEl, this.pos,
        h('span', { class: 'acts' },
          iconBtn('splitRight', 'Split right', () => ctx.splitFrom(this, 'right')),
          iconBtn('splitDown', 'Split down', () => ctx.splitFrom(this, 'down')),
          iconBtn('x', 'Close pane', () => ctx.closePane(this))
        )
      ),
      this.tabsEl,
      this.body
    );
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(this.body);
    this.init = loadMonaco().then((monaco) => {
      this.monaco = monaco;
      this.editor = monaco.editor.create(this.host, {
        model: null,
        theme: 'switchyard',
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
        fontSize: 12.5,
        minimap: { enabled: true, renderCharacters: false },
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        smoothScrolling: true,
        automaticLayout: false,
        padding: { top: 6 },
      });
      this.editor.onDidChangeCursorPosition((e) => {
        this.pos.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
      });
      this.editor.onDidFocusEditorText(() => ctx.focusPane(this, false));
      this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.save());
      this.msg.hidden = true;
      this.showEmpty();
    }, (err) => {
      this.msg.className = 'pane-msg err';
      this.msg.textContent = errMsg(err);
      throw err;
    });
  }

  showEmpty() {
    if (this.tabs.length) {
      this.msg.hidden = true;
      return;
    }
    this.msg.hidden = false;
    this.msg.className = 'pane-msg';
    this.msg.replaceChildren(h('div', null, 'No file open. Pick one from the ', h('b', null, 'Files'), ' view.'));
    this.titleEl.textContent = '';
    this.hostEl.textContent = 'Editor';
    this.pos.textContent = '';
  }

  async open(hostId, path, { line } = {}) {
    await this.init;
    let tab = this.tabs.find((t) => t.doc.hostId === hostId && t.doc.path === path);
    if (!tab) {
      const doc = await openDoc(hostId, path);
      tab = { doc, view: null, sub: null };
      tab.sub = doc.model.onDidChangeContent(() => this.renderTabs());
      this.tabs.push(tab);
    }
    this.activate(tab);
    if (line) {
      this.editor.revealLineInCenter(line);
      this.editor.setPosition({ lineNumber: line, column: 1 });
    }
    ctx.changed();
  }

  activate(tab) {
    if (this.active && this.active !== tab) this.active.view = this.editor.saveViewState();
    this.active = tab;
    this.editor.setModel(tab.doc.model);
    if (tab.view) this.editor.restoreViewState(tab.view);
    this.msg.hidden = true;
    this.hostEl.textContent = hostName(tab.doc.hostId);
    this.titleEl.textContent = tab.doc.path;
    this.renderTabs();
    this.layout();
    this.editor.focus();
  }

  renderTabs() {
    this.tabsEl.replaceChildren(
      ...this.tabs.map((t) =>
        h('div', {
          class: `etab ${t === this.active ? 'active' : ''} ${isDirty(t.doc) ? 'dirty' : ''}`,
          title: `${hostName(t.doc.hostId)}:${t.doc.path}`,
          onmousedown: (e) => {
            if (e.button === 1) return this.closeTab(t);
            this.activate(t);
          },
        },
          h('span', null, baseName(t.doc.path)),
          t.doc.hostId !== 'local' ? h('span', { class: 'ehost' }, hostName(t.doc.hostId)) : null,
          h('span', {
            class: 'eclose',
            onmousedown: (e) => e.stopPropagation(),
            onclick: (e) => {
              e.stopPropagation();
              this.closeTab(t);
            },
          }, icon('x'))
        )
      )
    );
  }

  async closeTab(tab, { force = false } = {}) {
    if (!force && isDirty(tab.doc) && tab.doc.refs === 1) {
      const r = await modal({
        title: `Save changes to ${baseName(tab.doc.path)}?`,
        body: h('p', null, 'Your changes will be lost if you do not save them.'),
        width: 430,
        buttons: [{ label: "Don't Save", value: 'discard', danger: true }, 'spacer', { label: 'Cancel', value: null }, { label: 'Save', value: 'save', primary: true }],
      });
      if (!r) return false;
      if (r === 'save' && !(await this.save(tab))) return false;
    }
    const i = this.tabs.indexOf(tab);
    if (i < 0) return true;
    this.tabs.splice(i, 1);
    tab.sub.dispose();
    if (this.active === tab) {
      this.active = null;
      const next = this.tabs[Math.min(i, this.tabs.length - 1)];
      if (next) this.activate(next);
      else this.editor.setModel(null);
    }
    releaseDoc(tab.doc);
    this.renderTabs();
    this.showEmpty();
    ctx.changed();
    return true;
  }

  async save(tab = this.active) {
    if (!tab) return false;
    const doc = tab.doc;
    const version = doc.model.getAlternativeVersionId();
    try {
      let res = await sy.invoke('fs.write', doc.hostId, doc.path, doc.model.getValue(), { expectMtime: doc.mtime });
      if (res.conflict) {
        const ok = await modal({
          title: 'File changed on disk',
          body: h('p', null, `${doc.path} was modified on ${hostName(doc.hostId)} since you opened it. Overwrite it with your version?`),
          width: 440,
          buttons: [{ label: 'Cancel', value: null }, { label: 'Overwrite', value: true, danger: true }],
        });
        if (!ok) return false;
        res = await sy.invoke('fs.write', doc.hostId, doc.path, doc.model.getValue(), { force: true });
      }
      doc.mtime = res.mtime;
      doc.saved = version;
      this.renderTabs();
      toast(`Saved ${baseName(doc.path)}`, 'ok', 1500);
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }

  async canClose() {
    for (const t of [...this.tabs]) {
      if (isDirty(t.doc) && t.doc.refs === 1) {
        this.activate(t);
        if (!(await this.closeTab(t))) return false;
      }
    }
    return true;
  }

  layout() {
    if (this.editor && this.host.offsetWidth) this.editor.layout({ width: this.host.offsetWidth, height: this.host.offsetHeight });
  }

  focus() {
    if (this.editor) this.editor.focus();
  }

  serialize() {
    const files = this.tabs.filter((t) => t.doc.hostId === 'local').map((t) => t.doc.path);
    return { kind: 'editor', files, active: this.active && this.active.doc.hostId === 'local' ? this.active.doc.path : null };
  }

  dispose() {
    this.ro.disconnect();
    for (const t of this.tabs) {
      t.sub.dispose();
      releaseDoc(t.doc);
    }
    this.tabs = [];
    if (this.editor) this.editor.dispose();
    this.el.remove();
  }
}
