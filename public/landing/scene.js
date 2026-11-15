// Troy landing: scene motion.
// Day to night crossfade, the problem section's lines, connection chips, the mouse depth effect,
// and Troy himself: one traveling mascot that lands in the hero, perches on each section as
// it comes into view, and falls asleep on the footer's chat bubble. Between perches he travels along
// the gold thread (thread.js) and rides just behind its drawing tip.
// While the pinned "day at USC" scene (#demos with a sticky stage) is on screen, the sky follows its clock
// ("day:stop") and Troy stays perched on a top corner of the stage; "day:idle" makes him pop forward and nod.
// Only opacity and transform are written. Under reduced motion everything is static.

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const byId = (id) => document.getElementById(id);

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const clamp01 = (x) => clamp(x, 0, 1);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (x) => x * x * (3 - 2 * x);
const easeOut = (u) => 1 - (1 - u) * (1 - u);
const easeIn = (u) => u * u;

// Piecewise keyframes: [[time, value, ease], ...]
function kf(t, frames) {
  if (t <= frames[0][0]) return frames[0][1];
  for (let i = 1; i < frames.length; i += 1) {
    if (t <= frames[i][0]) {
      const [t0, v0] = frames[i - 1];
      const [t1, v1, ease] = frames[i];
      const u = (t - t0) / (t1 - t0);
      return v0 + (v1 - v0) * (ease ? ease(u) : u);
    }
  }
  return frames[frames.length - 1][1];
}

/* ---------- Day to night ---------- */

const skyEl = $('#sky');
const skyGolden = $('#sky-golden');
const skyNight = $('#sky-night');

let stars = null;
if (!reduced && skyEl) {
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
  skyEl.appendChild(stars);
}

// The pinned day scene drives the sky once its script has spoken ("day:stop"). Until then the positions below do.
const demosEl = byId('demos');
const day = { on: false, tod: 0, range: null, g: 0, n: 0, tg: 0, tn: 0, raf: 0, last: 0 };

// The sticky stage inside the pinned scene, if the page has one.
function stickyIn(sec) {
  if (!sec || sec.id !== 'demos') return null;
  const kids = sec.querySelectorAll(':scope > *, :scope > * > *');
  for (let i = 0; i < kids.length; i += 1) {
    if (getComputedStyle(kids[i]).position === 'sticky') {
      return kids[i].getBoundingClientRect().height < sec.getBoundingClientRect().height - 40 ? kids[i] : null;
    }
  }
  return null;
}

// Scroll positions (of the middle of the viewport) where each fade begins and ends.
let fade = null;
let lineRange = null;
let viewH = window.innerHeight;
let viewW = document.documentElement.clientWidth;

function measure() {
  const y = window.scrollY;
  viewH = window.innerHeight;
  viewW = document.documentElement.clientWidth;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {
      top: r.top + y, bottom: r.bottom + y, left: r.left, right: r.right,
      width: r.width, height: r.height, mid: r.top + y + r.height / 2,
    };
  };
  const first = (ids) => ids.map(byId).find(Boolean);

  // Day to night from whatever sections exist. Looked up by id; missing ones fall back to neighbours.
  const all = $$('main > section');
  const footerEl = byId('footer');
  const docEnd = footerEl ? box(footerEl).top : document.documentElement.scrollHeight - viewH;
  const dayEl = first(['problem', 'hero']) || all[0];
  if (dayEl) {
    const goldenStart = box(dayEl).bottom;                    // day until the end of "The problem"
    const goldenEl = first(['lost-found']) || all[all.indexOf(dayEl) + 1];
    let goldenEnd = goldenEl ? box(goldenEl).bottom : goldenStart + viewH;
    goldenEnd = clamp(goldenEnd, goldenStart + viewH * 0.5, goldenStart + viewH * 1.6);
    const nightEl = first(['safe', 'next', 'faq']);           // night from the top of "Safe by design"
    let nightEnd = nightEl ? box(nightEl).top : docEnd - viewH * 0.5;
    const lastDemo = first(['broken', 'food', 'concern', 'demos']);    // golden hour until the demos end
    let nightStart = lastDemo ? box(lastDemo).bottom : nightEnd - viewH * 1.4;
    nightStart = Math.max(nightStart, goldenEnd);
    nightEnd = Math.max(nightEnd, nightStart + viewH * 0.5);
    fade = { goldenStart, goldenEnd, nightStart, nightEnd };
  }

  day.range = demosEl && demosEl.getBoundingClientRect().height ? box(demosEl) : null;

  // Problem lines: all four are complete when the cards are centered in the viewport.
  const pairs = $('.pairs');
  if (pairs) {
    const b = box(pairs);
    lineRange = { start: b.top - viewH * 0.3, end: b.mid };
  }

  measureTroy(box, all, footerEl);
}

let lastGolden = -1;
let lastNight = -1;

function setOpacity(el, value) {
  if (el) el.style.opacity = String(value);
}

