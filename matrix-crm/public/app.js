'use strict';
/* Matrix CRM frontend. No framework, no build step.
   Every piece of text from the server goes in through textContent, so it cannot inject HTML. */

const root = document.getElementById('app');
let me = null;      // { user, profile, waiverSigned } when logged in
let options = null; // { occupations, heardFrom }

/* ---------- tiny helpers ---------- */
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

async function api(path, body) {
  const init = { credentials: 'same-origin' };
  if (body !== undefined) {
    init.method = 'POST';
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res;
  try { res = await fetch('/api' + path, init); }
  catch { throw new Error('No internet connection. Please try again.'); }
  let data = {};
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Something went wrong. Please try again.');
    err.status = res.status;
    throw err;
  }
  return data;
}

function go(hash) {
  if (location.hash === hash) render(); else location.hash = hash;
}
async function refreshMe() {
  try { me = await api('/me'); } catch { me = null; }
}
async function logout() {
  try { await api('/logout', {}); } catch { /* ignore */ }
  me = null;
  go('#/');
}

const inr = (n) => (n == null ? '' : '₹' + Number(n).toLocaleString('en-IN'));
function fmtDate(s) {
  const str = String(s);
  // 'YYYY-MM-DD' = a calendar day (no timezone shift); anything longer is an exact moment from the database.
  const d = new Date(str.length === 10 ? str + 'T00:00:00' : str);
  return isNaN(d) ? s : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

const ICONS = {
  waiver: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  gallery: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 9"/>',
  referral: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M17 5.5a3 3 0 0 1 0 5.5M18 14.3c1.8.7 3 2.4 3 4.7"/>',
  voucher: '<path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2.5 2.5 0 0 0 0 5v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2.5 2.5 0 0 0 0-5z"/><path d="M14 5v14" stroke-dasharray="2 2.5"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
function icon(name) {
  const s = h('span', { class: 'icon' });
  s.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
  return s;
}

function mount(...nodes) {
  root.replaceChildren(...nodes);
  window.scrollTo(0, 0);
  const heading = root.querySelector('h1, h2');
  if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus({ preventScroll: true }); }
}

function shell({ back } = {}, ...content) {
  return [
    h('header', { class: 'top' },
      back ? h('a', { class: 'back', href: back }, '← Back') : h('span'),
      h('img', { class: 'mini-logo', src: '/assets/logo.png', alt: 'Matrix Escape Rooms' }),
      me ? h('button', { class: 'link', type: 'button', onclick: logout }, 'Log out') : h('span')),
    h('main', null, content),
  ];
}

// Runs fn when the button is pressed, disables it meanwhile, shows errors in errBox.
function onPress(btnOrForm, btn, errBox, fn) {
  let busy = false;
  const handler = async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Please wait…';
    errBox.textContent = '';
    try { await fn(); }
    catch (err) {
      if (err.status === 401 && me) { me = null; go('#/login'); return; }
      errBox.textContent = err.message;
    } finally { busy = false; btn.disabled = false; btn.textContent = label; }
  };
  btnOrForm.addEventListener(btnOrForm.tagName === 'FORM' ? 'submit' : 'click', handler);
}
const errorBox = () => h('p', { class: 'error', role: 'alert' });

// Fetch data for a screen, show Loading, then draw; on failure show a retry.
async function loadScreen(back, title, fetcher, draw) {
  mount(...shell({ back }, h('h2', null, title), h('p', { class: 'muted' }, 'Loading…')));
  try {
    const data = await fetcher();
    mount(...shell({ back }, h('h2', null, title), draw(data)));
  } catch (err) {
    if (err.status === 401) { me = null; go('#/login'); return; }
    mount(...shell({ back }, h('h2', null, title),
      h('p', { class: 'error' }, err.message),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => render() }, 'Try again')));
  }
}

/* ---------- screens ---------- */
function viewWelcome() {
  mount(h('main', { class: 'welcome' },
    h('img', { class: 'hero-logo', src: '/assets/logo.png', alt: 'Matrix Escape Rooms logo' }),
    h('h1', { class: 'brand' }, 'Matrix Escape Rooms'),
    h('p', { class: 'lead' }, 'Your next escape starts here.'),
    h('a', { class: 'btn primary', href: '#/signup' }, 'Sign up'),
    h('a', { class: 'btn ghost', href: '#/login' }, 'Login')));
}

