// Troy landing: the gold thread.
// One continuous gold line from Troy's feet in the hero to the chat bubble he sleeps on in the footer.
// The route is built from where the sections are right now: it leaves the hero between the phones,
// swings from one side gutter to the other between sections, loops in the open painting, runs through
// the engine's five circles, and ends at the footer bubble. It draws with the scroll and un-draws on the way up.
// Only stroke-dashoffset, opacity and transform are written per frame. Reduced motion: fully drawn, static.
//
// scene.js reads window.__troyThread to move Troy along the same path.

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const NS = 'http://www.w3.org/2000/svg';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const byId = (id) => document.getElementById(id);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const n1 = (v) => Math.round(v * 10) / 10;

const STEP = 6;          // px between samples of the finished path
const TIP_AT = 0.6;      // the drawing tip sits about this far down the screen
const RATE = 3;          // at most this many px of line per px of scroll, so crossings don't flash by

// Stable pseudo-random numbers, so the route keeps its shape when the page is measured again.
function rnd(a, b) {
  const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return v - Math.floor(v);
}

/* ---------- The overlay ---------- */

const svgEl = (name, attrs = {}) => {
  const node = document.createElementNS(NS, name);
  Object.keys(attrs).forEach((key) => node.setAttribute(key, attrs[key]));
  return node;
};

const wrap = document.createElement('div');
wrap.id = 'thread';
wrap.setAttribute('aria-hidden', 'true');
const svg = svgEl('svg', { focusable: 'false' });
const defs = svgEl('defs');
const clip = svgEl('clipPath', { id: 'thread-clip', clipPathUnits: 'userSpaceOnUse' });
const clipShape = svgEl('path', { 'clip-rule': 'evenodd' });
clip.appendChild(clipShape);
defs.appendChild(clip);
const group = svgEl('g', { 'clip-path': 'url(#thread-clip)' });
const shade = svgEl('path', { class: 'thread-shade' });
const line = svgEl('path', { class: 'thread-line' });
const tip = svgEl('g', { class: 'thread-tip' });
tip.appendChild(svgEl('circle', { class: 'thread-tip-glow', r: '11' }));
tip.appendChild(svgEl('circle', { class: 'thread-tip-dot', r: '4.5' }));
group.appendChild(shade);
group.appendChild(line);
group.appendChild(tip);
svg.appendChild(defs);
svg.appendChild(group);
wrap.appendChild(svg);
document.body.appendChild(wrap);

/* ---------- State shared with scene.js ---------- */

const S = {
  xs: null, ys: null, n: 0,
  map: [],            // [[scrollY, length], ...] ascending
  cur: 0, last: 0, raf: 0, first: true, sig: '',
};

const api = {
  ready: false,
  version: 0,
  total: 0,
  tip: 0,             // length drawn right now
  target: 0,          // length the scroll position asks for
  secs: [],           // per section (same order as scene.js): { L: where it passes the perch, end: where a rider stops }
  // Point on the thread at a length, in document coordinates.
  at(l) {
    if (!S.n) return { x: 0, y: 0 };
    const f = clamp(l / api.total, 0, 1) * S.n;
    const i = Math.min(S.n - 1, Math.floor(f));
    const u = f - i;
    return { x: lerp(S.xs[i], S.xs[i + 1], u), y: lerp(S.ys[i], S.ys[i + 1], u) };
  },
  // Length of the point on the thread closest to a document point.
  nearest(x, y) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i <= S.n; i += 1) {
      const dx = S.xs[i] - x;
      const dy = S.ys[i] - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return S.n ? (best / S.n) * api.total : 0;
  },
};
window.__troyThread = api;

/* ---------- Measuring the page ---------- */

