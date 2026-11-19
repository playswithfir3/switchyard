#!/usr/bin/env node
// sy — command-line and MCP client for a running Switchyard instance.
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');

const SOCK =
  process.env.SWITCHYARD_SOCK ||
  (process.platform === 'win32'
    ? `\\\\.\\pipe\\switchyard-${os.userInfo().username}`
    : path.join(process.env.SWITCHYARD_HOME || path.join(os.homedir(), '.switchyard'), 'control.sock'));

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCK);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${JSON.stringify({ id: 1, method, params })}\n`));
    sock.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      sock.end();
      try {
        const msg = JSON.parse(buf.slice(0, i));
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result);
      } catch (err) {
        reject(err);
      }
    });
    sock.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') reject(new Error('Switchyard is not running'));
      else reject(err);
    });
  });
}

const TOOLS = [
  {
    name: 'list_hosts',
    description: 'List the hosts configured in Switchyard (local machine plus saved servers), with their protocols and whether an SSH connection is up.',
    inputSchema: { type: 'object', properties: {} },
    run: () => call('hosts.list'),
  },
  {
    name: 'list_panes',
    description: 'List all terminal panes: id, host, foreground process, and the detected coding agent with its state (working, waiting, idle).',
    inputSchema: { type: 'object', properties: {} },
    run: () => call('panes.list'),
  },
  {
    name: 'open_pane',
    description: 'Open a new terminal pane on a host (name, address, id, or "local"). Remote panes attach to a persistent tmux session when the server has tmux. Returns the pane id.',
    inputSchema: {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Host name, address or id; "local" for this machine' },
        cwd: { type: 'string', description: 'Working directory to start in' },
        command: { type: 'string', description: 'Command to type into the new shell' },
        label: { type: 'string', description: 'Label shown on the pane' },
        tmux: { type: 'string', description: 'Attach to this existing remote tmux session name' },
        split: { type: 'string', enum: ['right', 'down', 'tab'], description: 'Where to place the pane (default right)' },
      },
      required: ['host'],
    },
    run: (a) => call('pane.open', a),
  },
  {
    name: 'send_text',
    description: 'Type text into a pane, followed by Enter unless enter=false.',
    inputSchema: {
      type: 'object',
      properties: { pane: { type: 'string' }, text: { type: 'string' }, enter: { type: 'boolean' } },
      required: ['pane', 'text'],
    },
    run: (a) => call('pane.send', a),
  },
  {
    name: 'send_keys',
    description: 'Send named keys to a pane, e.g. ["esc"], ["ctrl-c"], ["up","enter"], ["shift-tab"].',
    inputSchema: {
      type: 'object',
      properties: { pane: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } } },
      required: ['pane', 'keys'],
    },
    run: (a) => call('pane.keys', a),
  },
  {
    name: 'read_pane',
    description: 'Read the visible screen of a pane as text. Set lines for the last N lines; scrollback=true reaches into history.',
    inputSchema: {
      type: 'object',
      properties: { pane: { type: 'string' }, lines: { type: 'number' }, scrollback: { type: 'boolean' } },
      required: ['pane'],
    },
    run: (a) => call('pane.read', a),
  },
  {
    name: 'wait_for_pane',
    description: 'Block until a pane settles, then return its screen. Default: an agent pane waits until the agent stops working; a plain shell waits until output goes quiet. Or pass pattern (regex) to wait for text.',
    inputSchema: {
      type: 'object',
      properties: {
        pane: { type: 'string' },
        until: { type: 'string', enum: ['auto', 'idle', 'waiting', 'quiet', 'text'] },
        pattern: { type: 'string' },
        timeout: { type: 'number', description: 'Seconds, default 120' },
        lines: { type: 'number' },
      },
      required: ['pane'],
    },
    run: (a) => call('pane.wait', a),
  },
  {
    name: 'close_pane',
    description: 'Close a pane. A remote tmux session is ended too unless detach=true.',
    inputSchema: { type: 'object', properties: { pane: { type: 'string' }, detach: { type: 'boolean' } }, required: ['pane'] },
    run: (a) => call('pane.close', a),
  },
  {
    name: 'open_file',
    description: 'Open a file from a host in the Switchyard editor for the user to see.',
    inputSchema: { type: 'object', properties: { host: { type: 'string' }, path: { type: 'string' } }, required: ['host', 'path'] },
    run: (a) => call('file.open', a),
  },
];

function mcp() {
  const rl = readline.createInterface({ input: process.stdin });
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  rl.on('line', async (line) => {
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    if (req.id === undefined || req.id === null) return;
    const ok = (result) => send({ jsonrpc: '2.0', id: req.id, result });
    if (req.method === 'initialize') {
      return ok({
        protocolVersion: (req.params && req.params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'switchyard', version: '0.1.0' },
      });
    }
    if (req.method === 'ping') return ok({});
    if (req.method === 'tools/list') {
      return ok({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    }
    if (req.method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === req.params.name);
      if (!tool) return send({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'Unknown tool' } });
      try {
        const res = await tool.run(req.params.arguments || {});
        const text = res && typeof res.text === 'string' ? `${JSON.stringify({ ...res, text: undefined })}\n${res.text}` : JSON.stringify(res, null, 2);
        return ok({ content: [{ type: 'text', text }] });
      } catch (err) {
        return ok({ content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
      }
    }
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'Method not found' } });
  });
}

const BOOL = new Set(['no-enter', 'scrollback', 'detach', 'json']);

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (BOOL.has(k)) flags[k] = true;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (a === '-n') flags.lines = argv[++i];
    else pos.push(a);
  }
  return { pos, flags };
}

function table(rows, cols) {
  if (!rows.length) return '(none)';
  const w = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (vals) => vals.map((v, i) => String(v ?? '').padEnd(w[i])).join('  ').trimEnd();
  return [line(cols.map((c) => c.toUpperCase())), ...rows.map((r) => line(cols.map((c) => r[c])))].join('\n');
}

const HELP = `sy — control a running Switchyard

  sy hosts                              list hosts
  sy ls                                 list panes with agent state
  sy open <host> [--cwd DIR] [--cmd CMD] [--label L] [--tmux NAME] [--split right|down|tab]
  sy send <pane> <text...> [--no-enter] type text into a pane
  sy keys <pane> <key...>               esc, enter, ctrl-c, up, shift-tab, ...
  sy read <pane> [-n LINES] [--scrollback]
  sy wait <pane> [--until idle|waiting|quiet|text] [--pattern RE] [--timeout SEC]
  sy close <pane> [--detach]
  sy focus <pane>
  sy edit <host> <path>                 open a file in the editor
  sy vnc <host> | sy rdp <host>
  sy screenshot [file.png]
  sy mcp                                run as an MCP stdio server
  sy raw <method> [json]                call an API method directly