function passwordFields(newPassword) {
  const pw = h('input', { id: 'pw', type: 'password', required: true, minlength: newPassword ? 8 : null,
    autocomplete: newPassword ? 'new-password' : 'current-password' });
  const pw2 = newPassword ? h('input', { id: 'pw2', type: 'password', required: true, autocomplete: 'new-password' }) : null;
  const show = h('input', { type: 'checkbox', id: 'show', onchange: () => { pw.type = show.checked ? 'text' : 'password'; if (pw2) pw2.type = pw.type; } });
  const nodes = [
    h('div', null, h('label', { for: 'pw' }, newPassword ? 'Create a password' : 'Password'), pw,
      newPassword ? h('p', { class: 'hint' }, 'At least 8 characters.') : null),
    pw2 && h('div', null, h('label', { for: 'pw2' }, 'Type the password again'), pw2),
    h('label', { class: 'check', for: 'show' }, show, 'Show password'),
  ];
  return { nodes, pw, pw2 };
}

function viewSignup() {
  let kind = 'phone';
  const err = errorBox();
  const idLabel = h('label', { for: 'id' }, 'Your phone number');
  const idInput = h('input', { id: 'id', type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '98765 43210', required: true });
  const phoneTab = h('button', { type: 'button', 'aria-pressed': 'true' }, 'Phone');
  const emailTab = h('button', { type: 'button', 'aria-pressed': 'false' }, 'Email');
  function setKind(k) {
    kind = k;
    phoneTab.setAttribute('aria-pressed', String(k === 'phone'));
    emailTab.setAttribute('aria-pressed', String(k === 'email'));
    idLabel.textContent = k === 'phone' ? 'Your phone number' : 'Your email address';
    idInput.type = k === 'phone' ? 'tel' : 'email';
    idInput.setAttribute('inputmode', k === 'phone' ? 'tel' : 'email');
    idInput.setAttribute('autocomplete', k === 'phone' ? 'tel' : 'email');
    idInput.placeholder = k === 'phone' ? '98765 43210' : 'you@example.com';
    idInput.value = '';
    idInput.focus();
  }
  phoneTab.addEventListener('click', () => setKind('phone'));
  emailTab.addEventListener('click', () => setKind('email'));

  const { nodes, pw, pw2 } = passwordFields(true);
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Create my account');
  const form = h('form', { novalidate: true },
    h('div', { class: 'tabs', role: 'group', 'aria-label': 'Sign up with' }, phoneTab, emailTab),
    h('div', null, idLabel, idInput), ...nodes, err, submit);
  onPress(form, submit, err, async () => {
    if (!idInput.value.trim()) throw new Error('Please enter your ' + (kind === 'phone' ? 'phone number.' : 'email address.'));
    if (pw.value.length < 8) throw new Error('Your password must be at least 8 characters.');
    if (pw.value !== pw2.value) throw new Error('The two passwords do not match.');
    await api('/signup', { identifier: idInput.value, password: pw.value });
    await refreshMe();
    go('#/profile');
  });
  mount(...shell({ back: '#/' },
    h('h2', null, 'Create your account'),
    h('p', { class: 'lead' }, 'Use your phone number or email.'),
    h('div', { class: 'card' }, form),
    h('p', { class: 'center muted', style: null }, 'Already have an account? ', h('a', { href: '#/login' }, 'Login'))));
}

function viewLogin() {
  const err = errorBox();
  const idInput = h('input', { id: 'id', type: 'text', autocomplete: 'username', inputmode: 'email', required: true, placeholder: 'Phone number or email' });
  const { nodes, pw } = passwordFields(false);
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Login');
  const form = h('form', { novalidate: true },
    h('div', null, h('label', { for: 'id' }, 'Phone number or email'), idInput), ...nodes, err, submit);
  onPress(form, submit, err, async () => {
    if (!idInput.value.trim() || !pw.value) throw new Error('Please enter your phone number or email, and your password.');
    await api('/login', { identifier: idInput.value, password: pw.value });
    await refreshMe();
    go(me && me.profile ? '#/home' : '#/profile');
  });
  mount(...shell({ back: '#/' },
    h('h2', null, 'Welcome back'),
    h('div', { class: 'card' }, form),
    h('p', { class: 'center muted' }, 'New here? ', h('a', { href: '#/signup' }, 'Create an account'))));
}

