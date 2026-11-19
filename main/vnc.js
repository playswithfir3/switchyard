const net = require('net');

// Bridges a VNC TCP stream (direct or through an SSH tunnel) to the renderer over IPC.
// noVNC attaches to a WebSocket-shaped object there, so no local port is opened.
class VncBridge {
  constructor(store, ssh, send) {
    this.store = store;
    this.ssh = ssh;
    this.send = send;
    this.conns = new Map();
  }

  target(host, section) {
    const cfg = host[section];
    if (cfg.via) return { via: cfg.via, addr: cfg.via === host.id ? '127.0.0.1' : host.address, port: cfg.port };
    return { via: '', addr: host.address, port: cfg.port };
  }

  async open(id, hostId) {
    const host = this.store.getHost(hostId);
    if (!host || !host.vnc || !host.vnc.enabled) throw new Error('VNC is not enabled for this host');
    const t = this.target(host, 'vnc');
    let sock;
    if (t.via) {
      sock = await this.ssh.forward(t.via, t.addr, t.port);
    } else {
      sock = await new Promise((resolve, reject) => {
        const s = net.connect({ host: t.addr, port: t.port });
        s.setNoDelay(true);
        s.once('connect', () => resolve(s));
        s.once('error', reject);
        s.setTimeout(15000, () => s.destroy(new Error('Connection timed out')));
      });
      sock.setTimeout(0);
    }
    this.conns.set(id, sock);
    sock.on('data', (d) => this.send('vnc:data', id, d));
    sock.on('error', () => {});
    sock.on('close', () => {
      if (this.conns.get(id) === sock) {
        this.conns.delete(id);
        this.send('vnc:close', id);
      }
    });
    return true;
  }

  write(id, data) {
    const s = this.conns.get(id);
    if (s) s.write(Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength));
  }

  close(id) {
    const s = this.conns.get(id);
    if (!s) return;
    this.conns.delete(id);
    s.destroy();
  }

  closeAll() {
    for (const id of [...this.conns.keys()]) this.close(id);
  }
}

module.exports = { VncBridge };
