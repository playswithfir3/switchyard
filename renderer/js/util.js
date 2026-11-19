export const sy = window.sy;
export const MAC = sy.platform === 'darwin';
export const ctx = { hosts: [], connected: new Set() };

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const PATHS = {
  terminal: '<path d="M4 6l4 4-4 4M10 14h6"/><rect x="1.5" y="2.5" width="17" height="15" rx="2.5"/>',
  folder: '<path d="M2 5.5A1.5 1.5 0 013.5 4h4l2 2h7A1.5 1.5 0 0118 7.5v8a1.5 1.5 0 01-1.5 1.500h-13A1.5 1.5 0 012 15.500z"/>',
  file: '<path d="M5 2.5h6.500L16 7v10a.5.5 0 01-.5.500h-10.500a.5.5 0 01-.5-.500v-14a.5.5 0 01.5-.500z"/><path d="M11.5 2.500V7H16"/>',
  monitor: '<rect x="2" y="3" width="16" height="11" rx="1.5"/><path d="M7 17.500h6M10 14v3.5"/>',
  windows: '<rect x="2.5" y="2.5" width="15" height="15" rx="1.5"/><path d="M10 2.500v15M2.5 10h15"/>',
  plus: '<path d="M10 4v12M4 10h12"/>',
  x: '<path d="M5 5l10 10M15 5L5 15"/>',
  splitRight: '<rect x="2" y="3" width="16" height="14" rx="2"/><path d="M10 3v14"/>',
  splitDown: '<rect x="2" y="3" width="16" height="14" rx="2"/><path d="M2 10h16"/>',
  chevron: '<path d="M7 4l6 6-6 6"/>',
  refresh: '<path d="M16 10a6 6 0 11-1.8-4.300M16 3.500v3h-3"/>',
  up: '<path d="M10 16V5M5 9.500L10 4.500l5 5"/>',
  upload: '<path d="M10 13V3.500M6 7l4-4 4 4M3.5 13v3h13v-3"/>',
  import: '<path d="M10 3v9.500M6 9l4 4 4-4M3.5 13.500v3h13v-3"/>',
  edit: '<path d="M3.5 16.500l.8-3.500L13.5 3.800l2.7 2.700L7 15.700z"/>',
  keyboard: '<rect x="1.5" y="5" width="17" height="10" rx="2"/><path d="M5 8.500h.01M8 8.500h.01M11 8.500h.01M14 8.500h.01M6 12h8"/>',
  clipboard: '<rect x="4.5" y="4" width="11" height="13.5" rx="1.5"/><path d="M7.5 4V2.500h5V4"/>',
  fit: '<path d="M3 7.500V3h4.500M17 7.500V3h-4.500M3 12.500V17h4.500M17 12.500V17h-4.5"/>',
  zoom: '<path d="M11.5 3H17v5.500M8.5 17H3v-5.500M17 3l-6 6M3 17l6-6"/>',
};

export function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="ic" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] || ''}</svg>`;
  return t.content.firstChild;
}

export function iconBtn(name, title, onclick, cls = '') {
  return h('button', { class: `icon-btn ${cls}`, title, onclick: (e) => { e.stopPropagation(); onclick(e); } }, icon(name));
}

export function errMsg(err) {
  return String((err && err.message) || err)
    .replace(/^Error invoking remote method '[^']+': /, '')
    .replace(/^Error: /, '');
}

export function toast(msg, kind = '', ms = 5000) {
  const el = h('div', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'error' ? Math.max(ms, 8000) : ms);
}

export const fail = (err) => toast(errMsg(err), 'error');

let openCtx = null;
export function closeContextMenu() {
  if (openCtx) openCtx();
  openCtx = null;
}

export function contextMenu(ev, items, anchor) {
  ev.preventDefault();
  ev.stopPropagation();
  closeContextMenu();
  const menu = h('div', { class: 'ctx' });
  for (const it of items.filter(Boolean)) {
    if (it === '-') {
      menu.append(h('div', { class: 'sep' }));
      continue;
    }
    menu.append(
      h('div', {
        class: `item ${it.danger ? 'danger' : ''} ${it.disabled ? 'disabled' : ''}`,
        onclick: () => {
          closeContextMenu();
          Promise.resolve()
            .then(() => it.run())
            .catch(fail);
        },
      }, it.label)
    );
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(ev.clientX, innerWidth - r.width - 6))}px`;
  menu.style.top = `${Math.max(4, Math.min(ev.clientY, innerHeight - r.height - 6))}px`;
  if (anchor) anchor.classList.add('menu-open');
  const off = (e) => {
    if (e && e.type === 'mousedown' && menu.contains(e.target)) return;
    menu.remove();
    if (anchor) anchor.classList.remove('menu-open');
    removeEventListener('mousedown', off, true);
    removeEventListener('blur', off);
    removeEventListener('keydown', onKey, true);
    openCtx = null;
  };
  const onKey = (e) => {
    if (e.key === 'Escape') off();
  };
  addEventListener('mousedown', off, true);
  addEventListener('blur', off);
  addEventListener('keydown', onKey, true);
  openCtx = off;
}

