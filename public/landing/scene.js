// Troy landing: scene motion.
// Day to night crossfade, the problem section's lines, connection chips, and the small parts of
// Troy's footer scene that need a script (the z's, the stars, the one-eye peek).
// Troy's own animations (drop, bob, blink, breathing) are CSS in scene.css.

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x) => x * x * (3 - 2 * x);

/* ---------- Day to night ---------- */

const skyGolden = $('#sky-golden');
const skyNight = $('#sky-night');
const sections = {
  problem: $('#problem'),
  lostFound: $('#lost-found'),
  broken: $('#broken'),
  safe: $('#safe'),
};

let stars = null;
if (!reduced && $('#sky')) {
  // A few twinkling stars in the sky part of the night painting. Fixed spots so they never jump.
  const spots = [
    [6, 9], [13, 22], [21, 6], [29, 15], [36, 27], [43, 8], [50, 19],
    [57, 5], [63, 24], [70, 12], [78, 29], [84, 7], [91, 17], [96, 26],
  ];
  stars = document.createElement('div');
  stars.id = 'sky-stars';
  spots.forEach(([x, y], i) => {
    const star = document.createElement('i');
    star.style.left = x + '%';
    star.style.top = y + '%';
    star.style.animationDuration = 2.6 + (i % 5) * 0.7 + 's';
    star.style.animationDelay = -(i * 0.9) + 's';
    stars.appendChild(star);
  });
  $('#sky').appendChild(stars);
}

// Scroll positions (of the middle of the viewport) where each fade begins and ends.
let fade = null;
let lineMarks = [];
let viewH = window.innerHeight;

function measure() {
  const y = window.scrollY;
  viewH = window.innerHeight;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { top: r.top + y, bottom: r.bottom + y, mid: r.top + y + r.height / 2 };
  };
  if (sections.problem && sections.lostFound && sections.broken && sections.safe) {
    fade = {
      goldenStart: box(sections.problem).bottom,  // day until the end of "The problem"
      goldenEnd: box(sections.lostFound).bottom,  // the change to golden hour runs behind "Lost and found"
      nightStart: box(sections.broken).bottom,    // golden hour until the end of "Broken things"
      nightEnd: box(sections.safe).top,           // night from the top of "Safe by design"
    };
  }
  lineMarks = lines.map((line) => box(line).mid);
}

let lastGolden = -1;
let lastNight = -1;

function setOpacity(el, value) {
  if (el) el.style.opacity = String(value);
}

function paintSky() {
  if (!fade) return;
  const mid = window.scrollY + viewH / 2;
  let golden;
  let night;
  if (reduced) {
    // Simple fades: each painting switches at the halfway point and CSS fades it.
    golden = mid >= (fade.goldenStart + fade.goldenEnd) / 2 ? 1 : 0;
    night = mid >= (fade.nightStart + fade.nightEnd) / 2 ? 1 : 0;
  } else {
    golden = smooth(clamp01((mid - fade.goldenStart) / Math.max(1, fade.goldenEnd - fade.goldenStart)));
    night = smooth(clamp01((mid - fade.nightStart) / Math.max(1, fade.nightEnd - fade.nightStart)));
    golden = Math.round(golden * 1000) / 1000;
    night = Math.round(night * 1000) / 1000;
  }
  // Day stays at full opacity underneath; golden fades in over it, then night over golden.
  // Nothing ever fades out while the layer below is showing, so the wrong painting can't flash.
  if (golden !== lastGolden) {
    setOpacity(skyGolden, golden);
    lastGolden = golden;
  }
  if (night !== lastNight) {
    setOpacity(skyNight, night);
    setOpacity(stars, night);
    lastNight = night;
  }
}

/* ---------- Problem section lines ---------- */

const lines = $$('.pair-line');
const lineDone = lines.map(() => false);
let nextLineAt = 0;

lines.forEach((line) => {
  const fill = document.createElement('span');
  fill.className = 'pair-line-fill';
  line.appendChild(fill);
});

function connectLines() {
  // A line completes once its pair has scrolled up into the top third of the screen, so the broken state is read first.
  const trigger = window.scrollY + viewH * 0.33;
  const now = performance.now();
  lines.forEach((line, i) => {
    if (lineDone[i] || lineMarks[i] === undefined || lineMarks[i] > trigger) return;
    lineDone[i] = true;
    // One at a time, even when the visitor scrolls past several at once.
    const wait = Math.max(0, nextLineAt - now);
    nextLineAt = now + wait + 450;
    line.style.setProperty('--line-delay', reduced ? '0s' : wait / 1000 + 's');
    line.classList.add('is-connected');
  });
}

/* ---------- Scroll loop ---------- */

let ticking = false;
function frame() {
  ticking = false;
  paintSky();
  connectLines();
}
function requestFrame() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(frame);
}
function remeasure() {
  measure();
  requestFrame();
}

window.addEventListener('scroll', requestFrame, { passive: true });
window.addEventListener('resize', remeasure, { passive: true });
window.addEventListener('load', remeasure);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(remeasure);
// Section heights change as conversations play, so keep the positions fresh.
if ('ResizeObserver' in window && $('main')) {
  let pending = false;
  new ResizeObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      remeasure();
    });
  }).observe($('main'));
}
measure();
frame();

/* ---------- Connection chips ---------- */

const CHIP_WAIT = 4000;       // no chat script: show the chip after the section has been in view this long
const CHIP_WAIT_MAX = 60000;  // chat script running: wait for "convo:done", but never longer than this

$$('.chip').forEach((chip) => {
  const section = chip.closest('section');
  const convo = section && $('.convo', section);
  const show = () => chip.classList.add('is-shown');
  if (reduced || !section || !convo) {
    show();
    return;
  }
  // The chat script dispatches "convo:done" on the mount when the conversation has finished.
  convo.addEventListener('convo:done', show);

  // Fallback. If a script has taken over the mount, give the conversation time to finish.
  let scripted = false;
  const watcher = new MutationObserver(() => {
    scripted = true;
    watcher.disconnect();
  });
  watcher.observe(convo, { childList: true, subtree: true });

  if (!('IntersectionObserver' in window)) {
    show();
    return;
  }
  const seen = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    seen.disconnect();
    setTimeout(() => {
      watcher.disconnect();
      if (scripted) setTimeout(show, CHIP_WAIT_MAX - CHIP_WAIT);
      else show();
    }, CHIP_WAIT);
  }, { threshold: 0.35 });
  seen.observe(convo);
});

/* ---------- Troy in the footer ---------- */

const footer = $('#footer');
const sleep = $('.footer-sleep');
const footerBtn = footer && $('.btn', footer);

if (!reduced && sleep) {
  for (let i = 0; i < 3; i += 1) {
    const z = document.createElement('span');
    z.className = 'sleep-z';
    z.textContent = 'z';
    sleep.appendChild(z);
  }
}

if (!reduced && footer && footerBtn) {
  // Troy opens one eye while the visitor hovers, focuses or taps the button.
  let tapTimer = 0;
  const peek = (on) => footer.classList.toggle('is-peek', on);
  footerBtn.addEventListener('pointerenter', (event) => {
    if (event.pointerType !== 'touch') peek(true);
  });
  footerBtn.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'touch') peek(false);
  });
  footerBtn.addEventListener('focus', () => peek(true));
  footerBtn.addEventListener('blur', () => peek(false));
  footerBtn.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'touch') return;
    peek(true);
    clearTimeout(tapTimer);
    tapTimer = setTimeout(() => peek(false), 1800);
  });
}
