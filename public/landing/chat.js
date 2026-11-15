// Troy landing: the one conversation component.
// Reads landing/conversations.json and, for every .convo mount, replaces the static final state with
// an animated playback. Drives the hero phone (a loop of scenarios), the two-phone sections and the
// phone next to the map. With reduced motion it does nothing and the static HTML stays.
//
// Events, dispatched on the .convo mount (they bubble):
//   "convo:start"  detail { key, replay }               a conversation starts (or restarts)
//   "convo:step"   detail { key, index, step, phone }   a step's content has just appeared
//   "convo:done"   detail { key }                       the last step has finished
// The mount also carries data-convo-state="idle|playing|done" for scripts that load late.

// The data file sits next to this script. A version query on this script (added by the static build) carries over.
const DATA_URL = new URL('./conversations.json' + new URL(import.meta.url).search, import.meta.url);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

// Pacing, in milliseconds. Gaps between beats stay within 0.6 to 1.5 seconds.
const T = {
  firstBeat: 500,
  beforeTyping: 700,     // before the phone's owner starts typing
  charMin: 28,
  charMax: 72,
  beforeSend: 260,
  press: 130,
  delivered: 380,
  read: 650,
  beforeDots: 650,       // before the three dots show
  dotsMin: 900,
  dotsMax: 1500,
  dotsPerChar: 14,
  tapback: 1500,
  countUpdate: 1500,
  switchGroup: 1100,
  phoneChange: 400,      // extra beat when the story moves to the other phone
  holdBeforeClear: 2400,
  fade: 320,
};

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
        seen: this.loop,
      };
    }
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

    // On a narrow screen the second phone is below the first. Its part of the story waits until it has been seen.
    while (!p.seen) await this.sleep(150, run);

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
        await live.animate({ opacity: [1, 0] }, { duration: 160 }).finished.catch(() => {});
        this.check(run);
        live.textContent = step.text;
        live.animate({ opacity: [0, 1] }, { duration: 200 });
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
        { duration: Math.min(300 + rise * 0.3, 460), easing: EASE },
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
    const length = step.text ? step.text.length : 20;
    await this.sleep(Math.min(Math.max(T.dotsMin, 600 + length * T.dotsPerChar), T.dotsMax), run);
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
    let prevPhone = null;
    let i = 0;
    while (i < steps.length) {
      const beat = [i];
      while (sameBeat(steps[i], steps[i + beat.length])) beat.push(i + beat.length);
      await Promise.all(beat.map((index) => this.playStep(key, index, run, beat.length > 1 ? null : prevPhone)));
      prevPhone = beat.length > 1 ? null : steps[i].phone;
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
    } catch (err) {
      if (!(err instanceof Cancelled)) throw err;
    }
  }
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

function watchSection(convo) {
  const phones = Object.values(convo.phones);
  // Each phone's part of the story waits until that phone has been on screen.
  const seen = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      // A visitor who lands on the second phone has passed the first, so its part is free to play too.
      const at = phones.findIndex((phone) => phone.el === entry.target);
      for (const p of phones.slice(0, at + 1)) p.seen = true;
      seen.unobserve(entry.target);
    }
  }, { threshold: 0.3 });
  for (const p of phones) seen.observe(p.el);

  // Play once per page load, when a phone scrolls into view.
  const start = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    start.disconnect();
    convo.play();
  }, { threshold: 0.4 });
  for (const p of phones) start.observe(p.el);

  for (const key of convo.keys) {
    for (const button of document.querySelectorAll(`.replay[data-replay="${key}"]`)) {
      button.addEventListener('click', () => {
        start.disconnect();
        for (const p of phones) p.seen = true;
        convo.play(true);
      });
    }
  }
}

async function init() {
  if (reducedMotion.matches) return;
  const mounts = [...document.querySelectorAll('.convo[data-convo]')];
  if (!mounts.length) return;
  let data;
  try {
    const res = await fetch(DATA_URL);
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return; // The static conversation stays.
  }
  for (const mount of mounts) {
    const convo = new Convo(mount, data);
    if (!convo.keys.length) continue;
    convo.takeOver();
    if (convo.loop) watchHero(convo);
    else watchSection(convo);
  }
}

init();
