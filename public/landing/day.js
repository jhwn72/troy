// Troy landing: "A day at USC", the pinned scene (#demos).
// The wrapper is tall and its stage is position: sticky, so the page scrolls normally and the stage stays put.
// How far the visitor has scrolled through the wrapper picks the stop (0 to 4) and a 0 to 1 progress inside it.
// Nothing here listens to the wheel or to touch, and nothing stops a scroll.
//
// It sets, on <html>:
//   .day-on                 the scene is pinned (not with reduced motion, and not without subgrid support)
//   data-day-stop="0..4"    the current stop
//   data-day-pinned         present while the stage fills the screen
//   --day-tod               time of day, 0 (morning) to 1 (night)
//   --day-progress          0 to 1 through the whole scene
// It dispatches, on window:
//   "day:stop"    detail { index, progress, tod, key, minutes, pinned }   whenever any of them changes
//   "day:idle"    detail { index }   the visitor stopped scrolling on a finished stop (at most twice a visit)
//   "day:settle"  detail { key }     a stop is showing its finished state without a conversation to play
// It asks chat.js for a conversation with "convo:play" and "convo:stop" on the stop's .convo mount.

/* ---------- Everything John might want to tune ---------- */
const HOLD = 0.6;            // share of a stop's scrolling where the clock stands still; the rest ticks to the next stop
const PLAY_AFTER = 260;      // a stop must be current this long before its conversation starts, in milliseconds
const IDLE_AFTER = 6000;     // no scrolling for this long on a finished stop shows the nudge
const IDLE_SETTLE = 2500;    // and the conversation must have been finished at least this long
const IDLE_MAX = 2;          // nudges per visit
const CHAT_WAIT = 4000;      // how long to wait for chat.js before showing stops finished

const root = document.documentElement;
const wrap = document.getElementById('demos');
const stage = wrap && wrap.querySelector('.day-stage');
const stops = wrap ? [...wrap.querySelectorAll('.day-stop')] : [];
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const supported = typeof CSS !== 'undefined' && CSS.supports('position', 'sticky') && CSS.supports('grid-template-rows', 'subgrid');

const clamp01 = (n) => Math.min(Math.max(n, 0), 1);
const smooth = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;

