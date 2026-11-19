import { sy, h, ctx, modal, toast, fail, confirm } from './util.js';

function field(label, ...inputs) {
  return h('div', { class: 'field' }, h('label', null, label), ...inputs);
}

function section(title, on, body, onToggle) {
  const box = h('input', { type: 'checkbox', checked: on });
  const el = h('div', { class: `sect ${on ? 'on' : ''}` }, h('header', null, h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, box, title)), h('div', { class: 'sbody' }, body));
  box.addEventListener('change', () => {
    el.classList.toggle('on', box.checked);
    if (onToggle) onToggle(box.checked);
  });
  return { el, box };
}

export async function hostDialog(existing) {
  const info = ctx.info;
  const x = existing || {};
  const editing = !!x.id;
  const ssh = x.ssh || { enabled: true, port: 22, auth: 'agent', tmux: true };
  const vnc = x.vnc || { port: 5900 };
  const rdp = x.rdp || { port: 3389 };
  const sec = x.secrets || {};
  const text = (value, ph, cls = '') => h('input', { type: 'text', value: value ?? '', placeholder: ph || '', class: cls, spellcheck: false });
  const pass = (has) => h('input', { type: 'password', placeholder: has ? '•••••••• (saved — leave blank to keep)' : info.encrypt ? '' : 'keychain unavailable — will prompt each time', disabled: !info.encrypt });
  const others = ctx.hosts.filter((o) => !o.local && o.ssh && o.ssh.enabled && o.id !== x.id);
  const viaSelect = (cur, selfLabel) =>
    h('select', null,
      h('option', { value: '' }, 'Direct'),
      h('option', { value: '__self', selected: !!x.id && cur === x.id }, selfLabel),
      ...others.map((o) => h('option', { value: o.id, selected: cur === o.id }, `SSH tunnel via ${o.name}`))
    );

  const f = {
    name: text(x.name, 'web-01'),
    group: text(x.group, 'optional'),
    address: text(x.address, 'hostname or IP'),
    sshUser: text(ssh.user, 'user'),
    sshPort: text(ssh.port, '22', 'short'),
    sshAuth: h('select', null,
      h('option', { value: 'agent', selected: ssh.auth === 'agent' }, 'SSH agent'),
      h('option', { value: 'key', selected: ssh.auth === 'key' }, 'Private key file'),
      h('option', { value: 'password', selected: ssh.auth === 'password' }, 'Password')
    ),
    sshKey: text(ssh.keyPath, '~/.ssh/id_ed25519'),
    sshPass: pass(sec.ssh),
    sshPhrase: pass(sec.passphrase),
    sshJump: h('select', null, h('option', { value: '' }, 'None'), ...others.map((o) => h('option', { value: o.id, selected: ssh.jump === o.id }, o.name))),
    sshTmux: h('input', { type: 'checkbox', checked: ssh.tmux !== false }),
    vncPort: text(vnc.port, '5900', 'short'),
    vncPass: pass(sec.vnc),
    vncVia: viaSelect(vnc.via, 'SSH tunnel via this host'),
    rdpPort: text(rdp.port, '3389', 'short'),
    rdpUser: text(rdp.user, 'user'),
    rdpDomain: text(rdp.domain, 'optional'),
    rdpPass: pass(sec.rdp),
    rdpVia: viaSelect(rdp.via, 'SSH tunnel via this host'),
    rdpExtra: text(rdp.extra, '/f /multimon +fonts'),
  };

  const keyRow = field('Key file', f.sshKey, h('button', { class: 'btn small', onclick: async () => { const p = await sy.invoke('hosts.pickKey'); if (p) f.sshKey.value = p; } }, 'Browse'));
  const phraseRow = field('Passphrase', f.sshPhrase);
  const passRow = field('Password', f.sshPass);
  const syncAuth = () => {
    keyRow.hidden = phraseRow.hidden = f.sshAuth.value !== 'key';
    passRow.hidden = f.sshAuth.value !== 'password';
  };
  f.sshAuth.addEventListener('change', syncAuth);
  syncAuth();

  const sSsh = section('SSH — terminals and files', !!ssh.enabled, [
    field('User / port', f.sshUser, f.sshPort),
    field('Auth', f.sshAuth),
    keyRow, phraseRow, passRow,
    field('Jump host', f.sshJump),
    h('label', { class: 'check' }, f.sshTmux, 'Keep panes in remote tmux sessions when tmux is installed'),
  ]);
  const sVnc = section('VNC — embedded desktop', !!vnc.enabled, [field('Port', f.vncPort), field('Password', f.vncPass), field('Route', f.vncVia)]);
  const rdpNote = info.rdp.bin || info.rdp.mstsc ? null : h('p', { class: 'hint', style: { margin: '2px 0 8px' } }, `FreeRDP is not installed. ${info.platform === 'darwin' ? 'Run: brew install freerdp' : 'Install the freerdp package.'}`);
  const sRdp = section('RDP — opens in FreeRDP', !!rdp.enabled, [
    rdpNote,
    field('User / port', f.rdpUser, f.rdpPort),
    field('Domain', f.rdpDomain),
    field('Password', f.rdpPass),
    field('Route', f.rdpVia),
    field('Extra flags', f.rdpExtra),
  ]);

  const body = h('div', null, field('Name', f.name), field('Address', f.address), field('Group', f.group), sSsh.el, sVnc.el, sRdp.el);

  const collect = () => {
    const address = f.address.value.trim();
    if (!address) throw new Error('Address is required');
    if (!sSsh.box.checked && !sVnc.box.checked && !sRdp.box.checked) throw new Error('Enable at least one protocol');
    for (const [box, sel, name] of [[sVnc.box, f.vncVia, 'VNC'], [sRdp.box, f.rdpVia, 'RDP']]) {
      if (box.checked && sel.value === '__self' && !sSsh.box.checked) throw new Error(`${name} is routed through this host's SSH, but SSH is not enabled`);
    }
    const host = {
      id: x.id,
      name: f.name.value.trim() || address,
      group: f.group.value,
      address,
      ssh: { enabled: sSsh.box.checked, user: f.sshUser.value, port: f.sshPort.value, auth: f.sshAuth.value, keyPath: f.sshKey.value.replace(/^~(?=\/|$)/, info.home), jump: f.sshJump.value, tmux: f.sshTmux.checked },
      vnc: { enabled: sVnc.box.checked, port: f.vncPort.value, via: f.vncVia.value },
      rdp: { enabled: sRdp.box.checked, port: f.rdpPort.value, user: f.rdpUser.value, domain: f.rdpDomain.value, via: f.rdpVia.value, extra: f.rdpExtra.value },
    };
    const secrets = { ssh: f.sshPass.value, passphrase: f.sshPhrase.value, vnc: f.vncPass.value, rdp: f.rdpPass.value };
    return { host, secrets };
  };

  const saved = await modal({
    title: editing ? `Edit ${existing.name}` : 'New host',
    body,
    width: 520,
    buttons: [
      editing ? { label: 'Delete', value: 'delete', danger: true } : null,
      'spacer',
      { label: 'Cancel', value: null },
      {
        label: 'Save',
        primary: true,
        validate: async () => {
          const { host, secrets } = collect();
          const h1 = await sy.invoke('hosts.save', host, secrets);
          // "this host" as tunnel endpoint needs the id, which only exists after the first save
          let again = false;
          for (const k of ['vnc', 'rdp']) {
            if (host[k].via === '__self') {
              h1[k].via = h1.id;
              again = true;
            }
          }
          if (again) await sy.invoke('hosts.save', h1, {});
          return h1;
        },
      },
    ].filter(Boolean),
  });

  if (saved === 'delete') {
    if (await confirm({ title: `Delete ${existing.name}?`, message: 'The host entry and its saved passwords are removed. Nothing on the server is touched.', ok: 'Delete', danger: true })) {
      await sy.invoke('hosts.delete', existing.id);
      await ctx.reloadHosts();
    }
    return null;
  }
  if (saved) await ctx.reloadHosts();
  return saved;
}

