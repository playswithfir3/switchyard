import { sy, MAC, ctx, h, icon, iconBtn, toast, fail, errMsg, contextMenu, ask, confirm, hostName, debounce, baseName } from './util.js';
import { TermPane, agentState, paneTitle } from './term.js';
import { EditorPane, anyDirty } from './editor.js';
import { VncPane } from './vnc.js';
import { initFiles, renderHosts as renderFileHosts, showFiles, localRoot, currentFilesHost } from './files.js';
import { hostDialog, importSshConfig, tmuxDialog, palette } from './hosts.js';

const $ = (id) => document.getElementById(id);
const panes = new Map();
const workspaces = [];
const attention = new Map();
let active = null;
let windowFocused = true;
let restoring = true;
let wsSeq = 0;
let sideView = 'sessions';

document.body.classList.toggle('mac', MAC);

// ---------- layout tree ----------

function locate(node, pane, parent = null, key = null) {
  if (!node) return null;
  if (node.type === 'pane') return node.pane === pane ? { node, parent, key } : null;
  return locate(node.a, pane, node, 'a') || locate(node.b, pane, node, 'b');
}

function replaceNode(ws, oldNode, newNode) {
  if (ws.root === oldNode) {
    ws.root = newNode;
    return;
  }
  const walk = (n) => {
    if (!n || n.type !== 'split') return false;
    for (const k of ['a', 'b']) {
      if (n[k] === oldNode) {
        n[k] = newNode;
        return true;
      }
      if (walk(n[k])) return true;
    }
    return false;
  };
  walk(ws.root);
}

function panesIn(node, out = []) {
  if (!node) return out;
  if (node.type === 'pane') out.push(node.pane);
  else {
    panesIn(node.a, out);
    panesIn(node.b, out);
  }
  return out;
}

const wsOf = (pane) => workspaces.find((ws) => locate(ws.root, pane));

function welcome() {
  const m = MAC ? '⌘' : 'Ctrl+Shift+';
  const keys = [
    [`${m}N`, 'New local terminal'],
    [`${m}P`, 'Connect to a host'],
    [MAC ? '⌘D' : 'Ctrl+Shift+E', 'Split right'],
    [MAC ? '⇧⌘D' : 'Ctrl+Shift+O', 'Split down'],
    [`${m}J`, 'Jump to the next agent that needs you'],
    [`${m}T`, 'New workspace'],
  ];
  return h('div', { class: 'welcome' },
    h('h1', null, 'Switchyard'),
    h('p', null, 'Terminals on every server in one window, with an editor, VNC and RDP beside them. Panes running a coding agent show when it is working, finished, or waiting on you.'),
    h('div', { class: 'btns' },
      h('button', { class: 'btn primary', onclick: () => openTerminal('local') }, icon('terminal'), 'Local terminal'),
      h('button', { class: 'btn', onclick: () => hostDialog() }, icon('plus'), 'Add host'),
      h('button', { class: 'btn', onclick: importSshConfig }, icon('import'), 'Import ~/.ssh/config')
    ),
    h('div', { class: 'keys' }, keys.map(([k, d]) => [h('kbd', null, k), h('span', null, d)]))
  );
}