function geometry() {
  const sy = window.scrollY;
  const viewW = document.documentElement.clientWidth;
  const viewH = window.innerHeight;
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return {
      left: r.left, right: r.right, top: r.top + sy, bottom: r.bottom + sy,
      width: r.width, height: r.height, cx: r.left + r.width / 2, cy: r.top + sy + r.height / 2,
    };
  };
  const radius = (el) => parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
  const narrow = viewW < 768;
  const main = $('main');
  const footerEl = byId('footer');
  const heroEl = byId('hero');
  const troyEl = byId('troy-hero');
  const bubbleEl = $('.sleep-bubble');

  const g = { viewW, viewH, narrow, secs: [], holes: [] };
  g.hero = heroEl ? box(heroEl) : null;
  g.troy = troyEl && troyEl.getBoundingClientRect().width ? box(troyEl) : null;
  g.phones = heroEl ? $$('.phone', heroEl).map((el) => ({ ...box(el), r: radius(el) })).filter((b) => b.height) : [];
  g.phones.forEach((b) => g.holes.push(b));

  // Same list and order as scene.js: every top-level section but the hero that takes up room.
  $$('main > section').forEach((sec) => {
    if (sec.id === 'hero') return;
    const panel = $('.panel', sec) || sec;
    const b = box(panel);
    if (!b.height) return;
    const bg = getComputedStyle(panel).backgroundColor.match(/[\d.]+/g) || [];
    const solid = bg.length >= 3 && (bg.length < 4 || Number(bg[3]) > 0.5);
    const item = { ...b, r: radius(panel), solid, id: sec.id, circles: null };
    // The engine's circles, when they sit in one row.
    const circles = narrow ? [] : $$('.engine-circle', sec).map(box).filter((c) => c.width);
    if (circles.length >= 2 && circles.every((c) => Math.abs(c.cy - circles[0].cy) < 4)) {
      item.circles = circles.sort((p, q) => p.cx - q.cx);
      item.circles.forEach((c) => g.holes.push({ ...c, r: c.width / 2 }));
    }
    // The thread passes behind paper panels. Not on narrow screens, where panels fill the width.
    item.behind = solid && !item.circles && !narrow;
    if (item.behind) g.holes.push(item);
    g.secs.push(item);
  });

  g.footer = footerEl ? box(footerEl) : null;
  g.bubble = bubbleEl && bubbleEl.getBoundingClientRect().width ? box(bubbleEl) : null;
  const ends = [g.footer, main ? box(main) : null].filter(Boolean).map((b) => b.bottom);
  g.docH = Math.max(viewH, ...ends);
  return g;
}

function signature(g) {
  const parts = [g.viewW, g.viewH, g.docH];
  const add = (b) => { if (b) parts.push(b.left, b.right, b.top, b.bottom); };
  add(g.hero);
  add(g.troy);
  add(g.bubble);
  g.holes.forEach(add);
  g.secs.forEach(add);
  return parts.map(Math.round).join(',');
}

/* ---------- The route ---------- */

