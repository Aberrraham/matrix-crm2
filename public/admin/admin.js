'use strict';
/* Matrix staff dashboard. No framework. All server text goes in through textContent. */
const root = document.getElementById('app');
let staff = null;   // { id, email, name, role, mustChange }
let cfg = null;
let pendingNote = null;   // upload results to show after the team page redraws
let pendingSecret = null; // one-time password to show once on the Staff page     // { slots, themes, today, maxVideoMb, storage }

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

async function api(path, opts) {
  const o = opts || {};
  const init = { credentials: 'same-origin', method: o.method || (o.body !== undefined ? 'POST' : 'GET') };
  if (o.body !== undefined) { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(o.body); }
  let res;
  try { res = await fetch('/api/admin' + path, init); }
  catch { throw new Error('No internet connection. Please try again.'); }
  let data = {};
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong. Please try again.');
    err.status = res.status; err.mustChange = !!data.mustChange;
    throw err;
  }
  return data;
}

const fmtDate = (s) => {
  const str = String(s);
  const d = new Date(str.length === 10 ? str + 'T00:00:00' : str);
  return isNaN(d) ? s : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
const fmtTime = (s) => {
  const d = new Date(s);
  return isNaN(d) ? '' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
};
const mb = (n) => (n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const errorBox = () => h('p', { class: 'error', role: 'alert' });

function mount(...nodes) {
  root.replaceChildren(...nodes);
  const hd = root.querySelector('h2');
  if (hd) { hd.setAttribute('tabindex', '-1'); hd.focus({ preventScroll: true }); }
}

function onPress(el, btn, errBox, fn) {
  let busy = false;
  el.addEventListener(el.tagName === 'FORM' ? 'submit' : 'click', async (e) => {
    e.preventDefault();
    if (busy) return;
    if (btn.dataset.confirm && !confirm(btn.dataset.confirm)) return;
    busy = true;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Please wait…';
    errBox.textContent = '';
    try { await fn(); }
    catch (err) {
      if (err.status === 401) { staff = null; go('#/login'); return; }
      if (err.mustChange) { go('#/password'); return; }
      errBox.textContent = err.message;
    } finally { busy = false; btn.disabled = false; btn.textContent = label; }
  });
}

function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

async function logout() {
  try { await api('/logout', { body: {} }); } catch { /* ignore */ }
  staff = null;
  go('#/login');
}

/* ---------- layout ---------- */
const TABS = [
  ['#/waivers', 'Latest waivers'],
  ['#/sessions', 'Teams & media'],
  ['#/customers', 'Customers'],
  ['#/extras', 'Vouchers & visits'],
];
function page(active, ...content) {
  const tabs = [...TABS, ...(staff.role === 'owner' ? [['#/staff', 'Staff accounts']] : [])];
  return [
    h('header', { class: 'top' },
      h('img', { class: 'mini-logo', src: '/assets/logo.png', alt: 'Matrix Escape Rooms' }),
      h('div', { class: 'who' }, h('span', { class: 'muted' }, staff.name + (staff.role === 'owner' ? ' (owner)' : '')),
        h('button', { class: 'link', type: 'button', onclick: logout }, 'Log out'))),
    h('nav', { class: 'nav', 'aria-label': 'Dashboard' }, tabs.map(([href, label]) =>
      h('a', { href, class: href === active ? 'on' : null, 'aria-current': href === active ? 'page' : null }, label))),
    h('main', null, content),
  ];
}

// Fetch, show Loading, then draw.
async function screen(active, title, fetcher, draw) {
  mount(...page(active, h('h2', null, title), h('p', { class: 'muted' }, 'Loading…')));
  try {
    const data = await fetcher();
    mount(...page(active, h('h2', null, title), draw(data)));
  } catch (err) {
    if (err.status === 401) { staff = null; go('#/login'); return; }
    if (err.mustChange) { go('#/password'); return; }
    mount(...page(active, h('h2', null, title), h('p', { class: 'error' }, err.message),
      h('button', { class: 'btn ghost inline', type: 'button', onclick: () => render() }, 'Try again')));
  }
}

const teamHref = (d, s, t) => '#/team?date=' + encodeURIComponent(d) + '&slot=' + encodeURIComponent(s) + '&theme=' + encodeURIComponent(t);
const opts = (list, selected) => list.map((x) => h('option', { value: x, selected: x === selected ? true : null }, x));

/* ---------- login + password ---------- */
function viewLogin() {
  const err = errorBox();
  const email = h('input', { id: 'em', type: 'email', autocomplete: 'username', required: true });
  const pw = h('input', { id: 'pw', type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Log in');
  const form = h('form', { novalidate: true }, h('div', null, h('label', { for: 'em' }, 'Email'), email),
    h('div', null, h('label', { for: 'pw' }, 'Password'), pw), err, btn);
  onPress(form, btn, err, async () => {
    const r = await api('/login', { body: { email: email.value, password: pw.value } });
    staff = r.staff;
    await loadCfg();
    go(staff.mustChange ? '#/password' : '#/waivers');
  });
  mount(h('div', { class: 'login' }, h('img', { class: 'hero-logo', src: '/assets/logo.png', alt: 'Matrix Escape Rooms' }),
    h('h2', null, 'Staff login'), h('div', { class: 'card' }, form)));
}

function viewPassword() {
  const err = errorBox();
  const cur = h('input', { id: 'cp', type: 'password', autocomplete: 'current-password' });
  const nw = h('input', { id: 'np', type: 'password', autocomplete: 'new-password' });
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Save password');
  const form = h('form', { novalidate: true },
    h('div', null, h('label', { for: 'cp' }, staff.mustChange ? 'One-time password you were given' : 'Current password'), cur),
    h('div', null, h('label', { for: 'np' }, 'New password'), nw, h('p', { class: 'hint' }, 'At least 10 characters. Use something only you know.')),
    err, btn);
  onPress(form, btn, err, async () => {
    await api('/password', { body: { current: cur.value, next: nw.value } });
    staff.mustChange = false;
    go('#/waivers');
  });
  mount(h('div', { class: 'login' }, h('img', { class: 'hero-logo', src: '/assets/logo.png', alt: '' }),
    h('h2', null, staff.mustChange ? 'Choose your password' : 'Change password'), h('div', { class: 'card' }, form),
    h('p', { class: 'center' }, staff.mustChange ? h('button', { class: 'link', type: 'button', onclick: logout }, 'Log out') : h('a', { href: '#/waivers' }, 'Back'))));
}

/* ---------- latest waivers ---------- */
function waiverTable(rows, withActions) {
  return h('div', { class: 'tbl-wrap' }, h('table', null,
    h('thead', null, h('tr', null, ['Signed', 'Name', 'Phone', 'Game date', 'Slot', 'Theme', 'Team', ''].map((t) => h('th', null, t)))),
    h('tbody', null, rows.map((w) => h('tr', null,
      h('td', null, fmtTime(w.signedAt)),
      h('td', null, w.fullName, w.name && w.name !== w.fullName ? h('div', { class: 'muted small' }, 'Profile: ' + w.name) : null),
      h('td', null, w.phone ? '+' + w.phone : ''),
      h('td', null, fmtDate(w.playDate)), h('td', null, w.slot), h('td', null, w.theme),
      h('td', null, w.teamAccess ? h('span', { class: 'pill ok' }, w.teamSize + ' in team') : h('span', { class: 'pill red' }, 'removed')),
      h('td', null, h('a', { class: 'btn ghost tiny', href: teamHref(w.playDate, w.slot, w.theme) }, 'Open team')))))));
}

function viewWaivers() {
  let q = '', offset = 0;
  const list = h('div'), more = h('button', { class: 'btn ghost inline', type: 'button' }, 'Load more');
  const err = errorBox();
  const search = h('input', { id: 'wq', type: 'search', autocomplete: 'off', placeholder: 'Name, phone or email' });
  let seq = 0, timer = 0;
  async function load(reset) {
    const mine = ++seq;
    if (reset) { offset = 0; }
    err.textContent = '';
    try {
      const d = await api('/waivers?offset=' + offset + '&q=' + encodeURIComponent(q));
      if (mine !== seq) return;
      list.replaceChildren(...(reset ? [] : [...list.childNodes]), ...(d.waivers.length || !reset ? [] : [h('p', { class: 'empty' }, 'No waivers found.')]));
      if (d.waivers.length) list.append(waiverTable(d.waivers));
      offset += d.waivers.length;
      more.hidden = !d.hasMore;
    } catch (e) { if (e.status === 401) { staff = null; go('#/login'); } else err.textContent = e.message; }
  }
  more.addEventListener('click', () => load(false));
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value.trim(); load(true); }, 300); });
  mount(...page('#/waivers', h('h2', null, 'Latest waivers'),
    h('div', { class: 'toolbar' }, h('div', null, h('label', { for: 'wq' }, 'Search'), search)), err, list, h('p', null, more)));
  load(true);
}

