/* Troy: the "under the hood" page (panel.html).
   Draws the engine as an isometric machine (five carved blocks on a stepped platform, one per step, with the gold
   thread running through them), fills its readouts from the same data the feeds use, replays the most recent real
   match along the thread, and renders the proof strip and the feeds.
   The page asks for the data (TroyData.api, landing/demo.js) and hands it to TroyEngine.render(). Nothing here
   makes a request. Every figure comes from that data; a figure the data does not have is left out. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MASK = "•••• hidden until verified";
  const LIST_CAP = 40; // the server sends at most this many verifications and handoffs

  /** The five steps, in the landing page's own words (index.html, "One engine behind every connection"). */
  const STEPS = [
    { num: "I", name: "Understand", does: "your text or photo and figure out what you need" },
    { num: "II", name: "Find", does: "the right person or office by need, time and distance" },
    { num: "III", name: "Verify", does: "that it's a real match before anyone is connected" },
    { num: "IV", name: "Connect", does: "both sides with a group chat, a relayed message or an alert" },
    { num: "V", name: "Follow up", does: "with you when something changes, so you never have to chase anyone" },
  ];

  const state = {
    data: null,
    demo: false,
    staff: false,
    directory: null,   // number of directory entries, once the page has asked
    model: null,       // readouts and the replayed match, made by derive()
    pinned: null,      // step index whose detail panel is pinned
    layout: null,      // "wide" or "tall"
    view: null,        // the current drawing's elements
    firstLoad: true,
  };

  // ---------- small helpers ----------

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) n.append(kid);
    return n;
  }
  const words = (s) => String(s || "").replace(/_/g, " ");
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const clip = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s; };
  const plural = (n, one, many) => (n === 1 ? one : many);
  const now = () => (window.TroyData ? window.TroyData.now() : Date.now());

  function ago(ms) {
    const s = Math.max(0, Math.round((now() - ms) / 1000));
    if (s < 10) return "just now";
    if (s < 60) return s + " sec ago";
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " hr ago";
    return Math.floor(s / 86400) + " days ago";
  }

  /** A small bracketed tag: [example], [verified], [fallback]. The brackets are drawn in CSS. */
  const tg = (text, kind) => el("span", { class: "tg" + (kind ? " " + kind : ""), text });
  const exampleTag = (on) => (on ? tg("example", "eg") : null);
  const idTag = (n) => el("span", { class: "id", text: "#" + n });
  const ts = (ms) => el("span", { class: "ts", text: ago(ms) });

  const METHOD = { blind_description: "blind description", name_match: "name match", finder_confirm: "finder confirms", proof_photo: "proof photo", finder_judgment: "finder's call" };
  const HANDOFF = { group_chat: "group chat with finder and owner", relay: "relay through Troy", dps_code: "DPS pickup code" };
  const HANDOFF_SHORT = { group_chat: "group chat", relay: "relay", dps_code: "DPS code" };

  // ---------- isometric drawing ----------
  // One projection for everything: x runs down to the right at 30 degrees, y down to the left at 30 degrees, z up.

  const C = Math.cos(Math.PI / 6);
  const S = 0.5;
  const r1 = (n) => String(Math.round(n * 10) / 10);
  const P = (x, y, z) => [(x - y) * C, (x + y) * S - (z || 0)];
  const pts = (list) => list.map((p) => r1(p[0]) + "," + r1(p[1])).join(" ");
  const at = (p) => r1(p[0]) + " " + r1(p[1]);
  const CS = C.toFixed(4);
  /** Matrices that lay flat artwork onto a face: the top (u along x, v along y), the left face (u along x, v down)
      and the right face (u along y, v down). */
  const onTop = (x, y, z) => `matrix(${CS} ${S} -${CS} ${S} ${at(P(x, y, z))})`;
  const onLeft = (x, y, z) => `matrix(${CS} ${S} 0 1 ${at(P(x, y, z))})`;
  const onRight = (x, y, z) => `matrix(-${CS} ${S} 0 1 ${at(P(x, y, z))})`;

  /** The three visible faces of a box. */
  function box(x0, y0, z0, x1, y1, z1, cls) {
    const k = cls ? " " + cls : "";
    return `<polygon class="f fl${k}" points="${pts([P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0)])}"/>` +
      `<polygon class="f fr${k}" points="${pts([P(x1, y0, z1), P(x1, y1, z1), P(x1, y1, z0), P(x1, y0, z0)])}"/>` +
      `<polygon class="f ft${k}" points="${pts([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)])}"/>`;
  }
  const topPoly = (x0, y0, x1, y1, z, cls) => `<polygon class="${cls}" points="${pts([P(x0, y0, z), P(x1, y0, z), P(x1, y1, z), P(x0, y1, z)])}"/>`;
  const line = (a, b, cls, extra) => `<line class="${cls}" x1="${r1(a[0])}" y1="${r1(a[1])}" x2="${r1(b[0])}" y2="${r1(b[1])}"${extra || ""}/>`;

  /** The Greek key (the same drawing the site's key rule uses), carved along a left face. */
  function keyFrieze(x0, x1, y, zTop, height) {
    const len = x1 - x0, unit = 15, n = Math.floor((len - 20) / unit), pad = (len - n * unit) / 2, v0 = (height - 12) / 2;
    let d = "";
    for (let i = 0; i < n; i++) {
      const u = pad + i * unit;
      d += `M${r1(u)} ${r1(v0 + 10.5)}h15M${r1(u + 1.5)} ${r1(v0 + 10.5)}v-9h12v6h-9v-3h6`;
    }
    return `<path class="key" transform="${onLeft(x0, y, zTop)}" d="${d}"/>`;
  }

  /** Roman numerals as carved strokes with bars, so they still read as numerals when laid on a face. Centered on 0,0. */
  function numeral(num, cls, transform, scale) {
    const t = -12, b = 12;
    const I = (x) => `M${x} ${t}V${b}`;
    const bars = (x0, x1) => `M${x0} ${t}H${x1}M${x0} ${b}H${x1}`;
    const d = {
      I: I(0) + bars(-5, 5),
      II: I(-5) + I(5) + bars(-10, 10),
      III: I(-10) + I(0) + I(10) + bars(-15, 15),
      IV: I(-12) + bars(-17, -7) + `M-3 ${t}L6 ${b}L15 ${t}M-7 ${t}H1M11 ${t}H19`,
      V: `M-9 ${t}L0 ${b}L9 ${t}M-13 ${t}H-5M5 ${t}H13`,
    }[num];
    return `<path class="${cls}" transform="${transform}${scale ? ` scale(${scale})` : ""}" d="${d}"/>`;
  }

  /** The thread between two points: a dashed line where nothing has passed, and the gold line that draws over it. */
  function thread(k, a, b) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return line(a, b, "th") + line(a, b, "th-on", ` data-seg="${k}" data-len="${r1(len)}" stroke-dasharray="${r1(len)}" stroke-dashoffset="${r1(len)}"`);
  }

  /** The four text lines of one block's readout, starting at (x, y). */
  function readoutText(i, x, y) {
    const s = STEPS[i];
    return `<text class="ro-label" x="${r1(x)}" y="${r1(y + 4)}"><tspan class="ro-num">${s.num}</tspan><tspan dx="9">${s.name.toUpperCase()}</tspan></text>` +
      `<g class="ro-data"><text class="ro-fig" x="${r1(x)}" y="${r1(y + 31)}"><tspan class="n" data-n></tspan><tspan class="u" dx="8" data-u></tspan></text>` +
      `<text class="ro-sub" x="${r1(x)}" y="${r1(y + 48)}" data-sub></text>` +
      `<text class="ro-replay" x="${r1(x)}" y="${r1(y + 65)}" data-replay></text></g>`;
  }

  const bubble = (p) => `<g class="src" transform="translate(${at(p)})"><path class="src-b" d="M-19 -13h38a9 9 0 0 1 9 9v8a9 9 0 0 1 -9 9h-30l-9 7l2 -8.6a9 9 0 0 1 -10 -7.4v-8a9 9 0 0 1 9 -9z" transform="translate(-4 -1)"/><path class="src-l" d="M-15 -4h22M-15 3h14"/></g>`;
  const person = (p) => `<g class="dst" transform="translate(${at(p)})"><circle class="dst-c" r="13"/><circle class="dst-d" r="3.2"/></g>`;
  const TOKEN = `<g class="tok" data-token opacity="0"><circle class="tok-ring" r="9"/><circle class="tok-dot" r="4.5"/></g>`;

  /** Desktop: the five blocks in a row along the x axis on a stepped platform, satellites in front of it. */
  function buildWide() {
    const B = 96, IN = 9, BH = 9, H = 48, SP = 180, Z1 = BH + H, TZ = BH + H / 2, TY = B / 2;
    const X0 = -60, X1 = 4 * SP + B + 60, Y0 = -44, Y1 = B + 44, PT = 20, ST = 12, SW = 16, G = -(PT + ST);
    const bx0 = (i) => i * SP + IN, bx1 = (i) => i * SP + B - IN;
    const start = P(-176, TY, TZ), end = P(X1 + SW + 92, TY, TZ);
    const segs = [];
    for (let k = 0; k <= 5; k++) segs.push({ from: k === 0 ? start : P(bx1(k - 1), TY, TZ), to: k === 5 ? end : P(bx0(k) - 24, TY, TZ) });

    let s = "";
    // The platform: two steps, the Greek key along the upper one.
    s += `<g class="plat">` + box(X0 - SW, Y0 - SW, G, X1 + SW, Y1 + SW, -PT, "low") + box(X0, Y0, -PT, X1, Y1, 0, "up") + keyFrieze(X0, X1, Y1, 0, PT) + `</g>`;

    // What the engine talks to, joined to the platform by dashed lines along the y axis.
    const YB = 262, front = Y1 + SW;
    const tie = (x, y) => line(P(x, front, G), P(x, y, G), "tie");
    const satLabel = (left, bottom, name, sub, key) => `<text class="sat-name" x="${r1(left[0])}" y="${r1(bottom[1] + 20)}">${name}</text><text class="sat-sub" x="${r1(left[0])}" y="${r1(bottom[1] + 36)}"${key ? ` data-sat="${key}"` : ""}>${sub}</text>`;
    s += `<g class="sats">`;
    // two models: a larger and a smaller block
    s += tie(62, YB) + tie(117, YB + 22) + box(34, YB, G, 90, YB + 56, G + 42, "sat") + box(100, YB + 22, G, 134, YB + 56, G + 24, "sat");
    s += satLabel(P(34, YB + 56, G), P(134, YB + 56, G), "TWO MODELS", "one large, one small");
    // campus places: a low tablet with a few marked spots
    s += tie(262, YB) + box(228, YB, G, 296, YB + 68, G + 7, "sat");
    s += `<g class="spots" transform="${onTop(228, YB, G + 7)}">` + [[16, 18], [40, 12], [52, 34], [24, 44], [46, 54]].map((c) => `<circle cx="${c[0]}" cy="${c[1]}" r="3.4"/>`).join("") + `</g>`;
    s += satLabel(P(228, YB + 68, G), P(296, YB + 68, G), "CAMPUS PLACES", "walking times in code");
    // directory: a stack of tablets
    s += tie(442, YB);
    for (let t = 0; t < 3; t++) s += box(414, YB, G + t * 11, 470, YB + 56, G + t * 11 + 7, "sat");
    s += satLabel(P(414, YB + 56, G), P(470, YB + 56, G), "DIRECTORY", "offices and committees", "directory");
    // staff dashboard: an upright slab with rows on its face
    s += tie(622, YB + 20) + box(586, YB + 12, G, 658, YB + 38, G + 5, "sat") + box(592, YB + 20, G + 5, 652, YB + 30, G + 55, "sat");
    s += `<path class="rows" transform="${onLeft(592, YB + 30, G + 55)}" d="M9 11h42M9 21h30M9 31h36M9 41h22"/>`;
    s += satLabel(P(586, YB + 38, G), P(658, YB + 38, G), "STAFF DASHBOARD", "DPS, facilities, USG");
    s += `</g>`;

    // The blocks, back to front, each after the thread that runs into it.
    for (let i = 0; i < 5; i++) {
      const x0 = i * SP, a0 = bx0(i), a1 = bx1(i), size = a1 - a0;
      s += thread(i, segs[i].from, segs[i].to);
      s += `<g class="blk" data-step="${i}" tabindex="0" role="button" aria-pressed="false">`;
      s += box(x0, 0, 0, x0 + B, B, BH, "base") + box(a0, IN, BH, a1, B - IN, Z1, "body");
      s += topPoly(a0 + 7, IN + 7, a1 - 7, B - IN - 7, Z1, "inset");
      s += numeral(STEPS[i].num, "numeral", onTop(a0 + size / 2, TY, Z1));
      s += `<g class="lit">` + topPoly(a0, IN, a1, B - IN, Z1, "lit-face") + numeral(STEPS[i].num, "numeral", onTop(a0 + size / 2, TY, Z1)) + `</g>`;
      s += `<circle class="port" r="5" transform="${onRight(a1, TY, TZ)}"/>`;
      s += `</g>`;
    }
    s += thread(5, segs[5].from, segs[5].to);
    s += bubble(start) + `<text class="end-label" x="${r1(start[0] - 22)}" y="${r1(start[1] - 26)}">A TEXT OR PHOTO</text>`;
    s += person(end) + `<text class="end-label" x="${r1(end[0] + 24)}" y="${r1(end[1] + 4)}">PERSON OR OFFICE</text>`;

    // Readouts: a leader along the y axis from each block's top edge, then the figures.
    for (let i = 0; i < 5; i++) {
      const a = P(i * SP + B / 2, IN, Z1), b = P(i * SP + B / 2, IN - 160, Z1);
      s += `<g class="ro" data-ro="${i}"><polyline class="leader" points="${pts([a, b, [b[0] + 14, b[1]]])}"/><circle class="leader-dot" cx="${r1(a[0])}" cy="${r1(a[1])}" r="2.2"/>` + readoutText(i, b[0] + 22, b[1]) + `</g>`;
    }

    // Legend, bottom right.
    const lx = 880, ly = 532;
    s += `<g class="legend"><line class="th-key-on" x1="${lx}" y1="${ly}" x2="${lx + 30}" y2="${ly}"/><text x="${lx + 40}" y="${ly + 4}">a message has passed</text>` +
      `<line class="th" x1="${lx}" y1="${ly + 18}" x2="${lx + 30}" y2="${ly + 18}"/><text x="${lx + 40}" y="${ly + 22}">not yet</text>` +
      `<line class="tie" x1="${lx}" y1="${ly + 36}" x2="${lx + 30}" y2="${ly + 36}"/><text x="${lx + 40}" y="${ly + 40}">what the engine talks to</text></g>`;
    s += TOKEN;
    return { svg: s, viewBox: "-262 -140 1322 722", segs, clipAt: 26 };
  }

  /** Phones: the same five blocks stacked along the z axis, the thread running down through them. */
  function buildTall() {
    const B = 68, IN = 7, BH = 7, H = 38, PZ = 123, c = B / 2;
    const zb = (i) => -i * PZ, zt = (i) => zb(i) + BH + H;
    const top = (i) => P(c, c, zt(i));            // where the thread enters a block
    const under = (i) => P(B, B, zb(i));          // where it shows again below the block
    const PT = 14, ST = 9, E1 = 7, E2 = 13, platTop = zb(4), low = platTop - PT - ST;
    const start = [0, top(0)[1] - 62], end = [0, P(B + E2, B + E2, low)[1] + 40];
    const segs = [];
    for (let k = 0; k <= 5; k++) segs.push({ from: k === 0 ? start : under(k - 1), to: k === 5 ? end : top(k) });
    segs[5].from = P(B + E2, B + E2, low);

    let s = "";
    s += `<g class="plat">` + box(-E2, -E2, low, B + E2, B + E2, platTop - PT, "low") + box(-E1, -E1, platTop - PT, B + E1, B + E1, platTop, "up") + keyFrieze(-E1, B + E1, B + E1, platTop, PT) + `</g>`;
    for (let i = 4; i >= 0; i--) {
      const size = B - 2 * IN;
      s += `<g class="blk" data-step="${i}" tabindex="0" role="button" aria-pressed="false">`;
      s += box(0, 0, zb(i), B, B, zb(i) + BH, "base") + box(IN, IN, zb(i) + BH, B - IN, B - IN, zt(i), "body");
      s += `<g class="lit">` + topPoly(IN, IN, B - IN, B - IN, zt(i), "lit-face") + `</g>`;
      s += numeral(STEPS[i].num, "numeral", onLeft(IN + size / 2, B - IN, zt(i) - H / 2), 0.8);
      s += `<circle class="port" r="5" transform="${onTop(c, c, zt(i))}"/>`;
      s += `</g>`;
    }
    for (let k = 0; k <= 5; k++) s += thread(k, segs[k].from, segs[k].to);
    s += bubble(start) + `<text class="end-label" x="34" y="${r1(start[1] + 3)}">A TEXT OR PHOTO</text>`;
    s += person(end) + `<text class="end-label" x="24" y="${r1(end[1] + 4)}">PERSON OR OFFICE</text>`;
    for (let i = 0; i < 5; i++) {
      const a = P(B - IN, IN, zt(i));
      s += `<g class="ro" data-ro="${i}"><polyline class="leader" points="${pts([a, [a[0] + 30, a[1]]])}"/><circle class="leader-dot" cx="${r1(a[0])}" cy="${r1(a[1])}" r="2.2"/>` + readoutText(i, a[0] + 36, a[1] - 8) + `</g>`;
    }
    s += TOKEN;
    const y0 = start[1] - 26, y1 = end[1] + 24;
    return { svg: s, viewBox: `-97 ${r1(y0)} 360 ${r1(y1 - y0)}`, segs, clipAt: 18 };
  }

  // ---------- the drawing on the page ----------

  const wideQuery = window.matchMedia("(min-width: 1120px)");
  const stillQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

  function draw() {
    const stage = $("stage");
    if (!stage) return;
    const layout = wideQuery.matches ? "wide" : "tall";
    state.layout = layout;
    const built = layout === "wide" ? buildWide() : buildTall();
    stage.innerHTML = `<svg class="eng-svg ${layout}" viewBox="${built.viewBox}" role="group" aria-label="Troy's engine: five blocks, one for each step, with a gold thread running through them">${built.svg}</svg>`;
    const q = (sel) => [...stage.querySelectorAll(sel)];
    const view = {
      built,
      blocks: q(".blk").sort((a, b) => a.dataset.step - b.dataset.step),
      segs: q(".th-on").sort((a, b) => a.dataset.seg - b.dataset.seg),
      readouts: q(".ro").sort((a, b) => a.dataset.ro - b.dataset.ro),
      token: stage.querySelector("[data-token]"),
      sat: { directory: stage.querySelector('[data-sat="directory"]') },
    };
    state.view = view;
    view.blocks.forEach((g, i) => {
      let wasPinned = false;
      g.addEventListener("pointerdown", () => { wasPinned = state.pinned === i; });
      g.addEventListener("focus", () => pin(i));
      g.addEventListener("click", () => { pin(wasPinned ? null : i); wasPinned = state.pinned === i; });
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pin(state.pinned === i ? null : i); }
        else if (e.key === "Escape") pin(null);
      });
    });
    fillEngine();
    markPinned();
    replay.restart();
    replay.watch(stage);
  }

  /** Put the current figures into the drawing. A readout with no figure in the data is hidden. */
  function fillEngine() {
    const view = state.view, m = state.model;
    if (!view) return;
    view.readouts.forEach((g, i) => {
      const a = m && m.agg[i];
      const data = g.querySelector(".ro-data");
      data.style.display = a ? "" : "none";
      const set = (sel, text) => { const n = g.querySelector(sel); if (n.textContent !== text) n.textContent = text; };
      if (a) { set("[data-n]", String(a.n)); set("[data-u]", a.unit); set("[data-sub]", a.sub || ""); }
      const line = m && m.replay[i];
      set("[data-replay]", line ? "› " + clip(line, view.built.clipAt + 8) : "");
      const s = STEPS[i];
      view.blocks[i].setAttribute("aria-label", "Step " + s.num + ", " + s.name + (a ? ". " + a.n + " " + a.unit + (a.sub ? ", " + a.sub : "") : "") + ". Press to pin its detail.");
    });
    if (view.sat.directory && isNum(state.directory)) view.sat.directory.textContent = state.directory + " offices and committees";
    const tags = $("sat-tags");
    if (tags) {
      const want = ["two models", "campus places", isNum(state.directory) ? "directory, " + state.directory + " entries" : "directory", "staff dashboard"];
      if (tags.dataset.k !== want.join("|")) { tags.dataset.k = want.join("|"); tags.replaceChildren(el("span", { class: "sat-tags-l", text: "Talks to" }), ...want.map((w) => tg(w))); }
    }
    replay.sync();
  }

  // ---------- the replay: a token along the thread ----------

  const replay = (() => {
    const MOVE = 850, DWELL = 950, HOLD = 2600, GAP = 500;
    let phases = [], idx = 0, t = 0, last = null, raf = 0, visible = true;

    const reach = () => (state.model ? state.model.reach : 0);
    const complete = () => !!(state.model && state.model.complete);

    function plan() {
      phases = [];
      const r = reach();
      for (let k = 0; k < r; k++) { phases.push({ kind: "move", k, ms: MOVE }); phases.push({ kind: "dwell", k, ms: DWELL }); }
      if (r === 5 && complete()) phases.push({ kind: "move", k: 5, ms: MOVE });
      phases.push({ kind: "hold", ms: HOLD }, { kind: "gap", ms: GAP });
    }

    function setSeg(k, share) {
      const seg = state.view && state.view.segs[k];
      if (seg) seg.setAttribute("stroke-dashoffset", r1(Number(seg.dataset.len) * (1 - share)));
    }
    function clear() {
      const v = state.view;
      if (!v) return;
      for (let k = 0; k < v.segs.length; k++) setSeg(k, 0);
      v.blocks.forEach((b) => b.classList.remove("lit-on", "passed"));
      v.readouts.forEach((r) => r.classList.remove("tick"));
      v.token.setAttribute("opacity", "0");
      trace(-1);
    }
    function enter(p) {
      const v = state.view;
      if (p.kind === "dwell") {
        setSeg(p.k, 1);
        v.blocks[p.k].classList.add("lit-on", "passed");
        v.readouts[p.k].classList.add("tick");
        v.token.setAttribute("opacity", "0");
        trace(p.k);
      } else if (p.kind === "gap") clear();
    }
    function leave(p) {
      const v = state.view;
      if (p.kind === "dwell") v.blocks[p.k].classList.remove("lit-on");
      if (p.kind === "move") setSeg(p.k, 1);
    }
    function paint(p, share) {
      if (p.kind !== "move") return;
      const v = state.view, seg = v.built.segs[p.k];
      const e = share < 0.5 ? 2 * share * share : 1 - Math.pow(-2 * share + 2, 2) / 2;
      const x = seg.from[0] + (seg.to[0] - seg.from[0]) * e, y = seg.from[1] + (seg.to[1] - seg.from[1]) * e;
      v.token.setAttribute("transform", `translate(${r1(x)} ${r1(y)})`);
      v.token.setAttribute("opacity", String(Math.max(0, Math.min(1, share / 0.15, (1 - share) / 0.18)).toFixed(2)));
      setSeg(p.k, e);
    }
    function frame(ts) {
      raf = 0;
      if (!running()) return;
      if (last !== null) t += Math.min(100, ts - last);
      last = ts;
      let p = phases[idx];
      while (p && t >= p.ms) {
        t -= p.ms;
        leave(p);
        idx = (idx + 1) % phases.length;
        if (idx === 0) plan();
        p = phases[idx];
        enter(p);
      }
      if (p) paint(p, t / p.ms);
      raf = requestAnimationFrame(frame);
    }
    const running = () => visible && !document.hidden && !stillQuery.matches && !!state.view && reach() > 0;
    function kick() {
      if (raf || !running()) return;
      last = null;
      raf = requestAnimationFrame(frame);
    }
    /** With reduced motion: everything the replayed match has reached, shown at once and left alone. */
    function still() {
      const v = state.view;
      if (!v) return;
      clear();
      const r = reach();
      for (let k = 0; k < r; k++) { setSeg(k, 1); v.blocks[k].classList.add("passed"); v.readouts[k].classList.add("tick"); }
      if (r === 5 && complete()) setSeg(5, 1);
      trace(r - 1);
    }
    function restart() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0; idx = 0; t = 0; last = null;
      plan();
      clear();
      if (stillQuery.matches) still(); else kick();
    }
    /** New data arrived: keep the loop going, start it if there is now something to replay. */
    function sync() {
      if (stillQuery.matches) still();
      else if (!raf) { plan(); idx = 0; t = 0; clear(); kick(); }
    }
    document.addEventListener("visibilitychange", kick);
    stillQuery.addEventListener("change", restart);
    // Off screen, the token stops. The stage is watched afresh after every redraw, so its new size is what counts.
    const io = "IntersectionObserver" in window ? new IntersectionObserver((entries) => { for (const e of entries) visible = e.isIntersecting; kick(); }) : null;
    function watch(stage) {
      if (!io) return;
      io.disconnect();
      io.observe(stage);
    }
    return { restart, sync, watch };
  })();

  /** The line under the drawing that spells out what is being replayed, step by step. */
  function trace(upTo) {
    const box = $("trace");
    if (!box) return;
    box.querySelectorAll("[data-t]").forEach((n) => n.classList.toggle("on", Number(n.dataset.t) <= upTo));
  }
  function renderTrace() {
    const box = $("trace"), m = state.model;
    if (!box) return;
    const key = JSON.stringify(m ? [m.replay, m.what] : null);
    if (box.dataset.k === key) return;
    box.dataset.k = key;
    box.replaceChildren();
    if (!m || !m.reach) { box.append(el("span", { class: "trace-l", text: "Nothing to replay yet. Text Troy a photo of something you found." })); return; }
    box.append(tg("replay"), el("span", { class: "trace-l", text: m.what }));
    const list = el("ol", { class: "trace-steps" });
    m.replay.forEach((text, i) => { if (text) list.append(el("li", { "data-t": i }, el("b", { text: STEPS[i].num }), el("span", { text }))); });
    box.append(list);
  }

  // ---------- what the readouts say ----------

  /** Figures for the five blocks and the most recent real match to replay, from the panel data alone. */
  function derive(d) {
    const c = d.counts || {};
    const listings = Array.isArray(d.listings) ? d.listings : [];
    const matches = Array.isArray(d.matches) ? d.matches : [];
    const checks = Array.isArray(d.verifications) ? d.verifications : null;
    const handoffs = Array.isArray(d.handoffs) ? d.handoffs : null;
    const capped = (n) => (n >= LIST_CAP ? n + "+" : n);
    const agg = [null, null, null, null, null];

    if (isNum(c.found) && isNum(c.lost)) agg[0] = { n: c.found + c.lost, unit: "listings read", sub: c.found + " found · " + c.lost + " lost" };
    if (isNum(c.matches)) {
      const ok = matches.filter((m) => m.status === "verified").length, no = matches.filter((m) => m.status === "rejected").length;
      agg[1] = { n: c.matches, unit: "candidates ranked", sub: ok + " verified · " + no + " rejected" };
    }
    if (checks) {
      const pass = checks.filter((v) => v.result === "pass").length, fail = checks.filter((v) => v.result === "fail").length, wait = checks.length - pass - fail;
      agg[2] = { n: capped(checks.length), unit: plural(checks.length, "check run", "checks run"), sub: pass + " pass · " + fail + " fail" + (wait ? " · " + wait + " waiting" : "") };
    }
    if (handoffs) {
      const by = {};
      for (const h of handoffs) by[h.method] = (by[h.method] || 0) + 1;
      agg[3] = { n: capped(handoffs.length), unit: plural(handoffs.length, "handoff made", "handoffs made"), sub: Object.entries(by).map(([k, n]) => n + " " + (HANDOFF_SHORT[k] || words(k))).join(" · ") };
    }
    if (isNum(c.returned)) {
      const open = handoffs ? handoffs.filter((h) => !h.completedAt).length : 0;
      agg[4] = { n: c.returned, unit: "returned to the owner", sub: open ? open + " in progress" : "" };
    }

    // The most recent real match, as far as it has got: handoff, else verification, else candidate, else listing.
    const newest = (rows) => [...rows].sort((a, b) => (b.createdAt - a.createdAt) || (b.id - a.id))[0] || null;
    const hand = handoffs && handoffs.length ? newest(handoffs) : null;
    let check = !hand && checks && checks.length ? newest(checks) : null;
    const matchId = hand ? hand.matchId : check ? check.matchId : null;
    const match = matchId !== null ? matches.find((m) => m.id === matchId) || null : matches.length ? newest(matches) : null;
    if (!check && checks && (hand || match)) check = newest(checks.filter((v) => v.matchId === (hand ? hand.matchId : match.id)));
    const listing = match ? listings.find((l) => l.id === match.foundListingId) || null : listings.length ? newest(listings) : null;
    const title = (match && (match.foundTitle || match.lostTitle)) || (listing && (listing.publicSummary || listing.title || words(listing.category))) || null;

    const replayLines = [null, null, null, null, null];
    let reach = 0;
    if (title) { replayLines[0] = title; reach = 1; }
    if (match && isNum(match.confidence)) { replayLines[1] = "match #" + match.id + " · " + match.confidence + "/100 · " + (match.source === "ai" ? "ai" : "rules"); reach = 2; }
    if (check) {
      replayLines[2] = (check.score === null || check.score === undefined ? "" : check.score + " · ") + (check.result === "pass" ? "pass" : check.result === "fail" ? "fail" : "waiting") + " · " + (METHOD[check.method] || words(check.method));
      reach = 3;
    }
    if (hand) {
      replayLines[3] = (HANDOFF_SHORT[hand.method] || words(hand.method)) + " · chosen by " + hand.chosenBy;
      replayLines[4] = hand.completedAt ? "returned " + ago(hand.completedAt) : "handoff in progress";
      reach = 5;
    }
    const what = reach === 0 ? "" : match ? "match #" + match.id + ", the most recent one to get this far" : "the newest listing";
    return { agg, replay: replayLines, reach, complete: !!(hand && hand.completedAt), what };
  }

  // ---------- the feeds (and the same rows inside the pinned panel) ----------

  const seen = {};
  const lastJson = {};
  const revealed = new Set();

  /** Rebuild a section only when its data changed. Rows whose id was not on screen before slide in. */
  function section(key, box, rows, extra, emptyText, build) {
    if (!box) return;
    const json = JSON.stringify([rows, extra, state.staff]);
    if (lastJson[key] === json) return;
    lastJson[key] = json;
    const before = seen[key] || new Set();
    const fresh = new Set();
    box.replaceChildren();
    if (!rows.length) box.append(el("div", { class: "empty", text: emptyText }));
    for (const r of rows) {
      const card = build(r);
      fresh.add(r.id);
      if (!state.firstLoad && seen[key] && !before.has(r.id)) card.classList.add("new");
      box.append(card);
    }
    seen[key] = fresh;
  }

  function photo(l) {
    if (!l.hasPhoto) return null;
    if (l.photoSensitive && !state.staff) return el("div", { class: "photo locked", "aria-label": "Photo hidden" });
    const key = "l" + l.id;
    const blurred = l.photoSensitive && !revealed.has(key);
    const boxEl = el("button", { class: "photo" + (blurred ? " blurred" : ""), type: "button", "aria-label": l.photoSensitive ? "Blurred photo. Press to reveal or blur again." : "Photo",
      onclick: () => {
        if (!l.photoSensitive) return;
        if (revealed.has(key)) revealed.delete(key); else revealed.add(key);
        boxEl.classList.toggle("blurred", !revealed.has(key));
      } }, el("img", { src: "/api/photo/" + l.id + (state.staff ? "?staff=1" : ""), alt: "", loading: "lazy" }));
    return boxEl;
  }

  function hiddenBlock(label, value) {
    if (!state.staff) return el("div", { class: "hidden-line", text: MASK });
    return el("div", { class: "staff-line" }, el("b", { text: "staff only: " + label }), value || "nothing recorded");
  }

  const LISTING_STATUS_DONE = ["verified", "handed_off", "returned"];
  function listingCard(l, s) {
    const secret = (s && s.listings && s.listings[l.id]) || {};
    let hidden = null;
    if (l.hasHiddenDetails) {
      if (l.type === "found") {
        const parts = [].concat(secret.distinguishing || []);
        if (secret.nameOnItem) parts.push("name on item: " + secret.nameOnItem);
        hidden = hiddenBlock("distinguishing details", parts.join(" · "));
      } else {
        hidden = hiddenBlock("the owner's own words", secret.description);
      }
    }
    return el("div", { class: "rd" }, el("div", { class: "row" }, photo(l), el("div", { class: "body" },
      el("div", { class: "title" }, idTag(l.id), el("span", { text: l.publicSummary || l.title || words(l.category) || (l.type === "found" ? "found item" : "lost item") }), exampleTag(l.isExample)),
      el("div", { class: "meta" },
        tg(l.type, l.type),
        tg(words(l.status), LISTING_STATUS_DONE.includes(l.status) ? "ok" : l.status === "open" || l.status === "expired" ? "" : "wait"),
        l.locationText ? el("span", { text: l.locationText }) : null,
        l.heldBy ? el("span", { text: "held by " + (l.heldBy === "dps" ? "DPS" : "finder") }) : null,
        l.isDangerous ? tg("dangerous, DPS only", "bad") : null,
        ts(l.createdAt)),
      hidden)));
  }

  function matchCard(m) {
    const done = m.status === "verified";
    const share = Math.max(0, Math.min(100, m.confidence));
    return el("div", { class: "rd" },
      el("div", { class: "pair" },
        el("span", { class: "side" }, tg("found", "found"), el("span", { class: "title", text: m.foundTitle || "item " + m.foundListingId })),
        el("span", { class: "arrow", "aria-hidden": "true" }),
        el("span", { class: "side" }, tg("lost", "lost"), el("span", { class: "title", text: m.lostTitle || "report " + m.lostListingId }))),
      el("div", { class: "conf" },
        el("div", { class: "num" }, String(m.confidence), el("small", { text: "/100" })),
        el("div", { class: "bar", role: "img", "aria-label": "Confidence " + m.confidence + " out of 100" }, el("i", { style: "transform:scaleX(" + share / 100 + ")" }))),
      el("div", { class: "meta" },
        idTag(m.id),
        tg(words(m.status), done ? "ok" : m.status === "rejected" ? "bad" : "wait"),
        tg(m.source === "ai" ? "ai" : "fallback"),
        ts(m.createdAt)),
      m.reasons && m.reasons.length ? el("ul", { class: "reasons" }, m.reasons.map((r) => el("li", { text: r }))) : null);
  }

  function verificationCard(v, s) {
    const secret = (s && s.verifications && s.verifications[v.id]) || {};
    const cls = v.result === "pass" ? "pass" : v.result === "fail" ? "fail" : "";
    return el("div", { class: "rd" }, el("div", { class: "verif" },
      el("div", { class: "score " + cls, "aria-label": v.score === null ? "No score" : "Score " + v.score, text: v.score === null ? (v.result === "pass" ? "ok" : v.result === "fail" ? "no" : "...") : String(v.score) }),
      el("div", { class: "body" },
        el("div", { class: "title" }, el("span", { text: METHOD[v.method] || words(v.method) })),
        el("div", { class: "meta" },
          tg(v.result === "pass" ? "pass" : v.result === "fail" ? "fail" : "waiting", v.result === "pass" ? "ok" : v.result === "fail" ? "bad" : "wait"),
          el("span", { class: "id", text: "match #" + v.matchId }),
          el("span", { class: "ts", text: v.attempts === 1 ? "1 attempt" : v.attempts + " attempts" }),
          ts(v.createdAt)),
        v.hasAnswer ? hiddenBlock("what the owner said", secret.ownerAnswer) : null)));
  }

  function handoffCard(h, s) {
    const secret = (s && s.handoffs && s.handoffs[h.id]) || {};
    return el("div", { class: "rd" },
      el("div", { class: "title" }, el("span", { text: HANDOFF[h.method] || words(h.method) })),
      el("div", { class: "meta" },
        tg(h.completedAt ? "returned" : "in progress", h.completedAt ? "ok" : "wait"),
        el("span", { class: "id", text: "match #" + h.matchId }),
        el("span", { text: "chosen by " + h.chosenBy }),
        ts(h.completedAt || h.createdAt)),
      h.hasPickupCode ? (state.staff ? el("div", { class: "staff-line" }, el("b", { text: "staff only: pickup code" }), secret.pickupCode || "") : el("div", { class: "hidden-line", text: "pickup code •••••• made in code, texted to both" })) : null,
      h.thankYouNote ? el("div", { class: "quote", text: "“" + h.thankYouNote + "”" }) : null);
  }

  function foodCard(d) {
    const total = Math.max(0, d.servingsTotal);
    const live = d.status === "live";
    return el("div", { class: "rd" },
      el("div", { class: "title" }, el("span", { text: d.description || "food drop" }), exampleTag(d.isExample)),
      el("div", { class: "meta" },
        tg(live ? (d.servingsLeft > 0 ? "live" : "all gone") : words(d.status), live ? (d.servingsLeft > 0 ? "ok" : "wait") : ""),
        d.clubName ? el("span", { text: d.clubName }) : null,
        d.locationText ? el("span", { text: d.locationText }) : null),
      el("div", { class: "conf" },
        el("div", { class: "num" }, String(d.servingsLeft), el("small", { text: "/" + d.servingsTotal + " left" })),
        el("div", { class: "bar left", role: "img", "aria-label": d.servingsLeft + " of " + d.servingsTotal + " servings left" }, el("i", { style: "transform:scaleX(" + (total ? Math.max(0, Math.min(1, d.servingsLeft / total)) : 0) + ")" }))),
      el("div", { class: "meta" },
        el("span", { class: "ts", text: d.claims.held + " held" }),
        el("span", { class: "ts", text: d.claims.picked_up + " picked up" }),
        d.claims.released ? el("span", { class: "ts", text: d.claims.released + " released" }) : null));
  }

  // ---------- the pinned detail panel ----------

  function pin(i) {
    if (state.pinned === i) return;
    state.pinned = i;
    delete lastJson.detail;
    delete seen.detail;
    markPinned();
    renderDetail();
  }
  function markPinned() {
    if (!state.view) return;
    state.view.blocks.forEach((b, i) => { b.classList.toggle("pinned", state.pinned === i); b.setAttribute("aria-pressed", state.pinned === i ? "true" : "false"); });
    state.view.readouts.forEach((r, i) => r.classList.toggle("pinned", state.pinned === i));
  }
  function renderDetail() {
    const boxEl = $("pin"), hint = $("pin-hint"), d = state.data;
    if (!boxEl) return;
    const i = state.pinned;
    boxEl.hidden = i === null;
    if (hint) hint.hidden = i !== null;
    if (i === null || !d) return;
    const step = STEPS[i], s = d.staff || null;
    $("pin-num").textContent = step.num;
    $("pin-name").textContent = step.name;
    $("pin-does").textContent = step.does + ".";
    const rows = $("pin-rows");
    const handoffs = d.handoffs || [];
    const sets = [
      [(d.listings || []).slice(0, 3), s && s.listings, "No listings yet. Text Troy a photo of something you found.", (l) => listingCard(l, s), "latest listings"],
      [(d.matches || []).slice(0, 3), null, "No candidate matches yet.", matchCard, "top candidate matches"],
      [(d.verifications || []).slice(0, 3), s && s.verifications, "No verification attempts yet.", (v) => verificationCard(v, s), "latest checks"],
      [handoffs.slice(0, 3), s && s.handoffs, "No handoffs yet.", (h) => handoffCard(h, s), "latest handoffs"],
      [[...handoffs].sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0)).slice(0, 3), s && s.handoffs, "Nothing to follow up on yet.", (h) => handoffCard(h, s), "where each handoff stands"],
    ][i];
    $("pin-what").textContent = sets[4];
    section("detail", rows, sets[0], [i, sets[1]], sets[2], sets[3]);
  }

  // ---------- the proof strip ----------

  function setText(id, v) { const n = $(id); if (n && n.textContent !== String(v)) n.textContent = String(v); }

  /** One line per eval mode the data has: "36 of 40 with AI", "37 of 40 on rules alone". */
  function evalRuns(e) {
    const runs = [];
    const add = (r, mode) => {
      if (!r || typeof r !== "object") return;
      const total = r.total ?? r.n ?? r.count, correct = r.correct ?? r.passed, m = mode || r.mode || r.source;
      if (isNum(total) && isNum(correct)) runs.push({ total, correct, mode: m === "ai" ? "ai" : m === "fallback" || m === "rules" ? "fallback" : null });
    };
    add(e.ai, "ai");
    add(e.fallback || e.rules, "fallback");
    if (!runs.length) add(e, null);
    return runs;
  }
  function renderProof(d) {
    const e = d.eval, big = $("proof-big"), sub = $("eval-s");
    if (!e || typeof e !== "object") {
      big.hidden = true;
      setText("eval-s", "No eval run yet.");
    } else {
      const wrong = e.wrongHandoffs ?? e.wrong_handoffs;
      big.hidden = !isNum(wrong);
      if (isNum(wrong)) { setText("eval-n", wrong); setText("eval-w", plural(wrong, "wrong handoff", "wrong handoffs")); }
      const parts = evalRuns(e).map((r) => r.correct + " of " + r.total + (r.mode === "ai" ? " with AI" : r.mode === "fallback" ? " on rules alone" : " correct"));
      const key = parts.join("|");
      if (sub.dataset.k !== key) {
        sub.dataset.k = key;
        sub.replaceChildren(tg("matcher eval"), ...parts.flatMap((p, i) => (i ? [el("span", { class: "sep", text: "·" })] : []).concat(el("span", { text: p }))));
      }
    }
    const c = d.counts || {};
    for (const k of ["found", "lost", "matches", "returned"]) {
      const cell = $("t-" + k);
      if (cell) cell.hidden = !isNum(c[k]);
      if (isNum(c[k])) setText("s-" + k, c[k]);
    }
    renderChatHealth(d.chatHealth);
  }

  /** The chat brain's health number. Hidden until the server has one. A share (0 to 1) shows as a percent. */
  function renderChatHealth(h) {
    const boxEl = $("chat-stat");
    if (!boxEl) return;
    let text = null, label = "chat health";
    if (isNum(h)) text = h >= 0 && h <= 1 ? Math.round(h * 100) + "%" : String(Math.round(h));
    else if (h && typeof h === "object") {
      const total = h.total ?? h.checked ?? h.replies ?? h.n;
      const good = h.passed ?? h.ok ?? h.good ?? h.clean;
      const score = h.score ?? h.health ?? h.percent ?? h.rate;
      // Today's count of replies that fell back to a hand-written line because the checks turned the model down twice (lower is better).
      if (typeof h.doubleRejectsToday === "number") { text = String(h.doubleRejectsToday); label = "chat fallbacks today"; }
      else if (isNum(score)) text = score >= 0 && score <= 1 ? Math.round(score * 100) + "%" : String(Math.round(score));
      else if (typeof good === "number" && typeof total === "number") text = good + " of " + total;
      if (typeof h.label === "string" && h.label) label = "chat health, " + h.label;
    }
    boxEl.hidden = text === null;
    if (text === null) return;
    setText("chat-n", text);
    setText("chat-l", label);
  }

  // ---------- what the page calls ----------

  function render(d, opts) {
    state.data = d;
    state.demo = !!(opts && opts.demo);
    state.staff = !!(opts && opts.staff);
    const s = d.staff || null;
    const badge = $("badge");
    badge.className = state.demo ? "badge eg" : "badge live" + (d.enabled ? "" : " off");
    setText("badge-text", state.demo ? "example data" : d.enabled ? "live" : "troy is off (kill switch)");

    state.model = derive(d);
    renderTrace();
    if (!state.view) draw(); else fillEngine();
    renderProof(d);

    const count = (id, n) => setText(id, n);
    count("c-listings", (d.listings || []).length); count("c-matches", (d.matches || []).length); count("c-verifications", (d.verifications || []).length);
    count("c-handoffs", (d.handoffs || []).length); count("c-food", (d.foodDrops || []).length);
    section("listings", $("listings"), d.listings || [], s && s.listings, "No listings yet. Text Troy a photo of something you found.", (l) => listingCard(l, s));
    section("matches", $("matches"), d.matches || [], null, "No candidate matches yet.", matchCard);
    section("verifications", $("verifications"), d.verifications || [], s && s.verifications, "No verification attempts yet.", (v) => verificationCard(v, s));
    section("handoffs", $("handoffs"), d.handoffs || [], s && s.handoffs, "No handoffs yet.", (h) => handoffCard(h, s));
    section("food", $("food"), d.foodDrops || [], null, "No food drops yet.", foodCard);
    renderDetail();
    state.firstLoad = false;
  }

  function offline() {
    $("badge").className = "badge off";
    setText("badge-text", "server not reachable");
  }

  /** The staff view is being switched: photos blur again, as before. */
  function staffChanged() { revealed.clear(); }

  function setDirectory(n) {
    if (!isNum(n)) return;
    state.directory = n;
    fillEngine();
  }

  wideQuery.addEventListener("change", () => { if (state.view) draw(); });
  document.addEventListener("click", (e) => { if (e.target.closest && e.target.closest("#pin-close")) pin(null); });
  // The drawing is there before the data is: blocks, thread and labels, with the readouts empty.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", draw); else draw();

  window.TroyEngine = { render, offline, staffChanged, setDirectory };
})();