function applySky(golden, night) {
  // Day stays at full opacity underneath; golden fades in over it, then night over golden.
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

const round3 = (v) => Math.round(v * 1000) / 1000;

function paintSky() {
  const mid = window.scrollY + viewH / 2;
  if (day.on && day.range) {
    // The scene's clock: day before it, night after it, its own time of day while it is on screen.
    // Day for stops I and II, golden hour at III, dusk blending at IV, night by V.
    const tod = mid < day.range.top ? 0 : (mid > day.range.bottom ? 1 : day.tod);
    let golden = smooth(clamp01((tod - 0.3) / 0.2));
    let night = smooth(clamp01((tod - 0.56) / 0.4));
    if (reduced) {
      applySky(golden >= 0.5 ? 1 : 0, night >= 0.5 ? 1 : 0);
      return;
    }
    golden = round3(golden);
    night = round3(night);
    if (lastGolden < 0) {
      day.g = golden;
      day.n = night;
      applySky(golden, night);
      return;
    }
    // Eased over time, so a clock that moves in steps never makes the sky jump.
    day.tg = golden;
    day.tn = night;
    if (!day.raf && (golden !== lastGolden || night !== lastNight)) {
      day.g = lastGolden;
      day.n = lastNight;
      day.last = performance.now();
      day.raf = requestAnimationFrame(easeSky);
    }
    return;
  }
  if (!fade) return;
  let golden;
  let night;
  if (reduced) {
    // Simple fades: each painting switches at the halfway point and CSS fades it.
    golden = mid >= (fade.goldenStart + fade.goldenEnd) / 2 ? 1 : 0;
    night = mid >= (fade.nightStart + fade.nightEnd) / 2 ? 1 : 0;
  } else {
    golden = round3(smooth(clamp01((mid - fade.goldenStart) / Math.max(1, fade.goldenEnd - fade.goldenStart))));
    night = round3(smooth(clamp01((mid - fade.nightStart) / Math.max(1, fade.nightEnd - fade.nightStart))));
  }
  applySky(golden, night);
}

function easeSky(stamp) {
  day.raf = 0;
  const dt = clamp((stamp - day.last) / 1000, 0.001, 0.05);
  day.last = stamp;
  const k = 1 - Math.exp(-dt * 5);
  const step = (cur, to) => {
    const v = cur + (to - cur) * k;
    return Math.abs(to - v) < 0.004 ? to : v;
  };
  day.g = step(day.g, day.tg);
  day.n = step(day.n, day.tn);
  applySky(round3(day.g), round3(day.n));
  if (day.g !== day.tg || day.n !== day.tn) day.raf = requestAnimationFrame(easeSky);
}

window.addEventListener('day:stop', (event) => {
  const d = (event && event.detail) || {};
  let tod = d.tod == null ? NaN : Number(d.tod);
  if (!Number.isFinite(tod)) {
    // No time of day given: five stops, I to V, spread evenly from morning to night.
    const i = d.index == null ? NaN : Number(d.index);
    const p = Number(d.progress);
    if (!Number.isFinite(i)) return;
    tod = (i + (Number.isFinite(p) ? clamp01(p) : 0)) / 4;
  }
  day.on = true;
  day.tod = clamp01(tod);
  requestFrame();
});

/* ---------- Problem section lines ---------- */

const lines = $$('.pair-line');
const lineShown = lines.map(() => -1);

lines.forEach((line) => {
  const fill = document.createElement('span');
  fill.className = 'pair-line-fill';
  line.appendChild(fill);
});

function connectLines() {
  // Progress follows the scroll position both ways. Each line starts a little after the one before it.
  if (!lineRange || !lines.length) return;
  const mid = window.scrollY + viewH / 2;
  const p = clamp01((mid - lineRange.start) / Math.max(1, lineRange.end - lineRange.start));
  const lag = 0.18;
  const span = 1 + lag * (lines.length - 1);
  lines.forEach((line, i) => {
    const v = Math.round(clamp01(p * span - i * lag) * 500) / 500;
    if (v === lineShown[i]) return;
    lineShown[i] = v;
    line.style.setProperty('--line-p', String(v));
    line.classList.toggle('is-connected', v >= 1);
  });
}

/* ---------- Troy, the traveling mascot ---------- */

const BOX = 140;                 // Troy's box at full size, in px
const FEET = 0.94;               // where his feet are in the box (matches the CSS transform origin)
const heroSpot = byId('troy-hero');
const sleepSpot = byId('troy-sleep');
const footer = byId('footer');
const heroConvo = $('#hero .convo');
const qr = byId('qr');
const sleepBubble = $('.sleep-bubble');

// Cached anchor positions in document coordinates.
const A = { hero: null, footer: null, secs: [], stamp: 0 };

function measureTroy(box, all, footerEl) {
  const spot = (el) => {
    if (!el) return null;
    const b = box(el);
    if (!b.width) return null;
    return { x: (b.left + b.right) / 2, y: b.bottom, s: b.width / BOX };
  };
  A.hero = spot(heroSpot);
  A.footer = footerEl ? spot(sleepSpot) : null;
  const narrow = viewW < 768;
  A.secs = [];
  A.stamp += 1;
  all.forEach((sec) => {
    if (sec.id === 'hero') return;
    const stage = stickyIn(sec);             // the pinned scene is measured by its tall wrapper
    const b = box(stage ? sec : ($('.panel', sec) || sec));
    if (!b.height) return;
    const i = A.secs.length;
    let right = narrow || i % 2 === 0;       // alternate sides; always top right on narrow screens
    const s = narrow ? 0.4 : 0.6;
    let pin = null;
    if (stage) {
      // His corner of the stage: the one away from the clock, so he never sits on it.
      const r = stage.getBoundingClientRect();
      const clock = $('[class*="clock"], [id*="clock"]', sec);
      const c = clock ? clock.getBoundingClientRect() : null;
      if (c && c.width) right = c.left + c.width / 2 < r.left + r.width / 2;
      const edge = narrow ? 40 : 64;
      pin = {
        right,
        x: right ? Math.min(r.right, viewW) - edge : Math.max(r.left, 0) + edge,
        cx: clamp(r.left + r.width / 2, 0, viewW),
        h: r.height,
        stick: parseFloat(getComputedStyle(stage).top) || 0,
      };
    }
    const gutter = right ? viewW - b.right : b.left;
    const inset = narrow ? 56 : 68;
    A.secs.push({
      pin,
      top: b.top,
      bottom: b.bottom,
      s,
      face: right ? -1 : 1,                  // he looks toward the content
      x: right ? b.right - inset : b.left + inset,
      y: b.top + 3 + BOX * (1 - FEET) * s,   // sitting on the top edge
      sideOk: !narrow && gutter >= 100,      // room to float beside the panel
      sideX: right ? b.right + gutter / 2 : b.left - gutter / 2,
    });
  });
}

const T = {
  el: null, pose: null, eyes: null, eyeL: null, eyeR: null, helmet: null,
  key: null, hop: null, intro: null, cur: null,
  sq: 0, sqV: 0,                 // squash spring
  dip: 0, dipV: 0, dipOn: '',    // what he landed on dips a few px
  helmT: 0, shakeT: 0,
  blinks: [], nextBlink: 0,
  sleep: 0, sleepTarget: 0,
  gx: 0, gy: 0, lean: 0, pk: 0, peek: false,
  seq: [], parked: null, fixed: null, last: 0, clock: 0,
  th: null, thv: -1, thStamp: -1, curL: null,   // the gold thread he travels along (built by thread.js)
  pop: null, pops: 0,            // the pop forward in the pinned scene, at most twice per visit
  release: null,                 // lets the hero conversation start once he has landed
};

// Where the top of the pinned stage is on screen: it scrolls in, sticks, then leaves with the end of its wrapper.
function stageTop(sec, sy) {
  return Math.min(Math.max(sec.pin.stick, sec.top - sy), sec.bottom - sec.pin.h - sy);
}

// The gold thread, when thread.js has drawn it and its sections line up with ours. Without it he hops in free arcs.
function syncThread() {
  const th = window.__troyThread;
  if (!th || !th.ready || !(th.total > 0) || !th.secs || th.secs.length !== A.secs.length) {
    T.th = null;
    return;
  }
  T.th = th;
  if (th.version !== T.thv || A.stamp !== T.thStamp) {
    T.thv = th.version;
    T.thStamp = A.stamp;
    T.curL = null;
  }
}

// How far along the thread an anchor is.
function keyL(key) {
  const th = T.th;
  if (!key || key === 'hero') return 0;
  if (key === 'footer') return th.total;
  const i = Number(key.slice(key.indexOf(':') + 1));
  const sec = th.secs[i];
  if (!sec) return 0;
  // Riding beside a panel: just behind the drawing tip, from this section's perch to the next one.
  // Perched on the pinned stage he is off the thread; his place on it is kept beside the tip, so he joins it nearby.
  if (key[0] === 's' || key[0] === 'p') return clamp(th.tip - 26, sec.L, Math.max(sec.L, sec.end));
  return sec.L;
}

// Mouse depth
const M = { x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0, cx: 0, cy: 0, has: false };
const written = new Map();
function setT(el, value) {
  if (!el || written.get(el) === value) return;
  written.set(el, value);
  el.style.transform = value;
}

// Where an anchor is on screen right now (viewport coordinates of the bottom center of his box).
function anchorPos(key, sy) {
  if (key === 'hero' && A.hero) {
    return { x: A.hero.x, y: A.hero.y - sy, s: A.hero.s, par: 1, face: 0, bob: 5, fixed: false };
  }
  if (key === 'footer' && A.footer) {
    return { x: A.footer.x, y: A.footer.y - sy, s: A.footer.s, par: 1, face: 0, bob: 0, fixed: false };
  }
  const sec = A.secs[Number(key.slice(key.indexOf(':') + 1))];
  if (!sec) return T.cur || { x: viewW / 2, y: -200, s: 0.6, par: 0, face: 0, bob: 0, fixed: true };
  if (key[0] === 'p' && sec.pin) {
    // The pinned scene: on the stage's top edge as it scrolls in, then tucked into its top corner for as long as it is pinned.
    const top = stageTop(sec, sy);
    const y = Math.max(top + 3 + BOX * (1 - FEET) * sec.s, Math.min(14, top + 14) + BOX * sec.s);
    return { x: sec.pin.x, y, s: sec.s, par: 0, face: sec.pin.right ? -1 : 1, bob: 2, fixed: true };
  }
  if (key[0] === 's' && T.th) {
    // Riding the thread beside a tall panel, just behind the tip as it draws.
    const p = T.th.at(keyL(key));
    return { x: p.x, y: p.y - sy + BOX * (1 - FEET) * sec.s, s: sec.s, par: 0, face: sec.face, bob: 3, fixed: false };
  }
  if (key[0] === 's') {
    // Floating in the painting beside a tall panel, so he stays with the visitor.
    return { x: sec.sideX, y: Math.min(190, sec.bottom - sy - 24), s: sec.s, par: 1, face: sec.face, bob: 8, fixed: true };
  }
  return { x: sec.x, y: sec.y - sy, s: sec.s, par: 0, face: sec.face, bob: 2, fixed: false };
}

function keyIndex(key) {
  if (!key || key === 'hero') return -1;
  if (key === 'footer') return A.secs.length;
  return Number(key.slice(key.indexOf(':') + 1));
}

// Which anchor should he be at for this scroll position. Small hysteresis so he doesn't flip-flop.
function pickKey(sy) {
  const cur = keyIndex(T.key);
  let idx = -1;
  if (T.th) {
    // With the thread, he goes where its drawing tip has reached.
    const tip = T.th.target;
    if (A.footer && tip >= T.th.total - (T.key === 'footer' ? 340 : 230)) return 'footer';
    for (let i = 0; i < A.secs.length; i += 1) {
      if (tip >= T.th.secs[i].L - (cur >= i ? 90 : 30)) idx = i;
    }
  } else {
    if (A.footer && A.footer.y - sy < viewH * (T.key === 'footer' ? 0.97 : 0.88)) return 'footer';
    for (let i = 0; i < A.secs.length; i += 1) {
      if (A.secs[i].top - sy < viewH * (cur >= i ? 0.68 : 0.6)) idx = i;
    }
  }
  if (idx < 0) return A.hero ? 'hero' : (A.secs.length ? 't:0' : 'footer');
  const sec = A.secs[idx];
  if (sec.pin) return 'p:' + idx;            // one perch for the whole pinned scene: nothing inside it moves him
  const side = sec.sideOk && sec.top - sy < (T.key === 's:' + idx ? 150 : 100);
  return (side ? 's:' : 't:') + idx;
}

function at(delay, fn) {
  T.seq.push({ at: T.clock + delay, fn });
}
const blink = (now, dur = 150) => T.blinks.push({ t0: now, dur });

function startHop(key, now, sy) {
  const from = T.cur || anchorPos(key, sy);
  const to = anchorPos(key, sy);
  const fromY = clamp(from.y, -180, viewH + 180);   // if he was left off screen, come in from the edge
  const dist = Math.hypot(to.x - from.x, to.y - fromY);
  const fall = key === 'footer';
  if (T.key === 'footer') {
    // Waking up
    T.sleepTarget = 0;
    if (footer) footer.classList.remove('is-asleep');
    blink(now + 120);
  }
  T.seq.length = 0;
  T.pop = null;
  // Along the thread: from where he is on it to where the new anchor is. If he was left off screen,
  // he joins it at the edge of the screen instead.
  let path = null;
  if (T.th) {
    const th = T.th;
    const l1 = keyL(key);
    let l0 = T.curL != null ? T.curL : keyL(T.key);
    const seen = (l) => {
      const y = th.at(l).y - sy;
      return y > -170 && y < viewH + 170;
    };
    let moved = false;
    const step = Math.sign(l1 - l0) * 24;
    while (step && Math.abs(l1 - l0) > 24 && !seen(l0)) {
      l0 += step;
      moved = true;
    }
    const p0 = th.at(l0);
    const foot = BOX * (1 - FEET) * from.s;
    path = {
      l0,
      len: Math.abs(l1 - l0),
      ox: moved ? 0 : from.x - p0.x,
      oy: moved ? 0 : fromY - (p0.y - sy) - foot,
    };
  }
  T.hop = {
    path,
    to: key,
    from: { x: from.x, y: from.fixed ? fromY : fromY + sy, s: from.s, par: from.par, bob: from.bob, fixed: from.fixed },
    t0: now,
    dur: path ? clamp(380 + path.len * 0.42, 460, 1250)
      : (fall ? clamp(420 + dist * 0.5, 520, 900) : clamp(380 + dist * 0.3, 420, 760)),
    arc: path ? (fall ? 30 : 20) : (fall ? 36 : clamp(40 + dist * 0.16, 50, 150)),
    dir: Math.sign(to.x - from.x),
    fall,
  };
  T.key = key;
}

function land(hop, now) {
  if (hop.to === 'footer') {
    T.sqV += 6;
    T.dipV += 130;
    T.dipOn = 'footer';
    at(140, () => { T.shakeT = T.clock; });
    at(520, () => blink(T.clock));
    at(900, () => blink(T.clock, 620));       // one long slow blink
    at(1500, () => { T.sleepTarget = 1; });
    at(2100, () => { if (footer) footer.classList.add('is-asleep'); });
  } else {
    T.sqV += 3.6;
    at(260, () => blink(T.clock));
  }
}

// Helmet pop after the hero impact, in SVG units (the mascot is 320 units tall), time in ms.
const HELM_Y = [
  [0, 0], [230, -80, easeOut], [330, -86, smooth], [430, -80, smooth], [600, 0, easeIn],
  [690, -18, easeOut], [780, 0, easeIn], [830, -5, easeOut], [880, 0, easeIn],
];
const HELM_R = [[0, 0], [230, 9, easeOut], [430, 6], [600, 0, easeIn], [690, -4, easeOut], [780, 0, easeIn]];
const FALL_MS = 460;
const LEAD_MS = 380;             // the gold line between the hero phones draws first (hero.css), then he falls
const POP_IN = 420;
const POP_HOLD = 1650;
const POP_OUT = 480;

function troyFrame(stamp) {
  requestAnimationFrame(troyFrame);
  const dt = Math.min(0.05, (stamp - T.last) / 1000);
  T.last = stamp;
  // His own clock: it only advances by real, capped frames, so a stalled tab never skips a beat of the landing.
  T.clock += dt * 1000;
  const now = T.clock;
  const sy = window.scrollY;

  // Springs, in small steps so a slow frame can't blow them up.
  for (let left = dt; left > 0; left -= 1 / 120) {
    const h = Math.min(left, 1 / 120);
    T.sqV += (-420 * T.sq - 20 * T.sqV) * h;
    T.sq += T.sqV * h;
    T.dipV += (-320 * T.dip - 22 * T.dipV) * h;
    T.dip += T.dipV * h;
    M.vx += ((M.tx - M.x) * 90 - M.vx * 13) * h;
    M.x += M.vx * h;
    M.vy += ((M.ty - M.y) * 90 - M.vy * 13) * h;
    M.y += M.vy * h;
  }

  // Depth: the painting moves a little against the cursor, floating things a little more.
  const fgx = -M.x * 20;
  const fgy = -M.y * 14;
  if (finePointer) {
    setT(skyEl, `translate3d(${(-M.x * 12).toFixed(2)}px, ${(-M.y * 8).toFixed(2)}px, 0) scale(1.035)`);
    setT(qr, `translate3d(${(fgx * 0.7).toFixed(2)}px, ${(fgy * 0.7).toFixed(2)}px, 0)`);
  }
  setT(heroConvo, `translate3d(${fgx.toFixed(2)}px, ${(fgy + (T.dipOn === 'hero' ? T.dip : 0)).toFixed(2)}px, 0)`);
  setT(sleepBubble, `translate3d(${fgx.toFixed(2)}px, ${(fgy + (T.dipOn === 'footer' ? T.dip : 0)).toFixed(2)}px, 0)`);

  if (!T.el) return;

  // Scheduled beats (shake, blink, fall asleep)
  for (let i = T.seq.length - 1; i >= 0; i -= 1) {
    if (now >= T.seq[i].at) T.seq.splice(i, 1)[0].fn();
  }

  // Where should he be
  let dropY = 0;
  let tilt = 0;
  let stretch = 0;
  let nod = 0;
  let popW = 0;
  if (T.intro) {
    const t = now - T.intro.t0;
    if (t < 0) return;
    if (!T.intro.shown) {
      T.intro.shown = true;
      T.intro.height = (A.hero ? A.hero.y - sy : 400) + 200;
      T.el.style.opacity = '1';
    }
    if (t < FALL_MS) {
      // Falling with acceleration
      const u = t / FALL_MS;
      dropY = -T.intro.height * (1 - u * u);
      stretch = -0.07 * u;
    } else if (!T.intro.hit) {
      T.intro.hit = true;
      T.sqV += 6.5;            // squash
      T.dipV += 130;           // the phone dips and settles
      T.dipOn = 'hero';
      T.helmT = now;           // the helmet pops off
      if (T.release) T.release();                             // now the conversation may start
      at(600, () => { T.sqV += 2.2; });                       // helmet lands back on his head
      at(880, () => { T.shakeT = T.clock; });       // shake it off
      at(1020, () => blink(T.clock));
      at(1300, () => blink(T.clock));
    }
    if (t > 1900) {
      T.intro = null;
      T.nextBlink = now + 2600;
    }
  } else {
    syncThread();
    const want = pickKey(sy);
    if (want !== T.key) startHop(want, now, sy);
  }

  let P;
  if (T.hop) {
    const h = T.hop;
    const u = clamp01((now - h.t0) / h.dur);
    const to = anchorPos(h.to, sy);
    const fy = h.from.fixed ? h.from.y : h.from.y - sy;
    const ex = h.fall ? easeOut(u) : smooth(u);
    const ey = h.fall ? u * u : smooth(u);
    const up = Math.sin(Math.PI * u);
    if (h.path && T.th) {
      // He follows the thread: eases off where he was, runs along the line, then a small hop onto the new perch.
      const th = T.th;
      const e = smooth(u);
      const l1 = keyL(h.to);
      const l = lerp(h.path.l0, l1, e);
      const p = th.at(l);
      const p1 = th.at(l1);
      const ahead = th.at(l + Math.sign(l1 - h.path.l0) * 14);
      const s = lerp(h.from.s, to.s, e);
      const w0 = 1 - smooth(clamp01(u / 0.3));
      const end = clamp01((u - 0.66) / 0.34);
      const w1 = smooth(end);
      const hopUp = Math.sin(Math.PI * end);
      const foot = BOX * (1 - FEET);
      P = {
        x: p.x + h.path.ox * w0 + (to.x - p1.x) * w1,
        y: p.y - sy + foot * s + h.path.oy * w0 + (to.y - (p1.y - sy) - foot * to.s) * w1 - hopUp * h.arc,
        s,
        par: lerp(h.from.par, to.par, e),
        bob: lerp(h.from.bob, to.bob, e),
        face: to.face,
        fixed: true,
      };
      T.curL = l;
      tilt = clamp((ahead.x - p.x) / 12, -1, 1) * 9 * up;
      stretch = -0.05 * up;
    } else {
      P = {
        x: lerp(h.from.x, to.x, ex),
        y: lerp(fy, to.y, ey) - up * h.arc,
        s: lerp(h.from.s, to.s, ex),
        par: lerp(h.from.par, to.par, ex),
        bob: lerp(h.from.bob, to.bob, ex),
        face: to.face,
        fixed: true,
      };
      tilt = h.dir * 11 * up;
      stretch = -0.06 * up;
    }
    if (u >= 1) {
      T.hop = null;
      P = anchorPos(h.to, sy);
      land(h, now);
    }
  } else {
    P = anchorPos(T.key, sy);
  }
  if (!T.hop) T.curL = T.th ? keyL(T.key) : null;

  // The pop: forward to the lower center of the stage, two nods down at what is there, back to the perch.
  if (T.pop) {
    const sec = T.key && T.key[0] === 'p' ? A.secs[keyIndex(T.key)] : null;
    const t = now - T.pop.t0;
    if (T.hop || !sec || !sec.pin || t >= POP_HOLD + POP_OUT) T.pop = null;
    else {
      let w;
      if (t < POP_IN) {
        const u = t / POP_IN - 1;
        w = 1 + 2.2 * u * u * u + 1.2 * u * u;       // a little past, then back: the bounce
      } else w = t < POP_HOLD ? 1 : 1 - smooth((t - POP_HOLD) / POP_OUT);
      if (!T.pop.hit && t >= POP_IN * 0.8) {
        T.pop.hit = true;
        T.sqV += 2.6;
      }
      const u1 = (t - POP_IN - 200) / 360;
      const u2 = (t - POP_IN - 660) / 360;
      nod = u1 > 0 && u1 < 1 ? Math.sin(Math.PI * u1) : (u2 > 0 && u2 < 1 ? Math.sin(Math.PI * u2) : 0);
      popW = clamp01(w);
      const top = stageTop(sec, sy);
      P = {
        x: lerp(P.x, sec.pin.cx, w),
        y: lerp(P.y, Math.min(top + sec.pin.h - 26, viewH - 22), w) + nod * 7 * P.s,
        s: lerp(P.s, P.s * 1.4, w),
        par: 0,
        bob: P.bob,
        face: popW > 0.4 ? 0 : P.face,
        fixed: true,
      };
      stretch += 0.06 * nod;
    }
  }
  T.cur = P;

  // Nothing to draw while he waits off screen.
  const off = !T.hop && !T.intro && (P.y < -60 || P.y - BOX > viewH + 60);
  if (off && T.parked === T.key) return;
  T.parked = off ? T.key : null;

  // Sleep
  T.sleep += (T.sleepTarget - T.sleep) * (1 - Math.exp(-dt * 3.5));
  const awake = 1 - T.sleep;

  // Shake it off: a quick left-right that dies down
  let shakeX = 0;
  let shakeR = 0;
  if (T.shakeT) {
    const u = (now - T.shakeT) / 460;
    if (u >= 1) T.shakeT = 0;
    else {
      const w = Math.sin(u * Math.PI * 5) * (1 - u);
      shakeX = w * 7 * P.s;
      shakeR = w * 8;
    }
  }

  // Helmet
  let helmY = 0;
  let helmR = 0;
  if (T.helmT) {
    const t = now - T.helmT;
    if (t > 900) T.helmT = 0;
    else {
      helmY = kf(t, HELM_Y);
      helmR = kf(t, HELM_R);
    }
  }
  helmY += 9 * nod;                              // the helmet tips forward with each nod
  helmY += 4 * T.sleep;                          // it slips a little when he sleeps
  helmR += -3 * T.sleep;

  // Eyes: blinks, and looking at the cursor
  if (!T.intro && awake > 0.9 && now > T.nextBlink) {
    blink(now);
    if (Math.random() < 0.25) blink(now + 260);
    T.nextBlink = now + 3200 + Math.random() * 3800;
  }
  let shut = 0;
  for (let i = T.blinks.length - 1; i >= 0; i -= 1) {
    const b = T.blinks[i];
    const u = (now - b.t0) / b.dur;
    if (u >= 1) T.blinks.splice(i, 1);
    else if (u > 0) shut = Math.max(shut, Math.sin(Math.PI * u));
  }
  const open = (1 - 0.9 * shut) * (1 - 0.86 * T.sleep);
  T.pk += ((T.peek && T.sleep > 0.5 ? 1 : 0) - T.pk) * (1 - Math.exp(-dt * 14));
  const openR = lerp(open, 1, T.pk);             // one eye opens for the footer button

  let lookX = P.face * 4;
  let lookY = 0;
  let leanTo = P.face * 3;
  if (finePointer && M.has) {
    const dx = M.cx - P.x;
    const dy = M.cy - (P.y - 60 * P.s);
    const d = Math.hypot(dx, dy) || 1;
    const near = Math.min(1, d / 260);
    lookX = (dx / d) * 8 * near;
    lookY = (dy / d) * 6 * near;
    leanTo = clamp(dx / 420, -1, 1) * 3.5;
  }
  if (popW) {
    // Popped forward: he looks at the visitor, then down with each nod.
    lookX = lerp(lookX, 0, popW);
    lookY = lerp(lookY, 2 + 6 * nod, popW);
    leanTo = lerp(leanTo, 0, popW);
  }
  lookY += (helmY - 9 * nod) * 0.07;             // he watches his helmet go up
  const ease = 1 - Math.exp(-dt * 10);
  T.gx += (lookX * awake - T.gx) * ease;
  T.gy += (lookY * awake - T.gy) * ease;
  T.lean += (leanTo * awake - T.lean) * (1 - Math.exp(-dt * 5));

  // Body
  const bobY = -P.bob * (0.5 + 0.5 * Math.sin(now / 716)) * awake;
  const breath = T.sleep * (0.5 + 0.5 * Math.sin(now / 605));
  const a = T.sq + stretch;
  const sx = P.s * (1 + a) * (1 + 0.02 * breath);
  const syc = P.s * (1 - a) * (1 + 0.045 * breath);
  const rot = T.lean + tilt + shakeR - 12 * T.sleep;
  const dip = (T.key === T.dipOn && !T.hop) ? T.dip : 0;
  const x = P.x + shakeX + P.par * fgx;
  let y = P.y + dropY + bobY + dip + P.par * fgy;

  // Perched: he lives in the page and scrolls with it. Hopping or floating: fixed to the screen.
  const fixed = P.fixed;
  if (fixed !== T.fixed) {
    T.fixed = fixed;
    T.el.style.position = fixed ? 'fixed' : 'absolute';
  }
  if (!fixed) y += sy;

  T.el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
  T.pose.style.transform = `rotate(${rot.toFixed(2)}deg) scale(${sx.toFixed(4)}, ${syc.toFixed(4)})`;
  T.eyes.style.transform = `translate(${T.gx.toFixed(2)}px, ${T.gy.toFixed(2)}px)`;
  T.eyeL.style.transform = `scaleY(${open.toFixed(3)})`;
  T.eyeR.style.transform = `scaleY(${openR.toFixed(3)})`;
  T.helmet.style.transform = `translate(0px, ${helmY.toFixed(2)}px) rotate(${helmR.toFixed(2)}deg)`;
}

// The hero's opening: the gold line between the two phones draws first (hero.css, html.hero-lead), then Troy
// falls, then the conversation starts. chat.js pauses a hero conversation while the pointer is over a phone,
// so the conversation is held with that same signal until he has landed.
function leadHero() {
  const root = document.documentElement;
  root.classList.add('hero-lead');
  if (!heroConvo) return;
  const phone = $('.phone', heroConvo);
  let held = false;
  let done = false;
  const signal = (name) => {
    try {
      phone.dispatchEvent(new PointerEvent(name, { pointerType: 'mouse' }));
    } catch (error) { /* the conversation just starts on its own */ }
  };
  const watch = new MutationObserver(() => {
    const cl = heroConvo.classList;
    if (!done && !held && phone && cl.contains('is-live')) {
      held = true;
      signal('pointerenter');
    }
    // The line stays gold until chat.js connects the two phones itself; from then on it is chat.js's line.
    if (cl.contains('is-linked')) {
      root.classList.remove('hero-lead');
      watch.disconnect();
    }
  });
  watch.observe(heroConvo, { attributes: true, attributeFilter: ['class'] });
  T.release = () => {
    T.release = null;
    done = true;
    if (held) signal('pointerleave');
    held = false;
  };
  setTimeout(() => { if (T.release) T.release(); }, LEAD_MS + FALL_MS + 200);   // start the conversation at impact, while he shakes it off
}

function initTroy() {
  const src = heroSpot && $('svg', heroSpot);
  if (!src) return;
  const svg = src.cloneNode(true);
  svg.removeAttribute('role');
  svg.removeAttribute('aria-label');
  // The clone needs its own gradient ids.
  $$('[id]', svg).forEach((node) => { node.id += '-t'; });
  $$('[fill^="url(#"]', svg).forEach((node) => {
    node.setAttribute('fill', node.getAttribute('fill').replace(')', '-t)'));
  });
  const el = document.createElement('div');
  el.id = 'troy-traveler';
  el.setAttribute('aria-hidden', 'true');
  const pose = document.createElement('div');
  pose.className = 'troy-pose';
  pose.appendChild(svg);
  el.appendChild(pose);
  document.body.appendChild(el);

  const eyes = $$('.troy-eye', svg);
  Object.assign(T, {
    el, pose, eyes: $('.troy-eyes', svg), eyeL: eyes[0], eyeR: eyes[1], helmet: $('.troy-helmet', svg),
  });
  if (!T.eyes || !T.eyeL || !T.eyeR || !T.helmet) throw new Error('mascot parts missing');

  const sy = window.scrollY;
  const key = pickKey(sy);
  T.key = key;
  if (key === 'hero' && A.hero && A.hero.y - sy > 0) {
    // The landing: he waits above the screen, then falls onto the phone.
    // The gold line between the phones leads; he waits above the screen until it is drawn.
    T.intro = { t0: T.clock + LEAD_MS };
    el.style.opacity = '0';
    leadHero();
  } else if (key === 'footer') {
    T.sleep = 1;
    T.sleepTarget = 1;
    if (footer) footer.classList.add('is-asleep');
  }
  T.nextBlink = T.clock + 3000;
  document.documentElement.classList.add('troy-travel');
}

if (!reduced && finePointer) {
  window.addEventListener('pointermove', (event) => {
    if (event.pointerType && event.pointerType !== 'mouse') return;
    M.cx = event.clientX;
    M.cy = event.clientY;
    M.has = true;
    // The scene shifts while the cursor is over the hero, the footer or any open painting.
    const overPanel = event.target && event.target.closest && event.target.closest('.panel');
    if (!overPanel) {
      M.tx = clamp((event.clientX / viewW) * 2 - 1, -1, 1);
      M.ty = clamp((event.clientY / viewH) * 2 - 1, -1, 1);
    }
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => {
    M.has = false;
    M.tx = 0;
    M.ty = 0;
  });
}

// The pinned scene has gone quiet: Troy pops forward and nods at it. At most twice per visit.
window.addEventListener('day:idle', () => {
  if (!T.el || T.pop || T.hop || T.intro || T.pops >= 2 || !T.key || T.key[0] !== 'p') return;
  const sec = A.secs[keyIndex(T.key)];
  if (!sec || !sec.pin || sec.top - window.scrollY > viewH * 0.5) return;   // only once the stage is up
  T.pops += 1;
  T.pop = { t0: T.clock, hit: false };
});

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

if (!reduced) {
  try {
    initTroy();
  } catch (error) {
    // Fall back to the two still mascots in the page.
    if (T.el) T.el.remove();
    T.el = null;
    document.documentElement.classList.add('troy-static');
  }
  T.last = performance.now();
  requestAnimationFrame(troyFrame);
}

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

/* ---------- Troy in the footer: z's and the one-eye peek ---------- */

const sleepWrap = $('.footer-sleep');
const footerBtn = footer && $('.btn', footer);

if (!reduced && sleepWrap) {
  for (let i = 0; i < 3; i += 1) {
    const z = document.createElement('span');
    z.className = 'sleep-z';
    z.textContent = 'z';
    sleepWrap.appendChild(z);
  }
}

if (!reduced && footer && footerBtn) {
  // Troy opens one eye while the visitor hovers, focuses or taps the button.
  let tapTimer = 0;
  const peek = (on) => {
    T.peek = on;
    footer.classList.toggle('is-peek', on);
  };
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