/* ---------- teams ---------- */
function viewSessions() {
  const from = h('input', { id: 'sf', type: 'date' }), to = h('input', { id: 'st', type: 'date' });
  const out = h('div'), err = errorBox();
  async function load() {
    err.textContent = '';
    try {
      const d = await api('/sessions?from=' + from.value + '&to=' + to.value);
      out.replaceChildren(d.sessions.length ? h('div', { class: 'tbl-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Date', 'Slot', 'Theme', 'People', 'Files', ''].map((t) => h('th', null, t)))),
        h('tbody', null, d.sessions.map((s) => h('tr', null, h('td', null, fmtDate(s.playDate)), h('td', null, s.slot), h('td', null, s.theme),
          h('td', null, s.members), h('td', null, s.media ? h('span', { class: 'pill ok' }, s.media + ' files') : h('span', { class: 'pill' }, 'none')),
          h('td', null, h('a', { class: 'btn ghost tiny', href: teamHref(s.playDate, s.slot, s.theme) }, 'Open')))))))
        : h('p', { class: 'empty' }, 'No games in this range.'));
    } catch (e) { if (e.status === 401) { staff = null; go('#/login'); } else err.textContent = e.message; }
  }
  from.addEventListener('change', load); to.addEventListener('change', load);
  mount(...page('#/sessions', h('h2', null, 'Teams & media'),
    h('p', { class: 'muted' }, 'People who signed for the same date, time slot and theme are one team. Photos added to a team go to everyone in it.'),
    h('div', { class: 'toolbar' }, h('div', null, h('label', { for: 'sf' }, 'From (default: 2 weeks ago)'), from), h('div', null, h('label', { for: 'st' }, 'To (default: 30 days ahead)'), to)),
    err, out));
  load();
}