/* --- profile setup: one question per screen --- */
function viewProfile() {
  const p = { name: '', phone: '', dob: '', travellingFrom: '', occupation: '', heardFrom: '', heardOther: '' };
  let step = 0, otpSent = false, devCode = '', verifiedPhone = '';
  const phoneDraft = { value: me.user.phone ? '+' + me.user.phone : '' };
  const total = 6;
  const today = new Date().toISOString().slice(0, 10);

  function draw() {
    const err = errorBox();
    const next = h('button', { class: 'btn primary', type: 'submit' }, step === total - 1 ? 'Create my profile' : 'Next');
    const back = step > 0 ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { step--; draw(); } }, 'Back') : null;
    let body, validate;

    if (step === 0) {
      const i = h('input', { id: 'q', type: 'text', autocomplete: 'name', value: p.name, maxlength: 80 });
      body = [h('label', { for: 'q' }, 'What is your name?'), i];
      validate = () => { p.name = i.value.trim(); if (p.name.length < 2) throw new Error('Please enter your name.'); };
    } else if (step === 1) {
      return drawPhone();
    } else if (step === 2) {
      const i = h('input', { id: 'q', type: 'date', value: p.dob, max: today, min: '1900-01-01', autocomplete: 'bday' });
      body = [h('label', { for: 'q' }, 'What is your date of birth?'), i];
      validate = () => { p.dob = i.value; if (!p.dob) throw new Error('Please choose your date of birth.'); };
    } else if (step === 3) {
      const i = h('input', { id: 'q', type: 'text', value: p.travellingFrom, maxlength: 100, autocomplete: 'address-level2', placeholder: 'City or town' });
      body = [h('label', { for: 'q' }, 'Where are you travelling from?'), i];
      validate = () => { p.travellingFrom = i.value.trim(); if (p.travellingFrom.length < 2) throw new Error('Please tell us where you are travelling from.'); };
    } else if (step === 4) {
      const s = h('select', { id: 'q' }, h('option', { value: '' }, 'Choose one'),
        options.occupations.map((o) => h('option', { value: o, selected: o === p.occupation }, o)));
      body = [h('label', { for: 'q' }, 'What is your occupation?'), s];
      validate = () => { p.occupation = s.value; if (!p.occupation) throw new Error('Please choose your occupation.'); };
    } else {
      const s = h('select', { id: 'q' }, h('option', { value: '' }, 'Choose one'),
        options.heardFrom.map((o) => h('option', { value: o, selected: o === p.heardFrom }, o)));
      const other = h('input', { id: 'other', type: 'text', maxlength: 100, value: p.heardOther, placeholder: 'Tell us more' });
      const otherWrap = h('div', { hidden: p.heardFrom !== 'Other' }, h('label', { for: 'other' }, 'Please tell us how'), other);
      s.addEventListener('change', () => { otherWrap.hidden = s.value !== 'Other'; });
      body = [h('label', { for: 'q' }, 'How did you get to know about us?'), s, otherWrap];
      validate = () => {
        p.heardFrom = s.value; p.heardOther = other.value.trim();
        if (!p.heardFrom) throw new Error('Please choose one.');
        if (p.heardFrom === 'Other' && p.heardOther.length < 2) throw new Error('Please tell us how you heard about us.');
      };
    }

    const form = h('form', { novalidate: true }, h('div', null, body), err, h('div', { class: 'row' }, back, next));
    onPress(form, next, err, async () => {
      validate();
      if (step < total - 1) { step++; draw(); return; }
      await api('/profile', {
        name: p.name, phone: verifiedPhone, dob: p.dob, travellingFrom: p.travellingFrom,
        occupation: p.occupation,
        heardFrom: p.heardFrom === 'Other' ? 'Other: ' + p.heardOther : p.heardFrom,
      });
      await refreshMe();
      go('#/home');
    });
    frame(form);
  }

  function drawPhone() {
    const err = errorBox();
    let content;
    if (verifiedPhone) {
      const next = h('button', { class: 'btn primary', type: 'submit' }, 'Next');
      const back = h('button', { class: 'btn ghost', type: 'button', onclick: () => { step--; draw(); } }, 'Back');
      content = h('form', { novalidate: true },
        h('div', { class: 'verified' }, h('div', null, h('strong', null, '✓ Verified'), h('div', null, '+' + verifiedPhone)),
          h('button', { class: 'linkbtn', type: 'button', onclick: () => { verifiedPhone = ''; otpSent = false; phoneDraft.value = ''; drawPhone(); } }, 'Change')),
        h('div', { class: 'row' }, back, next));
      onPress(content, next, err, async () => { step++; draw(); });
    } else if (!otpSent) {
      const i = h('input', { id: 'q', type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '98765 43210', value: phoneDraft.value });
      const send = h('button', { class: 'btn primary', type: 'submit' }, 'Send OTP');
      const back = h('button', { class: 'btn ghost', type: 'button', onclick: () => { step--; draw(); } }, 'Back');
      content = h('form', { novalidate: true },
        h('div', null, h('label', { for: 'q' }, 'What is your phone number?'), i,
          h('p', { class: 'hint' }, 'We will send a 6-digit code to verify it.')),
        err, h('div', { class: 'row' }, back, send));
      onPress(content, send, err, async () => {
        phoneDraft.value = i.value;
        const r = await api('/otp/send', { phone: i.value });
        p.phone = r.phone; devCode = r.devCode || ''; otpSent = true; drawPhone();
      });
    } else {
      const i = h('input', { id: 'q', type: 'text', class: 'otp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '------' });
      const verify = h('button', { class: 'btn primary', type: 'submit' }, 'Verify');
      const resend = h('button', { class: 'linkbtn', type: 'button' }, 'Send a new code');
      const change = h('button', { class: 'linkbtn', type: 'button', onclick: () => { otpSent = false; drawPhone(); } }, 'Change number');
      content = h('form', { novalidate: true },
        h('div', null, h('label', { for: 'q' }, 'Enter the 6-digit code'), i,
          h('p', { class: 'hint' }, 'Sent to +' + p.phone + '. It works for 5 minutes.')),
        devCode && h('p', { class: 'notice' }, 'Test mode: your code is ', h('strong', null, devCode)),
        err, verify, h('div', { class: 'row' }, resend, change));
      onPress(content, verify, err, async () => {
        const r = await api('/otp/verify', { phone: p.phone, code: i.value });
        verifiedPhone = r.phone; devCode = ''; drawPhone();
      });
      resend.addEventListener('click', async () => {
        err.textContent = '';
        try { const r = await api('/otp/send', { phone: p.phone }); devCode = r.devCode || ''; drawPhone(); }
        catch (e) { err.textContent = e.message; }
      });
    }
    frame(content);
  }

  function frame(content) {
    const pct = Math.round(((step + 1) / total) * 100);
    mount(...shell({},
      h('div', { class: 'progress' },
        h('div', { class: 'bar', role: 'progressbar', 'aria-valuemin': '1', 'aria-valuemax': String(total), 'aria-valuenow': String(step + 1) },
          h('span', { style: null })),
        h('p', null, 'Step ' + (step + 1) + ' of ' + total)),
      h('h2', null, step === 0 ? 'Let’s set up your profile' : 'Almost there'),
      h('div', { class: 'card' }, content)));
    root.querySelector('.bar > span').style.width = pct + '%';
    const first = root.querySelector('#q');
    if (first) first.focus();
  }

  draw();
}

/* An invite link (/r/CODE) leaves the code in this browser. Once the person has a profile, use it once. */
async function applyPendingRef() {
  let code = null;
  try { code = localStorage.getItem('mx_ref'); } catch { /* storage blocked */ }
  if (!code) return;
  try { await api('/referral/apply', { code }); } catch { /* already used, own code or unknown: nothing to do */ }
  try { localStorage.removeItem('mx_ref'); } catch { /* ignore */ }
}

/* --- home --- */
function viewHome() {
  applyPendingRef();
  const first = me.profile.name.split(' ')[0];
  const tiles = [
    ['waiver', 'Fill waiver', '#/waiver', me.waiverSigned ? ['Signed', 'ok'] : ['To do', 'todo']],
    ['gallery', 'Gallery', '#/gallery'],
    ['referral', 'Referral code', '#/referral'],
    ['voucher', 'Coupons', '#/voucher'],
    ['history', 'History', '#/history'],
  ];
  mount(...shell({},
    h('div', { class: 'hello' }, h('h2', null, 'Hi, ' + first), h('p', { class: 'muted' }, 'What would you like to do?')),
    h('nav', { class: 'grid', 'aria-label': 'Main menu' },
      tiles.map(([ic, label, href, badge]) =>
        h('a', { class: 'tile', href }, badge && h('span', { class: 'badge ' + badge[1] }, badge[0]), icon(ic), h('span', { class: 't' }, label))))));
}

/* --- waiver: one per game (date + time slot + theme) --- */
function viewWaiver() {
  loadScreen('#/home', 'Waiver', () => api('/waiver'), (w) => {
    const text = h('div', { class: 'waiver-text', tabindex: '0', role: 'region', 'aria-label': 'Waiver text' }, w.text);
    const err = errorBox();
    const opt = (list, ph) => [h('option', { value: '' }, ph), ...list.map((x) => h('option', { value: x }, x))];
    const date = h('input', { id: 'pd', type: 'date', min: w.today, max: w.lastDate, value: w.today });
    const slot = h('select', { id: 'ps' }, opt(options.slots, 'Choose a time slot'));
    const theme = h('select', { id: 'pt' }, opt(options.themes, 'Choose a theme'));
    const agree = h('input', { type: 'checkbox', id: 'agree' });
    const cctv = h('input', { type: 'checkbox', id: 'cctv' });
    const name = h('input', { id: 'sig', type: 'text', autocomplete: 'name', maxlength: 80 });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, 'Sign waiver');
    const form = h('form', { novalidate: true },
      h('p', { class: 'hint' }, 'Sign once for each game you play. Friends who pick the same date, time slot and theme join your team and share the photos and videos.'),
      h('div', null, h('label', { for: 'pd' }, 'Date you are playing'), date),
      h('div', null, h('label', { for: 'ps' }, 'Time slot'), slot),
      h('div', null, h('label', { for: 'pt' }, 'Theme'), theme),
      text,
      h('label', { class: 'check', for: 'agree' }, agree, 'I have read the waiver and understand that by booking the event I am bound by its terms. (Required)'),
      h('label', { class: 'check', for: 'cctv' }, cctv, 'I voluntarily consent to CCTV surveillance and video recording within the facility premises for security purposes during my visit. (Required)'),
      h('div', null, h('label', { for: 'sig' }, 'Type your full name to sign'), name),
      err, submit);
    onPress(form, submit, err, async () => {
      if (!date.value) throw new Error('Please choose the date you are playing.');
      if (!slot.value) throw new Error('Please choose your time slot.');
      if (!theme.value) throw new Error('Please choose your theme.');
      if (!agree.checked) throw new Error('Please tick the box to confirm you agree.');
      if (!cctv.checked) throw new Error('Please tick the box to consent to CCTV surveillance.');
      await api('/waiver', { agree: true, cctv: true, fullName: name.value, playDate: date.value, slot: slot.value, theme: theme.value });
      await refreshMe();
      viewWaiver();
    });
    return h('div', { class: 'stack typewriter' },
      w.waivers.length && h('div', null,
        h('h3', null, 'Your signed waivers'),
        h('div', { class: 'stack' }, w.waivers.map((x) =>
          h('div', { class: 'item' },
            h('div', { class: 'head' }, h('strong', null, x.theme), h('span', { class: 'muted small' }, fmtDate(x.playDate) + ' · ' + x.slot)),
            h('p', { class: 'success small' }, '✓ Signed by ' + x.fullName))))),
      h('h3', null, w.waivers.length ? 'Sign for another game' : 'Sign your waiver'),
      form);
  });
}

