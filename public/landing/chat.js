// Troy landing: the one conversation component.
// Reads landing/conversations.json and, for every .convo mount, replaces the static final state with
// an animated playback. Drives the two hero phones (a loop of scenarios) and the five conversations of
// "A day at USC" (#demos). Those five do not start by themselves: day.js decides which stop is current and
// asks for it with a "convo:play" event on the mount (and "convo:stop" when the visitor scrolls on).
// With reduced motion it only fills in photos, and the static HTML stays (the five stops stacked).
//
// Events, dispatched on the .convo mount (they bubble):
//   "convo:start"  detail { key, replay }               a conversation starts (or restarts)
//   "convo:step"   detail { key, index, step, phone }   a step's content has just appeared
//   "convo:done"   detail { key }                       the last step has finished
// The mount also carries data-convo-state="idle|playing|done" for scripts that load late.
//
// Events it listens for on a mount that is not a loop:
//   "convo:play"   detail { replay }   play this conversation from the start
//   "convo:stop"                       stop where it is
// When every mount has been taken over (or the data could not load) it dispatches "convo:ready" on window,
// detail { live }, and sets data-convo-ready on <html>.
//
// Two optional step fields, used by the hero:
//   "with": true   the step plays alongside the step before it (each phone keeps its own order)
//   "link": true   the two people are connected at this step: the mount gets .is-linked until it clears

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
  // A day at USC
  focusRead: 700,        // one screen at a time: time to read before it switches to the other screen
};

/* ---------- Hero timing. The two phones at the top of the page play faster than the rest: these values
   replace the ones above for the hero loop only. A step's own "delay" in conversations.json still wins. ---------- */
const HERO = {
  firstBeat: 120,        // after the chat clears, the next scenario starts (fade + this is about 300 ms)
  beforeTyping: 180,
  charMin: 10,
  charMax: 14,
  beforeSend: 60,
  press: 60,
  delivered: 0,          // "Delivered" shows with the bubble and
  read: 260,             // turns to "Read" by itself: neither holds the conversation up
  statusInline: true,    // (that is what this switch does)
  beforeDots: 240,       // gap between bubbles: 240 to 400 with a step's own delay
  dotsMin: 220,
  dotsMax: 350,
  dotsPerChar: 2,
  tapback: 300,
  countUpdate: 300,
  switchGroup: 150,
  phoneChange: 0,        // the other phone starts while this one's bubble is still landing
  holdBeforeClear: 3200, // the payoff: the whole conversation stays readable this long
  fade: 260,
  lift: 3,               // px the phone that is "speaking" rises (hero.css reads it as --hero-lift)
  pulse: 700,            // the gold line's pulse at each connection
};

// The data file sits next to this script. A version query on this script (added by the static build) carries over.
const VERSION = new URL(import.meta.url).search;
const DATA_URL = new URL('./conversations.json' + VERSION, import.meta.url);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
// Below this width the day scene shows one phone at a time (the one that is "speaking").
const oneScreen = window.matchMedia('(max-width: 899px)');

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

function dotsFor(step, T) {
  const length = step.text ? step.text.length : 20;
  return Math.min(Math.max(T.dotsMin, T.dotsMin + length * T.dotsPerChar), T.dotsMax);
}

// Two steps that are really one beat: the same thing happening on both phones at once
// (both switch to the group chat, both get the same line from Troy in it).
function sameBeat(a, b) {
  if (!a || !b || a.phone === b.phone || kind(a) !== kind(b)) return false;
  if (kind(a) === 'clear') return true;
  if (kind(a) === 'switch-group') return a.name === b.name;
  return kind(a) === 'message' && a.from !== 'me' && a.from === b.from && a.text != null && a.text === b.text;
}

class Convo {
  constructor(mount, data) {
    this.mount = mount;
    this.data = data;
    this.loop = mount.hasAttribute('data-convo-loop');
    this.T = this.loop ? { ...TIMING, ...HERO } : TIMING;
    this.dots = [];
    this.pulseEl = null;
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
    if (this.focus && oneScreen.matches) await this.sleep(this.T.focusRead, run);
    this.showFocus(name);
  }