function mediaViewer() {
  const body = h('div', { class: 'viewer' });
  const dl = h('a', { class: 'btn ghost', href: '#' }, 'Download');
  const close = h('button', { class: 'btn primary', type: 'button' }, 'Close');
  const dlg = h('dialog', { 'aria-label': 'Photo or video' }, body, h('div', { class: 'row' }, dl, close));
  close.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => body.replaceChildren());
  return {
    dlg,
    open(m) {
      const src = '/api/admin/media/' + m.id + '/file';
      body.replaceChildren(m.kind === 'image' ? h('img', { src, alt: 'Uploaded photo' }) : h('video', { src, controls: true, playsinline: true, preload: 'metadata' }));
      dl.href = src + '?download=1';
      dlg.showModal();
    },
  };
}

function viewTeam() {
  const p = new URLSearchParams(location.hash.split('?')[1] || '');
  const key = { date: p.get('date') || '', slot: p.get('slot') || '', theme: p.get('theme') || '' };
  const qs = 'date=' + encodeURIComponent(key.date) + '&slot=' + encodeURIComponent(key.slot) + '&theme=' + encodeURIComponent(key.theme);
  const title = key.theme + ' · ' + key.slot + ' · ' + (key.date ? fmtDate(key.date) : '');
  return screen('#/sessions', title, () => api('/session?' + qs), (d) => {
    const viewer = mediaViewer();
    const gErr = errorBox();

    /* roster */
    const rErr = errorBox();
    const roster = h('div', { class: 'tbl-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Name', 'Phone', 'Signed', 'Status', ''].map((t) => h('th', null, t)))),
      h('tbody', null, d.roster.map((w) => {
        const act = async (fn) => { rErr.textContent = ''; try { await fn(); viewTeam(); } catch (e) { rErr.textContent = e.message; } };
        const toggle = h('button', { class: 'btn ghost tiny', type: 'button', onclick: () => {
          if (w.teamAccess && !confirm('Remove ' + w.fullName + ' from this team? They will stop seeing its photos and videos.')) return;
          act(() => api('/waivers/' + w.id + '/team', { method: 'PATCH', body: { access: !w.teamAccess } }));
        } }, w.teamAccess ? 'Remove from team' : 'Put back');
        const edit = h('button', { class: 'btn ghost tiny', type: 'button', onclick: () => editSession(w, rErr) }, 'Change session');
        return h('tr', null, h('td', null, w.fullName), h('td', null, w.phone ? '+' + w.phone : ''), h('td', null, fmtTime(w.signedAt)),
          h('td', null, w.teamAccess ? h('span', { class: 'pill ok' }, 'in team') : h('span', { class: 'pill red' }, 'removed')),
          h('td', null, h('div', { class: 'row' }, toggle, edit)));
      }))));

    /* media grid */
    const grid = h('div', { class: 'gallery' }, d.media.length ? d.media.map((m) => {
      const tile = h('button', { type: 'button', class: 'media-tile', 'aria-label': m.kind === 'video' ? 'Play video' : 'Open photo', onclick: () => viewer.open(m) },
        m.kind === 'image' ? h('img', { src: '/api/admin/media/' + m.id + '/thumb', alt: '', loading: 'lazy' }) : h('span', { class: 'play' }, 'Video'));
      const del = h('button', { class: 'linkbtn small', type: 'button', onclick: async () => {
        if (!confirm('Delete this ' + m.kind + ' for the whole team? This cannot be undone.')) return;
        gErr.textContent = '';
        try { await api('/media/' + m.id, { method: 'DELETE' }); viewTeam(); } catch (e) { gErr.textContent = e.message; }
      } }, 'Delete');
      return h('div', { class: 'media-cell' }, tile, h('span', { class: 'muted small' }, mb(m.size) + (m.uploadedBy ? ' · ' + m.uploadedBy : '')), del);
    }) : [h('p', { class: 'muted' }, 'No photos or videos yet.')]);

    /* upload */
    const upErr = errorBox();
    const files = h('input', { id: 'files', type: 'file', multiple: true, accept: 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm' });
    const status = h('ul', { class: 'status' });
    if (pendingNote) { status.append(...pendingNote.map((n) => h('li', { class: n.cls }, n.text))); pendingNote = null; }
    const upBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Upload to ' + d.roster.filter((w) => w.teamAccess).length + ' people');
    const upForm = h('form', { novalidate: true },
      h('div', null, h('label', { for: 'files' }, 'Choose photos or videos'), files,
        h('p', { class: 'hint' }, 'JPG, PNG, WebP, GIF, MP4, MOV or WebM. Videos up to ' + cfg.maxVideoMb + ' MB each. HEIC photos are not supported.')),
      status, upErr, upBtn);
    onPress(upForm, upBtn, upErr, async () => {
      const list = [...files.files];
      if (!list.length) throw new Error('Choose at least one file.');
      if (!cfg.storage) throw new Error('File storage is not set up yet. See "Photos and videos" in the README.');
      status.replaceChildren();
      let okCount = 0;
      for (const f of list) {
        const li = h('li', null, f.name + ' …');
        status.append(li);
        try {
          const fd = new FormData();
          fd.append('file', f);
          const r = await fetch('/api/admin/session/media?' + qs, { method: 'POST', headers: { 'X-Requested-With': 'crm' }, body: fd, credentials: 'same-origin' });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.error || 'Upload failed.');
          li.textContent = '✓ ' + f.name; li.className = 'ok'; okCount++;
        } catch (e) { li.textContent = '✗ ' + f.name + ' — ' + e.message; li.className = 'bad'; }
      }
      files.value = '';
      pendingNote = [...status.childNodes].map((li) => ({ text: li.textContent, cls: li.className }));
      viewTeam();
    });

    return h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Everyone in this team sees the photos and videos below.'),
      h('div', { class: 'card' }, h('h3', null, 'Add photos or videos'), upForm),
      h('div', { class: 'card' }, h('h3', null, 'Files (' + d.media.length + ')'), gErr, grid, viewer.dlg),
      h('div', { class: 'card' }, h('h3', null, 'People in this team (' + d.roster.length + ')'), rErr, roster,
        h('p', { class: 'hint' }, 'Someone picked the wrong game? Use "Change session" to move them. Someone who should not see these files? Use "Remove from team".')));
  });
}