/* --- photos and videos --- */
const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

function mediaTile(m, onOpen) {
  const when = fmtDate(m.createdAt);
  let inner;
  if (m.kind === 'image') {
    inner = h('img', { src: '/api/media/' + m.id + '/thumb', alt: '', loading: 'lazy' });
  } else {
    inner = h('span', { class: 'play' });
    inner.innerHTML = PLAY_ICON;
    inner.append('Video');
  }
  return h('button', { type: 'button', class: 'media-tile', 'aria-label': (m.kind === 'video' ? 'Play video from ' : 'Open photo from ') + when, onclick: () => onOpen(m) }, inner);
}

// A full-screen viewer for the customer gallery.
function mediaViewer() {
  const body = h('div', { class: 'viewer' });
  const dl = h('a', { class: 'btn ghost', href: '#' }, 'Download');
  const close = h('button', { class: 'btn primary', type: 'button' }, 'Close');
  const dlg = h('dialog', { 'aria-label': 'Photo or video' }, body, h('div', { class: 'row' }, dl, close));
  close.addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  dlg.addEventListener('close', () => body.replaceChildren()); // also stops a playing video
  return {
    dlg,
    open(m) {
      const src = '/api/media/' + m.id + '/file';
      body.replaceChildren(m.kind === 'image'
        ? h('img', { src, alt: 'Photo from ' + fmtDate(m.createdAt) })
        : h('video', { src, controls: true, playsinline: true, preload: 'metadata' }));
      dl.href = src + '?download=1';
      dlg.showModal();
    },
  };
}

