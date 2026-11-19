import { sy, h, icon, iconBtn, ctx, contextMenu, fail, toast, baseName, dirName, joinPath } from './util.js';

const state = { hostId: 'local', root: '', open: new Set(), cache: new Map(), selected: '' };
let els = null;

export function initFiles(container) {
  const hostSel = h('select', { title: 'Host', onchange: () => setHost(hostSel.value) });
  const pathInput = h('input', {
    type: 'text',
    spellcheck: false,
    title: 'Folder path',
    onkeydown: (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') setRoot(pathInput.value.trim());
    },
  });
  const tree = h('div', { id: 'tree' });
  container.append(
    h('div', { id: 'files-top' },
      h('div', { class: 'row' }, hostSel, iconBtn('refresh', 'Refresh', () => refresh()), iconBtn('upload', 'Upload to this folder…', () => upload(state.root))),
      h('div', { class: 'row' }, iconBtn('up', 'Parent folder', () => setRoot(dirName(state.root))), pathInput)
    ),
    tree
  );
  els = { hostSel, pathInput, tree };

  tree.addEventListener('contextmenu', (e) => {
    if (e.target === tree) dirMenu(e, state.root, null);
  });
  tree.addEventListener('dragover', (e) => {
    e.preventDefault();
    tree.classList.add('drop');
  });
  tree.addEventListener('dragleave', () => tree.classList.remove('drop'));
  tree.addEventListener('drop', (e) => {
    e.preventDefault();
    tree.classList.remove('drop');
    const row = e.target.closest('.trow.dir');
    const dir = row ? row.dataset.path : state.root;
    const paths = [...e.dataTransfer.files].map((f) => sy.pathForFile(f)).filter(Boolean);
    if (paths.length) upload(dir, paths);
  });
  renderHosts();
}

export function renderHosts() {
  if (!els) return;
  const list = ctx.hosts.filter((x) => x.local || (x.ssh && x.ssh.enabled));
  els.hostSel.replaceChildren(...list.map((x) => h('option', { value: x.id }, x.local ? 'Local' : x.name)));
  if (!list.some((x) => x.id === state.hostId)) state.hostId = 'local';
  els.hostSel.value = state.hostId;
}

export function showFiles(hostId, dir) {
  if (hostId && hostId !== state.hostId) return setHost(hostId, dir);
  if (dir) return setRoot(dir);
  if (!state.root) return setHost(state.hostId);
}

export function localRoot() {
  return state.hostId === 'local' ? state.root : '';
}

export function currentFilesHost() {
  return state.hostId;
}

async function setHost(hostId, dir) {
  state.hostId = hostId;
  state.open.clear();
  state.cache.clear();
  state.root = '';
  els.hostSel.value = hostId;
  els.tree.replaceChildren(h('div', { class: 'tree-note' }, hostId === 'local' ? 'Loading…' : 'Connecting…'));
  try {
    const root = dir || (await sy.invoke('fs.home', hostId));
    if (state.hostId !== hostId) return;
    await setRoot(root);
  } catch (err) {
    if (state.hostId !== hostId) return;
    els.tree.replaceChildren(h('div', { class: 'tree-note' }, 'Could not open this host.'), h('div', { class: 'tree-note' }, h('button', { class: 'btn small', onclick: () => setHost(hostId, dir) }, 'Retry')));
    fail(err);
  }
}

async function setRoot(dir) {
  if (!dir) return;
  try {
    const list = await sy.invoke('fs.list', state.hostId, dir);
    state.root = dir;
    state.cache.set(dir, list);
    els.pathInput.value = dir;
    render();
    ctx.changed();
  } catch (err) {
    els.pathInput.value = state.root;
    fail(err);
  }
}

async function refresh(dir) {
  const targets = dir ? [dir] : [state.root, ...state.open];
  await Promise.all(
    targets.map(async (d) => {
      try {
        state.cache.set(d, await sy.invoke('fs.list', state.hostId, d));
      } catch {
        state.cache.delete(d);
        state.open.delete(d);
      }
    })
  );
  render();
}

function render() {
  const rows = [];
  const walk = (dir, depth) => {
    const list = state.cache.get(dir);
    if (!list) return;
    if (!list.length && depth > 0) rows.push(h('div', { class: 'tree-note', style: { paddingLeft: `${14 + depth * 14}px` } }, 'empty'));
    for (const e of list) {
      const full = joinPath(dir, e.name);
      const isOpen = e.dir && state.open.has(full);
      rows.push(
        h('div', {
          class: `trow ${e.dir ? 'dir' : 'file'} ${isOpen ? 'open' : ''} ${e.name.startsWith('.') ? 'dotfile' : ''} ${state.selected === full ? 'sel' : ''}`,
          style: { paddingLeft: `${10 + depth * 14}px` },
          'data-path': full,
          title: full,
          onclick: () => (e.dir ? toggle(full) : openFile(full)),
          oncontextmenu: (ev) => (e.dir ? dirMenu(ev, full, ev.currentTarget) : fileMenu(ev, full, ev.currentTarget)),
        },
          h('span', { class: 'chev' }, e.dir ? icon('chevron') : null),
          h('span', { class: 'fic' }, icon(e.dir ? 'folder' : 'file')),
          h('span', { class: 'fname' }, e.name)
        )
      );
      if (isOpen) walk(full, depth + 1);
    }
  };
  walk(state.root, 0);
  if (!rows.length) rows.push(h('div', { class: 'tree-note' }, 'Empty folder'));
  const top = els.tree.scrollTop;
  els.tree.replaceChildren(...rows);
  els.tree.scrollTop = top;
}