function editSession(w, errBox) {
  const dlg = h('dialog', { 'aria-label': 'Change session' });
  const date = h('input', { id: 'ed', type: 'date', value: w.playDate });
  const slot = h('select', { id: 'es' }, opts(cfg.slots, w.slot));
  const theme = h('select', { id: 'et' }, opts(cfg.themes, w.theme));
  const err = errorBox();
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save');
  const cancel = h('button', { class: 'btn ghost', type: 'button' }, 'Cancel');
  const form = h('form', { novalidate: true, class: 'card' }, h('h3', null, 'Move ' + w.fullName),
    h('div', null, h('label', { for: 'ed' }, 'Date'), date), h('div', null, h('label', { for: 'es' }, 'Time slot'), slot),
    h('div', null, h('label', { for: 'et' }, 'Theme'), theme), err, h('div', { class: 'row' }, cancel, save));
  cancel.addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => dlg.remove());
  onPress(form, save, err, async () => {
    await api('/waivers/' + w.id, { method: 'PATCH', body: { playDate: date.value, slot: slot.value, theme: theme.value } });
    dlg.close();
    go(teamHref(date.value, slot.value, theme.value));
  });
  dlg.append(form);
  document.body.append(dlg);
  dlg.showModal();
}

/* ---------- customers ---------- */
function viewCustomers() {
  const q = h('input', { id: 'cq', type: 'search', autocomplete: 'off', placeholder: 'Name, phone or email (at least 2 characters)' });
  const out = h('div', { class: 'stack' }), detail = h('div', { class: 'stack' }), err = errorBox();
  let timer = 0, seq = 0;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const mine = ++seq; err.textContent = '';
      if (q.value.trim().length < 2) { out.replaceChildren(); return; }
      try {
        const d = await api('/customers?q=' + encodeURIComponent(q.value.trim()));
        if (mine !== seq) return;
        out.replaceChildren(...(d.customers.length ? d.customers.map((c) => h('button', { type: 'button', class: 'pick', onclick: () => show(c.id) },
          h('strong', null, c.name || '(profile not finished)'), h('span', { class: 'muted small' }, [c.phone && '+' + c.phone, c.email].filter(Boolean).join(' · '))))
          : [h('p', { class: 'muted' }, 'No customer found.')]));
      } catch (e) { err.textContent = e.message; }
    }, 300);
  });
  async function show(id) {
    out.replaceChildren(); err.textContent = '';
    try {
      const d = await api('/customers/' + id);
      const c = d.customer;
      detail.replaceChildren(h('div', { class: 'card' }, h('h3', null, c.name || '(profile not finished)'),
        h('p', { class: 'muted' }, [c.phone && '+' + c.phone, c.email].filter(Boolean).join(' · ')),
        c.dob ? h('p', { class: 'small muted' }, ['Born ' + fmtDate(c.dob), c.travellingFrom && 'From ' + c.travellingFrom, c.occupation, c.heardFrom && 'Heard via ' + c.heardFrom].filter(Boolean).join(' · ')) : null),
        h('h3', null, 'Waivers'), d.waivers.length ? waiverTable(d.waivers) : h('p', { class: 'empty' }, 'No waivers yet.'));
    } catch (e) { err.textContent = e.message; }
  }
  mount(...page('#/customers', h('h2', null, 'Customers'),
    h('p', { class: 'muted' }, 'To add photos for a customer, find them here, open their game and upload. Everyone on their team gets the files.'),
    h('div', { class: 'toolbar' }, h('div', null, h('label', { for: 'cq' }, 'Find a customer'), q)), err, out, detail));
}