function route(g) {
  const pts = [];
  const marks = [];       // waypoints whose length along the finished path is needed later
  const add = (x, y) => {
    pts.push({ x: clamp(x, 4, g.viewW - 4), y });
    return pts.length - 1;
  };
  const mark = (kind, sec = -1) => marks.push({ kind, sec, i: pts.length - 1 });
  const last = () => pts[pts.length - 1];

  // One turn of a loop, travelling in direction d (1 right, -1 left) along its bottom.
  const loop = (cx, cy, r, d, lead) => {
    if (lead) add(cx - d * r * 2.3, cy + r * 0.78);
    for (let k = 0; k <= 8; k += 1) {
      const a = (k / 8) * Math.PI * 2;
      add(cx + d * r * Math.sin(a) + d * k * r * 0.04, cy + r * Math.cos(a));
    }
    if (lead) add(cx + d * r * 2.6, cy + r * 0.7);
  };

  // From where the thread is to a point on the far side: a slow S across the open painting, or a loop.
  const cross = (to, withLoop, seed) => {
    const from = last();
    const dx = to.x - from.x;
    const d = Math.sign(dx) || 1;
    const midY = (from.y + to.y) / 2;
    const room = Math.max(24, to.y - from.y);
    if (Math.abs(dx) < 240) {
      add(lerp(from.x, to.x, 0.5) + (rnd(seed, 1) - 0.5) * 16, midY);
      return;
    }
    const amp = clamp(room * 0.16, 6, 22);
    if (withLoop) {
      const r = clamp(room * 0.3, 14, 34);
      add(lerp(from.x, to.x, 0.2), midY + amp * 0.5);
      loop(lerp(from.x, to.x, 0.5), midY - r * 0.1, r, d, true);
      add(lerp(from.x, to.x, 0.82), midY - amp * 0.6);
      return;
    }
    add(lerp(from.x, to.x, 0.2 + rnd(seed, 2) * 0.06), midY + amp * 0.9);
    add(lerp(from.x, to.x, 0.47 + rnd(seed, 3) * 0.08), midY - amp);
    add(lerp(from.x, to.x, 0.76 + rnd(seed, 4) * 0.06), midY + amp * 0.8);
  };

  // Down a side gutter in gentle, uneven S-curves. Spacing is counted from the top so it stays put as a panel grows.
  const wander = (x, amp, y0, y1, seed) => {
    let y = y0 + 140 + rnd(seed, 5) * 90;
    for (let k = 0; y < y1 - 110; k += 1) {
      const side = (k + seed) % 2 ? 1 : -1;
      add(x + side * amp * (0.55 + 0.45 * rnd(seed, 10 + k)), y);
      y += 210 + rnd(seed, 40 + k) * 150;
    }
  };

  const lane = (sec, right) => {
    if (g.narrow) return { x: g.viewW - 10, amp: 4.5 };
    const gutter = Math.max(0, right ? g.viewW - sec.right : sec.left);
    const off = sec.behind ? Math.min(gutter * 0.5, 26) : Math.min(gutter * 0.5, 64);
    const amp = sec.behind ? Math.min(gutter * 0.42, 40) : Math.min(gutter * 0.3, 36);
    return { x: right ? sec.right + off : sec.left - off, amp };
  };

  // Start: Troy's feet in the hero, then down between the phones.
  let start;
  if (g.troy) start = { x: g.troy.cx, y: g.troy.bottom - 8 };
  else if (g.hero) start = { x: g.viewW / 2, y: g.hero.top + g.hero.height * 0.5 };
  else start = { x: g.viewW / 2, y: 0 };
  add(start.x, start.y);
  mark('start');
  let below = start.y;
  g.phones.forEach((p) => { below = Math.max(below, p.bottom); });
  if (g.hero) below = Math.min(below, g.hero.bottom - 20);
  const sorted = g.phones.slice().sort((p, q) => p.left - q.left);
  let gap = 0;
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    if (sorted[i].right <= start.x && start.x <= sorted[i + 1].left) gap = sorted[i + 1].left - sorted[i].right;
  }
  const sway = gap ? Math.min(gap * 0.22, 14) : 10;
  let k = 0;
  for (let y = start.y + 90; y < below - 40; y += 130, k += 1) add(start.x + (k % 2 ? -1 : 1) * sway, y);
  add(start.x - sway * 0.5, below + 22);
  mark('free');

  // Sections: in at the top corner where Troy perches, down that side, out at the bottom.
  g.secs.forEach((sec, i) => {
    const right = g.narrow || i % 2 === 0;
    const a = lane(sec, right);
    if (g.narrow) {
      // One side gutter all the way down, with a small swing into the open painting between sections.
      const from = last();
      add(g.viewW - clamp((sec.top - from.y) * 0.5, 14, 44), (from.y + sec.top) / 2);
    } else {
      cross({ x: a.x, y: sec.top + 6 }, i === 0, i + 1);
    }
    add(a.x, sec.top + 6);
    mark('in', i);

    if (sec.circles) {
      // The engine: down to the row of circles, through all five, out the other side.
      const b = lane(sec, !right);
      const y = sec.circles[0].cy;
      const d = right ? -1 : 1;
      const row = right ? sec.circles.slice().reverse() : sec.circles;
      wander(a.x, a.amp, sec.top + 6, y - 60, i + 1);
      add(a.x, y - 60);
      mark('stop', i);
      add((right ? sec.right : sec.left) + d * 22, y + 3);
      row.forEach((c, j) => {
        add(c.cx, y);
        if (j + 1 < row.length) add((c.cx + row[j + 1].cx) / 2, y + (j % 2 ? -7 : 7));
      });
      add((right ? sec.left : sec.right) - d * 22, y - 3);
      add(b.x, y + 64);
      wander(b.x, b.amp, y + 64, sec.bottom - 10, i + 31);
      add(b.x, sec.bottom - 10);
    } else {
      wander(a.x, a.amp, sec.top + 6, sec.bottom - 10, i + 1);
      add(a.x, sec.bottom - 10);
    }
    mark('out', i);
  });

  // The footer: one last loop in the open night sky, then the chat bubble Troy sleeps on.
  if (g.bubble) {
    const from = last();
    const d = from.x >= g.bubble.cx ? -1 : 1;
    const end = { x: d < 0 ? g.bubble.right - 10 : g.bubble.left + 10, y: g.bubble.top + g.bubble.height * 0.44 };
    const span = Math.abs(from.x - end.x);
    const r = clamp(span * 0.2, 10, 34);
    const top = g.footer ? g.footer.top : from.y + 60;
    if (end.y - from.y > 120) add(from.x + d * Math.min(30, span * 0.2), lerp(Math.max(from.y, top), end.y, 0.45));
    if (span > 60) loop(lerp(from.x, end.x, 0.5), end.y - r * 0.5, r, d, span > 320);
    add(end.x, end.y);
  }
  mark('end');
  return { pts, marks };
}

