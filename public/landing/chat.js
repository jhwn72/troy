// Troy landing: the one conversation component.
// Reads landing/conversations.json and, for every .convo mount, replaces the static final state with
// an animated playback. Drives the hero phone (a loop of scenarios) and the demo stage (#demos): four
// tabs, one conversation playing at a time, moving on to the next tab by itself.
// With reduced motion it only fills in photos, and the static HTML stays (the four demos stacked).
//
// Events, dispatched on the .convo mount (they bubble):
//   "convo:start"  detail { key, replay }               a conversation starts (or restarts)
//   "convo:step"   detail { key, index, step, phone }   a step's content has just appeared
//   "convo:done"   detail { key }                       the last step has finished
// The mount also carries data-convo-state="idle|playing|done" for scripts that load late.

/* ---------- Timing. Everything John might want to tune is here, in milliseconds. ---------- */
const TIMING = {
  // Typing into the input bar
  firstBeat: 250,        // before the first thing in a conversation
  beforeTyping: 300,     // before the phone's owner starts typing
  charMin: 18,           // per character, low end
  charMax: 25,           // per character, high end
  beforeSend: 120,       // text sits in the bar, then
  press: 90,             // the send button is pressed
  delivered: 180,        // "Delivered" shows
  read: 220,             // then "Read"
  // Troy (or the other person) replying
  beforeDots: 280,       // gap before the three dots
  dotsMin: 350,          // shortest the dots show
  dotsMax: 600,          // longest the dots show
  dotsPerChar: 5,        // longer lines keep the dots up a little longer
  // Other beats
  tapback: 450,
  countUpdate: 900,      // "20 left" changing in place (steps can carry their own "delay")
  switchGroup: 450,      // before both phones switch to the group chat
  phoneChange: 200,      // extra beat when the story moves to the other phone
  holdBeforeClear: 700,  // hero: last bubble stays this long, then
  fade: 220,             // the chat fades out (and group chats fade in)
  // Demo stage
  demoHold: 2600,        // a finished demo stays this long before the next tab
  demoStatic: 6000,      // per tab when the conversations could not load
  focusRead: 700,        // one screen at a time: time to read before it switches to the other screen
};
const T = TIMING;

// The data file sits next to this script. A version query on this script (added by the static build) carries over.
const VERSION = new URL(import.meta.url).search;
const DATA_URL = new URL('./conversations.json' + VERSION, import.meta.url);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
// Below this width the demo stage shows one screen at a time (the one that is "speaking").
const oneScreen = window.matchMedia('(max-width: 1023px)');

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

/* ---------- Photos ---------- */
// Image bubbles use a real photo from img/photos/ when the file exists, and the drawn placeholder when it does not.
const PHOTO_FILES = {
  'airpods': 'airpods.webp',
  'food-trays': 'food-trays.webp',
  'broken-door': 'door-broken.webp',
  'fixed-door': 'door-fixed.webp',
};
const photos = {};

function fillPhoto(bubble) {
  const url = photos[bubble.dataset.image];
  if (!url || bubble.querySelector('.bubble-photo')) return;
  const img = document.createElement('img');
  img.className = 'bubble-photo';
  img.alt = '';
  img.src = url;
  bubble.append(img);
  bubble.classList.add('has-photo');
}

function probePhotos() {
  for (const [name, file] of Object.entries(PHOTO_FILES)) {
    const url = new URL('../img/photos/' + file + VERSION, import.meta.url).href;
    const probe = new Image();
    probe.onload = () => {
      if (!probe.naturalWidth) return;
      photos[name] = url;
      for (const bubble of document.querySelectorAll(`.bubble.is-image[data-image="${name}"]`)) fillPhoto(bubble);
    };
    probe.src = url;
  }
}