/* ---------- vouchers + visits ---------- */
function viewExtras() {
  return screen('#/extras', 'Vouchers & visits', () => api('/vouchers'), ({ vouchers }) => {
    const vErr = errorBox(), vOk = h('p', { class: 'success', role: 'status' });
    const code = h('input', { id: 'vc', type: 'text', maxlength: 40, autocapitalize: 'characters', autocomplete: 'off' });
    const desc = h('input', { id: 'vd', type: 'text', maxlength: 200, placeholder: 'Rs 200 off any room' });
    const exp = h('input', { id: 've', type: 'date', min: cfg.today });
    const vBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Create voucher');
    const vForm = h('form', { novalidate: true }, h('div', null, h('label', { for: 'vc' }, 'Code'), code),
      h('div', null, h('label', { for: 'vd' }, 'What it gives'), desc), h('div', null, h('label', { for: 've' }, 'Valid until (optional)'), exp), vOk, vErr, vBtn);
    onPress(vForm, vBtn, vErr, async () => {
      await api('/vouchers', { body: { code: code.value, description: desc.value, expiresOn: exp.value || null } });
      viewExtras();
    });

    const bErr = errorBox(), bOk = h('p', { class: 'success', role: 'status' });
    const ph = h('input', { id: 'bp', type: 'tel', autocomplete: 'off' });
    const bd = h('input', { id: 'bd', type: 'date', value: cfg.today });
    const room = h('input', { id: 'br', type: 'text', maxlength: 100, placeholder: 'Room or theme' });
    const pl = h('input', { id: 'bn', type: 'number', min: 1, max: 100 });
    const am = h('input', { id: 'ba', type: 'number', min: 0, step: '0.01' });
    const bBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Add visit');
    const bForm = h('form', { novalidate: true }, h('div', null, h('label', { for: 'bp' }, 'Customer phone'), ph),
      h('div', null, h('label', { for: 'bd' }, 'Date'), bd), h('div', null, h('label', { for: 'br' }, 'Room or theme'), room),
      h('div', { class: 'row' }, h('div', null, h('label', { for: 'bn' }, 'Players'), pl), h('div', null, h('label', { for: 'ba' }, 'Amount (₹)'), am)), bOk, bErr, bBtn);
    onPress(bForm, bBtn, bErr, async () => {
      bOk.textContent = '';
      await api('/bookings', { body: { phone: ph.value, date: bd.value, room: room.value, players: pl.value, amount: am.value } });
      bOk.textContent = '✓ Visit added. The customer sees it in History.';
      room.value = ''; pl.value = ''; am.value = '';
    });

    return h('div', { class: 'cols' },
      h('div', { class: 'card' }, h('h3', null, 'Create a voucher'), vForm),
      h('div', { class: 'card' }, h('h3', null, 'Add a visit'), bForm),
      h('div', { style: null }, h('h3', null, 'Recent vouchers'),
        vouchers.length ? h('div', { class: 'tbl-wrap' }, h('table', null, h('thead', null, h('tr', null, ['Code', 'What', 'Expires', 'Used by'].map((t) => h('th', null, t)))),
          h('tbody', null, vouchers.map((v) => h('tr', null, h('td', null, v.code), h('td', null, v.description), h('td', null, v.expiresOn ? fmtDate(v.expiresOn) : '—'),
            h('td', null, v.redeemedAt ? (v.redeemedBy || 'Used') : h('span', { class: 'pill' }, 'unused'))))))) : h('p', { class: 'empty' }, 'No vouchers yet.')));
  });
}