export async function importSshConfig() {
  try {
    const r = await sy.invoke('hosts.importSshConfig');
    await ctx.reloadHosts();
    toast(r.added ? `Imported ${r.added} host${r.added === 1 ? '' : 's'} from ~/.ssh/config` : `Nothing new in ~/.ssh/config${r.skipped ? ` (${r.skipped} already present)` : ''}`, r.added ? 'ok' : '');
  } catch (err) {
    fail(err);
  }
}

export async function tmuxDialog(host, attached) {
  let list;
  try {
    list = await sy.invoke('ssh.tmuxSessions', host.id);
  } catch (err) {
    return fail(err);
  }
  if (!list.length) return toast(`No tmux sessions on ${host.name}`);
  const ago = (t) => {
    const s = Math.max(0, Date.now() / 1000 - t);
    return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
  };
  await modal({
    title: `tmux sessions on ${host.name}`,
    width: 460,
    cls: 'palette',
    body: h('div', { class: 'plist', style: { padding: 0 } }),
    buttons: [{ label: 'Close', value: null }],
    onOpen: ({ box, done }) => {
      box.querySelector('.plist').append(
        ...list.map((s) => {
          const here = attached.has(s.name);
          return h('div', {
            class: 'pitem',
            style: { cursor: here ? 'default' : 'pointer', opacity: here ? 0.5 : 1 },
            onmouseenter: (e) => !here && e.currentTarget.classList.add('sel'),
            onmouseleave: (e) => e.currentTarget.classList.remove('sel'),
            onclick: () => {
              if (here) return;
              done(null);
              ctx.openTerminal(host.id, { tmux: s.name });
            },
          },
            h('span', null, s.name),
            h('span', { class: 'sub' }, `${s.windows} window${s.windows === 1 ? '' : 's'} · active ${ago(s.activity)}`),
            h('span', { class: 'kind' }, here ? 'open here' : s.attached ? 'attached elsewhere' : 'detached')
          );
        })
      );
    },
  });
}

