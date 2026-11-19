# Switchyard

Terminals on many servers in one window, aware of the coding agents running in them, with a
file editor, embedded VNC and RDP alongside. Electron, so the same code builds for macOS,
Windows and Linux.

- **Multiplexer** — workspaces (tabs) of split panes, local or over SSH. On servers that have
  tmux, each remote pane lives in its own tmux session (`sy-xxxxxx`), so it survives a dropped
  connection or an app restart; the pane shows "press Enter to reconnect" and reattaches.
- **Agent aware** — panes running Claude Code, Codex, Gemini CLI, aider, opencode, amp, goose,
  Cursor agent, Copilot CLI, Qwen, Droid or Crush show *working / needs input / done* in the
  pane header, the Panes sidebar and the workspace tab, with a desktop notification when one
  needs you. `Cmd+J` jumps to the next one waiting.
- **Agents can drive it** — a local control socket, the `sy` CLI and an MCP server let an agent
  open panes on any host, type into them, read their screens and wait for them to settle.
- **Files** — a tree for the local machine or any SSH host (SFTP), opening into Monaco (the
  VS Code editor). Upload by drag-and-drop, download, rename, delete, "open terminal here".
  Deleting a local file moves it to the Trash; deleting on a server is permanent and says so.
  Uploads and renames ask before replacing anything.
- **VNC** — renders in a pane (noVNC), direct or through an SSH tunnel.
- **RDP** — launches FreeRDP (`brew install freerdp`), direct or through an SSH tunnel.
  On Windows without FreeRDP it falls back to `mstsc`.

## Icon

`build/icon.svg` is the source. `npm run icon` re-renders `icon.png`, `icon.icns` and `icon.ico`
from it using Electron itself (no other tools needed).

## Run

```bash
npm install          # also fetches the Electron binary (scripts/setup.js)
npm start
npm run pack         # dist/mac-arm64/Switchyard.app (ad-hoc signed, not notarized)
npm run dist:mac     # dmg + zip;  dist:win / dist:linux must run on that OS
```

Only macOS has been run. Windows and Linux paths exist in the code (ConPTY shell, named-pipe
control socket, `mstsc`, `Ctrl+Shift` shortcuts) but are untested; Linux needs a compiler for
node-pty, which `scripts/setup.js` invokes when no prebuild matches.

## Keys (macOS; elsewhere `Ctrl+Shift` replaces `Cmd`)

| | |
|---|---|
| `Cmd+N` / `Cmd+T` | new local terminal / new workspace |
| `Cmd+P` | connect to a host |
| `Cmd+D` / `Cmd+Shift+D` | split right / down (non-mac: `Ctrl+Shift+E` / `O`) |
| `Cmd+Opt+Arrows` | move focus between panes |
| `Cmd+Enter` | zoom the focused pane |
| `Cmd+J` | next agent needing attention |
| `Cmd+W` / `Cmd+Opt+W` | close pane (ends its tmux session) / detach (keeps it) |
| `Cmd+1…9`, `Cmd+Shift+[ ]` | switch workspace |
| `Cmd+B` | toggle sidebar |
| `Cmd+S` | save the file in the focused editor |

Inside a tmux-backed pane the mouse wheel scrolls tmux history; hold `Option` to select text
with the mouse.

## Control API

```bash
ln -s "$PWD/bin/sy.js" /usr/local/bin/sy     # needs node on PATH

sy hosts                       # configured hosts
sy ls                          # panes, foreground process, agent + state
P=$(sy open web-01 --cwd /srv/app --cmd 'claude')
sy send $P 'run the test suite and fix what fails'
sy wait $P                     # blocks until the agent stops working, prints the screen
sy read $P -n 80 --scrollback
sy keys $P esc                 # esc, enter, ctrl-c, up, shift-tab, single characters…
sy close $P                    # --detach keeps the remote tmux session
sy edit web-01 /etc/nginx/nginx.conf
```

MCP (stdio), e.g. for Claude Code:

```bash
claude mcp add switchyard -- node /path/to/switchyard/bin/sy.js mcp
```

Tools: `list_hosts`, `list_panes`, `open_pane`, `send_text`, `send_keys`, `read_pane`,
`wait_for_pane`, `close_pane`, `open_file`.

The socket is `~/.switchyard/control.sock`, mode 600. Anything running as your user can use it,
and it can type into every open session, including remote ones. Inside a Switchyard terminal
`$SWITCHYARD_PANE` holds that pane's id (`sy read .`).

## Where things live

`~/.switchyard/` (mode 700; override with `SWITCHYARD_HOME`):

- `hosts.json` — host entries. `secrets.json` — passwords, encrypted with the OS keychain
  (Electron safeStorage); never plaintext. `known_hosts.json` — SSH host keys, trust-on-first-use
  with a warning dialog when a key changes. `state.json` — window layout.
- SSH auth: agent (`SSH_AUTH_SOCK`), key file, or password; jump hosts chain through other
  entries. File > Import `~/.ssh/config` pulls in `Host` blocks.

```
main/      Electron main process
  sessions.js  panes: local pty or SSH channel, headless xterm mirror of each screen
  agents.js    agent detection rules (process names, screen signatures, state regexes)
  ssh.js       connection pool, host-key check, tmux probe, SFTP, tunnels
  api.js       control socket      vnc.js / rdp.js   remote desktop backends
renderer/  UI (plain ES modules, no bundler): app.js layout, term.js, editor.js, files.js, vnc.js
bin/sy.js  CLI and MCP server
```

## How agent detection works, and where it can be wrong

Each pane's foreground process comes from the local pty, from `tmux list-panes`, or from `ps`
on the pane's tty (polled every 3 s over the existing SSH connection). A known agent process
name settles it; otherwise the visible screen is matched against per-agent signatures. State
comes from the last lines of the screen: "esc to interrupt"-style text means working, a
permission or y/n prompt means needs input. These are heuristics over terminal text, so a new
agent version that rewords its UI needs its pattern updated in `main/agents.js`.

## Known gaps

- RDP is a separate FreeRDP window, not a pane. A real RDP login has not been exercised here
  (launch, stdin argument passing, SSH tunnel and failure reporting have).
- VNC was exercised against a protocol-level test server, not a real desktop.
- Reopening the app does not auto-reconnect remote panes; press Enter in each (deliberate: no
  outbound connections without a keypress). VNC panes and remote editor tabs are not restored.
- The packaged app is ad-hoc signed: each rebuild is a new identity to the Keychain, so macOS
  asks again before it will read saved passwords.
- Closing a remote pane that is not connected cannot end its tmux session; it stays on the
  server until you attach to it again (host menu > Attach tmux Session) or kill it there.
- Files are read and written as UTF-8. Anything else is refused rather than opened, because
  saving it back would corrupt it. Remote saves write in place over SFTP, not atomically.

## License

MIT — see [LICENSE](LICENSE).