<pane> defaults to $SWITCHYARD_PANE inside a Switchyard terminal when given as "."`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parse(rest);
  const pane = (p) => (p === '.' || !p ? process.env.SWITCHYARD_PANE : p);
  const json = flags.json;
  const print = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

  switch (cmd) {
    case 'mcp':
      return mcp();
    case 'hosts': {
      const r = await call('hosts.list');
      return print(json ? r : table(r.map((h) => ({ ...h, protocols: h.protocols.join(','), connected: h.connected ? 'yes' : '' })), ['name', 'address', 'group', 'protocols', 'connected']));
    }
    case 'ls':
    case 'panes': {
      const r = await call('panes.list');
      return print(json ? r : table(r, ['pane', 'host', 'status', 'process', 'agent', 'state', 'tmux', 'title']));
    }
    case 'open': {
      const r = await call('pane.open', { host: pos[0], cwd: flags.cwd, command: flags.cmd, label: flags.label, tmux: flags.tmux, split: flags.split });
      return print(json ? r : r.pane);
    }
    case 'send':
      return void (await call('pane.send', { pane: pane(pos[0]), text: pos.slice(1).join(' '), enter: !flags['no-enter'] }));
    case 'keys':
      return void (await call('pane.keys', { pane: pane(pos[0]), keys: pos.slice(1) }));
    case 'read': {
      const r = await call('pane.read', { pane: pane(pos[0]), lines: flags.lines && Number(flags.lines), scrollback: !!flags.scrollback });
      return print(json ? r : r.text);
    }
    case 'wait': {
      const r = await call('pane.wait', { pane: pane(pos[0]), until: flags.until, pattern: flags.pattern, timeout: flags.timeout && Number(flags.timeout), lines: flags.lines && Number(flags.lines) });
      print(json ? r : r.text);
      if (r.timedOut) process.exitCode = 2;
      return;
    }
    case 'close':
      return void (await call('pane.close', { pane: pane(pos[0]), detach: !!flags.detach }));
    case 'focus':
      return void (await call('pane.focus', { pane: pane(pos[0]) }));
    case 'edit':
      return void (await call('file.open', { host: pos[0], path: pos[1] }));
    case 'vnc':
    case 'rdp':
      return void (await call('remote.open', { host: pos[0], kind: cmd }));
    case 'screenshot':
      return print(await call('app.screenshot', { path: pos[0] && path.resolve(pos[0]) }));
    case 'raw':
      return print(await call(pos[0], pos[1] ? JSON.parse(pos[1]) : {}));
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(`sy: ${err.message}`);
  process.exit(1);
});
