const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, safeStorage, shell } = require('electron');
const { Store, DIR, SOCK } = require('./store');
const { SshManager } = require('./ssh');
const { SessionManager } = require('./sessions');
const { FsProvider } = require('./fsprov');
const { VncBridge } = require('./vnc');
const { RdpLauncher } = require('./rdp');
const { ApiServer } = require('./api');

const ROOT = path.join(__dirname, '..');
const MAC = process.platform === 'darwin';
const ICON = path.join(ROOT, 'build', 'icon.png');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

app.setName('Switchyard');
app.setPath('userData', path.join(DIR, 'electron'));
protocol.registerSchemesAsPrivileged([
  { scheme: 'sy', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let win = null;
const store = new Store();
const send = (channel, ...args) => {
  if (win && !win.isDestroyed()) win.webContents.send(`sy:${channel}`, ...args);
};

const prompts = new Map();
let promptSeq = 0;
const ui = {
  prompt(opts) {
    if (!win || win.isDestroyed()) return Promise.resolve('');
    return new Promise((resolve) => {
      const id = ++promptSeq;
      prompts.set(id, resolve);
      send('ui:prompt', { id, ...opts });
      win.show();
    });
  },
  async confirmHostKey({ host, addr, fp, changed, old }) {
    const opts = changed
      ? {
          type: 'warning',
          message: `HOST KEY CHANGED for ${host}`,
          detail: `${addr}\n\nStored: ${old}\nOffered: ${fp}\n\nThis can mean the server was rebuilt, or that the connection is being intercepted.`,
          buttons: ['Cancel', 'Trust new key'],
        }
      : {
          type: 'question',
          message: `Trust host key for ${host}?`,
          detail: `${addr}\n${fp}\n\nThis host has not been seen before.`,
          buttons: ['Cancel', 'Trust'],
        };
    const r = await dialog.showMessageBox(win, { ...opts, defaultId: changed ? 0 : 1, cancelId: 0 });
    return r.response === 1;
  },
};

const ssh = new SshManager(store, ui);
const sessions = new SessionManager(store, ssh);
const files = new FsProvider(ssh);
const vnc = new VncBridge(store, ssh, send);
const rdp = new RdpLauncher(store, ssh, (info) => send('rdp:event', info));

async function screenshot(file) {
  if (!win) throw new Error('No window');
  const img = await win.webContents.capturePage();
  const out = file || path.join(DIR, 'screenshot.png');
  await fsp.writeFile(out, img.toPNG());
  return out;
}

const api = new ApiServer({
  store,
  ssh,
  sessions,
  rdp,
  send,
  screenshot,
  evalJs: (code) => win.webContents.executeJavaScript(code, true),
  version: app.getVersion(),
  adoptPane: (meta, opts) => send('pane:adopt', meta, opts),
});

sessions.on('data', (id, data) => send('session:data', id, data));
sessions.on('meta', (meta) => send('session:meta', meta));
sessions.on('removed', (id, reason) => send('session:removed', id, reason));
ssh.on('status', (hostId, up) => send('ssh:status', hostId, up));

function handle(name, fn) {
  ipcMain.handle(`sy:${name}`, async (_e, ...args) => fn(...args));
}

function registerIpc() {
  handle('app.info', async () => ({
    platform: process.platform,
    version: app.getVersion(),
    home: require('os').homedir(),
    sock: SOCK,
    dir: DIR,
    cli: path.join(ROOT, 'bin', 'sy.js').replace('app.asar', 'app.asar.unpacked'),
    encrypt: process.platform === 'linux' ? await store.canEncrypt() : true,
    rdp: rdp.status(),
  }));
  handle('app.openExternal', (url) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
  });

  handle('hosts.list', () => store.listHosts());
  handle('hosts.save', (host, secrets) => store.saveHost(host, secrets));
  handle('hosts.delete', (id) => {
    ssh.disconnect(id);
    store.deleteHost(id);
  });
  handle('hosts.importSshConfig', () => store.importSshConfig());
  handle('hosts.pickKey', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Select private key',
      defaultPath: path.join(require('os').homedir(), '.ssh'),
      properties: ['openFile', 'showHiddenFiles'],
    });
    return r.canceled ? '' : r.filePaths[0];
  });

  handle('session.create', (opts) => sessions.create(opts).meta());
  handle('session.start', (id) => sessions.get(id).start());
  handle('session.list', () => sessions.list());
  handle('session.snapshot', (id) => sessions.get(id).snapshot());
  handle('session.close', (id, opts) => sessions.close(id, opts));
  handle('session.ack', (id) => {
    const s = sessions.sessions.get(id);
    if (s) s.setAttention(null);
  });
  ipcMain.on('sy:session.write', (_e, id, data) => {
    const s = sessions.sessions.get(id);
    if (s) s.write(data);
  });
  ipcMain.on('sy:session.resize', (_e, id, cols, rows) => {
    const s = sessions.sessions.get(id);
    if (s) s.resize(cols, rows);
  });

  handle('ssh.connected', () => ssh.connectedHosts());
  handle('ssh.disconnect', (id) => ssh.disconnect(id));
  handle('ssh.tmuxSessions', (id) => ssh.tmuxSessions(id));

  handle('fs.home', (h) => files.home(h));
  handle('fs.list', (h, dir) => files.list(h, dir));
  handle('fs.read', (h, file) => files.read(h, file));
  handle('fs.write', (h, file, content, opts) => files.write(h, file, content, opts));
  handle('fs.create', (h, file, isDir) => files.create(h, file, isDir));
  handle('fs.rename', (h, from, to) => files.rename(h, from, to));
  handle('fs.remove', async (h, file) => {
    const local = h === 'local';
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      message: `${local ? 'Move' : 'Delete'} ${path.posix.basename(file.replace(/\\/g, '/'))}${local ? ' to the Trash' : ''}?`,
      detail: local ? file : `${file}\n\nThis deletes it on the server and cannot be undone.`,
      buttons: ['Cancel', local ? 'Move to Trash' : 'Delete'],
      defaultId: 0,
      cancelId: 0,
    });
    if (r.response !== 1) return false;
    if (local) await shell.trashItem(file);
    else await files.remove(h, file);
    return true;
  });
  handle('fs.download', async (h, remote) => {
    const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), path.posix.basename(remote)) });
    if (r.canceled) return null;
    await files.download(h, remote, r.filePath);
    return r.filePath;
  });
  handle('fs.upload', async (h, dir, locals) => {
    if (!locals || !locals.length) {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'openDirectory', 'multiSelections'] });
      if (r.canceled) return 0;
      locals = r.filePaths;
    }
    // Never copy a file onto itself, and never replace something without asking.
    locals = locals.filter((l) => h !== 'local' || path.resolve(l) !== path.resolve(files.join(h, dir, path.basename(l))));
    const clash = [];
    for (const l of locals) {
      try {
        await files.stat(h, files.join(h, dir, path.basename(l)));
        clash.push(path.basename(l));
      } catch {}
    }
    if (clash.length) {
      const r = await dialog.showMessageBox(win, {
        type: 'warning',
        message: clash.length === 1 ? `Replace ${clash[0]}?` : `Replace ${clash.length} existing items?`,
        detail: `Already in ${dir}:\n${clash.slice(0, 12).join('\n')}${clash.length > 12 ? '\n…' : ''}`,
        buttons: ['Cancel', 'Replace'],
        defaultId: 0,
        cancelId: 0,
      });
      if (r.response !== 1) return 0;
    }
    if (!locals.length) return 0;
    return files.upload(h, locals, dir);
  });

  handle('vnc.open', (id, hostId) => vnc.open(id, hostId));
  handle('vnc.close', (id) => vnc.close(id));
  handle('vnc.password', (hostId) => store.getSecret(hostId, 'vnc'));
  ipcMain.on('sy:vnc.send', (_e, id, data) => vnc.write(id, data));
  handle('rdp.open', (hostId) => rdp.open(hostId));

  handle('state.load', () => store.loadState());
  ipcMain.on('sy:state.save', (_e, state) => {
    try {
      store.saveState(state);
    } catch {}
  });
  ipcMain.on('sy:ui.promptReply', (_e, id, value) => {
    const resolve = prompts.get(id);
    prompts.delete(id);
    if (resolve) resolve(value || '');
  });
  ipcMain.on('sy:ui.focusWindow', () => {
    if (win) {
      win.show();
      win.focus();
    }
  });
}