class Cancelled extends Error {}

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter() : null;
function letters(text) {
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// A bubble's text. An emoji with more text after it gets its own span so phone.css can give it room.
const EMOJI_THEN_TEXT = /(\p{Extended_Pictographic}\uFE0F?)(?=\s+\S)/gu;
function textNode(text) {
  const span = el('span', 'bubble-text');
  let at = 0;
  for (const match of text.matchAll(EMOJI_THEN_TEXT)) {
    span.append(text.slice(at, match.index), el('span', 'emo', match[0]));
    at = match.index + match[0].length;
  }
  span.append(text.slice(at));
  return span;
}

function kind(step) {
  return step.type || 'message';
}

function dotsFor(step) {
  const length = step.text ? step.text.length : 20;
  return Math.min(Math.max(T.dotsMin, T.dotsMin + length * T.dotsPerChar), T.dotsMax);
}

// Two steps that are really one beat: the same thing happening on both phones at once
// (both switch to the group chat, both get the same line from Troy in it).
function sameBeat(a, b) {
  if (!a || !b || a.phone === b.phone || kind(a) !== kind(b)) return false;
  if (kind(a) === 'switch-group') return a.name === b.name;
  return kind(a) === 'message' && a.from !== 'me' && a.from === b.from && a.text != null && a.text === b.text;
}

class Convo {
  constructor(mount, data) {
    this.mount = mount;
    this.data = data;
    this.loop = mount.hasAttribute('data-convo-loop');
    this.keys = (mount.dataset.convoLoop || mount.dataset.convo || '').trim().split(/\s+/).filter((k) => data[k]);
    this.run = 0;
    this.pauses = new Set();
    this.phones = {};
    for (const phone of mount.querySelectorAll('.phone[data-phone]')) {
      const header = phone.querySelector('.msg-header');
      const avatar = phone.querySelector('.msg-avatar');
      const name = phone.querySelector('.msg-name');
      this.phones[phone.dataset.phone] = {
        el: phone,
        header,
        avatar,
        name,
        list: phone.querySelector('.msg-list'),
        input: phone.querySelector('.msg-input'),
        inputText: phone.querySelector('.msg-input-text'),
        send: phone.querySelector('.msg-send'),
        homeName: name.textContent,
        group: false,
      };
    }
    // In the demo stage: which screen is showing when there is only room for one, and its small labels.
    this.stage = mount.closest('.stage');
    this.focus = null;
    this.who = {};
  }

  // Small labels above the stage naming the two screens. Only shown when one screen shows at a time.
  addWho() {
    const key = this.keys[0];
    const screens = Object.entries(this.data[key].phones || {}).filter(([, screen]) => screen.label);
    if (!this.stage || screens.length < 2) return;
    const row = el('div', 'stage-who');
    row.setAttribute('aria-hidden', 'true');
    for (const [name, screen] of screens) {
      this.who[name] = el('span', '', screen.label);
      row.append(this.who[name]);
    }
    this.stage.prepend(row);
  }

  showFocus(name) {
    this.focus = name;
    if (!this.stage) return;
    if (name) this.stage.dataset.focus = name;
    else delete this.stage.dataset.focus;
    for (const [who, label] of Object.entries(this.who)) label.classList.toggle('is-on', who === name);
  }

  // Move to the screen that speaks next. With one screen showing, the current one is given time to be read first.
  async focusOn(name, run) {
    if (!this.stage || !name || this.focus === name) return;
    if (this.focus && oneScreen.matches) await this.sleep(T.focusRead, run);
    this.showFocus(name);
  }

  // Take over the mount: keep the conversation as plain text for screen readers, empty the phones.
  takeOver() {
    for (const p of Object.values(this.phones)) {
      const transcript = el('div', 'sr-only');
      for (const node of p.list.children) {
        if (node.classList.contains('msg-status')) continue;
        const line = node.getAttribute('aria-label') || node.textContent.trim();
        if (line) transcript.append(el('p', '', line));
      }
      if (this.loop) {
        for (const key of this.keys.slice(1)) {
          for (const step of this.data[key].steps) {
            const who = step.from === 'me' ? 'Student' : 'Troy';
            if (step.tapback) transcript.append(el('p', '', `${who} reacted ${step.tapback}`));
            else if (step.text) transcript.append(el('p', '', `${who}: ${step.text}`));
          }
        }
      }
      p.el.append(transcript);
      for (const part of [p.header, p.list, p.input]) part.setAttribute('aria-hidden', 'true');
    }
    this.mount.classList.add('is-live');
    this.reset();
    this.mount.dataset.convoState = 'idle';
  }

  reset() {
    for (const p of Object.values(this.phones)) {
      for (const part of [p.header, p.list]) {
        for (const anim of part.getAnimations()) anim.cancel();
        part.style.opacity = '';
      }
      p.list.replaceChildren();
      p.list.scrollTop = 0;
      p.inputText.textContent = '';
      p.input.classList.remove('is-typing');
      p.send.classList.remove('is-pressed');
      this.setGroup(p, null);
    }
    this.showFocus(null);
  }

  stop() {
    this.run += 1;
    this.mount.dataset.convoState = 'idle';
  }

  setGroup(p, name) {
    p.group = Boolean(name);
    p.header.classList.toggle('is-group', p.group);
    p.header.querySelector('.msg-group')?.remove();
    p.name.textContent = name || p.homeName;
    if (!p.group) return;
    const cluster = el('span', 'msg-group');
    const troy = p.avatar.cloneNode();
    troy.className = '';
    cluster.append(el('i'), troy, el('i'));
    p.header.prepend(cluster);
  }

  check(run) {
    if (run !== this.run) throw new Cancelled();
  }

  // A wait that stops counting while the conversation is paused and ends early when it is cancelled.
  sleep(ms, run) {
    return new Promise((resolve, reject) => {
      let left = ms;
      let last = performance.now();
      const tick = () => {
        if (run !== this.run) return reject(new Cancelled());
        const now = performance.now();
        if (!this.pauses.size) left -= now - last;
        last = now;
        if (left <= 0) resolve();
        else setTimeout(tick, Math.min(Math.max(left, 16), 80));
      };
      tick();
    });
  }

  setPaused(reason, on) {
    if (on) this.pauses.add(reason);
    else this.pauses.delete(reason);
  }

  async fade(parts, from, to, run) {
    const anims = parts.map((part) => part.animate({ opacity: [from, to] }, { duration: T.fade, easing: 'ease-in-out' }));
    for (const part of parts) part.style.opacity = to === 1 ? '' : String(to);
    await Promise.all(anims.map((a) => a.finished.catch(() => {})));
    this.check(run);
  }

  emit(name, detail) {
    this.mount.dispatchEvent(new CustomEvent(name, { bubbles: true, detail }));
  }

  // Keep the newest thing visible by scrolling the list, never the page.
  toBottom(p, smooth) {
    const top = p.list.scrollHeight - p.list.clientHeight;
    if (top <= p.list.scrollTop) return;
    if (smooth) p.list.scrollTo({ top, behavior: 'smooth' });
    else p.list.scrollTop = top;
  }

  addBubble(p, step, key, index) {
    const mine = step.from === 'me';
    const side = mine ? 'from-me' : 'from-them';
    const prev = p.list.lastElementChild;
    const continues = prev && prev.classList.contains('bubble') && prev.classList.contains(side);
    if (continues) prev.classList.remove('tail');
    if (p.group && !mine && !continues) {
      p.list.append(el('div', 'msg-sender', step.name || 'Troy'));
    }
    const bubble = el('div', `bubble ${side} tail`);
    if (step.image) {
      bubble.classList.add('is-image');
      bubble.dataset.image = step.image;
      fillPhoto(bubble);
    } else {
      bubble.append(textNode(step.text));
    }
    if (kind(step) === 'count') bubble.classList.add('count');
    // If the next thing on this phone is a tapback, keep its room now so nothing shifts later.
    const next = this.data[key].steps.slice(index + 1).find((s) => s.phone === step.phone);
    if (next && next.tapback) bubble.classList.add('awaits-tapback');
    p.list.append(bubble);
    return bubble;
  }

  async playStep(key, index, run, prevPhone) {
    const step = this.data[key].steps[index];
    const p = this.phones[step.phone];
    if (!p) return;
    const type = kind(step);
    const mine = step.from === 'me';
    const detail = { key, index, step, phone: step.phone };

    if (type !== 'count' || step.focus) await this.focusOn(step.focus || step.phone, run);

    const moved = prevPhone && prevPhone !== step.phone ? T.phoneChange : 0;
    const gap = (ms) => this.sleep(step.delay != null ? step.delay : (index === 0 ? T.firstBeat : ms + moved), run);

    if (type === 'clear') {
      await gap(T.holdBeforeClear);
      await this.fade([p.list], 1, 0, run);
      p.list.replaceChildren();
      p.list.scrollTop = 0;
      p.list.style.opacity = '';
      this.emit('convo:step', detail);
      return;
    }

    if (type === 'switch-group') {
      await gap(T.switchGroup);
      await this.fade([p.header, p.list], 1, 0, run);
      p.list.replaceChildren();
      p.list.scrollTop = 0;
      this.setGroup(p, step.name);
      this.emit('convo:step', detail);
      await this.fade([p.header, p.list], 0, 1, run);
      return;
    }

    if (step.tapback) {
      await gap(T.tapback);
      const targets = p.list.querySelectorAll(mine ? '.bubble.from-them' : '.bubble.from-me');
      const target = targets[targets.length - 1];
      if (target) target.append(el('span', 'tapback', step.tapback));
      this.emit('convo:step', detail);
      return;
    }

    if (type === 'count') {
      const live = p.list.querySelector('.bubble.count .bubble-text');
      if (live) {
        // The count changes in place, like an edited message.
        await gap(T.countUpdate);
        await live.animate({ opacity: [1, 0] }, { duration: 120 }).finished.catch(() => {});
        this.check(run);
        live.textContent = step.text;
        live.animate({ opacity: [0, 1] }, { duration: 160 });
        this.emit('convo:step', detail);
        return;
      }
    }

    if (mine) {
      await gap(T.beforeTyping);
      if (step.text) {
        p.input.classList.add('is-typing');
        for (const ch of letters(step.text)) {
          p.inputText.textContent += ch;
          this.toBottom(p, false);
          await this.sleep(T.charMin + Math.random() * (T.charMax - T.charMin), run);
        }
        await this.sleep(T.beforeSend, run);
      }
      p.send.classList.add('is-pressed');
      await this.sleep(T.press, run);
      const inputTop = p.inputText.getBoundingClientRect().top;
      p.send.classList.remove('is-pressed');
      p.input.classList.remove('is-typing');
      p.inputText.textContent = '';
      p.list.querySelector('.msg-status')?.remove();
      const bubble = this.addBubble(p, step, key, index);
      // The blue bubble slides up from the input bar to its place.
      const rise = Math.max(inputTop - bubble.getBoundingClientRect().top, 24);
      bubble.animate(
        { transform: [`translateY(${rise}px)`, 'none'], opacity: [0.6, 1] },
        { duration: Math.min(220 + rise * 0.25, 340), easing: EASE },
      );
      this.toBottom(p, true);
      this.emit('convo:step', detail);

      await this.sleep(T.delivered, run);
      const status = el('div', 'msg-status', 'Delivered');
      bubble.after(status);
      this.toBottom(p, true);
      // "Read" shows before the other side starts typing.
      const next = this.data[key].steps.slice(index + 1).find((s) => s.phone === step.phone);
      const read = step.status === 'Read' || (next && next.from !== 'me' && kind(next) === 'message' && !step.status);
      if (read) {
        await this.sleep(T.read, run);
        status.textContent = 'Read';
      }
      return;
    }

    // Troy or the other person: three dots first, then the gray bubble.
    await gap(T.beforeDots);
    const dots = el('div', 'typing');
    dots.append(el('i'), el('i'), el('i'));
    p.list.append(dots);
    this.toBottom(p, true);
    await this.sleep(dotsFor(step), run);
    dots.remove();
    const bubble = this.addBubble(p, step, key, index);
    bubble.classList.add('is-new');
    this.toBottom(p, true);
    this.emit('convo:step', detail);
  }

  async playOne(key, run, replay) {
    const steps = this.data[key].steps;
    this.reset();
    this.mount.dataset.convoCurrent = key;
    this.mount.dataset.convoState = 'playing';
    this.emit('convo:start', { key, replay });
    this.showFocus(steps[0] ? steps[0].focus || steps[0].phone : null);
    let prevPhone = null;
    let i = 0;
    while (i < steps.length) {
      const beat = [i];
      while (sameBeat(steps[i], steps[i + beat.length])) beat.push(i + beat.length);
      await Promise.all(beat.map((index) => this.playStep(key, index, run, beat.length > 1 ? null : prevPhone)));
      prevPhone = beat.length > 1 ? null : steps[i].phone;
      if (steps[i].focusAfter) await this.focusOn(steps[i].focusAfter, run);
      i += beat.length;
    }
    this.mount.dataset.convoState = 'done';
    this.emit('convo:done', { key });
  }

  async play(replay = false) {
    const run = ++this.run;
    try {
      do {
        for (const key of this.keys) await this.playOne(key, run, replay);
      } while (this.loop);
      return true;
    } catch (err) {
      if (!(err instanceof Cancelled)) throw err;
      return false;
    }
  }
}

// Roughly how long a conversation takes to play, for the progress line on its tab.
function estimate(steps, single) {
  const perChar = (T.charMin + T.charMax) / 2;
  let ms = 0;
  let prev = null;
  let focus = steps[0] ? steps[0].focus || steps[0].phone : null;
  const look = (name) => {
    if (!single || !name || name === focus) return;
    ms += T.focusRead;
    focus = name;
  };
  steps.forEach((step, i) => {
    if (sameBeat(steps[i - 1], step)) return; // plays alongside the step before it
    const type = kind(step);
    const moved = prev && prev !== step.phone ? T.phoneChange : 0;
    const gap = (wait) => (step.delay != null ? step.delay : (i === 0 ? T.firstBeat : wait + moved));
    if (type !== 'count' || step.focus) look(step.focus || step.phone);
    if (type === 'clear') ms += gap(T.holdBeforeClear) + T.fade;
    else if (type === 'switch-group') ms += gap(T.switchGroup) + T.fade * 2;
    else if (step.tapback) ms += gap(T.tapback);
    else if (type === 'count' && i > 0 && kind(steps[i - 1]) === 'count') ms += gap(T.countUpdate) + 120;
    else if (step.from === 'me') {
      ms += gap(T.beforeTyping) + T.press + T.delivered + T.read;
      if (step.text) ms += letters(step.text).length * perChar + T.beforeSend;
    } else ms += gap(T.beforeDots) + dotsFor(step);
    look(step.focusAfter);
    prev = step.phone;
  });
  return ms;
}

function watchHero(convo) {
  const phone = Object.values(convo.phones)[0];
  // Pause while the pointer is over the phone, or after a tap (tap again to resume).
  phone.el.addEventListener('pointerenter', (e) => {
    if (e.pointerType === 'mouse') convo.setPaused('hover', true);
  });
  phone.el.addEventListener('pointerleave', () => convo.setPaused('hover', false));
  phone.el.addEventListener('click', () => convo.setPaused('tap', !convo.pauses.has('tap')));
  // Stop while the hero is off screen.
  convo.setPaused('offscreen', true);
  new IntersectionObserver((entries) => {
    for (const entry of entries) convo.setPaused('offscreen', !entry.isIntersecting);
  }).observe(phone.el);
  convo.play();
}

/* ---------- The demo stage: four tabs, one conversation at a time ---------- */
// convos[i] plays in panels[i]. It is missing when conversations.json could not load; the tabs then
// show the static conversations and move on by a timer.
function watchDemos(root, convos) {
  const tabs = [...root.querySelectorAll('.demo-tab[data-demo]')];
  const panels = tabs.map((tab) => document.getElementById(tab.dataset.demo));
  const area = root.querySelector('.demo-panels');
  if (!tabs.length || !area || panels.some((panel) => !panel)) return;

  const list = root.querySelector('.demo-tabs');
  list.setAttribute('role', 'tablist');
  tabs.forEach((tab, i) => {
    tab.id = `tab-${tab.dataset.demo}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panels[i].id);
    panels[i].setAttribute('role', 'tabpanel');
  });
  root.classList.add('is-tabbed');

  let active = -1;
  let turn = 0;
  let phase = 'idle';      // idle | playing | hold
  let started = false;
  let onscreen = false;
  let elapsed = 0;         // time the current demo has been playing
  let total = 1;           // how long it is expected to play
  let holdElapsed = 0;
  let holdFrom = 0;        // where the progress line stood when the demo finished
  const holds = new Set(); // reasons auto-advance is paused: "hover", "tap"

  const bar = (i) => tabs[i].querySelector('.demo-tab-bar i');
  const setBar = (i, frac) => {
    const line = bar(i);
    if (line) line.style.transform = `scaleX(${frac})`;
  };

  const show = (i) => {
    active = i;
    tabs.forEach((tab, n) => {
      tab.classList.toggle('is-active', n === i);
      tab.setAttribute('aria-selected', String(n === i));
      tab.tabIndex = n === i ? 0 : -1;
      setBar(n, 0);
    });
    // On phones the tab row scrolls sideways: bring the active tab to the middle of it.
    if (list.scrollWidth > list.clientWidth) {
      const row = list.getBoundingClientRect();
      const tab = tabs[i].getBoundingClientRect();
      const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      list.scrollTo({ left: list.scrollLeft + tab.left - row.left - (row.width - tab.width) / 2, behavior: calm ? 'auto' : 'smooth' });
    }
    panels.forEach((panel, n) => {
      panel.classList.toggle('is-active', n === i);
      panel.inert = n !== i;
    });
  };

  const toHold = () => {
    holdFrom = Math.min(elapsed / (total + T.demoHold), 1);
    holdElapsed = 0;
    phase = 'hold';
  };

  const start = (i) => {
    const token = ++turn;
    if (active >= 0 && convos[active]) convos[active].stop();
    show(i);
    started = true;
    elapsed = 0;
    holdElapsed = 0;
    phase = 'playing';
    const convo = convos[i];
    if (!convo) {
      total = T.demoStatic;
      return;
    }
    // The chip comes back when this conversation finishes (scene.js shows it on "convo:done").
    const chip = panels[i].querySelector('.chip');
    if (chip) chip.classList.remove('is-shown');
    total = estimate(convo.data[convo.keys[0]].steps, oneScreen.matches);
    // Always a "replay", so the map and the repair steps start over each time their tab comes round.
    convo.play(true).then((finished) => {
      if (finished && token === turn) toHold();
    });
  };

  let last = performance.now();
  const tick = (now) => {
    const dt = Math.min(now - last, 100);
    last = now;
    if (onscreen && active >= 0 && phase !== 'idle') {
      const whole = total + T.demoHold;
      let frac;
      if (phase === 'playing') {
        elapsed += dt;
        frac = Math.min(elapsed, total) / whole;
        if (!convos[active] && elapsed >= total) toHold();
      } else {
        if (!holds.size) holdElapsed += dt;
        frac = holdFrom + (1 - holdFrom) * Math.min(holdElapsed / T.demoHold, 1);
      }
      setBar(active, frac);
      if (phase === 'hold' && holdElapsed >= T.demoHold) start((active + 1) % tabs.length);
    }
    requestAnimationFrame(tick);
  };

  const setHold = (reason, on) => {
    if (on) holds.add(reason);
    else holds.delete(reason);
    root.classList.toggle('is-paused', holds.size > 0);
  };

  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => {
      setHold('tap', false);
      start(i);
    });
    tab.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      const next = (i + step + tabs.length) % tabs.length;
      tabs[next].focus();
      start(next);
    });
  });

  // Hovering the stage, or tapping it, keeps the current demo up. Tap again to let it move on.
  let pointer = 'mouse';
  area.addEventListener('pointerdown', (event) => { pointer = event.pointerType; });
  area.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'mouse') setHold('hover', true);
  });
  area.addEventListener('pointerleave', () => setHold('hover', false));
  area.addEventListener('click', (event) => {
    if (pointer === 'mouse' || event.target.closest('.replay')) return;
    setHold('tap', !holds.has('tap'));
  });

  for (const button of root.querySelectorAll('.replay')) {
    button.addEventListener('click', () => {
      setHold('tap', false);
      if (active >= 0) start(active);
    });
  }

  // A link to one demo (#food) opens its tab.
  const fromHash = () => tabs.findIndex((tab) => `#${tab.dataset.demo}` === location.hash);
  window.addEventListener('hashchange', () => {
    const i = fromHash();
    if (i >= 0) start(i);
  });

  show(Math.max(fromHash(), 0));

  // Play while the stage is on screen. The first demo starts when it first scrolls into view.
  new IntersectionObserver((entries) => {
    onscreen = entries[entries.length - 1].isIntersecting;
    for (const convo of convos) if (convo) convo.setPaused('offscreen', !onscreen);
    if (onscreen && !started) start(active);
  }, { threshold: 0.25 }).observe(area);

  requestAnimationFrame(tick);
}

async function init() {
  probePhotos();
  if (reducedMotion.matches) return;
  let data = null;
  try {
    const res = await fetch(DATA_URL);
    if (res.ok) data = await res.json();
  } catch {
    // The static conversations stay.
  }
  const live = new Map();
  if (data) {
    for (const mount of document.querySelectorAll('.convo[data-convo]')) {
      const convo = new Convo(mount, data);
      if (!convo.keys.length) continue;
      convo.takeOver();
      live.set(mount, convo);
      if (convo.loop) watchHero(convo);
      else convo.addWho();
    }
  }
  const demos = document.getElementById('demos');
  if (demos) {
    const convos = [...demos.querySelectorAll('.demo-tab[data-demo]')].map((tab) => {
      const panel = document.getElementById(tab.dataset.demo);
      return (panel && live.get(panel.querySelector('.convo'))) || null;
    });
    watchDemos(demos, convos);
  }
}

init();