function renderWs(ws) {
  const build = (node) => {
    if (node.type === 'pane') return node.pane.el;
    const a = h('div', { class: 'cell' }, build(node.a));
    const b = h('div', { class: 'cell' }, build(node.b));
    const divider = h('div', { class: 'divider' });
    const el = h('div', { class: `split ${node.dir}` }, a, divider, b);
    const apply = () => {
      a.style.flex = `${node.ratio} 1 0`;
      b.style.flex = `${1 - node.ratio} 1 0`;
    };
    apply();
    divider.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const shield = h('div', { style: { position: 'fixed', inset: 0, zIndex: 40, cursor: node.dir === 'row' ? 'col-resize' : 'row-resize' } });
      document.body.append(shield);
      divider.classList.add('dragging');
      const move = (ev) => {
        const r = node.dir === 'row' ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
        node.ratio = Math.min(0.9, Math.max(0.1, r));
        apply();
      };
      const up = () => {
        shield.remove();
        divider.classList.remove('dragging');
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        changed();
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
    divider.addEventListener('dblclick', () => {
      node.ratio = 0.5;
      apply();
      changed();
    });
    return el;
  };
  const content = ws.zoom ? ws.zoom.el : ws.root ? build(ws.root) : welcome();
  ws.el.replaceChildren(content);
  for (const p of panesIn(ws.root)) p.el.classList.toggle('focused', p === ws.focused);
  requestAnimationFrame(() => {
    for (const p of panesIn(ws.root)) p.layout();
  });
}

function newWorkspace(name) {
  const ws = { id: ++wsSeq, name: name || `Workspace ${workspaces.length + 1}`, root: null, focused: null, zoom: null, el: h('div', { class: 'ws inactive' }) };
  workspaces.push(ws);
  $('stage').append(ws.el);
  renderWs(ws);
  return ws;
}

function activateWs(ws, { focus = true } = {}) {
  if (!ws) return;
  active = ws;
  for (const w of workspaces) w.el.classList.toggle('inactive', w !== ws);
  renderTabs();
  renderPaneList();
  if (ws.focused) {
    if (focus) ws.focused.focus();
    ack(ws.focused);
    requestAnimationFrame(() => panesIn(ws.root).forEach((p) => p.layout()));
  }
  changed();
}

async function closeWorkspace(ws) {
  const list = panesIn(ws.root);
  const terms = list.filter((p) => p.kind === 'term' && p.meta.status === 'open');
  if (terms.length) {
    const ok = await confirm({ title: `Close ${ws.name}?`, message: `${terms.length} running terminal${terms.length === 1 ? '' : 's'} will be closed, including any remote tmux sessions behind them.`, ok: 'Close', danger: true });
    if (!ok) return;
  }
  for (const p of list) {
    if (p.kind === 'editor' && !(await p.canClose())) return;
  }
  ws.closing = true;
  for (const p of list) {
    if (p.kind === 'term') sy.invoke('session.close', p.id, { kill: true });
    detachPane(p);
  }
  dropWorkspace(ws);
}

function dropWorkspace(ws) {
  const i = workspaces.indexOf(ws);
  if (i < 0) return;
  workspaces.splice(i, 1);
  ws.el.remove();
  if (!workspaces.length) newWorkspace();
  if (active === ws) activateWs(workspaces[Math.min(i, workspaces.length - 1)]);
  else renderTabs();
  changed();
}

function addPane(pane, { split = 'auto', ws, target, focus = true } = {}) {
  panes.set(pane.id, pane);
  if (split === 'tab' && active && active.root) ws = newWorkspace(pane.kind === 'vnc' ? hostName(pane.hostId) : undefined);
  ws = ws || active || newWorkspace();
  const leaf = { type: 'pane', pane };
  if (!ws.root) {
    ws.root = leaf;
  } else {
    const t = target || ws.focused || panesIn(ws.root)[0];
    const loc = locate(ws.root, t);
    let dir = split === 'down' ? 'col' : 'row';
    if (split === 'auto') {
      const r = t.el.getBoundingClientRect();
      dir = r.width >= r.height * 1.5 || !r.width ? 'row' : 'col';
    }
    replaceNode(ws, loc.node, { type: 'split', dir, ratio: 0.5, a: loc.node, b: leaf });
  }
  ws.zoom = null;
  if (!ws.focused) ws.focused = pane;
  renderWs(ws);
  if (focus || ws !== active) {
    if (ws !== active && focus) activateWs(ws, { focus: false });
    if (focus) focusPane(pane);
  } else if (ws.focused) {
    ws.focused.focus();
  }
  renderPaneList();
  renderTabs();
  changed();
  return pane;
}

// Removes a pane from the layout and disposes its view. Does not end its session.
function detachPane(pane) {
  if (!panes.has(pane.id)) return;
  panes.delete(pane.id);
  attention.delete(pane.id);
  const ws = wsOf(pane);
  if (ws) {
    const loc = locate(ws.root, pane);
    if (!loc.parent) ws.root = null;
    else replaceNode(ws, loc.parent, loc.parent[loc.key === 'a' ? 'b' : 'a']);
    if (ws.zoom === pane) ws.zoom = null;
    if (ws.focused === pane) ws.focused = panesIn(ws.root)[0] || null;
  }
  pane.dispose();
  if (!ws || ws.closing) return;
  if (!ws.root && workspaces.length > 1) {
    dropWorkspace(ws);
  } else {
    renderWs(ws);
    if (ws === active && ws.focused) focusPane(ws.focused);
  }
  renderPaneList();
  renderTabs();
  changed();
}

async function closePane(pane, { detach = false } = {}) {
  if (!pane) return;
  if (pane.kind === 'term') {
    await sy.invoke('session.close', pane.id, { kill: !detach });
    detachPane(pane);
    if (detach && pane.meta.tmux) toast(`Detached. tmux session ${pane.meta.tmux} keeps running on ${hostName(pane.hostId)}.`);
  } else if (pane.kind === 'editor') {
    if (await pane.canClose()) detachPane(pane);
  } else {
    detachPane(pane);
  }
}

function ack(pane) {
  if (pane && pane.kind === 'term' && pane.meta.agent.attention && windowFocused) sy.invoke('session.ack', pane.id);
}

function focusPane(pane, doFocus = true) {
  if (!pane || !panes.has(pane.id)) return;
  const ws = wsOf(pane);
  if (!ws) return;
  if (ws !== active) activateWs(ws, { focus: false });
  const moved = ws.focused !== pane;
  ws.focused = pane;
  if (ws.zoom && ws.zoom !== pane) {
    ws.zoom = pane;
    renderWs(ws);
  }
  for (const p of panesIn(ws.root)) p.el.classList.toggle('focused', p === pane);
  if (doFocus) pane.focus();
  ack(pane);
  if (moved) {
    renderPaneList();
    changed();
  }
}

function toggleZoom(pane = active && active.focused) {
  if (!pane) return;
  const ws = wsOf(pane);
  ws.zoom = ws.zoom ? null : pane;
  ws.focused = pane;
  renderWs(ws);
  pane.focus();
}

function focusDir(dir) {
  const ws = active;
  if (!ws || !ws.focused || ws.zoom) return;
  const from = ws.focused.el.getBoundingClientRect();
  let best = null;
  let bestScore = Infinity;
  for (const p of panesIn(ws.root)) {
    if (p === ws.focused) continue;
    const r = p.el.getBoundingClientRect();
    const horizontal = dir === 'left' || dir === 'right';
    const ahead = dir === 'left' ? from.left - r.right : dir === 'right' ? r.left - from.right : dir === 'up' ? from.top - r.bottom : r.top - from.bottom;
    if (ahead < -2) continue;
    const overlap = horizontal ? Math.min(from.bottom, r.bottom) - Math.max(from.top, r.top) : Math.min(from.right, r.right) - Math.max(from.left, r.left);
    const score = ahead + (overlap > 0 ? 0 : 10000) - overlap / 1000;
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  if (best) focusPane(best);
}

function nextAttention() {
  const order = workspaces.flatMap((ws) => panesIn(ws.root)).filter((p) => p.kind === 'term');
  const want = (p) => p.meta.agent.attention;
  const cur = active && active.focused ? order.indexOf(active.focused) : -1;
  const rotated = [...order.slice(cur + 1), ...order.slice(0, cur + 1)];
  const next = rotated.find((p) => want(p) === 'waiting') || rotated.find(want);
  if (next) focusPane(next);
  else toast('No agent needs attention', '', 1800);
}

// ---------- opening things ----------

async function openTerminal(hostId, opts = {}) {
  try {
    const meta = await sy.invoke('session.create', { hostId, cwd: opts.cwd, command: opts.command, tmux: opts.tmux, label: opts.label, cols: 100, rows: 30 });
    return addPane(new TermPane(meta), { split: opts.split || 'auto', target: opts.target });
  } catch (err) {
    fail(err);
  }
}

async function openFile(hostId, path, { side = false, line } = {}) {
  let pane = !side && active ? (active.focused && active.focused.kind === 'editor' ? active.focused : panesIn(active.root).find((p) => p.kind === 'editor')) : null;
  let created = false;
  if (!pane) {
    pane = new EditorPane();
    created = true;
    addPane(pane, { split: 'auto' });
  }
  try {
    await pane.open(hostId, path, { line });
    focusPane(pane);
  } catch (err) {
    if (created && !pane.tabs.length) detachPane(pane);
    throw err;
  }
}

function openVnc(hostId) {
  addPane(new VncPane(hostId), { split: 'tab' });
}

async function openRdp(hostId) {
  try {
    await sy.invoke('rdp.open', hostId);
    toast(`RDP session to ${hostName(hostId)} opened in FreeRDP`, 'ok', 2500);
  } catch (err) {
    fail(err);
  }
}

function openPrimary(host) {
  if (host.local || host.ssh.enabled) return openTerminal(host.id);
  if (host.vnc.enabled) return openVnc(host.id);
  if (host.rdp.enabled) return openRdp(host.id);
}

function browseFiles(hostId, dir) {
  setSideView('files');
  document.body.classList.remove('no-sidebar');
  showFiles(hostId, dir);
}

function splitFrom(pane, dir) {
  focusPane(pane, false);
  if (pane.kind === 'term') return openTerminal(pane.hostId, { split: dir, target: pane, cwd: pane.meta.cwd });
  if (pane.kind === 'editor') {
    const p = addPane(new EditorPane(), { split: dir, target: pane });
    if (pane.active) p.open(pane.active.doc.hostId, pane.active.doc.path).catch(fail);
    return p;
  }
  return openTerminal('local', { split: dir, target: pane });
}

// ---------- sidebar ----------

async function reloadHosts() {
  ctx.hosts = await sy.invoke('hosts.list');
  ctx.connected = new Set(await sy.invoke('ssh.connected'));
  renderHosts();
  renderFileHosts();
  for (const p of panes.values()) if (p.kind === 'term') p.update(p.meta);
  renderPaneList();
}

function hostMenu(ev, host, row) {
  const sshOn = host.local || host.ssh.enabled;
  const attached = new Set([...panes.values()].filter((p) => p.kind === 'term' && p.hostId === host.id && p.meta.tmux).map((p) => p.meta.tmux));
  contextMenu(ev, [
    sshOn ? { label: 'New Terminal', run: () => openTerminal(host.id) } : null,
    sshOn ? { label: 'New Terminal in New Workspace', run: () => openTerminal(host.id, { split: 'tab' }) } : null,
    !host.local && sshOn ? { label: 'Attach tmux Session…', run: () => tmuxDialog(host, attached) } : null,
    sshOn ? { label: 'Browse Files', run: () => browseFiles(host.id) } : null,
    !host.local && host.vnc.enabled ? { label: 'Open VNC', run: () => openVnc(host.id) } : null,
    !host.local && host.rdp.enabled ? { label: 'Open RDP', run: () => openRdp(host.id) } : null,
    host.local ? null : '-',
    host.local ? null : { label: 'Edit…', run: () => hostDialog(host) },
    host.local ? null : { label: 'Duplicate', run: () => hostDialog({ ...host, id: undefined, name: `${host.name} copy`, secrets: {} }) },
    !host.local && ctx.connected.has(host.id) ? { label: 'Disconnect SSH', run: () => sy.invoke('ssh.disconnect', host.id) } : null,
  ], row);
}

function renderHosts() {
  const list = $('host-list');
  const groups = new Map();
  for (const x of ctx.hosts) {
    const g = x.local ? '' : x.group || '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(x);
  }
  const names = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  const rows = [];
  for (const g of names) {
    if (g) rows.push(h('div', { class: 'group-label' }, g));
    for (const x of groups.get(g).sort((a, b) => (a.local ? -1 : b.local ? 1 : a.name.localeCompare(b.name)))) {
      const sshOn = x.local || x.ssh.enabled;
      const row = h('div', {
        class: `host ${x.local || ctx.connected.has(x.id) ? 'up' : ''}`,
        title: x.local ? 'This machine' : `${x.address}${sshOn ? `\nssh ${x.ssh.user ? `${x.ssh.user}@` : ''}${x.address}:${x.ssh.port}` : ''}`,
        onclick: () => openPrimary(x),
        oncontextmenu: (e) => hostMenu(e, x, e.currentTarget),
      },
        h('span', { class: 'dot' }),
        h('span', { class: 'name' }, x.name),
        h('span', { class: 'addr' }, x.local ? '' : x.address),
        h('span', { class: 'acts' },
          sshOn ? iconBtn('terminal', 'New terminal', () => openTerminal(x.id)) : null,
          sshOn ? iconBtn('folder', 'Browse files', () => browseFiles(x.id)) : null,
          !x.local && x.vnc.enabled ? iconBtn('monitor', 'VNC', () => openVnc(x.id)) : null,
          !x.local && x.rdp.enabled ? iconBtn('windows', 'RDP', () => openRdp(x.id)) : null,
          !x.local ? iconBtn('edit', 'Edit host', () => hostDialog(x)) : null
        )
      );
      rows.push(row);
    }
  }
  if (ctx.hosts.length <= 1) {
    rows.push(h('div', { class: 'side-empty' }, 'No servers yet. ', h('a', { onclick: () => hostDialog() }, 'Add a host'), ' or ', h('a', { onclick: importSshConfig }, 'import ~/.ssh/config'), '.'));
  }
  list.replaceChildren(...rows);
}

const renderPaneList = debounce(() => {
  const rows = [];
  let waiting = 0;
  let working = 0;
  for (const ws of workspaces) {
    const list = panesIn(ws.root);
    if (!list.length) continue;
    if (workspaces.length > 1) rows.push(h('div', { class: 'ws-label' }, ws.name));
    for (const p of list) {
      let dot = 'idle';
      let title = '';
      let state = '';
      let stateCls = '';
      if (p.kind === 'term') {
        dot = agentState(p.meta);
        title = paneTitle(p.meta);
        if (p.meta.agent.kind) {
          state = `${p.meta.agent.kind} · ${dot === 'waiting' ? 'needs input' : dot}`;
          stateCls = `st-${dot}`;
          if (dot === 'waiting') waiting++;
          if (dot === 'working') working++;
        } else if (p.meta.status !== 'open') {
          state = p.meta.status;
        }
      } else if (p.kind === 'editor') {
        dot = 'shell';
        title = p.active ? baseName(p.active.doc.path) : 'editor';
        state = 'editor';
      } else {
        dot = p.status === 'open' ? 'done' : p.status === 'connecting' ? 'working' : 'off';
        title = p.desktop || 'desktop';
        state = 'vnc';
      }
      const hostLabel = p.kind === 'editor' ? (p.active ? hostName(p.active.doc.hostId) : '') : hostName(p.hostId);
      rows.push(
        h('div', {
          class: `prow ${ws === active && ws.focused === p ? 'focused' : ''}`,
          onmousedown: (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            focusPane(p);
          },
          oncontextmenu: (e) =>
            contextMenu(e, [
              { label: 'Focus', run: () => focusPane(p) },
              p.kind === 'term' && p.meta.tmux ? { label: 'Detach (keep tmux session)', run: () => closePane(p, { detach: true }) } : null,
              { label: 'Close', danger: true, run: () => closePane(p) },
            ], e.currentTarget),
        },
          h('span', { class: `sdot ${dot}` }),
          h('span', { class: 'ptitle' }, hostLabel ? h('span', { class: 'phost' }, `${hostLabel} · `) : null, title),
          h('span', { class: `pstate ${stateCls}` }, state),
          p.kind === 'term' ? h('span', { class: 'pid' }, p.id) : null
        )
      );
    }
  }
  if (!rows.length) rows.push(h('div', { class: 'side-empty' }, 'No open panes.'));
  $('pane-list').replaceChildren(...rows);
  $('pane-count').textContent = [waiting ? `${waiting} need input` : '', working ? `${working} working` : ''].filter(Boolean).join(' · ');
  $('pane-count').className = `side-count ${waiting ? 'st-waiting' : working ? 'st-working' : ''}`;
}, 30);

const renderTabs = debounce(() => {
  $('tabs').replaceChildren(
    ...workspaces.map((ws, i) => {
      const states = panesIn(ws.root).filter((p) => p.kind === 'term').map((p) => agentState(p.meta));
      const agg = ['waiting', 'done', 'working'].find((s) => states.includes(s));
      const name = h('span', { class: 'tname' }, ws.name);
      const rename = () => {
        const input = h('input', { value: ws.name });
        const commit = () => {
          ws.name = input.value.trim() || ws.name;
          renderTabs();
          renderPaneList();
          changed();
        };
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter' || e.key === 'Escape') input.blur();
        });
        input.addEventListener('blur', commit);
        name.replaceWith(input);
        input.select();
      };
      return h('div', {
        class: `tab ${ws === active ? 'active' : ''}`,
        title: `${ws.name}${i < 9 ? `  (${MAC ? '⌘' : 'Alt+'}${i + 1})` : ''}`,
        onclick: () => ws !== active && activateWs(ws),
        ondblclick: rename,
        onauxclick: (e) => e.button === 1 && closeWorkspace(ws),
        oncontextmenu: (e) => contextMenu(e, [{ label: 'Rename', run: rename }, { label: 'Close Workspace', danger: true, run: () => closeWorkspace(ws) }]),
      },
        agg ? h('span', { class: `sdot ${agg}` }) : null,
        name,
        h('span', { class: 'tclose', onclick: (e) => { e.stopPropagation(); closeWorkspace(ws); } }, icon('x'))
      );
    })
  );
}, 20);

