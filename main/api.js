const fs = require('fs');
const net = require('net');
const { keyToBytes } = require('./sessions');
const { SOCK } = require('./store');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Local control API: newline-delimited JSON-RPC on a user-only unix socket
// (named pipe on Windows). bin/sy.js and its MCP mode are the clients.
class ApiServer {
  constructor(ctx) {
    this.ctx = ctx;
    this.server = null;
  }

  start() {
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(SOCK);
      } catch {}
    }
    this.server = net.createServer((sock) => this.onClient(sock));
    this.server.on('error', (err) => console.error('control api:', err.message));
    // Create the socket user-only from the start rather than chmod-ing it afterwards.
    const umask = process.platform === 'win32' ? null : process.umask(0o177);
    this.server.listen(SOCK, () => {
      if (umask !== null) {
        process.umask(umask);
        fs.chmodSync(SOCK, 0o600);
      }
    });
  }

  stop() {
    if (this.server) this.server.close();
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(SOCK);
      } catch {}
    }
  }

  onClient(sock) {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d;
      if (buf.length > 4 * 1024 * 1024) return sock.destroy();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) this.handle(sock, line);
      }
    });
  }

  async handle(sock, line) {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return sock.write(`${JSON.stringify({ id: null, error: 'invalid JSON' })}\n`);
    }
    try {
      const fn = this.methods[req.method];
      if (!fn) throw new Error(`Unknown method: ${req.method}`);
      const result = await fn.call(this, req.params || {});
      if (!sock.destroyed) sock.write(`${JSON.stringify({ id: req.id, result: result ?? null })}\n`);
    } catch (err) {
      if (!sock.destroyed) sock.write(`${JSON.stringify({ id: req.id, error: String(err.message || err) })}\n`);
    }
  }

  host(ref) {
    const h = this.ctx.store.findHost(ref);
    if (!h) throw new Error(`No such host: ${ref}`);
    return h;
  }

  paneInfo(m) {
    const h = this.ctx.store.getHost(m.hostId);
    return {
      pane: m.id,
      host: h ? h.name : m.hostId,
      status: m.status,
      title: m.label || m.title || m.proc || '',
      process: m.proc,
      tmux: m.tmux,
      agent: m.agent.kind,
      state: m.agent.kind ? m.agent.state : null,
      attention: m.agent.attention,
      size: `${m.cols}x${m.rows}`,
    };
  }

  methods = {
    ping() {
      return { app: 'switchyard', version: this.ctx.version, pid: process.pid };
    },

    'hosts.list'() {
      return this.ctx.store.listHosts().map((h) => ({
        id: h.id,
        name: h.name,
        group: h.group || '',
        address: h.address,
        protocols: h.local ? ['local'] : ['ssh', 'vnc', 'rdp'].filter((k) => h[k] && h[k].enabled),
        connected: h.local ? true : this.ctx.ssh.isConnected(h.id),
      }));
    },

    'panes.list'() {
      return this.ctx.sessions.list().map((m) => this.paneInfo(m));
    },

    async 'pane.open'(p) {
      const h = this.host(p.host);
      if (!h.local && !(h.ssh && h.ssh.enabled)) throw new Error(`${h.name} has no SSH configured`);
      const s = this.ctx.sessions.create({
        hostId: h.id,
        cwd: p.cwd,
        command: p.command,
        tmux: p.tmux,
        label: p.label,
        cols: 120,
        rows: 32,
      });
      this.ctx.adoptPane(s.meta(), { split: p.split || 'right', focus: p.focus !== false });
      const deadline = Date.now() + 30000;
      while (s.status === 'connecting' && Date.now() < deadline) await sleep(100);
      // Let the shell print its prompt, so text sent right after is not typed into a half-started shell.
      const settle = Date.now() + 5000;
      while (s.status === 'open' && Date.now() < settle && (!s.lastOutput || Date.now() - s.lastOutput < 300)) await sleep(60);
      return this.paneInfo(s.meta());
    },

    async 'pane.send'(p) {
      const s = this.ctx.sessions.get(p.pane);
      if (s.status !== 'open') throw new Error(`Pane ${s.id} is not connected`);
      if (p.text) s.write(String(p.text));
      if (p.enter !== false) {
        await sleep(p.text ? 80 : 0);
        s.write('\r');
      }
      return { ok: true };
    },

    'pane.keys'(p) {
      const s = this.ctx.sessions.get(p.pane);
      if (s.status !== 'open') throw new Error(`Pane ${s.id} is not connected`);
      const keys = Array.isArray(p.keys) ? p.keys : String(p.keys || '').split(/\s+/).filter(Boolean);
      s.write(keys.map(keyToBytes).join(''));
      return { ok: true };
    },

    async 'pane.read'(p) {
      const s = this.ctx.sessions.get(p.pane);
      const lines = Math.min(Number(p.lines) || 0, 5000);
      const text = p.scrollback ? await this.ctx.sessions.readScrollback(s, lines || 200) : s.screen(lines || undefined);
      return { ...this.paneInfo(s.meta()), text };
    },

    async 'pane.wait'(p) {
      const s = this.ctx.sessions.get(p.pane);
      const timeout = Math.min(Number(p.timeout) || 120, 3600) * 1000;
      const until = p.until || (p.pattern ? 'text' : 'auto');
      if (!['auto', 'idle', 'waiting', 'quiet', 'text'].includes(until)) throw new Error(`Unknown until: ${until}`);
      if (until === 'text' && !p.pattern) throw new Error('until=text needs a pattern');
      const re = p.pattern ? new RegExp(p.pattern, 'm') : null;
      let sawWorking = false;
      const quietMs = Number(p.quiet_ms) || 1500;
      const start = Date.now();
      let timedOut = true;
      await sleep(Math.min(700, timeout));
      while (Date.now() - start < timeout) {
        if (!this.ctx.sessions.sessions.has(s.id) || s.status !== 'open') {
          timedOut = false;
          break;
        }
        const mode = until === 'auto' ? (s.agent.kind ? 'idle' : 'quiet') : until;
        let done = false;
        if (mode === 'text') done = re.test(s.screen());
        else if (mode === 'idle') {
          // An agent takes a moment to show it has started; until it has been seen
          // working, require a longer quiet spell before calling it settled.
          if (s.agent.state === 'working') sawWorking = true;
          done = s.agent.state !== 'working' && Date.now() - s.lastOutput > (sawWorking ? 800 : 2500);
        }
        else if (mode === 'waiting') done = s.agent.state === 'waiting';
        else done = Date.now() - s.lastOutput > quietMs;
        if (done) {
          timedOut = false;
          break;
        }
        await sleep(250);
      }
      const alive = this.ctx.sessions.sessions.has(s.id);
      return { ...this.paneInfo(s.meta()), closed: !alive, timedOut, text: alive ? s.screen(Number(p.lines) || 40) : '' };
    },

    async 'pane.close'(p) {
      const s = this.ctx.sessions.get(p.pane);
      await this.ctx.sessions.close(s.id, { kill: !p.detach });
      return { ok: true };
    },

    'pane.focus'(p) {
      const s = this.ctx.sessions.get(p.pane);
      this.ctx.send('pane:focus', s.id);
      return { ok: true };
    },

    'file.open'(p) {
      const h = this.host(p.host);
      if (!p.path) throw new Error('path is required');
      this.ctx.send('file:open', h.id, p.path);
      return { ok: true };
    },

    async 'remote.open'(p) {
      const h = this.host(p.host);
      if (p.kind === 'rdp') return this.ctx.rdp.open(h.id);
      if (p.kind !== 'vnc') throw new Error('kind must be vnc or rdp');
      if (!h.vnc || !h.vnc.enabled) throw new Error(`${h.name} has no VNC configured`);
      this.ctx.send('vnc:adopt', h.id);
      return { ok: true };
    },

    // Test hook, only with SWITCHYARD_DEBUG=1: evaluate JS in the window.
    async 'app.eval'(p) {
      if (process.env.SWITCHYARD_DEBUG !== '1') throw new Error('Unknown method: app.eval');
      return this.ctx.evalJs(p.code);
    },

    async 'app.screenshot'(p) {
      return this.ctx.screenshot(p.path);
    },
  };
}

module.exports = { ApiServer };