/* --- gallery: photos and videos from your team's games --- */
function viewGallery() {
  loadScreen('#/home', 'My photos & videos', () => api('/media'), ({ media }) => {
    if (!media.length) return h('p', { class: 'empty' }, 'Your photos and videos from your visit will appear here after our team adds them.');
    const viewer = mediaViewer();
    const groups = new Map();
    for (const m of media) {
      const k = m.playDate + '|' + m.slot + '|' + m.theme;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(m);
    }
    return h('div', { class: 'stack' },
      [...groups.values()].map((list) => h('section', null,
        h('h3', null, list[0].theme),
        h('p', { class: 'muted small' }, fmtDate(list[0].playDate) + ' · ' + list[0].slot),
        h('div', { class: 'gallery' }, list.map((m) => mediaTile(m, viewer.open))))),
      viewer.dlg);
  });
}

/* --- referral: code, link and points --- */
function viewReferral() {
  loadScreen('#/home', 'Refer a friend', () => api('/referral'), (r) => {
    const link = location.origin + '/r/' + r.code;
    const status = h('p', { class: 'small success', role: 'status' });
    const copier = (text, label, done) => {
      const b = h('button', { class: 'btn ghost', type: 'button' }, label);
      b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(text); status.textContent = done; }
        catch { status.textContent = 'Press and hold to copy: ' + text; }
      });
      return b;
    };
    const msg = 'Step inside Matrix Escape Rooms with me. Five worlds, one door, and a team that never leaves anyone behind. Open this invite: ' + link + ' (my code: ' + r.code + ')';
    const share = h('a', { class: 'btn primary', href: 'https://wa.me/?text=' + encodeURIComponent(msg), target: '_blank', rel: 'noopener' }, 'Share on WhatsApp');
    const parts = [
      h('p', { class: 'lead' }, 'Share your code or your invite link with friends.'),
      h('div', { class: 'code-box' }, h('div', { class: 'code' }, r.code)),
      h('div', { class: 'stack' }, share, copier(link, 'Copy invite link', 'Invite link copied!'), copier(r.code, 'Copy code only', 'Code copied!'), status),
      h('div', { class: 'card points-card' },
        h('p', { class: 'small muted' }, 'Your points'),
        h('div', { class: 'big' }, String(r.points)),
        h('p', { class: 'small muted' }, 'You earn ' + r.pointsPerFriend + ' points each time a friend uses your code on our coupon website.'),
        r.pointsHistory.length && h('div', { class: 'stack' }, r.pointsHistory.map((p) =>
          h('div', { class: 'row-between' }, h('span', { class: 'small' }, p.reason + ' · ' + fmtDate(p.at)), h('strong', { class: p.delta > 0 ? 'plus' : 'minus' }, (p.delta > 0 ? '+' : '') + p.delta))))),
      h('p', { class: 'center muted' }, r.friendsJoined + (r.friendsJoined === 1 ? ' friend has' : ' friends have') + ' joined through your link.'),
    ];
    if (!r.usedFriendsCode) {
      const err = errorBox();
      const i = h('input', { id: 'fc', type: 'text', autocapitalize: 'characters', maxlength: 20, placeholder: 'MX-XXXXXX' });
      const apply = h('button', { class: 'btn ghost', type: 'submit' }, 'Use this code');
      const form = h('form', { novalidate: true }, h('div', null, h('label', { for: 'fc' }, 'Did a friend give you a code?'), i), err, apply);
      onPress(form, apply, err, async () => {
        await api('/referral/apply', { code: i.value });
        viewReferral();
      });
      parts.push(h('hr', { class: 'divider' }), form);
    }
    return h('div', null, parts);
  });
}