function setSideView(view) {
  sideView = view;
  for (const b of $('side-tabs').children) b.classList.toggle('active', b.dataset.view === view);
  $('view-sessions').hidden = view !== 'sessions';
  $('view-files').hidden = view !== 'files';
  if (view === 'files') showFiles();
  changed();
}

// ---------- persistence ----------

function snapshot() {
  const ser = (node) => {
    if (!node) return null;
    if (node.type === 'pane') return node.pane.serialize();
    const a = ser(node.a);
    const b = ser(node.b);
    if (!a || !b) return a || b;
    return { split: node.dir, ratio: node.ratio, a, b };
  };
  return {
    v: 1,
    sidebar: { width: $('sidebar').offsetWidth || undefined, hidden: document.body.classList.contains('no-sidebar'), view: sideView },
    filesRoot: localRoot(),
    active: workspaces.indexOf(active),
    workspaces: workspaces.map((ws) => ({ name: ws.name, tree: ser(ws.root) })),
  };
}

const save = () => {
  if (!restoring) sy.send('state.save', snapshot());
};
const changed = debounce(save, 400);

async function restore() {
  const st = await sy.invoke('state.load');
  const live = new Map((await sy.invoke('session.list')).map((m) => [m.id, m]));
  if (st && st.sidebar) {
    if (st.sidebar.width) $('sidebar').style.width = `${Math.min(600, Math.max(180, st.sidebar.width))}px`;
    document.body.classList.toggle('no-sidebar', !!st.sidebar.hidden);
  }

  const build = async (node) => {
    if (!node) return null;
    if (node.split) {
      const a = await build(node.a);
      const b = await build(node.b);
      if (!a || !b) return a || b;
      return { type: 'split', dir: node.split === 'col' ? 'col' : 'row', ratio: Math.min(0.9, Math.max(0.1, Number(node.ratio) || 0.5)), a, b };
    }
    let pane = null;
    try {
      pane = await buildPane(node);
    } catch {}
    if (!pane) return null;
    panes.set(pane.id, pane);
    return { type: 'pane', pane };
  };

  const buildPane = async (node) => {
    let pane = null;
    if (node.kind === 'term') {
      let meta = live.get(node.sid);
      if (meta) live.delete(node.sid);
      else if (node.hostId === 'local') meta = await sy.invoke('session.create', { hostId: 'local', cwd: node.cwd, label: node.label, cols: 100, rows: 30 });
      else if (ctx.hosts.some((x) => x.id === node.hostId)) meta = await sy.invoke('session.create', { hostId: node.hostId, tmux: node.tmux, cwd: node.cwd, label: node.label, dormant: true, cols: 100, rows: 30 });
      if (meta) pane = new TermPane(meta);
    } else if (node.kind === 'editor' && node.files && node.files.length) {
      pane = new EditorPane();
      const ed = pane;
      (async () => {
        for (const f of node.files) await ed.open('local', f).catch(() => {});
        if (node.active) await ed.open('local', node.active).catch(() => {});
      })();
    }
    return pane;
  };

  for (const w of (st && st.workspaces) || []) {
    const root = w.tree ? await build(w.tree).catch(() => null) : null;
    if (!root) continue;
    const ws = newWorkspace(w.name);
    ws.root = root;
    ws.focused = panesIn(ws.root)[0] || null;
    renderWs(ws);
  }
  if (!workspaces.length) newWorkspace();
  activateWs(workspaces[Math.min(Math.max(0, (st && st.active) || 0), workspaces.length - 1)]);
  for (const meta of live.values()) addPane(new TermPane(meta), { focus: false });
  if (st && st.sidebar && st.sidebar.view === 'files') setSideView('files');
  if (st && st.filesRoot && sideView === 'files') showFiles('local', st.filesRoot);
  restoring = false;
  renderPaneList();
  renderTabs();
}

