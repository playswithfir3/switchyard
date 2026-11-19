// Rasterises build/icon.svg with Electron's own Chromium and writes
// build/icon.png (1024), build/icon.icns (macOS, via iconutil) and build/icon.ico (Windows).
// Run: npm run icon
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const BUILD = path.join(__dirname, '..', 'build');

function ico(pngs) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  const dir = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size;
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    dir.push(e);
  }
  return Buffer.concat([head, ...dir, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const svg = fs.readFileSync(path.join(BUILD, 'icon.svg'), 'utf8');
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((r) => setTimeout(r, 400));
  const full = (await win.webContents.capturePage()).resize({ width: 1024, height: 1024, quality: 'best' });
  const at = (n) => full.resize({ width: n, height: n, quality: 'best' }).toPNG();
  fs.writeFileSync(path.join(BUILD, 'icon.png'), full.toPNG());
  fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: at(size) }))));

  if (process.platform === 'darwin') {
    const set = fs.mkdtempSync(path.join(os.tmpdir(), 'sy-icon-')) + '/icon.iconset';
    fs.mkdirSync(set);
    for (const n of [16, 32, 128, 256, 512]) {
      fs.writeFileSync(path.join(set, `icon_${n}x${n}.png`), at(n));
      fs.writeFileSync(path.join(set, `icon_${n}x${n}@2x.png`), at(n * 2));
    }
    execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(BUILD, 'icon.icns')]);
    fs.rmSync(path.dirname(set), { recursive: true });
  }
  app.quit();
});