async function toggle(dir) {
  if (state.open.has(dir)) {
    state.open.delete(dir);
    return render();
  }
  try {
    state.cache.set(dir, await sy.invoke('fs.list', state.hostId, dir));
    state.open.add(dir);
    render();
  } catch (err) {
    fail(err);
  }
}

function openFile(file) {
  state.selected = file;
  render();
  ctx.openFile(state.hostId, file).catch(fail);
}

function inlineInput(afterRow, depthPx, initial, commit) {
  const input = h('input', { type: 'text', value: initial, spellcheck: false });
  const row = h('div', { class: 'trow', style: { paddingLeft: depthPx } }, h('span', { class: 'chev' }), input);
  let finished = false;
  const finish = (ok) => {
    if (finished) return;
    finished = true;
    const v = input.value.trim();
    row.remove();
    if (ok && v && v !== initial) commit(v);
    else render();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  if (afterRow) afterRow.after(row);
  else els.tree.prepend(row);
  input.focus();
  const dot = initial.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : initial.length);
}

async function createIn(dir, row, isDir) {
  if (dir !== state.root && !state.open.has(dir)) await toggle(dir);
  const anchor = dir === state.root ? null : els.tree.querySelector(`[data-path="${CSS.escape(dir)}"]`);
  const pad = anchor ? `${parseInt(anchor.style.paddingLeft, 10) + 14}px` : '10px';
  inlineInput(anchor, pad, '', async (name) => {
    try {
      const full = joinPath(dir, name);
      await sy.invoke('fs.create', state.hostId, full, isDir);
      await refresh(dir);
      if (!isDir) openFile(full);
    } catch (err) {
      fail(err);
      render();
    }
  });
}

function rename(full, row) {
  const pad = row.style.paddingLeft;
  row.hidden = true;
  inlineInput(row, pad, baseName(full), async (name) => {
    try {
      await sy.invoke('fs.rename', state.hostId, full, joinPath(dirName(full), name));
      await refresh(dirName(full));
    } catch (err) {
      fail(err);
      render();
    }
  });
}

async function remove(full) {
  try {
    if (await sy.invoke('fs.remove', state.hostId, full)) {
      state.open.delete(full);
      await refresh(dirName(full));
    }
  } catch (err) {
    fail(err);
  }
}

async function upload(dir, paths) {
  try {
    const n = await sy.invoke('fs.upload', state.hostId, dir, paths || null);
    if (n) {
      toast(`Copied ${n} file${n === 1 ? '' : 's'} to ${dir}`, 'ok');
      await refresh(dir === state.root || state.open.has(dir) ? dir : undefined);
    }
  } catch (err) {
    fail(err);
  }
}

async function download(full) {
  try {
    const out = await sy.invoke('fs.download', state.hostId, full);
    if (out) toast(`Downloaded to ${out}`, 'ok');
  } catch (err) {
    fail(err);
  }
}

function dirMenu(ev, dir, row) {
  const remote = state.hostId !== 'local';
  contextMenu(ev, [
    { label: 'New File', run: () => createIn(dir, row, false) },
    { label: 'New Folder', run: () => createIn(dir, row, true) },
    '-',
    { label: 'Open Terminal Here', run: () => ctx.openTerminal(state.hostId, { cwd: dir }) },
    { label: 'Open as Root Folder', run: () => setRoot(dir) },
    '-',
    { label: remote ? 'Upload Here…' : 'Copy Files Here…', run: () => upload(dir) },
    remote && row ? { label: 'Download Folder…', run: () => download(dir) } : null,
    { label: 'Copy Path', run: () => navigator.clipboard.writeText(dir) },
    { label: 'Refresh', run: () => refresh() },
    row ? '-' : null,
    row ? { label: 'Rename', run: () => rename(dir, row) } : null,
    row ? { label: 'Delete', danger: true, run: () => remove(dir) } : null,
  ], row);
}

function fileMenu(ev, file, row) {
  const remote = state.hostId !== 'local';
  contextMenu(ev, [
    { label: 'Open', run: () => openFile(file) },
    { label: 'Open to the Side', run: () => ctx.openFile(state.hostId, file, { side: true }) },
    '-',
    remote ? { label: 'Download…', run: () => download(file) } : null,
    { label: 'Copy Path', run: () => navigator.clipboard.writeText(file) },
    '-',
    { label: 'Rename', run: () => rename(file, row) },
    { label: 'Delete', danger: true, run: () => remove(file) },
  ], row);
}