// ---------- events from main ----------

function notify(pane, meta) {
  const what = meta.agent.attention === 'waiting' ? 'needs your input' : 'finished';
  try {
    const n = new Notification(`${meta.agent.kind || 'Agent'} ${what}`, { body: `${hostName(meta.hostId)} · ${paneTitle(meta)}`, silent: meta.agent.attention !== 'waiting' });
    n.onclick = () => {
      sy.send('ui.focusWindow');
      focusPane(pane);
    };
  } catch {}
}

sy.on('session:data', (id, data) => {
  const p = panes.get(id);
  if (p) p.onData(data);
});

sy.on('session:meta', (meta) => {
  const pane = panes.get(meta.id);
  if (!pane) return;
  const layoutChanged = pane.meta.tmux !== meta.tmux || pane.meta.status !== meta.status;
  pane.update(meta);
  const prev = attention.get(meta.id) || null;
  const cur = meta.agent.attention;
  attention.set(meta.id, cur);
  if (cur && cur !== prev) {
    const watching = windowFocused && active && active.focused === pane;
    if (watching) sy.invoke('session.ack', meta.id);
    else notify(pane, meta);
  }
  renderPaneList();
  renderTabs();
  if (layoutChanged && !restoring) changed();
});

sy.on('session:removed', (id) => {
  const p = panes.get(id);
  if (p) detachPane(p);
});

