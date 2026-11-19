import { Terminal } from '../../node_modules/@xterm/xterm/lib/xterm.mjs';
import { FitAddon } from '../../node_modules/@xterm/addon-fit/lib/addon-fit.mjs';
import { WebLinksAddon } from '../../node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs';
import { sy, h, iconBtn, ctx, hostName, debounce } from './util.js';

const THEME = {
  background: '#0f1115',
  foreground: '#d7dae2',
  cursor: '#d7dae2',
  cursorAccent: '#0f1115',
  selectionBackground: '#2f4470',
  black: '#1b1e27', red: '#ef6b73', green: '#7fd88f', yellow: '#e5c07b',
  blue: '#6ea0f7', magenta: '#c58af9', cyan: '#56c8d8', white: '#c8ccd6',
  brightBlack: '#5d6375', brightRed: '#ff8088', brightGreen: '#98e6a6', brightYellow: '#f2d08f',
  brightBlue: '#8cb6ff', brightMagenta: '#d7a6ff', brightCyan: '#74dcea', brightWhite: '#f2f4f8',
};

const STATE_LABEL = { working: 'working', waiting: 'needs input', idle: 'idle', done: 'done' };

export function agentState(meta) {
  if (meta.status !== 'open') return meta.status === 'closed' ? 'off' : 'shell';
  if (!meta.agent.kind) return 'shell';
  if (meta.agent.attention === 'done' && meta.agent.state === 'idle') return 'done';
  return meta.agent.state;
}

export function paneTitle(meta) {
  return meta.label || meta.title || meta.proc || (meta.status === 'open' ? 'shell' : meta.status);
}

export class TermPane {
  constructor(meta) {
    this.kind = 'term';
    this.id = meta.id;
    this.hostId = meta.hostId;
    this.meta = meta;
    this.ready = false;

    this.dot = h('span', { class: 'sdot' });
    this.hostEl = h('span', { class: 'phost' });
    this.titleEl = h('span', { class: 'ptitle' });
    this.tagEl = h('span', { class: 'tag', hidden: true });
    this.chip = h('span', { class: 'chip', hidden: true });
    this.body = h('div', { class: 'pane-body term-body' });
    this.el = h('div', { class: 'pane', onmousedown: () => ctx.focusPane(this) },
      h('div', { class: 'pane-head', ondblclick: () => ctx.toggleZoom(this) },
        this.dot, this.hostEl, this.titleEl, this.tagEl, this.chip,
        h('span', { class: 'acts' },
          iconBtn('splitRight', 'Split right', () => ctx.splitFrom(this, 'right')),
          iconBtn('splitDown', 'Split down', () => ctx.splitFrom(this, 'down')),
          iconBtn('x', 'Close pane', () => ctx.closePane(this))
        )
      ),
      this.body
    );

    this.term = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'),
      fontSize: 12.5,
      lineHeight: 1.15,
      theme: THEME,
      cursorBlink: true,
      scrollback: 10000,
      macOptionClickForcesSelection: true,
      allowProposedApi: true,
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(new WebLinksAddon((_e, url) => sy.invoke('app.openExternal', url)));
    this.term.open(this.body);

    this.term.onData((d) => {
      if (this.meta.status === 'open') sy.send('session.write', this.id, d);
      else if (d === '\r' && this.meta.status !== 'connecting') sy.invoke('session.start', this.id);
    });
    this.term.onResize(({ cols, rows }) => sy.send('session.resize', this.id, cols, rows));
    // OSC 52: lets tmux / vim on the far side copy into the local clipboard.
    this.term.parser.registerOscHandler(52, (data) => {
      const b64 = data.split(';').pop();
      if (!b64 || b64 === '?') return true;
      try {
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        navigator.clipboard.writeText(new TextDecoder().decode(bytes)).catch(() => {});
      } catch {}
      return true;
    });

    this.refit = debounce(() => this.layout(), 40);
    this.ro = new ResizeObserver(this.refit);
    this.ro.observe(this.body);

    sy.invoke('session.snapshot', this.id)
      .then((snap) => {
        if (snap) this.term.write(snap);
      })
      .catch(() => {})
      .finally(() => {
        this.ready = true;
        this.layout();
      });
    this.update(meta);
  }

  onData(data) {
    if (this.ready) this.term.write(data);
  }

  update(meta) {
    this.meta = meta;
    const st = agentState(meta);
    this.dot.className = `sdot ${st}`;
    this.hostEl.textContent = hostName(meta.hostId);
    this.titleEl.textContent = paneTitle(meta);
    this.tagEl.hidden = !meta.tmux;
    this.tagEl.textContent = meta.tmux ? `tmux:${meta.tmux}` : '';
    this.tagEl.title = meta.tmux ? 'Persistent remote tmux session — survives disconnects' : '';
    if (meta.agent.kind) {
      this.chip.hidden = false;
      this.chip.className = `chip st-${st}`;
      this.chip.textContent = `${meta.agent.kind} · ${STATE_LABEL[st] || st}`;
    } else {
      this.chip.hidden = true;
    }
    this.el.classList.toggle('attn-waiting', meta.agent.attention === 'waiting');
    this.el.classList.toggle('attn-done', meta.agent.attention === 'done');
  }

  layout() {
    if (!this.body.offsetWidth || !this.body.offsetHeight) return;
    try {
      this.fit.fit();
    } catch {}
  }

  focus() {
    this.term.focus();
  }

  serialize() {
    return { kind: 'term', sid: this.id, hostId: this.hostId, tmux: this.meta.tmux || null, cwd: this.meta.cwd || '', label: this.meta.label || '' };
  }

  dispose() {
    this.ro.disconnect();
    this.term.dispose();
    this.el.remove();
  }
}
