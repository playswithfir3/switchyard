const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { detect, basename } = require('./agents');
const { shq } = require('./ssh');
const { SOCK } = require('./store');

let pty = null;
function loadPty() {
  if (!pty) pty = require('node-pty');
  return pty;
}

const KEYS = {
  enter: '\r', return: '\r', esc: '\x1b', escape: '\x1b', tab: '\t', space: ' ', backspace: '\x7f',
  up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  home: '\x1b[H', end: '\x1b[F', pageup: '\x1b[5~', pagedown: '\x1b[6~', delete: '\x1b[3~',
  'shift-tab': '\x1b[Z', 's-tab': '\x1b[Z',
};

function keyToBytes(key) {
  const k = String(key).toLowerCase();
  if (KEYS[k]) return KEYS[k];
  if ([...String(key)].length === 1) return String(key);
  const m = k.match(/^(?:c|ctrl)[-+](.)$/);
  if (m) {
    const ch = m[1].toUpperCase().charCodeAt(0);
    if (ch >= 64 && ch <= 95) return String.fromCharCode(ch - 64);
    if (m[1] === ' ') return '\x00';
  }
  const a = k.match(/^(?:m|alt)[-+](.)$/);
  if (a) return `\x1b${a[1]}`;
  throw new Error(`Unknown key: ${key}`);
}