function start() {
  root.classList.add('day-on');

  const N = stops.length;
  const minutes = stops.map((stop) => Number(stop.dataset.dayMinutes) || 0);
  const tods = stops.map((stop) => Number(stop.dataset.dayTod) || 0);
  const mounts = stops.map((stop) => stop.querySelector('.convo'));
  const chips = stops.map((stop) => stop.querySelector('.chip'));
  const marks = [...wrap.querySelectorAll('.day-mark')];
  const next = wrap.querySelector('.day-next');
  const pill = wrap.querySelector('.day-idle');
  const clockTime = wrap.querySelector('.day-clock-time');
  const clockAmpm = wrap.querySelector('.day-clock-ampm');
  const doneAt = stops.map(() => 0);   // when each stop's conversation finished (0: not finished)

  const now = { index: -1, progress: -1, tod: -1, minutes: -1, pinned: false, active: false };
  let chatReady = root.dataset.convoReady != null;
  let playTimer = 0;
  let lastScroll = performance.now();
  let nudges = 0;
  let nudging = false;

  /* ---------- Where the visitor is ---------- */

  const travel = () => Math.max(1, wrap.offsetHeight - stage.offsetHeight);
  const stopTop = (i) => {
    const top = wrap.getBoundingClientRect().top + window.scrollY;
    if (i >= N) return top + wrap.offsetHeight;             // past the scene, on to the rest of the page
    return top + (travel() * Math.max(i, 0)) / N + 2;
  };

  function read() {
    const rect = wrap.getBoundingClientRect();
    const view = window.innerHeight;
    const p = clamp01(-rect.top / travel());
    const x = p * N;
    const index = Math.min(N - 1, Math.floor(x));
    const progress = clamp01(x - index);
    // The clock holds at the stop's time, then ticks through to the next stop's as the visitor scrolls on.
    const t = index < N - 1 ? smooth(clamp01((progress - HOLD) / (1 - HOLD))) : 0;
    const to = Math.min(index + 1, N - 1);
    return {
      index,
      progress: Math.round(progress * 1000) / 1000,
      whole: Math.round(p * 1000) / 1000,
      minutes: Math.round(lerp(minutes[index], minutes[to], t)),
      tod: Math.round(lerp(tods[index], tods[to], t) * 1000) / 1000,
      pinned: rect.top <= 1 && rect.bottom >= view - 1,
      active: rect.top < view * 0.45 && rect.bottom > view * 0.55,
    };
  }

  function showClock(m) {
    const hour = Math.floor(m / 60) % 24;
    const minute = String(m % 60).padStart(2, '0');
    if (clockTime) clockTime.textContent = `${hour % 12 || 12}:${minute}`;
    if (clockAmpm) clockAmpm.textContent = hour >= 12 ? 'pm' : 'am';
  }

  function showStop(index) {
    stops.forEach((stop, i) => {
      stop.classList.toggle('is-current', i === index);
      stop.inert = i !== index;
    });
    marks.forEach((mark, i) => {
      mark.classList.toggle('is-current', i === index);
      mark.classList.toggle('is-past', i < index);
      if (i === index) mark.setAttribute('aria-current', 'step');
      else mark.removeAttribute('aria-current');
    });
    root.dataset.dayStop = String(index);
  }

  /* ---------- Conversations ---------- */

  const state = (i) => (mounts[i] ? mounts[i].dataset.convoState : '');
  const isLive = (i) => Boolean(mounts[i] && mounts[i].classList.contains('is-live'));

  function settle(i) {
    if (doneAt[i]) return;
    doneAt[i] = performance.now();
    if (chips[i]) chips[i].classList.add('is-shown');
    window.dispatchEvent(new CustomEvent('day:settle', { detail: { key: stops[i].id } }));
  }

  function play(i, again) {
    if (i !== now.index || !now.active || !chatReady) return;
    if (!isLive(i)) return settle(i);
    if (!again && (state(i) === 'playing' || state(i) === 'done')) return;
    mounts[i].dispatchEvent(new CustomEvent('convo:play', { detail: { replay: true } }));
  }

  function queuePlay() {
    clearTimeout(playTimer);
    playTimer = setTimeout(() => play(now.index, false), PLAY_AFTER);
  }

  wrap.addEventListener('convo:start', (event) => {
    const i = mounts.indexOf(event.target);
    if (i < 0) return;
    doneAt[i] = 0;
    if (chips[i]) chips[i].classList.remove('is-shown');
  });
  wrap.addEventListener('convo:done', (event) => {
    const i = mounts.indexOf(event.target);
    if (i < 0) return;
    doneAt[i] = performance.now();
    if (chips[i]) chips[i].classList.add('is-shown');
  });

  const onReady = () => {
    if (chatReady) return;
    chatReady = true;
    queuePlay();
  };
  window.addEventListener('convo:ready', onReady);
  setTimeout(onReady, CHAT_WAIT);

  /* ---------- One update per frame ---------- */

  function update() {
    const at = read();
    const was = now.index;
    const changed = at.index !== now.index || at.progress !== now.progress || at.tod !== now.tod || at.pinned !== now.pinned;
    const woke = at.active && !now.active;

    if (at.minutes !== now.minutes) showClock(at.minutes);
    if (at.tod !== now.tod) root.style.setProperty('--day-tod', String(at.tod));
    if (at.whole !== now.whole) root.style.setProperty('--day-progress', String(at.whole));
    if (at.pinned !== now.pinned) root.toggleAttribute('data-day-pinned', at.pinned);
    Object.assign(now, at);

    if (at.index !== was) {
      showStop(at.index);
      if (was >= 0 && state(was) === 'playing') mounts[was].dispatchEvent(new CustomEvent('convo:stop'));
      queuePlay();
    } else if (woke) {
      queuePlay();
    }

    if (changed) {
      window.dispatchEvent(new CustomEvent('day:stop', {
        detail: { index: at.index, progress: at.progress, tod: at.tod, key: stops[at.index].id, minutes: at.minutes, pinned: at.pinned },
      }));
    }
  }

  let framed = false;
  const frame = () => {
    if (framed) return;
    framed = true;
    requestAnimationFrame(() => {
      framed = false;
      update();
    });
  };

  const hideNudge = () => {
    if (!nudging) return;
    nudging = false;
    if (pill) pill.classList.remove('is-on');
  };

  window.addEventListener('scroll', () => {
    lastScroll = performance.now();
    hideNudge();
    frame();
  }, { passive: true });
  window.addEventListener('resize', frame);
  window.addEventListener('load', () => {
    // Say where the day stands once more, for scripts that started listening after the first update.
    now.progress = -1;
    update();
  });

  /* ---------- Moving by click or key (for people who would rather not scroll) ---------- */

  const goTo = (i) => window.scrollTo({ top: stopTop(i), behavior: 'smooth' });

  marks.forEach((mark, i) => mark.addEventListener('click', () => goTo(i)));
  if (next) next.addEventListener('click', () => goTo(now.index + 1));

  window.addEventListener('keydown', (event) => {
    if (!now.pinned || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]')) return;
    if (event.key === 'ArrowRight') goTo(now.index + 1);
    else if (event.key === 'ArrowLeft' && now.index > 0) goTo(now.index - 1);
  });

  for (const button of wrap.querySelectorAll('.replay')) {
    button.addEventListener('click', () => {
      lastScroll = performance.now();
      play(now.index, true);
    });
  }

  // A link to one stop (#food) goes to its place in the scene.
  const fromHash = () => {
    const i = stops.findIndex((stop) => `#${stop.id}` === location.hash);
    if (i >= 0) requestAnimationFrame(() => window.scrollTo({ top: stopTop(i), behavior: 'auto' }));
  };
  window.addEventListener('hashchange', fromHash);
  window.addEventListener('load', fromHash);

  /* ---------- The nudge for people who stop scrolling ---------- */

  setInterval(() => {
    if (nudging || nudges >= IDLE_MAX || !now.pinned || document.hidden) return;
    const t = performance.now();
    const done = doneAt[now.index];
    if (!done || t - done < IDLE_SETTLE || t - lastScroll < IDLE_AFTER) return;
    nudging = true;
    nudges += 1;
    if (pill) pill.classList.add('is-on');
    window.dispatchEvent(new CustomEvent('day:idle', { detail: { index: now.index } }));
  }, 1000);

  update();
}

if (wrap && stage && stops.length && !reduced && supported) start();