// A smooth curve through every waypoint. Handles are capped so uneven spacing never kinks or overshoots.
function curve(pts) {
  let d = `M${n1(pts[0].x)} ${n1(pts[0].y)}`;
  for (let i = 0; i + 1 < pts.length; i += 1) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const cap = Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.45;
    const handle = (ax, ay) => {
      const len = Math.hypot(ax, ay) || 1;
      const f = Math.min(1, cap / len);
      return [ax * f, ay * f];
    };
    const [ax, ay] = handle((p2.x - p0.x) / 6, (p2.y - p0.y) / 6);
    const [bx, by] = handle((p3.x - p1.x) / 6, (p3.y - p1.y) / 6);
    d += `C${n1(p1.x + ax)} ${n1(p1.y + ay)} ${n1(p2.x - bx)} ${n1(p2.y - by)} ${n1(p2.x)} ${n1(p2.y)}`;
  }
  return d;
}

function roundRect(b) {
  const r = Math.min(b.r || 0, b.width / 2, b.height / 2);
  const x = n1(b.left);
  const y = n1(b.top);
  const x2 = n1(b.right);
  const y2 = n1(b.bottom);
  if (r < 1) return `M${x} ${y}H${x2}V${y2}H${x}Z`;
  const q = n1(r);
  return `M${n1(b.left + r)} ${y}H${n1(b.right - r)}A${q} ${q} 0 0 1 ${x2} ${n1(b.top + r)}V${n1(b.bottom - r)}`
    + `A${q} ${q} 0 0 1 ${n1(b.right - r)} ${y2}H${n1(b.left + r)}A${q} ${q} 0 0 1 ${x} ${n1(b.bottom - r)}`
    + `V${n1(b.top + r)}A${q} ${q} 0 0 1 ${n1(b.left + r)} ${y}Z`;
}

/* ---------- Build ---------- */

function build() {
  const g = geometry();
  const sig = signature(g);
  if (sig === S.sig) return;
  S.sig = sig;

  const { pts, marks } = route(g);
  if (pts.length < 2) return;

  wrap.style.height = Math.round(g.docH) + 'px';
  svg.setAttribute('width', g.viewW);
  svg.setAttribute('height', Math.round(g.docH));
  svg.setAttribute('viewBox', `0 0 ${g.viewW} ${Math.round(g.docH)}`);
  clipShape.setAttribute('d', `M0 0H${g.viewW}V${Math.round(g.docH)}H0Z` + g.holes.map(roundRect).join(''));

  const d = curve(pts);
  line.setAttribute('d', d);
  shade.setAttribute('d', d);
  const total = line.getTotalLength();
  if (!(total > 0)) return;

  // Sample the finished path once; everything else reads the samples.
  const n = Math.max(2, Math.ceil(total / STEP));
  const xs = new Float32Array(n + 1);
  const ys = new Float32Array(n + 1);
  for (let i = 0; i <= n; i += 1) {
    const p = line.getPointAtLength((i / n) * total);
    xs[i] = p.x;
    ys[i] = p.y;
  }
  S.xs = xs;
  S.ys = ys;
  S.n = n;
  api.total = total;

  // Where each marked waypoint is along the path. Marks are in order, so each search starts at the one before.
  let from = 0;
  marks.forEach((m) => {
    const p = pts[m.i];
    let best = from;
    let bestD = Infinity;
    for (let i = from; i <= n; i += 1) {
      const dx = xs[i] - p.x;
      const dy = ys[i] - p.y;
      const dist = dx * dx + dy * dy;
      if (dist < bestD) {
        bestD = dist;
        best = i;
      }
    }
    from = best;
    m.L = (best / n) * total;
    m.y = p.y;
  });
  marks[0].L = 0;
  marks[marks.length - 1].L = total;

  // For Troy: where the thread passes each section's perch, and how far he may ride it from there.
  api.secs = g.secs.map((sec, i) => {
    const inL = marks.find((m) => m.kind === 'in' && m.sec === i).L;
    const stop = marks.find((m) => m.kind === 'stop' && m.sec === i);
    const next = marks.find((m) => m.kind === 'in' && m.sec === i + 1);
    return { L: inL, end: stop ? stop.L : (next ? next.L : Math.max(inL, total - 260)) };
  });

  // Scroll position to length drawn. Each mark is reached when it is about 60% down the screen;
  // short steep stretches (the crossings) borrow scroll from both sides so they draw at a readable pace.
  const maxScroll = Math.max(1, g.docH - g.viewH - 24);
  const s = marks.map((m) => m.y - g.viewH * TIP_AT);
  const grow = s.map(() => 0);
  for (let j = 0; j + 1 < marks.length; j += 1) {
    const need = (marks[j + 1].L - marks[j].L) / RATE;
    const span = s[j + 1] - s[j];
    if (span < need) {
      grow[j] -= (need - span) / 2;
      grow[j + 1] += (need - span) / 2;
    }
  }
  for (let j = 0; j < s.length; j += 1) s[j] += grow[j];
  s[0] = 0;
  for (let j = 1; j < s.length; j += 1) s[j] = Math.max(s[j], s[j - 1] + (marks[j].L - marks[j - 1].L) / (RATE * 2));
  s[s.length - 1] = maxScroll;
  for (let j = s.length - 2; j >= 0; j -= 1) s[j] = clamp(s[j], 0, s[j + 1]);
  S.map = marks.map((m, j) => [s[j], m.L]);

  line.style.strokeDasharray = `${n1(total)} ${n1(total + 20)}`;
  shade.style.strokeDasharray = `${n1(total)} ${n1(total + 20)}`;
  api.version += 1;
  api.ready = true;
  api.target = lengthFor(window.scrollY);
  if (S.first || reduced) {
    S.first = false;
    S.cur = api.target;
  }
  paint();
  requestTick();
}

