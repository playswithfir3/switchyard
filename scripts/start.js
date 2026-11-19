// Launches Electron with ELECTRON_RUN_AS_NODE cleared: editors such as VS Code
// export it into their terminals, which makes Electron start as plain Node.
const { spawn } = require('child_process');
const path = require('path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// `node scripts/start.js some-script.js` runs that script under Electron instead of the app.
const args = process.argv.slice(2);
const entry = args[0] && args[0].endsWith('.js') ? path.resolve(args.shift()) : path.join(__dirname, '..');
const child = spawn(require('electron'), [entry, ...args], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
