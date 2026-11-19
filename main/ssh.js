const fs = require('fs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Client } = require('ssh2');

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

class SshManager extends EventEmitter {
  constructor(store, ui) {
    super();
    this.store = store;
    this.ui = ui;
    this.hosts = new Map();
  }

  entry(hostId) {
    let e = this.hosts.get(hostId);
    if (!e) {
      e = { clients: [], connecting: null, info: null, sftp: null };
      this.hosts.set(hostId, e);
    }
    return e;
  }

  isConnected(hostId) {
    const e = this.hosts.get(hostId);
    return !!(e && e.clients.length);
  }

  connectedHosts() {
    return [...this.hosts.entries()].filter(([, e]) => e.clients.length).map(([id]) => id);
  }

  async client(hostId) {
    const e = this.entry(hostId);
    if (e.clients.length) return e.clients[0];
    if (!e.connecting) {
      e.connecting = this.connect(hostId).finally(() => {
        e.connecting = null;
      });
    }
    return e.connecting;
  }

  async connect(hostId, depth = 0) {
    const host = this.store.getHost(hostId);
    if (!host || host.local) throw new Error('Unknown host');
    if (!host.ssh.enabled) throw new Error(`SSH is not enabled for ${host.name}`);
    if (depth > 4) throw new Error('Jump host chain too deep');

    const openSock = async () => {
      if (!host.ssh.jump || host.ssh.jump === hostId) return undefined;
      const jump = await this.client(host.ssh.jump);
      return new Promise((res, rej) => {
        jump.forwardOut('127.0.0.1', 0, host.address, host.ssh.port, (err, s) => (err ? rej(err) : res(s)));
      });
    };

    const base = {
      host: host.address,
      port: host.ssh.port,
      username: host.ssh.user || require('os').userInfo().username,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      readyTimeout: 20000,
    };

    let password = await this.store.getSecret(hostId, 'ssh');
    let passphrase = await this.store.getSecret(hostId, 'passphrase');
    let lastErr = null;
    let skipKey = false;
    let agentOnlyTried = false;

    for (let attempt = 0; attempt < 5; attempt++) {
      // A tunnel stream through the jump host is single-use, so each attempt gets its own.
      const cfg = { ...base, sock: await openSock() };
      if (process.env.SSH_AUTH_SOCK && host.ssh.auth !== 'password') cfg.agent = process.env.SSH_AUTH_SOCK;
      if (host.ssh.auth === 'key' && host.ssh.keyPath && !skipKey) {
        try {
          cfg.privateKey = fs.readFileSync(host.ssh.keyPath);
        } catch (err) {
          throw new Error(`Cannot read key ${host.ssh.keyPath}: ${err.message}`);
        }
        if (passphrase) cfg.passphrase = passphrase;
      }
      if (password) {
        cfg.password = password;
        cfg.tryKeyboard = true;
      }
      try {
        const c = await this.tryConnect(hostId, host, cfg, password);
        return c;
      } catch (err) {
        lastErr = err;
        const msg = String(err.message || err);
        const needsPhrase = /passphrase|encrypted private key|bad decrypt|integrity check/i.test(msg);
        // An encrypted key file is often already loaded in the agent (as OpenSSH assumes
        // for IdentityFile); try the agent alone before asking for the passphrase.
        if (needsPhrase && cfg.agent && !agentOnlyTried) {
          agentOnlyTried = true;
          skipKey = true;
          continue;
        }
        if (needsPhrase || (skipKey && err.level === 'client-authentication')) {
          skipKey = false;
          passphrase = await this.ui.prompt({
            title: `Key passphrase — ${host.name}`,
            label: `Passphrase for ${host.ssh.keyPath}`,
            password: true,
          });
          if (!passphrase) throw new Error('Cancelled');
          continue;
        }
        if (err.level === 'client-authentication') {
          password = await this.ui.prompt({
            title: `Password — ${host.name}`,
            label: `${base.username}@${host.address}`,
            password: true,
          });
          if (!password) throw new Error('Authentication cancelled');
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error('Authentication failed');
  }

  tryConnect(hostId, host, cfg, password) {
    return new Promise((resolve, reject) => {
      const c = new Client();
      let settled = false;
      const addr = `${host.address}:${host.ssh.port}`;

      cfg.hostVerifier = (key, cb) => {
        const fp = `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
        const known = this.store.knownKey(addr);
        if (known === fp) return cb(true);
        this.ui
          .confirmHostKey({ host: host.name, addr, fp, changed: !!known, old: known })
          .then((ok) => {
            if (ok) this.store.trustKey(addr, fp);
            cb(ok);
          })
          .catch(() => cb(false));
      };

      c.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
        finish(prompts.map(() => password || ''));
      });
      c.on('ready', async () => {
        settled = true;
        const e = this.entry(hostId);
        e.clients.push(c);
        if (!e.info) e.info = await this.probe(c);
        this.emit('status', hostId, true);
        resolve(c);
      });
      c.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      c.on('close', () => {
        const e = this.entry(hostId);
        e.clients = e.clients.filter((x) => x !== c);
        if (e.sftpClient === c) e.sftp = null;
        if (!e.clients.length) {
          e.info = null;
          e.sftp = null;
          this.emit('status', hostId, false);
        }
        if (!settled) {
          settled = true;
          reject(new Error('Connection closed'));
        }
      });
      try {
        c.connect(cfg);
      } catch (err) {
        settled = true;
        reject(err);
      }
    });
  }

  probe(c) {
    return new Promise((resolve) => {
      const info = { posix: false, tmux: '' };
      const timer = setTimeout(() => resolve(info), 6000);
      // Falls back to a login shell for PATH: on macOS/Homebrew hosts tmux is not on sshd's default PATH.
      const script = 'p=$(command -v tmux 2>/dev/null || "${SHELL:-sh}" -lc "command -v tmux" 2>/dev/null | tail -1); echo "__SY_TMUX=$p"; echo __SY_POSIX';
      c.exec(`sh -c ${shq(script)}`, (err, stream) => {
        if (err) {
          clearTimeout(timer);
          return resolve(info);
        }
        let out = '';
        stream.on('data', (d) => (out += d));
        stream.stderr.on('data', () => {});
        stream.on('close', () => {
          clearTimeout(timer);
          info.posix = out.includes('__SY_POSIX');
          const m = /__SY_TMUX=(\/[^\r\n]*)/.exec(out);
          info.tmux = m ? m[1].trim() : '';
          resolve(info);
        });
      });
    });
  }

  async info(hostId) {
    await this.client(hostId);
    return this.entry(hostId).info || { posix: false, tmux: '' };
  }

  // Runs fn(client) on an existing connection; opens another connection when the
  // server's per-connection channel limit (sshd MaxSessions) is reached.
  async withChannel(hostId, fn) {
    await this.client(hostId);
    const e = this.entry(hostId);
    let lastErr;
    for (const c of [...e.clients]) {
      try {
        return await fn(c);
      } catch (err) {
        lastErr = err;
        if (!/open fail|channel/i.test(String(err.message))) throw err;
      }
    }
    if (e.clients.length >= 4) throw lastErr;
    const c = await this.connect(hostId);
    return fn(c);
  }

  exec(hostId, cmd, { timeout = 8000, quiet = false } = {}) {
    const run = (c) =>
      new Promise((resolve, reject) => {
        c.exec(cmd, (err, stream) => {
          if (err) return reject(err);
          let stdout = '';
          let stderr = '';
          const timer = setTimeout(() => {
            stream.close();
            resolve({ stdout, stderr, code: -1, timedOut: true });
          }, timeout);
          stream.on('data', (d) => (stdout += d));
          stream.stderr.on('data', (d) => (stderr += d));
          stream.on('close', (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, code });
          });
        });
      });
    if (quiet) {
      const e = this.hosts.get(hostId);
      if (!e || !e.clients.length) return Promise.resolve({ stdout: '', stderr: '', code: -1 });
    }
    return this.withChannel(hostId, run);
  }

  openPty(hostId, cmd, pty) {
    return this.withChannel(
      hostId,
      (c) =>
        new Promise((resolve, reject) => {
          const cb = (err, stream) => (err ? reject(err) : resolve({ stream, client: c }));
          if (cmd) c.exec(cmd, { pty }, cb);
          else c.shell(pty, cb);
        })
    );
  }

  async sftp(hostId) {
    const e = this.entry(hostId);
    if (e.sftp) return e.sftp;
    return this.withChannel(
      hostId,
      (c) =>
        new Promise((resolve, reject) => {
          c.sftp((err, sftp) => {
            if (err) return reject(err);
            e.sftp = sftp;
            e.sftpClient = c;
            sftp.on('close', () => {
              if (e.sftp === sftp) e.sftp = null;
            });
            resolve(sftp);
          });
        })
    );
  }

  forward(hostId, dstHost, dstPort) {
    return this.withChannel(
      hostId,
      (c) =>
        new Promise((resolve, reject) => {
          c.forwardOut('127.0.0.1', 0, dstHost, dstPort, (err, s) => (err ? reject(err) : resolve(s)));
        })
    );
  }

  tmuxBin(hostId) {
    const e = this.hosts.get(hostId);
    return shq((e && e.info && e.info.tmux) || 'tmux');
  }

  async tmuxSessions(hostId) {
    await this.client(hostId);
    const r = await this.exec(
      hostId,
      `${this.tmuxBin(hostId)} list-sessions -F '#{session_name}|~|#{session_windows}|~|#{session_attached}|~|#{session_activity}' 2>/dev/null`
    );
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, windows, attached, activity] = l.split('|~|');
        return { name, windows: Number(windows), attached: Number(attached), activity: Number(activity) };
      });
  }

  disconnect(hostId) {
    const e = this.hosts.get(hostId);
    if (!e) return;
    for (const c of [...e.clients]) c.end();
  }

  disconnectAll() {
    for (const id of this.hosts.keys()) this.disconnect(id);
  }
}

module.exports = { SshManager, shq };
