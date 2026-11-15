// Troy landing: the use-case stream in "Same engine. Endless connections."
// Each category row becomes a lane. Its pills drift sideways in a seamless loop (neighboring lanes go
// opposite ways) and ride a gentle sine wave, so they rise and fall like things carried on a stream.
// One requestAnimationFrame loop sets a transform on every pill; nothing else is animated.
// The loop stops while the section is off screen or the tab is hidden. A lane pauses on hover or focus.
// With reduced motion this file does nothing and the static pill rows from page.css stay.

const rows = document.querySelector("#next .next-rows");
const motionOk = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

if (rows && motionOk) {
  const GAP = 14;                                  // px between pills
  const LOOP_SECONDS = [48, 56, 44, 40];           // time for one set of pills to pass, per lane
  const narrow = window.matchMedia("(max-width: 767px)");

  const lanes = [...rows.querySelectorAll("ul.pills")].map((list, index) => {
    const originals = [...list.children];
    list.classList.add("stream-lane");
    list.tabIndex = 0;                             // so keyboard users can stop a lane by focusing it
    return {
      list,
      originals,
      pills: [],                                   // { el, base, width }
      dir: index % 2 === 0 ? -1 : 1,               // even lanes drift left, odd lanes right
      seconds: LOOP_SECONDS[index % LOOP_SECONDS.length],
      phase: index * 1.7,
      setWidth: 0,
      total: 0,
      lead: 0,
      travel: 0,                                   // px travelled so far
      paused: false,
    };
  });
  rows.classList.add("is-stream");

  // Measure the pills and add as many hidden copies of the set as it takes to fill the lane and loop cleanly.
  const layout = () => {
    lanes.forEach((lane) => {
      lane.list.querySelectorAll("li[data-stream-copy]").forEach((copy) => copy.remove());
      const widths = lane.originals.map((li) => li.offsetWidth);
      const setWidth = widths.reduce((sum, w) => sum + w + GAP, 0);
      const widest = Math.max(...widths);
      const laneWidth = lane.list.clientWidth;
      const copies = Math.max(2, Math.ceil((laneWidth + widest) / setWidth) + 1);
      lane.pills = [];
      for (let c = 0; c < copies; c += 1) {
        let x = c * setWidth;
        lane.originals.forEach((li, i) => {
          let el = li;
          if (c > 0) {
            el = li.cloneNode(true);
            el.setAttribute("aria-hidden", "true");
            el.dataset.streamCopy = "";
            lane.list.appendChild(el);
          }
          lane.pills.push({ el, base: x, width: widths[i] });
          x += widths[i] + GAP;
        });
      }
      lane.setWidth = setWidth;
      lane.total = copies * setWidth;
      lane.lead = widest + GAP;                    // pills wrap this far outside the lane's left edge
    });
    draw();
  };

  const draw = () => {
    const amp = narrow.matches ? 7 : 11;           // how far a pill rises and falls, px
    const k = (Math.PI * 2) / (narrow.matches ? 340 : 560);   // one wave every 560px (340px on phones)
    lanes.forEach((lane) => {
      const { total, lead, phase } = lane;
      if (!total) return;
      lane.pills.forEach((pill) => {
        const x = ((((pill.base + lane.dir * lane.travel) % total) + total) % total) - lead;
        const mid = x + pill.width / 2;
        const y = Math.sin(mid * k + phase) * amp;
        const tilt = Math.atan(Math.cos(mid * k + phase) * amp * k) * (180 / Math.PI) * 0.45;
        pill.el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${tilt.toFixed(2)}deg)`;
      });
    });
  };

  let running = false;
  let onScreen = false;
  let last = 0;
  let frame = 0;

  const tick = (now) => {
    const dt = Math.min(0.05, (now - last) / 1000);   // a long gap (tab switch) never makes the pills jump
    last = now;
    lanes.forEach((lane) => {
      if (!lane.paused) lane.travel = (lane.travel + (lane.setWidth / lane.seconds) * dt) % lane.total;
    });
    draw();
    frame = requestAnimationFrame(tick);
  };
  const sync = () => {
    const want = onScreen && !document.hidden;
    if (want === running) return;
    running = want;
    if (running) {
      last = performance.now();
      frame = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(frame);
    }
  };

  lanes.forEach((lane) => {
    const held = { hover: false, focus: false };
    const set = () => { lane.paused = held.hover || held.focus; };
    lane.list.addEventListener("pointerenter", (event) => { if (event.pointerType === "mouse") { held.hover = true; set(); } });
    lane.list.addEventListener("pointerleave", () => { held.hover = false; set(); });
    lane.list.addEventListener("focusin", () => { held.focus = true; set(); });
    lane.list.addEventListener("focusout", () => { held.focus = false; set(); });
  });

  new IntersectionObserver((entries) => {
    onScreen = entries[entries.length - 1].isIntersecting;
    sync();
  }, { rootMargin: "120px 0px" }).observe(rows);
  document.addEventListener("visibilitychange", sync);

  let resizeTimer = 0;
  let lastWidth = window.innerWidth;
  window.addEventListener("resize", () => {
    if (window.innerWidth === lastWidth) return;   // a phone's address bar hiding is not a new layout
    lastWidth = window.innerWidth;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layout, 150);
  });

  layout();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(layout);
}