class Session {
  constructor(mgr, opts) {
    this.mgr = mgr;
    this.id = opts.id;
    this.hostId = opts.hostId || 'local';
    this.cols = opts.cols || 100;
    this.rows = opts.rows || 30;
    this.cwd = opts.cwd || '';
    this.command = opts.command || '';
    this.tmux = opts.tmux || null;
    this.plain = !!opts.plain;
    this.label = opts.label || '';
    this.status = 'dormant';
    this.title = '';
    this.proc = '';
    this.tty = '';
    this.hasProc = false;
    this.agent = { kind: null, state: 'none', attention: null };
    this.idleTicks = 0;
    this.dirty = false;
    this.backend = null;
    this.pending = '';
    this.flushTimer = null;
    this.ranCommand = false;
    this.created = Date.now();
    this.lastOutput = 0;

    this.term = new Terminal({ cols: this.cols, rows: this.rows, scrollback: 5000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.term.onTitleChange((t) => {
      this.title = t;
      this.dirty = true;
      mgr.metaChanged(this);
    });
    this.term.onBell(() => {
      if (this.agent.kind && this.agent.state !== 'working') this.setAttention('waiting');
    });
  }

  meta() {
    return {
      id: this.id,
      hostId: this.hostId,
      status: this.status,
      title: this.title,
      label: this.label,
      tmux: this.tmux,
      proc: this.proc,
      cwd: this.cwd,
      agent: { ...this.agent },
      cols: this.cols,
      rows: this.rows,
    };
  }

  output(data) {
    if (!data) return;
    this.term.write(data);
    this.dirty = true;
    this.lastOutput = Date.now();
    this.pending += data;
    if (!this.flushTimer && !this.holding) this.flushTimer = setTimeout(() => this.flush(), 6);
  }

  note(msg, color = 33) {
    this.output(`\r\n\x1b[${color}m[${msg}]\x1b[0m\r\n`);
  }

  setAttention(a) {
    if (this.agent.attention === a) return;
    this.agent.attention = a;
    this.mgr.metaChanged(this);
  }

  async start() {
    if (this.status === 'open' || this.status === 'connecting') return;
    this.status = 'connecting';
    this.mgr.metaChanged(this);
    try {
      if (this.hostId === 'local') this.startLocal();
      else await this.startSsh();
      this.status = 'open';
      this.mgr.metaChanged(this);
      if (this.command && !this.ranCommand) {
        this.ranCommand = true;
        setTimeout(() => this.write(`${this.command}\r`), 400);
      }
    } catch (err) {
      this.status = 'closed';
      this.backend = null;
      this.note(`${err.message || err} — press Enter to retry`, 31);
      this.mgr.metaChanged(this);
    }
  }

  startLocal() {
    const win = process.platform === 'win32';
    const shell = win ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';
    const args = win ? [] : ['-l'];
    const env = { ...process.env, TERM_PROGRAM: 'Switchyard', SWITCHYARD_PANE: this.id, SWITCHYARD_SOCK: SOCK };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    const p = loadPty().spawn(shell, args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd && require('fs').existsSync(this.cwd) ? this.cwd : os.homedir(),
      env,
    });
    this.hasProc = !win;
    p.onData((d) => this.output(d));
    p.onExit(() => {
      if (this.backend && this.backend.p === p) this.ended(false);
    });
    this.backend = {
      p,
      write: (d) => p.write(d),
      resize: (c, r) => p.resize(c, r),
      kill: () => p.kill(),
      proc: () => p.process,
    };
  }

  async startSsh() {
    const { ssh, store } = this.mgr;
    const host = store.getHost(this.hostId);
    if (!host) throw new Error('Host no longer exists');
    const info = await ssh.info(this.hostId);
    const ptyOpts = { term: 'xterm-256color', cols: this.cols, rows: this.rows };
    const cd = this.cwd ? `cd ${shq(this.cwd)} 2>/dev/null; ` : '';
    let cmd = null;
    let expectTty = false;

    if (!this.plain && info.tmux && (host.ssh.tmux || this.tmux)) {
      if (!this.tmux) this.tmux = `sy-${crypto.randomBytes(3).toString('hex')}`;
      cmd = `sh -c ${shq(`${cd}exec ${shq(info.tmux)} -u new-session -A -s ${shq(this.tmux)} \\; set-option status off \\; set-option mouse on`)}`;
      this.hasProc = true;
    } else if (info.posix) {
      this.tmux = null;
      cmd = `sh -c ${shq(`echo __SY_TTY=$(tty); ${cd}exec "\${SHELL:-/bin/sh}" -l`)}`;
      expectTty = true;
      this.hasProc = true;
    } else {
      this.tmux = null;
      this.hasProc = false;
    }

    const { stream } = await ssh.openPty(this.hostId, cmd, ptyOpts);
    const dec = new StringDecoder('utf8');
    let head = expectTty ? '' : null;
    const onData = (buf) => {
      let s = dec.write(buf);
      if (head !== null) {
        head += s;
        const m = head.match(/__SY_TTY=([^\r\n]*)\r?\n/);
        if (m) {
          this.tty = m[1].replace(/^\/dev\//, '');
          s = head.slice(0, m.index) + head.slice(m.index + m[0].length);
          head = null;
        } else if (head.length > 4096) {
          s = head;
          head = null;
        } else {
          return;
        }
      }
      this.output(s);
    };
    stream.on('data', onData);
    stream.stderr.on('data', onData);
    stream.on('close', (code) => {
      if (this.backend && this.backend.stream === stream) this.ended(code === undefined || code === null);
    });
    this.backend = {
      stream,
      write: (d) => stream.write(d),
      resize: (c, r) => stream.setWindow(r, c, 0, 0),
      kill: () => stream.close(),
      proc: null,
    };
  }

  ended(lost) {
    this.backend = null;
    this.status = 'closed';
    this.proc = '';
    this.agent = { kind: null, state: 'none', attention: null };
    if (lost) {
      this.note('disconnected — press Enter to reconnect');
      this.mgr.metaChanged(this);
    } else {
      this.mgr.remove(this.id, 'exit');
    }
  }

  write(data) {
    if (this.backend) this.backend.write(data);
  }

  resize(cols, rows) {
    cols = Math.max(2, cols | 0);
    rows = Math.max(1, rows | 0);
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.term.resize(cols, rows);
    if (this.backend) {
      try {
        this.backend.resize(cols, rows);
      } catch {}
    }
  }

  screen(lines) {
    const buf = this.term.buffer.active;
    const out = [];
    const start = lines && lines > this.term.rows ? Math.max(0, buf.baseY + this.term.rows - lines) : buf.baseY;
    for (let i = start; i < buf.baseY + this.term.rows; i++) {
      const line = buf.getLine(i);
      out.push(line ? line.translateToString(true) : '');
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return lines ? out.slice(-lines).join('\n') : out.join('\n');
  }

  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.holding || !this.pending) return;
    const chunk = this.pending;
    this.pending = '';
    this.mgr.emit('data', this.id, chunk);
  }

  // Everything emitted before this resolves is in the snapshot; everything after
  // is delivered later, so a renderer can attach without gaps or duplicates.
  async snapshot() {
    this.flush();
    this.holding = true;
    await new Promise((r) => this.term.write('', r));
    const data = this.serializer.serialize({ scrollback: 2000 });
    setTimeout(() => {
      this.holding = false;
      this.flush();
    }, 0);
    return data;
  }

  evaluate() {
    if (this.status !== 'open') return;
    const prev = { kind: this.agent.kind, state: this.agent.state, proc: basename(this.proc) };
    const next = detect(prev, { proc: this.proc, hasProc: this.hasProc, title: this.title, text: this.screen() });
    let state = next.state;

    // Debounce working -> idle so a mid-redraw frame does not read as "done".
    if (prev.state === 'working' && state === 'idle') {
      this.idleTicks++;
      if (this.idleTicks < 2 || Date.now() - this.lastOutput < 1200) state = 'working';
    } else {
      this.idleTicks = 0;
    }

    if (next.kind === prev.kind && state === prev.state) return;
    this.agent.kind = next.kind;
    this.agent.state = state;
    if (!next.kind) this.agent.attention = null;
    else if (state === 'waiting') this.agent.attention = 'waiting';
    else if (state === 'idle' && prev.state === 'working') this.agent.attention = 'done';
    else if (state === 'working') this.agent.attention = null;
    this.mgr.metaChanged(this);
    this.mgr.emit('agent', this.meta(), prev);
  }
}

class SessionManager extends EventEmitter {
  constructor(store, ssh) {
    super();
    this.store = store;
    this.ssh = ssh;
    this.sessions = new Map();
    this.counter = 0;
    this.metaTimers = new Map();
    this.tick = setInterval(() => this.localTick(), 800);
    this.remoteTick = setInterval(() => this.remotePoll(), 3000);
    this.polling = new Set();
  }

