'use strict';
/* The page a friend sees when they open a shared invite link: /r/MX-ABC123 */
(async function () {
  const root = document.getElementById('app');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const fromPath = decodeURIComponent((location.pathname.split('/')[2] || '')).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
  let code = null;
  try {
    const r = await fetch('/api/referral/check?code=' + encodeURIComponent(fromPath));
    const d = await r.json();
    if (d.valid) code = d.code;
  } catch { /* offline: show the welcome without a code */ }
  if (code) { try { localStorage.setItem('mx_ref', code); } catch { /* storage blocked */ } }

  const logo = el('img', 'hero-logo'); logo.src = '/assets/logo.png'; logo.alt = 'Matrix Escape Rooms';
  const box = el('section', 'welcome invite');
  box.append(logo,
    el('p', 'invite-kicker', 'A friend has sent you a key'),
    el('h1', 'brand', 'Welcome to Matrix Escape Rooms'),
    el('p', 'lead', 'Five worlds. One door. Somewhere in Bengaluru a team just fought their way out of a cursed castle, a forbidden temple and a mummy’s tomb, and now a friend wants you on their next one.'),
    el('p', 'invite-story', 'Trust your instincts. Don’t split up. And whatever you do, don’t look behind you.'));

  const themes = el('ul', 'theme-chips');
  ['Lost Mummy', 'Forbidden Temple', 'Zombie Apocalypse', 'Cursed Castle', 'Mental Asylum'].forEach((t) => themes.append(el('li', null, t)));
  box.append(themes);

  if (code) {
    const cb = el('div', 'code-box');
    cb.append(el('p', 'small muted', 'Your friend’s invite code'), el('div', 'code', code));
    const copy = el('button', 'btn ghost', 'Copy code');
    const note = el('p', 'small success'); note.setAttribute('role', 'status');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code); note.textContent = 'Code copied. Keep it safe.'; }
      catch { note.textContent = 'Press and hold the code to copy it.'; }
    });
    box.append(cb, copy, note);
  }

  const join = el('a', 'btn primary', 'Join the Matrix'); join.href = '/#/signup';
  const login = el('a', 'btn ghost', 'I already have an account'); login.href = '/#/login';
  box.append(join, login);
  root.replaceChildren(box);
})();
