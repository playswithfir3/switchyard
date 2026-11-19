const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CANDIDATES = ['sdl-freerdp3', 'sdl3-freerdp', 'sdl-freerdp', 'sdl2-freerdp', 'xfreerdp3', 'xfreerdp', 'wlfreerdp3', 'wlfreerdp'];
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/opt/local/bin'];

function findFreerdp() {
  const dirs = [...new Set([...(process.env.PATH || '').split(path.delimiter), ...EXTRA_PATH])].filter(Boolean);
  const ext = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const name of CANDIDATES) {
    for (const d of dirs) {
      for (const e of ext) {
        const f = path.join(d, name + e);
        try {
          fs.accessSync(f, fs.constants.X_OK);
          return f;
        } catch {}
      }
    }
  }
  return null;
}

function majorVersion(bin) {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
    const m = /version (\d+)\./i.exec(`${r.stdout}${r.stderr}`);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

class RdpLauncher {
  constructor(store, ssh, notify) {
    this.store = store;
    this.ssh = ssh;
    this.notify = notify;
    this.children = new Set();
  }

  status() {
    const bin = findFreerdp();
    return { bin, mstsc: process.platform === 'win32' };
  }

  // Local listener that forwards one RDP client through an SSH connection.
  async tunnel(via, addr, port) {
    await this.ssh.client(via);
    const server = net.createServer((sock) => {
      this.ssh
        .forward(via, addr, port)
        .then((ch) => {
          sock.pipe(ch).pipe(sock);
          ch.on('error', () => sock.destroy());
          sock.on('error', () => ch.destroy());
          sock.on('close', () => ch.destroy());
        })
        .catch(() => sock.destroy());
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    return server;
  }

  async open(hostId) {
    const host = this.store.getHost(hostId);
    if (!host || !host.rdp || !host.rdp.enabled) throw new Error('RDP is not enabled for this host');
    const cfg = host.rdp;
    let addr = host.address;
    let port = cfg.port;
    let server = null;
    if (cfg.via) {
      server = await this.tunnel(cfg.via, cfg.via === host.id ? '127.0.0.1' : host.address, cfg.port);
      addr = '127.0.0.1';
      port = server.address().port;
    }

    const bin = findFreerdp();
    const password = await this.store.getSecret(hostId, 'rdp');
    let child;
    if (bin) {
      const args = [`/v:${addr}:${port}`, `/t:${host.name} — Switchyard`, '/dynamic-resolution', '+clipboard', '/cert:tofu'];
      if (cfg.user) args.push(`/u:${cfg.user}`);
      if (cfg.domain) args.push(`/d:${cfg.domain}`);
      args.push(...splitArgs(cfg.extra));
      if (password && majorVersion(bin) >= 3) {
        // Keep the password off the process list: FreeRDP 3 reads its whole argv from stdin.
        child = spawn(bin, ['/args-from:stdin'], { stdio: ['pipe', 'ignore', 'pipe'] });
        child.stdin.end([...args, `/p:${password}`].join('\n') + '\n');
      } else {
        if (password) args.push(`/p:${password}`);
        child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      }
    } else if (process.platform === 'win32') {
      child = spawn('mstsc.exe', [`/v:${addr}:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    } else {
      if (server) server.close();
      const hint = process.platform === 'darwin' ? 'brew install freerdp' : 'install the freerdp package (xfreerdp / sdl-freerdp)';
      throw new Error(`FreeRDP was not found. To enable RDP: ${hint}`);
    }

    let err = '';
    child.stderr.on('data', (d) => {
      err = (err + d).slice(-2000);
    });
    this.children.add(child);
    const started = Date.now();
    child.on('error', (e) => this.notify({ host: host.name, error: e.message }));
    child.on('exit', (code) => {
      this.children.delete(child);
      if (server) server.close();
      // FreeRDP lingers ~15 s before exiting on a failed connect, hence the wide window.
      if (code && Date.now() - started < 45000) {
        const lines = err.split('\n').filter((l) => /ERROR|fail/i.test(l));
        const pick = lines.find((l) => /ERRCONNECT|ERRINFO/.test(l)) || lines.pop() || `FreeRDP exited with code ${code}`;
        const m = /(ERRCONNECT_\w+|ERRINFO_\w+)/.exec(pick);
        const why = m ? m[1].replace(/^ERR(CONNECT|INFO)_/, '').replace(/_/g, ' ').toLowerCase() : pick.replace(/^(\[[^\]]*\]\s*)+(-\s*)?/, '').slice(0, 240);
        this.notify({ host: host.name, error: why });
      } else {
        this.notify({ host: host.name, closed: true });
      }
    });
    return { bin: bin || 'mstsc' };
  }

  closeAll() {
    for (const c of this.children) c.kill();
  }
}

module.exports = { RdpLauncher, findFreerdp };
