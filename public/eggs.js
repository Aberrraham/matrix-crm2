'use strict';
/* Small hidden touches for customers. Nothing here affects how the site works.
   Everything respects "reduce motion" and never runs inside form fields. */
(function () {
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* 1. A quick glitch on the logo or a heading, now and then, and when the logo is hovered. */
  function glitch(el) {
    if (reduce || !el || el.classList.contains('glitch')) return;
    el.classList.add('glitch');
    setTimeout(() => el.classList.remove('glitch'), 520);
  }
  function idleGlitch() {
    setTimeout(() => {
      if (!document.hidden) {
        const pool = document.querySelectorAll('.mini-logo, .hero-logo, #app h2');
        if (pool.length) glitch(pool[Math.floor(Math.random() * pool.length)]);
      }
      idleGlitch();
    }, 25000 + Math.random() * 25000);
  }
  idleGlitch();
  document.addEventListener('mouseover', (e) => {
    const logo = e.target.closest && e.target.closest('.mini-logo, .hero-logo');
    if (logo) glitch(logo);
  });

  /* 2. Red digital rain. Tap the logo 5 times, type "matrix", or use the old cheat code. */
  let raining = false;
  function rain() {
    if (raining) return;
    raining = true;
    const msg = (t) => {
      const d = document.createElement('div');
      d.className = 'mx-toast'; d.setAttribute('role', 'status'); d.textContent = t;
      document.body.append(d); setTimeout(() => d.remove(), 3200); raining = false;
    };
    if (reduce) return msg('The room is watching.');
    const c = document.createElement('canvas');
    c.id = 'mx-rain'; c.setAttribute('aria-hidden', 'true');
    document.body.append(c);
    const ctx = c.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = innerWidth * dpr; c.height = innerHeight * dpr;
    const fs = 16 * dpr, cols = Math.ceil(c.width / fs);
    const drops = Array.from({ length: cols }, () => Math.random() * -40);
    const chars = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓ0123456789';
    const start = performance.now();
    let raf = 0, over = false;
    function stop() {
      if (over) return; over = true; cancelAnimationFrame(raf);
      c.classList.add('out'); setTimeout(() => { c.remove(); raining = false; }, 900);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') stop(); }
    document.addEventListener('keydown', onKey);
    c.addEventListener('click', stop);
    (function frame(t) {
      ctx.fillStyle = 'rgba(10,10,11,.14)'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.font = fs + 'px monospace';
      for (let i = 0; i < cols; i++) {
        const y = drops[i] * fs;
        ctx.fillStyle = Math.random() < 0.04 ? '#ffd9d6' : '#ee1c12';
        ctx.fillText(chars[Math.floor(Math.random() * chars.length)], i * fs, y);
        if (y > c.height && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      }
      if (t - start < 5000) raf = requestAnimationFrame(frame); else stop();
    })(start);
  }

  let taps = 0, tapTimer = 0;
  document.addEventListener('click', (e) => {
    if (!(e.target.closest && e.target.closest('.mini-logo, .hero-logo'))) return;
    taps++; clearTimeout(tapTimer); tapTimer = setTimeout(() => { taps = 0; }, 3000);
    if (taps >= 5) { taps = 0; rain(); }
  });

  const code = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
  let ki = 0, typed = '';
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    ki = k === code[ki] ? ki + 1 : (k === code[0] ? 1 : 0);
    if (ki === code.length) { ki = 0; rain(); }
    typed = (typed + (e.key.length === 1 ? k : '')).slice(-6);
    if (typed === 'matrix') { typed = ''; rain(); }
  });

  /* 3. The tab title changes when you look away. */
  const title = document.title;
  document.addEventListener('visibilitychange', () => {
    document.title = document.hidden ? 'The room is waiting…' : title;
  });

  /* 4. A hello in the developer console. */
  try {
    console.log('%cLooking under the hood?', 'color:#ee1c12;font:bold 16px monospace');
    console.log('%cWe like curious people. Escape artists welcome.', 'color:#a1a1aa;font:12px monospace');
  } catch { /* ignore */ }
})();