function lengthFor(sy) {
  if (reduced) return api.total;
  const map = S.map;
  if (!map.length) return 0;
  if (sy <= map[0][0]) return map[0][1];
  for (let j = 1; j < map.length; j += 1) {
    if (sy <= map[j][0]) {
      const span = map[j][0] - map[j - 1][0];
      return span > 0 ? lerp(map[j - 1][1], map[j][1], (sy - map[j - 1][0]) / span) : map[j][1];
    }
  }
  return api.total;
}

/* ---------- Drawing with the scroll ---------- */

function paint() {
  const l = S.cur;
  api.tip = l;
  const off = n1(api.total - l);
  line.style.strokeDashoffset = off;
  shade.style.strokeDashoffset = off;
  line.style.opacity = l < 1 ? '0' : '1';
  shade.style.opacity = l < 1 ? '0' : '1';
  if (reduced) return;
  const p = api.at(l);
  tip.style.transform = `translate(${n1(p.x)}px, ${n1(p.y)}px)`;
  tip.style.opacity = l < 6 || l > api.total - 3 ? '0' : '1';
}

function tick(stamp) {
  S.raf = 0;
  const dt = Math.min(0.05, Math.max(0.001, (stamp - S.last) / 1000));
  S.last = stamp;
  const gap = api.target - S.cur;
  if (Math.abs(gap) < 0.6) S.cur = api.target;
  else {
    S.cur += gap * (1 - Math.exp(-dt * 12));
    requestTick();
  }
  paint();
}

function requestTick() {
  if (S.raf || !api.ready) return;
  S.last = performance.now();
  S.raf = requestAnimationFrame(tick);
}

function onScroll() {
  if (!api.ready) return;
  api.target = lengthFor(window.scrollY);
  requestTick();
}

/* ---------- Keeping it fresh ---------- */

let pending = 0;
function rebuildSoon() {
  if (pending) return;
  pending = requestAnimationFrame(() => {
    pending = 0;
    try {
      build();
    } catch (error) {
      // Without the thread the page still works; Troy falls back to his own hops.
      api.ready = false;
      wrap.style.display = 'none';
    }
  });
}

if (reduced) wrap.classList.add('is-static');
window.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', rebuildSoon, { passive: true });
window.addEventListener('load', rebuildSoon);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(rebuildSoon);
// Sections grow as conversations play, so the route follows them.
if ('ResizeObserver' in window && $('main')) new ResizeObserver(rebuildSoon).observe($('main'));
rebuildSoon();