export function palette() {
  const input = h('input', { type: 'text', placeholder: 'Connect to host…', spellcheck: false });
  const listEl = h('div', { class: 'plist' });
  let items = [];
  let sel = 0;
  let finish = null;
  const kinds = (x) => (x.local ? ['terminal'] : [x.ssh.enabled && 'ssh', x.vnc.enabled && 'vnc', x.rdp.enabled && 'rdp'].filter(Boolean));
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    items = ctx.hosts.filter((x) => !q || `${x.name} ${x.address} ${x.group || ''}`.toLowerCase().includes(q));
    sel = Math.min(sel, Math.max(0, items.length - 1));
    listEl.replaceChildren(
      ...items.map((x, i) =>
        h('div', { class: `pitem ${i === sel ? 'sel' : ''}`, onmousemove: () => { if (sel !== i) { sel = i; draw(); } }, onclick: () => go(x) },
          h('span', null, x.name), h('span', { class: 'sub' }, x.local ? 'this machine' : x.address), h('span', { class: 'kind' }, kinds(x).join(' · ')))
      )
    );
    if (!items.length) listEl.append(h('div', { class: 'side-empty' }, 'No matching hosts'));
    const cur = listEl.children[sel];
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  };
  const go = (x) => {
    finish(null);
    ctx.openPrimary(x);
  };
  input.addEventListener('input', () => {
    sel = 0;
    draw();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length);
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (items[sel]) go(items[sel]);
    }
  });
  draw();
  return modal({
    cls: 'palette',
    body: h('div', { style: { display: 'flex', flexDirection: 'column', margin: '-10px -18px -6px' } }, input, listEl),
    onOpen: ({ done }) => {
      finish = done;
      input.focus();
    },
  });
}