sy.on('pane:adopt', (meta, opts) => {
  if (panes.has(meta.id)) return;
  const empty = !active || !active.root;
  addPane(new TermPane(meta), { split: (opts && opts.split) || 'auto', focus: empty || !!(opts && opts.focus) });
});
sy.on('pane:focus', (id) => {
  sy.send('ui.focusWindow');
  focusPane(panes.get(id));
});
sy.on('file:open', (hostId, path) => openFile(hostId, path).catch(fail));
sy.on('vnc:adopt', (hostId) => openVnc(hostId));
sy.on('rdp:event', (info) => {
  if (info.error) toast(`RDP ${info.host}: ${info.error}`, 'error');
});
sy.on('ssh:status', (hostId, up) => {
  if (up) ctx.connected.add(hostId);
  else ctx.connected.delete(hostId);
  renderHosts();
});
sy.on('ui:prompt', async (req) => {
  const v = await ask({ title: req.title, label: req.label, password: req.password, ok: 'Continue' });
  sy.send('ui.promptReply', req.id, v || '');
});
sy.on('window:focus', (f) => {
  windowFocused = f;
  if (f && active) ack(active.focused);
});
sy.on('app:closing', async () => {
  sy.send('ui.closeAck');
  if (anyDirty()) {
    const ok = await confirm({ title: 'Quit with unsaved changes?', message: 'Some files in the editor have changes that were not saved.', ok: 'Quit Anyway', danger: true });
    if (!ok) return;
  }
  restoring = false;
  sy.send('state.save', snapshot());
  sy.send('ui.closeOk');
});

