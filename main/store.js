const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.SWITCHYARD_HOME || path.join(os.homedir(), '.switchyard');
const SOCK = process.env.SWITCHYARD_SOCK || (process.platform === 'win32'
  ? `\\\\.\\pipe\\switchyard-${os.userInfo().username}`
  : path.join(DIR, 'control.sock'));

const LOCAL = { id: 'local', name: 'Local', group: '', address: 'localhost', local: true };

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(DIR, 0o700);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  ensureDir();
  const file = path.join(DIR, name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function normalizeHost(h) {
  const ssh = h.ssh || {};
  const vnc = h.vnc || {};
  const rdp = h.rdp || {};
  return {
    id: h.id || crypto.randomBytes(5).toString('hex'),
    name: String(h.name || h.address || 'host').trim(),
    group: String(h.group || '').trim(),
    address: String(h.address || '').trim(),
    ssh: {
      enabled: !!ssh.enabled,
      port: Number(ssh.port) || 22,
      user: String(ssh.user || '').trim(),
      auth: ['agent', 'key', 'password'].includes(ssh.auth) ? ssh.auth : 'agent',
      keyPath: String(ssh.keyPath || '').trim(),
      jump: String(ssh.jump || ''),
      tmux: ssh.tmux !== false,
    },
    vnc: {
      enabled: !!vnc.enabled,
      port: Number(vnc.port) || 5900,
      via: String(vnc.via || ''),
    },
    rdp: {
      enabled: !!rdp.enabled,
      port: Number(rdp.port) || 3389,
      user: String(rdp.user || '').trim(),
      domain: String(rdp.domain || '').trim(),
      via: String(rdp.via || ''),
      extra: String(rdp.extra || '').trim(),
    },
  };
}

class Store {
  constructor() {
    ensureDir();
    this.hosts = readJson('hosts.json', []).map(normalizeHost);
    this.secrets = readJson('secrets.json', {});
    this.known = readJson('known_hosts.json', {});
    this.safeStorage = null;
  }

  setSafeStorage(s) {
    this.safeStorage = s;
  }

  listHosts() {
    return [LOCAL, ...this.hosts.map((h) => ({ ...h, secrets: this.secretFlags(h.id) }))];
  }

  getHost(id) {
    if (id === 'local') return LOCAL;
    return this.hosts.find((h) => h.id === id) || null;
  }

  findHost(ref) {
    if (!ref || ref === 'local') return LOCAL;
    const lc = String(ref).toLowerCase();
    return (
      this.hosts.find((h) => h.id === ref) ||
      this.hosts.find((h) => h.name.toLowerCase() === lc) ||
      this.hosts.find((h) => h.address.toLowerCase() === lc) ||
      null
    );
  }

  async saveHost(host, secrets) {
    const h = normalizeHost(host);
    const i = this.hosts.findIndex((x) => x.id === h.id);
    if (i >= 0) this.hosts[i] = h;
    else this.hosts.push(h);
    writeJson('hosts.json', this.hosts);
    for (const [k, v] of Object.entries(secrets || {})) {
      if (v === null) await this.setSecret(h.id, k, '');
      else if (typeof v === 'string' && v !== '') await this.setSecret(h.id, k, v);
    }
    return h;
  }

  deleteHost(id) {
    this.hosts = this.hosts.filter((h) => h.id !== id);
    for (const h of this.hosts) {
      if (h.ssh.jump === id) h.ssh.jump = '';
      if (h.vnc.via === id) h.vnc.via = '';
      if (h.rdp.via === id) h.rdp.via = '';
    }
    writeJson('hosts.json', this.hosts);
    for (const k of Object.keys(this.secrets)) {
      if (k.startsWith(`${id}:`)) delete this.secrets[k];
    }
    writeJson('secrets.json', this.secrets);
  }

  secretFlags(id) {
    const out = {};
    for (const k of ['ssh', 'passphrase', 'vnc', 'rdp']) out[k] = !!this.secrets[`${id}:${k}`];
    return out;
  }

  // Secrets go through the OS keychain (safeStorage). Only the async API is used,
  // and only when a secret is actually needed: on macOS the first access can raise
  // a Keychain prompt, which must not block the main process or fire at startup.
  async canEncrypt() {
    try {
      return !!this.safeStorage && (await this.safeStorage.isAsyncEncryptionAvailable());
    } catch {
      return false;
    }
  }

  async setSecret(id, kind, value) {
    const key = `${id}:${kind}`;
    if (!value) {
      delete this.secrets[key];
    } else {
      if (!(await this.canEncrypt())) throw new Error('OS keychain encryption is unavailable; secret not saved');
      this.secrets[key] = (await this.safeStorage.encryptStringAsync(value)).toString('base64');
    }
    writeJson('secrets.json', this.secrets);
  }

  async getSecret(id, kind) {
    const v = this.secrets[`${id}:${kind}`];
    if (!v || !this.safeStorage) return '';
    try {
      const r = await this.safeStorage.decryptStringAsync(Buffer.from(v, 'base64'));
      return r.result || '';
    } catch {
      return '';
    }
  }

  knownKey(addr) {
    return this.known[addr] || null;
  }

  trustKey(addr, fp) {
    this.known[addr] = fp;
    writeJson('known_hosts.json', this.known);
  }

  loadState() {
    return readJson('state.json', null);
  }

  saveState(state) {
    writeJson('state.json', state);
  }

  importSshConfig() {
    let text;
    try {
      text = fs.readFileSync(path.join(os.homedir(), '.ssh', 'config'), 'utf8');
    } catch {
      return { added: 0, skipped: 0 };
    }
    const blocks = [];
    let cur = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^(\S+?)(?:\s*=\s*|\s+)(.*)$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const val = m[2].replace(/^"(.*)"$/, '$1').trim();
      if (key === 'host') {
        cur = { patterns: val.split(/\s+/), opts: {} };
        blocks.push(cur);
      } else if (key === 'match') {
        cur = null;
      } else if (cur && !(key in cur.opts)) {
        cur.opts[key] = val;
      }
    }
    const expand = (p) => (p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
    let added = 0;
    let skipped = 0;
    const pending = [];
    for (const b of blocks) {
      for (const alias of b.patterns) {
        if (/[*?!]/.test(alias)) continue;
        if (this.hosts.some((h) => h.name === alias)) {
          skipped++;
          continue;
        }
        const o = b.opts;
        const host = normalizeHost({
          name: alias,
          group: 'ssh config',
          address: o.hostname || alias,
          ssh: {
            enabled: true,
            port: o.port,
            user: o.user || os.userInfo().username,
            auth: o.identityfile ? 'key' : 'agent',
            keyPath: o.identityfile ? expand(o.identityfile) : '',
          },
        });
        this.hosts.push(host);
        pending.push([host, o.proxyjump]);
        added++;
      }
    }
    for (const [host, jump] of pending) {
      if (!jump) continue;
      const first = jump.split(',')[0].replace(/^.*@/, '').replace(/:\d+$/, '');
      const j = this.hosts.find((h) => h.name === first || h.address === first);
      if (j) host.ssh.jump = j.id;
    }
    if (added) writeJson('hosts.json', this.hosts);
    return { added, skipped };
  }
}

module.exports = { Store, DIR, SOCK, LOCAL };
