// Troy landing: "A day at USC", the pinned scene (#demos).
// It plays like a video. When the scene comes into view it runs through its five stops by itself: the time and
// setup line, the conversation on the phone, the connection picture, the other person's card, the chip, a short
// rest, then the clock ticks on to the next stop. After the last stop it rests there (a small replay control shows).
//
// The wrapper is a little over three screens tall and its stage is position: sticky, so the page scrolls normally
// and the stage stays put for a short while. Scrolling is fast-forward: a scroll down while it plays moves to the
// next stop, a scroll up goes back one, and scrolling on past the wrapper leaves the scene. How far the visitor has
// scrolled also sets a floor ("at least this stop"), so the timer and the scroll never fight.
// Coming into the scene from above always begins at the first stop: the scroll that brought the visitor in never
// skips anything, and only scrolling that starts while the stage is pinned moves the day on.
// Nothing here listens to the wheel or to touch, and nothing stops a scroll.
// Out of view (or with the pause control) everything holds where it is, and carries on when the scene is back.
//
// It sets, on <html>:
//   .day-on                 the scene is pinned (not with reduced motion, and not without subgrid support)
//   data-day-stop="0..4"    the current stop
//   data-day-pinned         present while the stage fills the screen
//   --day-tod               time of day, 0 (morning) to 1 (night)
//   --day-progress          0 to 1 through the whole scene
// It dispatches, on window:
//   "day:stop"    detail { index, progress, tod, key, minutes, pinned }   whenever any of them changes
//                 (progress is 0 while the stop plays and 1 once it has finished)
//   "day:idle"    detail { index }   the whole day has played and the visitor has not moved for a while
//   "day:settle"  detail { key }     a stop is showing its finished state without a conversation to play
// It asks chat.js for a conversation with "convo:play", "convo:stop" and "convo:pause" on the stop's .convo mount.
//
// The spotlight. One phone is on stage (the stop's data-main side); the other side is a notification card beside
// the connection picture (.day-card). .day-panel carries data-spot, and day.css gives that one thing a small lift
// (nothing else is dimmed or blurred):
//   "intro"  the time and setup line, large, alone on the panel for a beat when a stop begins (the stage is empty)
//   "phone"  while the asker's side of the conversation plays
//   "map"    while the connection picture moves (steps that carry "map" in conversations.json), and while Troy is
//            reaching the other person
//   "card"   when the other person's side lands on their card
//   "chip"   when the conversation has finished
// It follows chat.js: "convo:step" events, and data-focus on the stop's .stage (the side about to speak).

/* ---------- Everything John might want to tune ---------- */
const INTRO_MS = 1600;       // the large time and setup line hold the stage this long, then the conversation starts
const REST_MS = 2500;        // a finished stop rests this long before the day moves on
const TICK_MS = 900;         // the clock takes this long to tick over to the next stop's time
const MAP_BEAT = 1500;       // the connection picture keeps the spotlight this long when it moves
const MAP_BEAT_FOOD = 3000;  // free food: the ring and its circles take longer
const FOOD_TRIGGER = 'sending it to trojans nearby';
const ZONES = [0.28, 0.46, 0.64, 0.82];   // how far through the pinned scrolling stops II to V begin (the floor)
const SKIP_PX = 50;          // a scroll of at least this much while the scene is pinned skips one stop
const GESTURE_GAP = 280;     // scrolling that pauses this long counts as a new scroll
const SKIP_REST = 700;       // a stop that has only just begun is not skipped by the same burst of scrolling
const IDLE_AFTER = 6000;     // the day has finished and nothing has moved for this long: show the nudge
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

const ICONS = {
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5v11M15 6.5v11"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5l8.500 5.500-8.500 5.500z"/></svg>',
  again: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.5 12a6.500 6.500 0 1 0 2-4.700"/><path d="M5.250 4.500v3.750H9"/></svg>',
};