const commands = {
  'new-local': () => openTerminal('local'),
  'new-workspace': () => activateWs(newWorkspace()),
  palette: () => palette(),
  'new-host': () => hostDialog(),
  'import-ssh': () => importSshConfig(),
  save: () => active && active.focused && active.focused.kind === 'editor' && active.focused.save(),
  'close-pane': () => {
    if (active && active.focused) closePane(active.focused);
    else if (active && workspaces.length > 1) closeWorkspace(active);
  },
  'detach-pane': () => active && active.focused && closePane(active.focused, { detach: true }),
  'toggle-sidebar': () => {
    document.body.classList.toggle('no-sidebar');
    changed();
  },
  'view-sessions': () => {
    document.body.classList.remove('no-sidebar');
    setSideView('sessions');
  },
  'view-files': () => {
    document.body.classList.remove('no-sidebar');
    const f = active && active.focused;
    setSideView('files');
    if (f && f.kind === 'term' && f.hostId !== currentFilesHost() && ctx.connected.has(f.hostId)) showFiles(f.hostId);
  },
  'split-right': () => (active && active.focused ? splitFrom(active.focused, 'right') : openTerminal('local')),
  'split-down': () => (active && active.focused ? splitFrom(active.focused, 'down') : openTerminal('local')),
  zoom: () => toggleZoom(),
  'focus-left': () => focusDir('left'),
  'focus-right': () => focusDir('right'),
  'focus-up': () => focusDir('up'),
  'focus-down': () => focusDir('down'),
  'next-attention': nextAttention,
  'next-workspace': () => activateWs(workspaces[(workspaces.indexOf(active) + 1) % workspaces.length]),
  'prev-workspace': () => activateWs(workspaces[(workspaces.indexOf(active) - 1 + workspaces.length) % workspaces.length]),
};
sy.on('menu', (name) => {
  const fn = commands[name];
  if (fn) Promise.resolve().then(fn).catch(fail);
});