  // Take over the mount: keep the conversation as plain text for screen readers, empty the phones.
  takeOver() {
    for (const [phoneName, p] of Object.entries(this.phones)) {
      const transcript = el('div', 'sr-only');
      for (const node of p.list.children) {
        if (node.classList.contains('msg-status')) continue;
        const line = node.getAttribute('aria-label') || node.textContent.trim();
        if (line) transcript.append(el('p', '', line));
      }
      if (this.loop) {
        for (const key of this.keys.slice(1)) {
          const screen = (this.data[key].phones || {})[phoneName] || {};
          for (const step of this.data[key].steps) {
            if (step.phone !== phoneName) continue;
            const who = step.from === 'me' ? screen.label || 'Student' : 'Troy';
            if (step.image) transcript.append(el('p', '', `${who}: ${step.alt || 'Photo'}`));
            else if (step.tapback) transcript.append(el('p', '', `${who} reacted ${step.tapback}`));
            else if (step.text) transcript.append(el('p', '', `${who}: ${step.text}`));
          }
        }
      }
      p.el.append(transcript);
      for (const part of [p.header, p.list, p.input]) part.setAttribute('aria-hidden', 'true');
    }
    this.mount.classList.add('is-live');
    this.mount.classList.remove('is-linked');
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
      p.el.classList.remove('is-speaking');
      this.setGroup(p, null);
    }
    this.mount.classList.remove('is-linked');
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
        else setTimeout(tick, Math.min(Math.max(left, 4), 80));
      };
      tick();
    });
  }

  setPaused(reason, on) {
    if (on) this.pauses.add(reason);
    else this.pauses.delete(reason);
  }

  async fade(parts, from, to, run) {
    const anims = parts.map((part) => part.animate({ opacity: [from, to] }, { duration: this.T.fade, easing: 'ease-in-out' }));
    for (const part of parts) part.style.opacity = to === 1 ? '' : String(to);
    await Promise.all(anims.map((a) => a.finished.catch(() => {})));
    this.check(run);
  }

  emit(name, detail) {
    if (name === 'convo:step' && detail.step.link != null) {
      this.mount.classList.toggle('is-linked', Boolean(detail.step.link));
      if (detail.step.link) this.pulse();
    }
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

  // Hero only: the gold line between the phones pulses once when the two people are connected.
  pulse() {
    if (!this.pulseEl) return;
    for (const anim of this.pulseEl.getAnimations()) anim.cancel();
    this.pulseEl.animate(
      { opacity: [0, 0.55, 0], transform: ['scale(0.98)', 'scale(1)', 'scale(1.03)'] },
      { duration: this.T.pulse, delay: 380, easing: 'ease-out' },
    );
  }

  // Hero only: four small dots under the phones show which scenario is playing. A click jumps to it.
  addDots() {
    if (!this.loop || this.keys.length < 2) return;
    const gold = this.mount.querySelector('.hero-link-gold');
    if (gold) {
      this.pulseEl = gold.cloneNode();
      this.pulseEl.setAttribute('class', 'hero-link-pulse');
      gold.after(this.pulseEl);
    }
    this.mount.style.setProperty('--hero-lift', `${this.T.lift}px`);
    const row = el('div', 'hero-dots');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Examples');
    this.keys.forEach((key, i) => {
      const dot = el('button', 'hero-dot');
      dot.type = 'button';
      dot.setAttribute('aria-label', `Play example ${i + 1} of ${this.keys.length}`);
      dot.addEventListener('click', () => {
        this.setPaused('tap', false);
        this.play(false, i);
      });
      this.dots.push(dot);
      row.append(dot);
    });
    this.mount.append(row);
  }

  markDot(key) {
    this.dots.forEach((dot, i) => {
      const on = this.keys[i] === key;
      dot.classList.toggle('is-on', on);
      if (on) dot.setAttribute('aria-current', 'true');
      else dot.removeAttribute('aria-current');
    });
  }

  async playStep(key, index, run, prevPhone) {
    const step = this.data[key].steps[index];
    const p = this.phones[step.phone];
    if (!p) return;
    const T = this.T;
    const type = kind(step);
    const mine = step.from === 'me';
    const detail = { key, index, step, phone: step.phone };

    if (type !== 'count' || step.focus) await this.focusOn(step.focus || step.phone, run);

    const moved = prevPhone && prevPhone !== step.phone ? T.phoneChange : 0;
    const gap = (ms) => this.sleep(step.delay != null ? step.delay : (index === 0 ? T.firstBeat : ms + moved), run);

    if (type === 'clear') {
      await gap(T.holdBeforeClear);
      this.mount.classList.remove('is-linked');
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
      if (this.loop) p.el.classList.add('is-speaking');
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
      p.el.classList.remove('is-speaking');
      this.emit('convo:step', detail);

      // "Read" shows before the other side starts typing.
      const next = this.data[key].steps.slice(index + 1).find((s) => s.phone === step.phone);
      const read = step.status === 'Read' || (next && next.from !== 'me' && kind(next) === 'message' && !step.status);
      if (T.statusInline) {
        // Hero: the status is there with the bubble and changes by itself, so the other phone can already answer.
        const status = el('div', 'msg-status', 'Delivered');
        bubble.after(status);
        this.toBottom(p, true);
        if (read) setTimeout(() => { if (run === this.run && status.isConnected) status.textContent = 'Read'; }, T.read);
        return;
      }
      await this.sleep(T.delivered, run);
      const status = el('div', 'msg-status', 'Delivered');
      bubble.after(status);
      this.toBottom(p, true);
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
    if (this.loop) p.el.classList.add('is-speaking');
    this.toBottom(p, true);
    await this.sleep(dotsFor(step, T), run);
    dots.remove();
    p.el.classList.remove('is-speaking');
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
    this.markDot(key);
    this.emit('convo:start', { key, replay });
    this.showFocus(steps[0] ? steps[0].focus || steps[0].phone : null);
    let prevPhone = null;
    let i = 0;
    while (i < steps.length) {
      const beat = [i];
      const joins = (next) => next && (next.with || sameBeat(steps[i], next));
      while (joins(steps[i + beat.length])) beat.push(i + beat.length);
      // In a beat each phone plays its own steps in order, and the phones run side by side.
      const lanes = new Map();
      for (const index of beat) {
        const lane = lanes.get(steps[index].phone) || [];
        lane.push(index);
        lanes.set(steps[index].phone, lane);
      }
      const from = beat.length > 1 ? null : prevPhone;
      await Promise.all([...lanes.values()].map(async (lane) => {
        for (const index of lane) await this.playStep(key, index, run, from);
      }));
      prevPhone = beat.length > 1 ? null : steps[i].phone;
      if (steps[i].focusAfter) await this.focusOn(steps[i].focusAfter, run);
      i += beat.length;
    }
    this.mount.dataset.convoState = 'done';
    this.emit('convo:done', { key });
  }

  async play(replay = false, startAt = 0) {
    const run = ++this.run;
    try {
      let i = startAt;
      do {
        for (; i < this.keys.length; i += 1) await this.playOne(this.keys[i], run, replay);
        i = 0;
      } while (this.loop);
      return true;
    } catch (err) {
      if (!(err instanceof Cancelled)) throw err;
      return false;
    }
  }
}

function watchHero(convo) {
  // Pause while the pointer is over a phone, or after a tap on one (tap again to resume).
  for (const phone of Object.values(convo.phones)) {
    phone.el.addEventListener('pointerenter', (e) => {
      if (e.pointerType === 'mouse') convo.setPaused('hover', true);
    });
    phone.el.addEventListener('pointerleave', () => convo.setPaused('hover', false));
    phone.el.addEventListener('click', () => convo.setPaused('tap', !convo.pauses.has('tap')));
  }
  // Stop while the hero is off screen.
  convo.setPaused('offscreen', true);
  new IntersectionObserver((entries) => {
    for (const entry of entries) convo.setPaused('offscreen', !entry.isIntersecting);
  }).observe(convo.mount);
  convo.play();
}

function ready(live) {
  document.documentElement.dataset.convoReady = String(live);
  window.dispatchEvent(new CustomEvent('convo:ready', { detail: { live } }));
}

async function init() {
  probePhotos();
  if (reducedMotion.matches) return ready(0);
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
      // The day scene's conversations only play when day.js has pinned the scene. Otherwise the static stops stay.
      if (!convo.loop && !document.documentElement.classList.contains('day-on')) continue;
      convo.takeOver();
      live.set(mount, convo);
      if (convo.loop) {
        convo.addDots();
        watchHero(convo);
        continue;
      }
      // A day at USC: day.js says when each stop plays.
      convo.addWho();
      mount.addEventListener('convo:play', (event) => {
        convo.play(!event.detail || event.detail.replay !== false);
      });
      mount.addEventListener('convo:stop', () => convo.stop());
    }
  }
  ready(live.size);
}

init();