  nextId() {
    do {
      this.counter++;
    } while (this.sessions.has(`p${this.counter}`));
    return `p${this.counter}`;
  }

  create(opts) {
    const id = opts.id && !this.sessions.has(opts.id) ? opts.id : this.nextId();
    const m = /^p(\d+)$/.exec(id);
    if (m) this.counter = Math.max(this.counter, Number(m[1]));
    const s = new Session(this, { ...opts, id });
    this.sessions.set(id, s);
    if (!opts.dormant) s.start();
    else s.output('\x1b[2m[not connected — press Enter to connect]\x1b[0m\r\n');
    return s;
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`No such pane: ${id}`);
    return s;
  }

  list() {
    return [...this.sessions.values()].map((s) => s.meta());
  }

  metaChanged(s) {
    if (this.metaTimers.has(s.id)) return;
    this.metaTimers.set(
      s.id,
      setTimeout(() => {
        this.metaTimers.delete(s.id);
        if (this.sessions.has(s.id)) this.emit('meta', s.meta());
      }, 30)
    );
  }

  remove(id, reason) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.term.dispose();
    this.emit('removed', id, reason);
  }

  // kill=true ends the remote tmux session too; kill=false detaches and leaves it running.
  async close(id, { kill = true } = {}) {
    const s = this.sessions.get(id);
    if (!s) return;
    const backend = s.backend;
    s.backend = null;
    if (s.tmux && kill && s.hostId !== 'local' && this.ssh.isConnected(s.hostId)) {
      this.ssh.exec(s.hostId, `${this.ssh.tmuxBin(s.hostId)} kill-session -t ${shq(s.tmux)}`, { quiet: true, timeout: 4000 }).catch(() => {});
    }
    if (backend) {
      try {
        backend.kill();
      } catch {}
    }
    this.remove(id, 'closed');
  }

  localTick() {
    for (const s of this.sessions.values()) {
      if (s.status !== 'open') continue;
      if (s.backend && s.backend.proc) {
        let p = '';
        try {
          p = basename(s.backend.proc());
        } catch {}
        if (p !== s.proc) {
          s.proc = p;
          s.dirty = true;
          this.metaChanged(s);
        }
      }
      if (s.dirty || s.agent.state === 'working') {
        s.dirty = false;
        s.evaluate();
      }
    }
  }

  async remotePoll() {
    const byHost = new Map();
    for (const s of this.sessions.values()) {
      if (s.status !== 'open' || s.hostId === 'local' || !s.hasProc) continue;
      if (!byHost.has(s.hostId)) byHost.set(s.hostId, []);
      byHost.get(s.hostId).push(s);
    }
    for (const [hostId, list] of byHost) {
      if (this.polling.has(hostId)) continue;
      this.polling.add(hostId);
      this.pollHost(hostId, list)
        .catch(() => {})
        .finally(() => this.polling.delete(hostId));
    }
  }

  async pollHost(hostId, list) {
    const parts = [];
    if (list.some((s) => s.tmux)) {
      parts.push(`${this.ssh.tmuxBin(hostId)} list-panes -a -F 'T|~|#{session_name}|~|#{window_active}#{pane_active}|~|#{pane_current_command}' 2>/dev/null`);
    }
    const ttys = list.filter((s) => !s.tmux && /^[\w/]+$/.test(s.tty)).map((s) => s.tty);
    if (ttys.length) parts.push(`ps -o tty=,stat=,comm= -t ${ttys.join(',')} 2>/dev/null`);
    if (!parts.length) return;
    const r = await this.ssh.exec(hostId, `sh -c ${shq(parts.join('; '))}`, { quiet: true, timeout: 5000 });
    const tmux = new Map();
    const fg = new Map();
    for (const line of r.stdout.split('\n')) {
      if (line.startsWith('T|~|')) {
        const [, name, active, cmd] = line.split('|~|');
        if (active === '11' || !tmux.has(name)) tmux.set(name, cmd || '');
      } else {
        const m = line.trim().match(/^(\S+)\s+(\S+)\s+(.+)$/);
        if (m && m[2].includes('+')) {
          const tty = m[1];
          const name = basename(m[3]);
          if (!fg.has(tty)) fg.set(tty, []);
          fg.get(tty).push(name);
        }
      }
    }
    for (const s of list) {
      let p = '';
      if (s.tmux) p = tmux.get(s.tmux) || '';
      else {
        const names = fg.get(s.tty) || fg.get(s.tty.replace(/^tty/, '')) || [];
        p = names[names.length - 1] || '';
      }
      if (p !== s.proc) {
        s.proc = p;
        s.dirty = true;
        this.metaChanged(s);
      }
    }
  }

  async readScrollback(s, lines) {
    if (s.tmux && s.hostId !== 'local' && this.ssh.isConnected(s.hostId)) {
      const r = await this.ssh.exec(s.hostId, `${this.ssh.tmuxBin(s.hostId)} capture-pane -p -J -S -${lines | 0} -t ${shq(s.tmux)}`, { quiet: true });
      if (r.code === 0) return r.stdout.replace(/\n+$/, '').split('\n').slice(-lines).join('\n');
    }
    return s.screen(lines);
  }

  shutdown() {
    clearInterval(this.tick);
    clearInterval(this.remoteTick);
    for (const s of this.sessions.values()) {
      const b = s.backend;
      s.backend = null;
      if (b) {
        try {
          b.kill();
        } catch {}
      }
    }
  }
}

module.exports = { SessionManager, keyToBytes };