addEventListener('keydown', (e) => {
  const mod = MAC ? e.metaKey && !e.ctrlKey && !e.altKey : e.altKey && !e.ctrlKey && !e.metaKey;
  if (mod && /^[1-9]$/.test(e.key) && workspaces[Number(e.key) - 1]) {
    e.preventDefault();
    e.stopPropagation();
    activateWs(workspaces[Number(e.key) - 1]);
  }
}, true);

// ---------- boot ----------

const refresh = () => {
  renderPaneList();
  renderTabs();
  changed();
};
Object.assign(ctx, { commands, focusPane, toggleZoom, splitFrom, closePane, changed: refresh, openTerminal, openFile, openPrimary, reloadHosts });

$('tab-add').append(icon('plus'));
$('tab-add').addEventListener('click', () => activateWs(newWorkspace()));
$('host-actions').append(iconBtn('import', 'Import ~/.ssh/config', importSshConfig), iconBtn('plus', 'New host', () => hostDialog()));
for (const b of $('side-tabs').children) b.addEventListener('click', () => setSideView(b.dataset.view));
initFiles($('view-files'));

$('side-resizer').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const shield = h('div', { style: { position: 'fixed', inset: 0, zIndex: 40, cursor: 'col-resize' } });
  document.body.append(shield);
  const move = (ev) => {
    $('sidebar').style.width = `${Math.min(600, Math.max(180, ev.clientX))}px`;
  };
  const up = () => {
    shield.remove();
    removeEventListener('mousemove', move);
    removeEventListener('mouseup', up);
    changed();
  };
  addEventListener('mousemove', move);
  addEventListener('mouseup', up);
});

(async () => {
  try {
    ctx.info = await sy.invoke('app.info');
    await reloadHosts();
    await restore();
  } catch (err) {
    restoring = false;
    if (!workspaces.length) activateWs(newWorkspace());
    toast(`Startup problem: ${errMsg(err)}`, 'error');
  }
})();
