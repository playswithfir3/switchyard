const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..', 'node_modules');

const electronInstall = path.join(root, 'electron', 'install.js');
if (fs.existsSync(electronInstall) && !fs.existsSync(path.join(root, 'electron', 'dist'))) {
  spawnSync(process.execPath, [electronInstall], { stdio: 'inherit' });
}

const pre = path.join(root, 'node-pty', 'prebuilds');
if (fs.existsSync(pre)) {
  for (const d of fs.readdirSync(pre)) {
    const helper = path.join(pre, d, 'spawn-helper');
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
}
const hasPrebuild = fs.existsSync(path.join(pre, `${process.platform}-${process.arch}`));
const hasBuild = fs.existsSync(path.join(root, 'node-pty', 'build', 'Release', 'pty.node'));
if (!hasPrebuild && !hasBuild) {
  spawnSync('npx', ['node-gyp', 'rebuild'], { cwd: path.join(root, 'node-pty'), stdio: 'inherit', shell: true });
}