function buildMenu() {
  // Off macOS every app shortcut carries Ctrl+Shift, and no menu role keeps its default
  // accelerator: plain Ctrl+A/C/M/Q/S/W/X/Z are terminal keys and must reach the pane.
  const m = MAC ? 'Cmd' : 'Ctrl+Shift';
  const cmd = (label, accelerator, name) => ({ label, accelerator, click: () => send('menu', name) });
  const edit = MAC
    ? [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
    : [
        { role: 'copy', accelerator: 'Ctrl+Shift+C' },
        { role: 'paste', accelerator: 'Ctrl+Shift+V' },
      ];
  const template = [
    ...(MAC ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        cmd('New Local Terminal', `${m}+N`, 'new-local'),
        cmd('New Workspace', `${m}+T`, 'new-workspace'),
        cmd('Connect to Host…', `${m}+P`, 'palette'),
        { type: 'separator' },
        cmd('New Host…', undefined, 'new-host'),
        cmd('Import ~/.ssh/config', undefined, 'import-ssh'),
        { type: 'separator' },
        // Off macOS the editor binds Ctrl+S itself, so it stays free in terminals.
        cmd('Save', MAC ? 'Cmd+S' : undefined, 'save'),
        { type: 'separator' },
        cmd('Close Pane', `${m}+W`, 'close-pane'),
        cmd('Detach Pane (keep tmux session)', `${m}+Alt+W`, 'detach-pane'),
        ...(MAC ? [] : [{ type: 'separator' }, { label: 'Quit', accelerator: 'Ctrl+Shift+Q', click: () => app.quit() }]),
      ],
    },
    { label: 'Edit', submenu: edit },
    {
      label: 'View',
      submenu: [
        cmd('Toggle Sidebar', `${m}+B`, 'toggle-sidebar'),
        cmd('Sessions', MAC ? 'Cmd+Shift+E' : 'Ctrl+Shift+F1', 'view-sessions'),
        cmd('Files', MAC ? 'Cmd+Shift+F' : 'Ctrl+Shift+F2', 'view-files'),
        { type: 'separator' },
        cmd('Split Right', MAC ? 'Cmd+D' : 'Ctrl+Shift+E', 'split-right'),
        cmd('Split Down', MAC ? 'Cmd+Shift+D' : 'Ctrl+Shift+O', 'split-down'),
        cmd('Zoom Pane', `${m}+Enter`, 'zoom'),
        { type: 'separator' },
        cmd('Focus Pane Left', `${m}+Alt+Left`, 'focus-left'),
        cmd('Focus Pane Right', `${m}+Alt+Right`, 'focus-right'),
        cmd('Focus Pane Up', `${m}+Alt+Up`, 'focus-up'),
        cmd('Focus Pane Down', `${m}+Alt+Down`, 'focus-down'),
        cmd('Next Pane Needing Attention', `${m}+J`, 'next-attention'),
        { type: 'separator' },
        cmd('Next Workspace', MAC ? 'Cmd+Shift+]' : 'Ctrl+PageDown', 'next-workspace'),
        cmd('Previous Workspace', MAC ? 'Cmd+Shift+[' : 'Ctrl+PageUp', 'prev-workspace'),
        { type: 'separator' },
        { role: 'resetZoom', accelerator: MAC ? 'Cmd+0' : 'Ctrl+Shift+0' },
        { role: 'zoomIn', accelerator: MAC ? 'Cmd+Plus' : 'Ctrl+Shift+Plus' },
        { role: 'zoomOut', accelerator: MAC ? 'Cmd+-' : 'Ctrl+Shift+-' },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'reload', accelerator: MAC ? 'Cmd+Alt+R' : 'Ctrl+Alt+R' },
        { role: 'toggleDevTools', accelerator: MAC ? 'Cmd+Alt+I' : 'Ctrl+Shift+I' },
      ],
    },
    MAC ? { role: 'windowMenu' } : { label: 'Window', submenu: [{ label: 'Minimize', click: () => win && win.minimize() }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#0f1115',
    ...(MAC ? {} : { icon: ICON }),
    titleBarStyle: MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: MAC ? { x: 14, y: 13 } : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  // The page only needs notifications and the clipboard (OSC 52, VNC paste).
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(['notifications', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('sy://app/')) e.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('focus', () => send('window:focus', true));
  win.on('blur', () => send('window:focus', false));
  // The renderer gets a chance to warn about unsaved editor changes and to save layout.
  let closeOk = false;
  let closeTimer = null;
  win.on('close', (e) => {
    if (closeOk || win.webContents.isCrashed()) return;
    e.preventDefault();
    send('app:closing');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeOk = true;
      if (win) win.close();
    }, 1500);
  });
  ipcMain.removeAllListeners('sy:ui.closeAck');
  ipcMain.removeAllListeners('sy:ui.closeOk');
  ipcMain.on('sy:ui.closeAck', () => clearTimeout(closeTimer));
  ipcMain.on('sy:ui.closeOk', () => {
    closeOk = true;
    if (win) win.close();
  });
  win.on('closed', () => {
    win = null;
  });
  win.loadURL('sy://app/renderer/index.html');
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

app.whenReady().then(() => {
  store.setSafeStorage(safeStorage);
  protocol.handle('sy', async (req) => {
    const u = new URL(req.url);
    let rel;
    try {
      rel = decodeURIComponent(u.pathname);
    } catch {
      return new Response('bad request', { status: 400 });
    }
    const file = path.normalize(path.join(ROOT, rel));
    const allowed = ['renderer', 'node_modules'].some((d) => file.startsWith(path.join(ROOT, d) + path.sep));
    if (u.host !== 'app' || !allowed) return new Response('forbidden', { status: 403 });
    try {
      const body = await fsp.readFile(file);
      return new Response(body, { headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
  if (MAC && !app.isPackaged && fs.existsSync(ICON)) app.dock.setIcon(ICON);
  registerIpc();
  buildMenu();
  createWindow();
  api.start();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  api.stop();
  vnc.closeAll();
  rdp.closeAll();
  sessions.shutdown();
  ssh.disconnectAll();
});