function start() {
  root.classList.add('day-on');

  const N = stops.length;
  const minutes = stops.map((stop) => Number(stop.dataset.dayMinutes) || 0);
  const tods = stops.map((stop) => Number(stop.dataset.dayTod) || 0);
  const mounts = stops.map((stop) => stop.querySelector('.convo'));
  const chips = stops.map((stop) => stop.querySelector('.chip'));
  const panel = wrap.querySelector('.day-panel');
  const stages = stops.map((stop) => stop.querySelector('.stage'));
  const cards = stops.map((stop) => stop.querySelector('.day-card'));
  const mains = stops.map((stop) => (stop.dataset.main === 'right' ? 'right' : 'left'));
  const heard = stops.map(() => 0);    // how many things the other side has received or said so far

  // The large time and setup line.
  const intro = document.createElement('p');
  intro.className = 'day-intro';
  intro.setAttribute('aria-hidden', 'true');
  const introTime = document.createElement('span');
  introTime.className = 'day-intro-time';
  const introLine = document.createElement('span');
  introLine.className = 'day-intro-line';
  intro.append(introTime, introLine);
  panel.append(intro);
  const marks = [...wrap.querySelectorAll('.day-mark')];
  const nav = wrap.querySelector('.day-nav');
  const next = wrap.querySelector('.day-next');
  const pill = wrap.querySelector('.day-idle');
  const clockTime = wrap.querySelector('.day-clock-time');
  const clockAmpm = wrap.querySelector('.day-clock-ampm');
  const doneAt = stops.map(() => 0);   // when each stop's conversation finished (0: not finished)

  // Two small controls beside the stop marks: pause or play, and (once the day has played) play it again.
  const control = (className, label, icon) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.setAttribute('aria-label', label);
    button.innerHTML = icon;
    if (nav) nav.append(button);
    return button;
  };
  const pauseButton = control('day-pause', 'Pause', ICONS.pause);
  const againButton = control('day-again', 'Play the day again', ICONS.again);
  againButton.hidden = true;

  let cur = -1;            // the current stop
  let finished = false;    // the last stop has played and rested
  let userPaused = false;
  let pinned = false;
  let active = false;      // the scene is in view
  let applied = true;      // whether everything is being held right now (it starts held, until the scene is in view)
  let chatReady = root.dataset.convoReady != null;
  let pendingPlay = false;
  let spotTimer = 0;
  let holdUntil = 0;       // the picture keeps the spotlight until then
  let wanted = '';         // what gets it afterwards
  let lastMove = performance.now();
  let nudges = 0;
  let nudging = false;
  let beganAt = 0;         // when the current stop began

  /* ---------- One timer that can be held ---------- */

  const timer = { id: 0, fn: null, left: 0, at: 0, running: false };
  const runTimer = () => {
    timer.at = performance.now();
    timer.running = true;
    timer.id = setTimeout(() => {
      const fn = timer.fn;
      timer.fn = null;
      timer.running = false;
      if (fn) fn();
    }, timer.left);
  };
  const holdTimer = () => {
    if (!timer.running) return;
    clearTimeout(timer.id);
    timer.running = false;
    timer.left = Math.max(0, timer.left - (performance.now() - timer.at));
  };
  const cancel = () => {
    clearTimeout(timer.id);
    timer.fn = null;
    timer.running = false;
  };
  const later = (ms, fn) => {
    cancel();
    timer.fn = fn;
    timer.left = ms;
    if (!applied) runTimer();
  };

  const held = () => userPaused || !active || document.hidden;
  const tellConvo = () => {
    if (cur >= 0 && mounts[cur]) mounts[cur].dispatchEvent(new CustomEvent('convo:pause', { detail: { paused: applied } }));
  };
  function applyHold() {
    const hold = held();
    if (hold === applied) return;
    applied = hold;
    if (hold) holdTimer();
    else if (timer.fn) runTimer();
    tellConvo();
  }

  /* ---------- Where the visitor is ---------- */

  const travel = () => Math.max(1, wrap.offsetHeight - stage.offsetHeight);
  const sceneTop = () => wrap.getBoundingClientRect().top + window.scrollY;
  let zone = 0;            // the stop the scroll position asks for at least
  let wasAbove = false;    // the scene has been out of view above the screen since it was last pinned

  function measure() {
    const rect = wrap.getBoundingClientRect();
    const view = window.innerHeight;
    const p = clamp01(-rect.top / travel());
    zone = ZONES.filter((from) => p >= from).length;
    const nowPinned = rect.top <= 1 && rect.bottom >= view - 1;
    active = rect.top < view * 0.45 && rect.bottom > view * 0.55;
    if (rect.top >= view * 0.45) wasAbove = true;
    if (nowPinned !== pinned) {
      pinned = nowPinned;
      root.toggleAttribute('data-day-pinned', pinned);
      announce();
    }
    if (pinned) {
      // Entered from above: the day begins at its first stop, wherever it was left.
      const restart = wasAbove && cur > 0 && performance.now() >= ignoreUntil;
      wasAbove = false;
      if (restart) go(0);
    }
    applyHold();
  }

  /* ---------- The clock ---------- */

  const shown = { minutes: minutes[0], tod: tods[0] };
  let tickFrame = 0;

  function showClock(m) {
    const hour = Math.floor(m / 60) % 24;
    const minute = String(m % 60).padStart(2, '0');
    if (clockTime) clockTime.textContent = `${hour % 12 || 12}:${minute}`;
    if (clockAmpm) clockAmpm.textContent = hour >= 12 ? 'pm' : 'am';
  }

  function announce() {
    if (cur < 0) return;
    window.dispatchEvent(new CustomEvent('day:stop', {
      detail: { index: cur, progress: doneAt[cur] ? 1 : 0, tod: shown.tod, key: stops[cur].id, minutes: shown.minutes, pinned },
    }));
  }

  function paint() {
    showClock(shown.minutes);
    root.style.setProperty('--day-tod', String(shown.tod));
    root.style.setProperty('--day-progress', String(Math.round(((cur + (doneAt[cur] ? 1 : 0)) / N) * 1000) / 1000));
    announce();
  }

  // The clock ticks over to a stop's time, and the sky follows it.
  function tickTo(i, instant) {
    cancelAnimationFrame(tickFrame);
    const from = { ...shown };
    const t0 = performance.now();
    const step = () => {
      const t = instant ? 1 : clamp01((performance.now() - t0) / TICK_MS);
      const eased = smooth(t);
      shown.minutes = Math.round(lerp(from.minutes, minutes[i], eased));
      shown.tod = Math.round(lerp(from.tod, tods[i], eased) * 1000) / 1000;
      paint();
      if (t < 1) tickFrame = requestAnimationFrame(step);
    };
    step();
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

  /* ---------- The spotlight ---------- */

  const setSpot = (spot) => {
    if (panel.dataset.spot !== spot) panel.dataset.spot = spot;
  };
  const clearSpot = () => {
    clearTimeout(spotTimer);
    holdUntil = 0;
    wanted = '';
  };
  // Give the spotlight to something, once the picture has had its beat.
  const want = (spot) => {
    wanted = spot;
    clearTimeout(spotTimer);
    const left = holdUntil - performance.now();
    if (left <= 0) setSpot(spot);
    else spotTimer = setTimeout(() => setSpot(wanted), left);
  };
  const mapBeat = (ms, then) => {
    clearTimeout(spotTimer);
    setSpot('map');
    holdUntil = performance.now() + ms;
    want(then);
  };

  // The other person's card: each line carries data-from (it shows once that many things have reached them)
  // and sometimes data-to (it makes room for what comes later).
  function showCard(i, count) {
    const card = cards[i];
    if (!card) return false;
    const all = count == null;      // the finished card
    let any = false;
    let fresh = false;              // something new just landed on it
    for (const item of card.querySelectorAll('[data-from]')) {
      const from = Number(item.dataset.from);
      const to = item.dataset.to == null ? Infinity : Number(item.dataset.to);
      const on = all ? to === Infinity : count > from && count <= to;
      if (on && !item.classList.contains('is-on')) fresh = true;
      item.classList.toggle('is-on', on);
      if (on) any = true;
    }
    card.classList.toggle('is-out', any);
    return fresh;
  }
  const cardOut = (i) => Boolean(cards[i] && cards[i].classList.contains('is-out'));
  // Who has it when nothing else is going on: whoever chat.js says is about to speak.
  const bySide = (i) => {
    const side = stages[i] && stages[i].dataset.focus;
    if (!side || side === mains[i]) return 'phone';
    return cardOut(i) ? 'card' : 'map';
  };

  function showIntro(i) {
    const time = (stops[i].querySelector('.day-time') || {}).textContent || '';
    const [clock, ampm] = time.trim().split(/\s+/);
    introTime.textContent = clock || '';
    if (ampm) {
      const small = document.createElement('small');
      small.textContent = ampm;
      introTime.append(small);
    }
    introLine.textContent = (stops[i].querySelector('.day-setup') || {}).textContent || '';
  }

  /* ---------- Playing a stop ---------- */

  const state = (i) => (mounts[i] ? mounts[i].dataset.convoState : '');
  const isLive = (i) => Boolean(mounts[i] && mounts[i].classList.contains('is-live'));

  const moved = () => {
    lastMove = performance.now();
    if (!nudging) return;
    nudging = false;
    if (pill) pill.classList.remove('is-on');
  };

  // A stop begins: the clock ticks over, the time and setup line take the stage for a beat, then the conversation
  // plays from the start.
  function go(i) {
    i = Math.min(Math.max(i, 0), N - 1);
    const was = cur;
    if (was >= 0 && state(was) === 'playing') mounts[was].dispatchEvent(new CustomEvent('convo:stop'));
    if (was >= 0) doneAt[was] = 0;
    cur = i;
    beganAt = performance.now();
    finished = false;
    againButton.hidden = true;
    pendingPlay = false;
    moved();
    showStop(i);
    tickTo(i, was < 0);
    clearSpot();
    showIntro(i);
    heard[i] = 0;
    showCard(i, 0);
    if (chips[i]) chips[i].classList.remove('is-shown');
    setSpot('intro');
    later(INTRO_MS, () => startConvo(i));
  }

  function startConvo(i) {
    if (i !== cur) return;
    if (!chatReady) {
      pendingPlay = true;
      return;
    }
    if (panel.dataset.spot === 'intro') setSpot('phone');
    if (!isLive(i)) return settle(i);
    mounts[i].dispatchEvent(new CustomEvent('convo:play', { detail: { replay: true } }));
    tellConvo();
  }

  // A stop has finished: it rests, then the day moves on. The last stop stays.
  function rest(i) {
    doneAt[i] = performance.now();
    if (chips[i]) chips[i].classList.add('is-shown');
    paint();
    later(REST_MS, () => {
      if (i !== cur) return;
      if (i < N - 1) return go(i + 1);
      finished = true;
      againButton.hidden = false;
      lastMove = performance.now();
    });
  }

  // No conversation to play (the data did not load): show the stop finished.
  function settle(i) {
    showCard(i, null);
    clearSpot();
    setSpot('chip');
    window.dispatchEvent(new CustomEvent('day:settle', { detail: { key: stops[i].id } }));
    rest(i);
  }

  wrap.addEventListener('convo:start', (event) => {
    const i = mounts.indexOf(event.target);
    if (i < 0) return;
    doneAt[i] = 0;
    heard[i] = 0;
    showCard(i, 0);
    if (chips[i]) chips[i].classList.remove('is-shown');
    if (i === cur) {
      clearSpot();
      setSpot(bySide(i));
    }
  });
  wrap.addEventListener('convo:step', (event) => {
    const i = mounts.indexOf(event.target);
    const detail = event.detail || {};
    const step = detail.step || {};
    if (i < 0) return;
    const type = step.type || 'message';
    const said = Boolean(step.text || step.image || step.tapback) && type !== 'count';
    const other = detail.phone !== mains[i];
    let landed = false;
    if (other && said) {
      heard[i] += 1;
      landed = showCard(i, heard[i]);
    }
    if (i !== cur) return;
    const moves = step.map != null || (typeof step.text === 'string' && step.text.includes(FOOD_TRIGGER));
    if (moves) mapBeat(stops[i].id === 'food' ? MAP_BEAT_FOOD : MAP_BEAT, landed ? 'card' : bySide(i));
    else if (landed) want('card');
    else if (!other && said) want('phone');
  });
  wrap.addEventListener('convo:done', (event) => {
    const i = mounts.indexOf(event.target);
    if (i < 0 || i !== cur) return;
    want('chip');
    rest(i);
  });

  // chat.js marks the side that is about to speak on the stop's .stage (data-focus).
  stages.forEach((stage, i) => {
    if (!stage) return;
    new MutationObserver(() => {
      if (i !== cur || state(i) !== 'playing' || !stage.dataset.focus) return;
      want(bySide(i));
    }).observe(stage, { attributes: true, attributeFilter: ['data-focus'] });
  });

  const onReady = () => {
    if (chatReady) return;
    chatReady = true;
    if (pendingPlay) {
      pendingPlay = false;
      startConvo(cur);
    }
  };
  window.addEventListener('convo:ready', onReady);
  setTimeout(onReady, CHAT_WAIT);

  /* ---------- Scrolling is fast-forward ---------- */

  let lastY = window.scrollY;
  let lastZone = 0;
  let gesture = null;
  let ignoreUntil = 0;     // scrolling this script started itself does not count

  window.addEventListener('scroll', () => {
    const t = performance.now();
    const y = window.scrollY;
    const dy = y - lastY;
    const wasPinned = pinned;
    lastY = y;
    measure();
    moved();
    if (!dy) return;
    const dir = dy > 0 ? 1 : -1;
    if (!gesture || t - gesture.last > GESTURE_GAP || gesture.dir !== dir) gesture = { dir, sum: 0, used: false, ok: wasPinned };
    gesture.last = t;
    gesture.sum += Math.abs(dy);
    const rose = zone > lastZone;
    lastZone = zone;
    if (t < ignoreUntil || !pinned) return;
    // The floor: scrolled far enough for a later stop than the one playing. Only for scrolling that began inside
    // the scene: the scroll that arrives from above never skips ahead.
    if (gesture.ok && rose && zone > cur) {
      gesture.used = true;
      return go(zone);
    }
    // One scroll, one stop.
    if (!gesture.ok || gesture.used || gesture.sum < SKIP_PX || t - beganAt < SKIP_REST) return;
    gesture.used = true;
    if (dir > 0 && cur < N - 1) go(cur + 1);
    else if (dir < 0 && cur > 0) go(cur - 1);
  }, { passive: true });
  window.addEventListener('resize', measure);
  document.addEventListener('visibilitychange', applyHold);
  window.addEventListener('load', () => {
    // Say where the day stands once more, for scripts that started listening after the first update.
    measure();
    announce();
  });

  /* ---------- Moving by click or key ---------- */

  const setPaused = (on) => {
    userPaused = on;
    pauseButton.innerHTML = on ? ICONS.play : ICONS.pause;
    pauseButton.setAttribute('aria-label', on ? 'Play' : 'Pause');
    applyHold();
  };
  // A stop the visitor asked for plays, even if the day was paused.
  const jump = (i) => {
    setPaused(false);
    go(i);
  };
  const leave = () => {
    ignoreUntil = performance.now() + 1200;
    window.scrollTo({ top: sceneTop() + wrap.offsetHeight, behavior: 'smooth' });   // on to the rest of the page
  };
  const forward = () => (cur < N - 1 ? jump(cur + 1) : leave());

  marks.forEach((mark, i) => mark.addEventListener('click', () => jump(i)));
  if (next) next.addEventListener('click', forward);
  pauseButton.addEventListener('click', () => {
    moved();
    setPaused(!userPaused);
  });
  againButton.addEventListener('click', () => jump(0));

  window.addEventListener('keydown', (event) => {
    if (!pinned || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest('input, textarea, select, [contenteditable]')) return;
    if (event.key === 'ArrowRight') forward();
    else if (event.key === 'ArrowLeft' && cur > 0) jump(cur - 1);
  });

  // The small replay button beside each chip plays that stop again (and the day carries on from there).
  for (const button of wrap.querySelectorAll('.replay')) button.addEventListener('click', () => jump(cur));

  // A link to one stop (#food) goes to the scene and plays from that stop.
  const fromHash = () => {
    const i = stops.findIndex((stop) => `#${stop.id}` === location.hash);
    if (i < 0) return;
    requestAnimationFrame(() => {
      ignoreUntil = performance.now() + 600;
      window.scrollTo({ top: sceneTop() + 2, behavior: 'auto' });
      jump(i);
    });
  };
  window.addEventListener('hashchange', fromHash);
  window.addEventListener('load', fromHash);

  /* ---------- The nudge, once the whole day has played ---------- */

  setInterval(() => {
    if (nudging || !finished || nudges >= IDLE_MAX || !pinned || document.hidden) return;
    if (performance.now() - lastMove < IDLE_AFTER) return;
    nudging = true;
    nudges += 1;
    if (pill) pill.classList.add('is-on');
    window.dispatchEvent(new CustomEvent('day:idle', { detail: { index: cur } }));
  }, 1000);

  go(0);
  measure();
}

if (wrap && stage && stops.length && !reduced && supported) start();