/* ---------- staff accounts (owner) ---------- */
function viewStaff() {
  if (staff.role !== 'owner') return go('#/waivers');
  return screen('#/staff', 'Staff accounts', async () => ({ ...(await api('/staff')), ...(await api('/audit')) }), ({ staff: list, log }) => {
    const secret = h('div', { id: 'secret-slot' });
    if (pendingSecret) {
      secret.append(h('div', { class: 'card' }, h('h3', null, 'One-time password for ' + pendingSecret.email),
        h('div', { class: 'secret' }, pendingSecret.pw),
        h('p', { class: 'hint' }, 'Give this to them privately. It is shown only once, and they must choose their own password at first login.')));
      pendingSecret = null;
    }

    const err = errorBox();
    const email = h('input', { id: 'se', type: 'email', autocomplete: 'off' });
    const name = h('input', { id: 'sn', type: 'text', maxlength: 80 });
    const role = h('select', { id: 'sr' }, h('option', { value: 'staff' }, 'Staff (can use the dashboard)'), h('option', { value: 'owner' }, 'Owner (can also manage staff)'));
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Add staff member');
    const form = h('form', { novalidate: true }, h('div', null, h('label', { for: 'se' }, 'Email'), email), h('div', null, h('label', { for: 'sn' }, 'Name'), name),
      h('div', null, h('label', { for: 'sr' }, 'Role'), role), err, btn);
    onPress(form, btn, err, async () => {
      const r = await api('/staff', { body: { email: email.value, name: name.value, role: role.value } });
      pendingSecret = { email: r.email, pw: r.tempPassword };
      viewStaff();
    });

    const rErr = errorBox();
    const act = async (fn) => { rErr.textContent = ''; try { await fn(); viewStaff(); } catch (e) { rErr.textContent = e.message; } };
    const table = h('div', { class: 'tbl-wrap' }, h('table', null,
      h('thead', null, h('tr', null, ['Name', 'Email', 'Role', 'Status', 'Last login', ''].map((t) => h('th', null, t)))),
      h('tbody', null, list.map((s) => {
        const me = s.id === staff.id;
        const buttons = me ? [h('span', { class: 'muted small' }, 'You')] : [
          h('button', { class: 'btn ghost tiny', type: 'button', onclick: () => {
            if (confirm('Make a new one-time password for ' + s.email + '? They will be logged out.')) {
              act(async () => { const r = await api('/staff/' + s.id + '/reset-password', { body: {} }); pendingSecret = { email: r.email, pw: r.tempPassword }; });
            } } }, 'Reset password'),
          h('button', { class: 'btn ghost tiny', type: 'button', onclick: () => act(() => api('/staff/' + s.id, { method: 'PATCH', body: { active: !s.active } })) }, s.active ? 'Turn off' : 'Turn on'),
          h('button', { class: 'btn ghost tiny', type: 'button', onclick: () => { if (confirm('Remove ' + s.email + ' for good?')) act(() => api('/staff/' + s.id, { method: 'DELETE' })); } }, 'Remove'),
        ];
        return h('tr', null, h('td', null, s.name), h('td', null, s.email), h('td', null, s.role),
          h('td', null, s.locked ? h('span', { class: 'pill red' }, 'locked') : s.active ? h('span', { class: 'pill ok' }, 'active') : h('span', { class: 'pill' }, 'off')),
          h('td', null, s.lastLoginAt ? fmtTime(s.lastLoginAt) : 'never'), h('td', null, h('div', { class: 'row' }, buttons)));
      }))));

    return h('div', { class: 'stack' },
      h('div', { id: 'secret-slot' }),
      h('div', { class: 'card' }, h('h3', null, 'Add a staff member'), form),
      h('h3', null, 'Who can log in'), rErr, table,
      h('p', { class: 'hint' }, 'Remove or turn off a person and they are logged out straight away. Five wrong passwords lock an account for 15 minutes; "Reset password" unlocks it.'),
      h('h3', null, 'Recent activity'),
      log.length ? h('div', { class: 'tbl-wrap' }, h('table', null, h('thead', null, h('tr', null, ['When', 'Who', 'What', 'Detail'].map((t) => h('th', null, t)))),
        h('tbody', null, log.map((a) => h('tr', null, h('td', null, fmtTime(a.at)), h('td', null, a.by || '—'), h('td', null, a.action), h('td', null, a.detail || '')))))) : h('p', { class: 'empty' }, 'Nothing yet.'));
  });
}

/* ---------- router ---------- */
async function loadCfg() { cfg = (await api('/me')); }
const routes = { '/login': viewLogin, '/password': viewPassword, '/waivers': viewWaivers, '/sessions': viewSessions, '/team': viewTeam, '/customers': viewCustomers, '/extras': viewExtras, '/staff': viewStaff };

async function render() {
  const path = (location.hash.slice(1) || '/waivers').split('?')[0];
  const view = routes[path];
  if (!view) return location.replace('#/waivers');
  if (path !== '/login' && !staff) return location.replace('#/login');
  if (staff && path === '/login') return location.replace('#/waivers');
  if (staff && staff.mustChange && path !== '/password') return location.replace('#/password');
  return view();
}
window.addEventListener('hashchange', render);
(async function boot() {
  try { const m = await api('/me'); cfg = m; staff = m.staff; } catch { staff = null; }
  render();
})();
