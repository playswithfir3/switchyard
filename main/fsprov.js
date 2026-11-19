const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const MAX_EDIT = 10 * 1024 * 1024;

function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function p(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

function sortEntries(list) {
  return list.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

class FsProvider {
  constructor(ssh) {
    this.ssh = ssh;
  }

  join(hostId, dir, name) {
    return hostId === 'local' ? path.join(dir, name) : path.posix.join(dir, name);
  }

  async home(hostId) {
    if (hostId === 'local') return os.homedir();
    const sftp = await this.ssh.sftp(hostId);
    return p(sftp, 'realpath', '.');
  }

  async list(hostId, dir) {
    if (hostId === 'local') {
      const ents = await fsp.readdir(dir, { withFileTypes: true });
      const out = await Promise.all(
        ents.map(async (e) => {
          let isDir = e.isDirectory();
          const link = e.isSymbolicLink();
          if (link) {
            try {
              isDir = (await fsp.stat(path.join(dir, e.name))).isDirectory();
            } catch {}
          }
          return { name: e.name, dir: isDir, link };
        })
      );
      return sortEntries(out);
    }
    const sftp = await this.ssh.sftp(hostId);
    const ents = await p(sftp, 'readdir', dir);
    const out = await Promise.all(
      ents.map(async (e) => {
        let isDir = e.attrs.isDirectory();
        const link = e.attrs.isSymbolicLink();
        if (link) {
          try {
            isDir = (await p(sftp, 'stat', path.posix.join(dir, e.filename))).isDirectory();
          } catch {}
        }
        return { name: e.filename, dir: isDir, link, size: e.attrs.size };
      })
    );
    return sortEntries(out);
  }

  async stat(hostId, file) {
    if (hostId === 'local') {
      const st = await fsp.stat(file);
      return { size: st.size, mtime: Math.floor(st.mtimeMs / 1000), dir: st.isDirectory() };
    }
    const sftp = await this.ssh.sftp(hostId);
    const st = await p(sftp, 'stat', file);
    return { size: st.size, mtime: st.mtime, dir: st.isDirectory() };
  }

  async read(hostId, file) {
    const st = await this.stat(hostId, file);
    if (st.dir) throw new Error('Is a directory');
    if (st.size > MAX_EDIT) return { tooLarge: true, size: st.size };
    let buf;
    if (hostId === 'local') buf = await fsp.readFile(file);
    else buf = await p(await this.ssh.sftp(hostId), 'readFile', file);
    if (looksBinary(buf)) return { binary: true, size: st.size };
    let content;
    try {
      // fatal: a file in another encoding would be silently mangled and then saved back mangled.
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    } catch {
      return { binary: true, encoding: true, size: st.size };
    }
    return { content, mtime: st.mtime, size: st.size };
  }

  async write(hostId, file, content, { expectMtime, force } = {}) {
    if (expectMtime && !force) {
      try {
        const st = await this.stat(hostId, file);
        if (st.mtime !== expectMtime) return { conflict: true, mtime: st.mtime };
      } catch {}
    }
    if (hostId === 'local') await fsp.writeFile(file, content, 'utf8');
    else await p(await this.ssh.sftp(hostId), 'writeFile', file, Buffer.from(content, 'utf8'));
    const st = await this.stat(hostId, file);
    return { mtime: st.mtime };
  }

  async create(hostId, file, isDir) {
    let exists = true;
    try {
      await this.stat(hostId, file);
    } catch {
      exists = false;
    }
    if (exists) throw new Error('Already exists');
    if (hostId === 'local') {
      if (isDir) await fsp.mkdir(file);
      else await fsp.writeFile(file, '', { flag: 'wx' });
      return;
    }
    const sftp = await this.ssh.sftp(hostId);
    if (isDir) await p(sftp, 'mkdir', file);
    else await p(sftp, 'writeFile', file, Buffer.alloc(0));
  }

  async rename(hostId, from, to) {
    let exists = true;
    try {
      await this.stat(hostId, to);
    } catch {
      exists = false;
    }
    if (exists) throw new Error(`${path.basename(to)} already exists`);
    if (hostId === 'local') return fsp.rename(from, to);
    return p(await this.ssh.sftp(hostId), 'rename', from, to);
  }

  async remove(hostId, file) {
    if (hostId === 'local') return fsp.rm(file, { recursive: true });
    const sftp = await this.ssh.sftp(hostId);
    const walk = async (target) => {
      const st = await p(sftp, 'lstat', target);
      if (st.isDirectory()) {
        for (const e of await p(sftp, 'readdir', target)) await walk(path.posix.join(target, e.filename));
        await p(sftp, 'rmdir', target);
      } else {
        await p(sftp, 'unlink', target);
      }
    };
    await walk(file);
  }

  async download(hostId, remote, local) {
    const sftp = await this.ssh.sftp(hostId);
    const walk = async (r, l) => {
      const st = await p(sftp, 'stat', r);
      if (st.isDirectory()) {
        await fsp.mkdir(l, { recursive: true });
        for (const e of await p(sftp, 'readdir', r)) await walk(path.posix.join(r, e.filename), path.join(l, e.filename));
      } else {
        await p(sftp, 'fastGet', r, l);
      }
    };
    await walk(remote, local);
  }

  async upload(hostId, locals, remoteDir) {
    const sftp = hostId === 'local' ? null : await this.ssh.sftp(hostId);
    let count = 0;
    const walk = async (l, r) => {
      const st = await fsp.stat(l);
      if (st.isDirectory()) {
        if (sftp) await p(sftp, 'mkdir', r).catch(() => {});
        else await fsp.mkdir(r, { recursive: true });
        for (const name of await fsp.readdir(l)) await walk(path.join(l, name), this.join(hostId, r, name));
      } else {
        if (sftp) await p(sftp, 'fastPut', l, r);
        else await fsp.copyFile(l, r);
        count++;
      }
    };
    for (const l of locals) await walk(l, this.join(hostId, remoteDir, path.basename(l)));
    return count;
  }
}

module.exports = { FsProvider };