// buttons: [{label, value, primary, danger}] -> resolves the clicked value, or null on dismiss
export function modal({ title, body, buttons, width, onOpen, cls = '' }) {
  return new Promise((resolve) => {
    const overlays = document.getElementById('overlays');
    const prev = document.activeElement;
    const done = (v) => {
      scrim.remove();
      if (prev && prev.focus) prev.focus();
      resolve(v);
    };
    const foot = h('div', { class: 'mfoot' });
    const box = h('div', { class: `modal ${cls}`, style: width ? { width: `${width}px` } : null },
      title ? h('h2', null, title) : null,
      h('div', { class: 'mbody' }, body),
      foot
    );
    for (const b of buttons || []) {
      if (b === 'spacer') {
        foot.append(h('div', { class: 'spacer' }));
        continue;
      }
      foot.append(
        h('button', {
          class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`,
          'data-primary': b.primary ? '1' : null,
          onclick: async () => {
            if (b.validate) {
              try {
                const v = await b.validate();
                if (v === false) return;
                return done(v === undefined ? b.value : v);
              } catch (err) {
                return fail(err);
              }
            }
            done(b.value);
          },
        }, b.label)
      );
    }
    if (!foot.children.length) foot.remove();
    const scrim = h('div', {
      class: 'scrim',
      onmousedown: (e) => {
        if (e.target === scrim) done(null);
      },
      onkeydown: (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') done(null);
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
          const p = foot.querySelector('[data-primary]');
          if (p) {
            e.preventDefault();
            p.click();
          }
        }
      },
    }, box);
    overlays.append(scrim);
    const first = box.querySelector('input:not([type=checkbox]), select, textarea') || box.querySelector('[data-primary]');
    if (first) first.focus();
    if (onOpen) onOpen({ box, done });
  });
}

export function ask({ title, label, value = '', password = false, ok = 'OK', hint }) {
  const input = h('input', { type: password ? 'password' : 'text', value, style: { width: '100%' } });
  const body = h('div', null,
    label ? h('p', null, label) : null,
    h('div', { class: 'field' }, input),
    hint ? h('p', { class: 'hint' }, hint) : null
  );
  return modal({
    title,
    body,
    width: 420,
    buttons: [{ label: 'Cancel', value: null }, { label: ok, primary: true, validate: () => input.value }],
    onOpen: () => input.select(),
  });
}

export function confirm({ title, message, ok = 'OK', danger = false }) {
  return modal({
    title,
    body: h('p', null, message),
    width: 420,
    buttons: [{ label: 'Cancel', value: false }, { label: ok, value: true, primary: !danger, danger }],
  }).then((v) => !!v);
}

export function hostName(id) {
  const x = ctx.hosts.find((y) => y.id === id);
  return x ? x.name : id;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function baseName(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

export function dirName(p) {
  const s = String(p);
  const sep = s.includes('\\') && !s.includes('/') ? '\\' : '/';
  const i = s.replace(/[\\/]+$/, '').lastIndexOf(sep);
  if (i <= 0) return sep === '/' ? '/' : s.slice(0, 3);
  return s.slice(0, i);
}

export function joinPath(dir, name) {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}