/* --- coupons: only what the team has made for you --- */
function viewVoucher() {
  loadScreen('#/home', 'Coupons', () => api('/vouchers'), ({ vouchers }) => {
    if (!vouchers.length) return h('p', { class: 'empty' }, 'No coupons yet. When we make one for you, it will appear here.');
    const group = (status) => vouchers.filter((v) => v.status === status);
    const card = (v) => h('div', { class: 'item coupon ' + v.status },
      h('div', { class: 'head' }, h('span', { class: 'code' }, v.code || 'Expired'),
        h('span', { class: 'muted small' }, v.status === 'used' ? 'Used' : v.status === 'expired' ? 'Expired ' + fmtDate(v.expiresOn) : 'Valid until ' + fmtDate(v.expiresOn))),
      h('p', null, v.description));
    const section = (title, list) => list.length ? h('div', { class: 'stack' }, h('h3', null, title), list.map(card)) : null;
    return h('div', { class: 'stack' },
      section('Ready to use', group('active')), section('Used', group('used')), section('Expired', group('expired')),
      h('p', { class: 'hint' }, 'Show your code to our team when you book or visit.'));
  });
}

/* --- history --- */
function viewHistory() {
  loadScreen('#/home', 'History', () => api('/history'), ({ bookings }) =>
    bookings.length
      ? h('div', { class: 'stack' }, bookings.map((b) =>
          h('div', { class: 'item' },
            h('div', { class: 'head' }, h('strong', null, b.room), h('span', { class: 'muted small' }, fmtDate(b.date))),
            h('p', { class: 'muted small' },
              [b.players != null ? b.players + ' players' : null, b.amount != null ? inr(b.amount) : null, b.status].filter(Boolean).join(' · ')))))
      : h('p', { class: 'empty' }, 'No visits yet. Your games will show up here.'));
}

/* ---------- router ---------- */
const routes = {
  '/': viewWelcome, '/signup': viewSignup, '/login': viewLogin, '/profile': viewProfile, '/home': viewHome,
  '/waiver': viewWaiver, '/gallery': viewGallery, '/referral': viewReferral, '/voucher': viewVoucher, '/history': viewHistory,
};
const publicRoutes = new Set(['/', '/signup', '/login']);

function render() {
  const path = location.hash.slice(1) || '/';
  const view = routes[path];
  const redirect = (to) => { location.replace(to); };
  if (!view) return redirect('#/');
  if (!me && !publicRoutes.has(path)) return redirect('#/');
  if (me && !me.profile && path !== '/profile') return redirect('#/profile');
  if (me && me.profile && (publicRoutes.has(path) || path === '/profile')) return redirect('#/home');
  view();
}

window.addEventListener('hashchange', render);
(async function boot() {
  try { options = await api('/options'); } catch { options = { occupations: [], heardFrom: [], themes: [], slots: [] }; }
  await refreshMe();
  render();
})();
