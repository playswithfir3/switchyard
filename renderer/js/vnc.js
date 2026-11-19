import { sy, h, iconBtn, ctx, hostName, ask, errMsg } from './util.js';

let seq = 0;
const channels = new Map();
sy.on('vnc:data', (id, data) => {
  const ch = channels.get(id);
  if (ch) ch.deliver(data);
});
sy.on('vnc:close', (id) => {
  const ch = channels.get(id);
  if (ch) ch.remoteClosed();
});

// A WebSocket-shaped object backed by IPC, which noVNC accepts in place of a URL.
function makeChannel(id) {
  let onmessage = null;
  const queue = [];
  const ch = {
    binaryType: 'arraybuffer',
    protocol: '',
    readyState: 1,
    onopen: null,
    onclose: null,
    onerror: null,
    send(data) {
      if (ch.readyState !== 1) return;
      sy.send('vnc.send', id, data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    },
    close() {
      if (ch.readyState === 3) return;
      ch.readyState = 3;
      channels.delete(id);
      sy.invoke('vnc.close', id);
      if (ch.onclose) ch.onclose({ code: 1000, reason: '', wasClean: true });
    },
    deliver(u8) {
      const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
      if (onmessage) onmessage({ data: buf });
      else queue.push(buf);
    },
    remoteClosed() {
      if (ch.readyState === 3) return;
      ch.readyState = 3;
      channels.delete(id);
      if (ch.onclose) ch.onclose({ code: 1006, reason: 'Connection closed', wasClean: false });
    },
  };
  Object.defineProperty(ch, 'onmessage', {
    enumerable: true,
    get: () => onmessage,
    set: (fn) => {
      onmessage = fn;
      if (fn) setTimeout(() => { while (queue.length && onmessage) onmessage({ data: queue.shift() }); }, 0);
    },
  });
  channels.set(id, ch);
  return ch;
}

export class VncPane {
  constructor(hostId) {
    this.kind = 'vnc';
    this.id = `vnc${++seq}`;
    this.hostId = hostId;
    this.rfb = null;
    this.scale = true;
    this.status = 'connecting';
    this.desktop = '';

    this.dot = h('span', { class: 'sdot' });
    this.titleEl = h('span', { class: 'ptitle' });
    this.screen = h('div', { class: 'vnc-screen' });
    this.msg = h('div', { class: 'pane-msg' });
    this.body = h('div', { class: 'pane-body vnc-body' }, this.screen, this.msg);
    this.scaleBtn = iconBtn('fit', 'Toggle scale to fit / 1:1', () => this.toggleScale(), 'on');
    this.el = h('div', { class: 'pane', onmousedown: () => ctx.focusPane(this) },
      h('div', { class: 'pane-head', ondblclick: () => ctx.toggleZoom(this) },
        this.dot, h('span', { class: 'phost' }, hostName(hostId)), h('span', { class: 'tag' }, 'VNC'), this.titleEl,
        h('span', { class: 'acts' },
          iconBtn('keyboard', 'Send Ctrl+Alt+Del', () => this.rfb && this.rfb.sendCtrlAltDel()),
          iconBtn('clipboard', 'Send local clipboard to remote', () => this.pasteClipboard()),
          this.scaleBtn,
          iconBtn('refresh', 'Reconnect', () => this.connect()),
          iconBtn('splitRight', 'Split right', () => ctx.splitFrom(this, 'right')),
          iconBtn('x', 'Close', () => ctx.closePane(this))
        )
      ),
      this.body
    );
    this.connect();
  }

  setStatus(status, text, isErr) {
    this.status = status;
    this.dot.className = `sdot ${status === 'open' ? 'done' : status === 'connecting' ? 'working' : 'off'}`;
    this.titleEl.textContent = status === 'open' ? this.desktop : status;
    this.msg.hidden = status === 'open';
    this.msg.className = `pane-msg ${isErr ? 'err' : ''}`;
    this.msg.replaceChildren(
      h('div', null, text || ''),
      status === 'closed' ? h('button', { class: 'btn small', onclick: () => this.connect() }, 'Reconnect') : null
    );
    ctx.changed();
  }

  async connect() {
    this.teardown();
    const cid = `${this.id}-${Date.now()}`;
    this.cid = cid;
    this.setStatus('connecting', `Connecting to ${hostName(this.hostId)}…`);
    const ch = makeChannel(cid);
    try {
      await sy.invoke('vnc.open', cid, this.hostId);
      if (this.cid !== cid) return ch.close();
      const { default: RFB } = await import('../../node_modules/@novnc/novnc/core/rfb.js');
      const saved = await sy.invoke('vnc.password', this.hostId);
      const rfb = new RFB(this.screen, ch, saved ? { credentials: { password: saved } } : {});
      this.rfb = rfb;
      rfb.scaleViewport = this.scale;
      rfb.clipViewport = false;
      rfb.background = '#07080b';
      rfb.addEventListener('connect', () => this.setStatus('open'));
      rfb.addEventListener('desktopname', (e) => {
        this.desktop = e.detail.name;
        if (this.status === 'open') this.titleEl.textContent = this.desktop;
      });
      rfb.addEventListener('disconnect', (e) => {
        if (this.rfb !== rfb) return;
        this.rfb = null;
        this.setStatus('closed', this.failure || (e.detail.clean ? 'Disconnected' : 'Connection lost'), !!this.failure || !e.detail.clean);
      });
      rfb.addEventListener('securityfailure', (e) => {
        this.failure = `Authentication failed${e.detail.reason ? `: ${e.detail.reason}` : ''}`;
      });
      rfb.addEventListener('credentialsrequired', async (e) => {
        const types = e.detail.types || ['password'];
        const creds = {};
        for (const t of types) {
          const v = await ask({ title: `VNC ${t} — ${hostName(this.hostId)}`, password: t === 'password', ok: 'Connect' });
          if (v === null) return rfb.disconnect();
          creds[t] = v;
        }
        rfb.sendCredentials(creds);
      });
      rfb.addEventListener('clipboard', (e) => navigator.clipboard.writeText(e.detail.text).catch(() => {}));
      this.failure = '';
    } catch (err) {
      ch.close();
      if (this.cid === cid) this.setStatus('closed', errMsg(err), true);
    }
  }

  async pasteClipboard() {
    if (!this.rfb) return;
    try {
      this.rfb.clipboardPasteFrom(await navigator.clipboard.readText());
    } catch {}
  }

  toggleScale() {
    this.scale = !this.scale;
    this.scaleBtn.classList.toggle('on', this.scale);
    if (this.rfb) {
      this.rfb.scaleViewport = this.scale;
      this.rfb.clipViewport = !this.scale;
      this.rfb.dragViewport = false;
    }
    this.screen.style.overflow = this.scale ? 'hidden' : 'auto';
  }

  teardown() {
    const rfb = this.rfb;
    this.rfb = null;
    this.cid = null;
    if (rfb) {
      try {
        rfb.disconnect();
      } catch {}
    }
    this.screen.replaceChildren();
  }

  layout() {}

  focus() {
    if (this.rfb) this.rfb.focus();
  }

  serialize() {
    return null;
  }

  dispose() {
    this.teardown();
    this.el.remove();
  }
}
