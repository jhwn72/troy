// Troy web simulator: the phone on simulator.html.
//
// One call does everything: POST api/sim with the whole conversation, and Troy's next texts come back.
//   request:  { messages: [{ from: "me" | "troy", text?, imageBase64?, imageMime?, photo?, location?, vote?, reaction?, poll?, sig? }], situation? }
//   response: { ok, bubbles: [{ text, sig }], poll?: { question, options, sig }, tapback?, card?, example?, fixed?, ended? }
// Each troy line comes with a signature and goes back with it unchanged: the function refuses troy lines it never sent.
//             or { ok: false, error: "limit" | "bad_request" | "busy" }
// The function behind it is stateless and connected to nothing: no Troy server, no database, no other people.
// Every situation Troy plays here is an example.
//
// Forgetting is by construction. The conversation is the `convo` array below and lives nowhere else: nothing in
// localStorage, sessionStorage, cookies or the URL, and the server keeps nothing. Leaving the page drops it.

const LEAVE_TEXT = "Are you sure? This is a simulator, so Troy will forget the conversation after you leave.";
const LIMIT_TEXT = "This is a demo with a message limit, and you have reached it. Troy works on iMessage.";
const OFFLINE_TEXT = "The simulator is offline right now. Troy works on iMessage.";
const ENDED_TEXT = 'Troy will stay quiet now. Text "START" or "hey troy" to talk again.';
const MAX_MINE = 25;               // the function refuses more; the page says so before sending
const MAX_TEXT = 600;
const MAX_IMAGE_SIDE = 1024;
const MAX_IMAGE_BYTES = 950 * 1024;
const STAMP_GAP_MS = 15 * 60 * 1000;
const TAPBACKS = [
  { type: "love", glyph: "\u2764\uFE0F", label: "Love" },
  { type: "like", glyph: "\uD83D\uDC4D", label: "Like" },
  { type: "dislike", glyph: "\uD83D\uDC4E", label: "Dislike" },
  { type: "laugh", glyph: "HA HA", label: "Laugh", word: true },
  { type: "emphasize", glyph: "!!", label: "Emphasize" },
  { type: "question", glyph: "?", label: "Question" },
];
// USC University Park, for the rough "near campus or not" a location share turns into.
const USC = { lat: 34.0224, lng: -118.2851 };

const $ = (id) => document.getElementById(id);
const list = $("sim-list");
const form = $("sim-form");
const field = $("sim-text");
const sendBtn = $("sim-send");
const plus = $("sim-plus");
const menu = $("sim-menu");
const fileInput = $("sim-file");
const attachBox = $("sim-attach");
const leave = $("sim-leave");

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- State (this page only, never stored) ----------

let convo = [];             // the whole conversation, sent with every request
let epoch = 0;              // bumped when the phone starts over, so a late answer is dropped
let busy = false;           // an exchange with Troy is in progress
let pumpTimer = null;
let sentCount = 0;          // messages the visitor has sent; the leave prompt starts after the first
let situation = "";         // the example Troy is playing, as he named it
let ended = false;          // after STOP: quiet until START or "hey troy"
let leaving = false;
let attachment = null;      // { base64, mime, url }
let typingEl = null;
let lastStampAt = 0;
let lastMine = null;        // the visitor's newest bubble, where Delivered / Read sits
let statusEl = null;
let lastTroy = null;        // Troy's newest text bubble: a thumbs up or a heart on it is an answer

// ---------- Small pieces of the Messages look ----------

const clock = (at) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function tickClock() {
  const node = $("sim-clock");
  if (node) node.textContent = clock(Date.now()).replace(/\s?[AP]M$/i, "");
}

function nearBottom() {
  return list.scrollHeight - list.scrollTop - list.clientHeight < 140;
}
function toBottom() {
  list.scrollTop = list.scrollHeight;
}

/** Adds a node at the end of the conversation, keeping the typing dots last. */
function append(node, { stick = true } = {}) {
  const pinned = nearBottom();
  if (typingEl && typingEl.parentNode === list) list.insertBefore(node, typingEl);
  else list.append(node);
  if (stick || pinned) toBottom();
  return node;
}

/** The centered line. Messages opens a thread with "iMessage" and the day, and repeats the time after a long gap. */
function stamp(at) {
  if (lastStampAt && at - lastStampAt < STAMP_GAP_MS) return;
  const first = !lastStampAt;
  lastStampAt = at;
  const note = el("p", "msg-note");
  if (first) note.append("iMessage", el("br"));
  note.append(el("b", "", "Today"), ` ${clock(at)}`);
  append(note);
}

/** A small gray system line. The same line is not written twice in a row. */
function note(text) {
  const last = list.lastElementChild === typingEl ? typingEl.previousElementSibling : list.lastElementChild;
  if (last && last.classList.contains("msg-note") && last.textContent === text) return last;
  return append(el("p", "msg-note", text));
}

/** Only the last bubble of a run from one side keeps its tail. */
function retail() {
  const bubbles = Array.from(list.querySelectorAll(".bubble"));
  bubbles.forEach((b, i) => {
    const next = bubbles[i + 1];
    const side = b.classList.contains("from-me");
    const lastOfRun = !next || next.classList.contains("from-me") !== side;
    b.classList.toggle("tail", lastOfRun && !b.classList.contains("is-photo"));
  });
}

function setStatus(text, failed = false) {
  if (statusEl) statusEl.remove();
  statusEl = null;
  if (!lastMine || !text) return;
  statusEl = el("p", "msg-status" + (failed ? " is-failed" : ""), text);
  lastMine.after(statusEl);
  if (nearBottom()) toBottom();
}

function showTyping(on) {
  if (on) {
    if (!typingEl) {
      typingEl = el("div", "typing");
      typingEl.setAttribute("aria-label", "Troy is typing");
      typingEl.append(el("i"), el("i"), el("i"));
    }
    const pinned = nearBottom();
    list.append(typingEl);
    if (pinned) toBottom();
  } else if (typingEl) {
    typingEl.remove();
  }
}

// ---------- Bubbles ----------

function photoBubble(side, src, alt) {
  const bubble = el("div", `bubble ${side} is-photo`);
  const img = el("img");
  img.alt = alt;
  img.decoding = "async";
  img.addEventListener("load", () => { if (nearBottom()) toBottom(); });
  img.src = src;
  bubble.append(img);
  return bubble;
}

function cardBubble(side, { picture, pin, title, caption }) {
  const bubble = el("div", `bubble ${side} is-card`);
  if (picture) {
    const img = el("img", "sim-card-pic");
    img.src = picture;
    img.alt = "";
    bubble.append(img);
  } else if (pin) {
    bubble.append(el("span", "sim-pin"));
  }
  const words = el("span", "sim-card-words");
  words.append(el("b", "", title));
  if (caption) words.append(el("small", "", caption));
  bubble.append(words);
  return bubble;
}

function drawTapback(rec) {
  const old = rec.bubble.querySelector(":scope > .tapback");
  if (old) old.remove();
  // On Troy's bubble the badge is the visitor's reaction; on the visitor's bubble it is Troy's.
  const spec = TAPBACKS.find((t) => t.type === rec.tap);
  if (!spec) return;
  const badge = el("span", "tapback" + (spec.word ? " is-word" : ""), spec.glyph);
  badge.setAttribute("role", "img");
  badge.setAttribute("aria-label", `${rec.mine ? "Troy" : "You"} reacted: ${spec.label}`);
  rec.bubble.append(badge);
}

// ---------- The tapback picker (on Troy's bubbles) ----------

let picker = null;

function closePicker() {
  if (!picker) return;
  picker.node.remove();
  picker.rec.bubble.classList.remove("is-picking");
  picker = null;
}

function openPicker(rec, focusFirst = false) {
  closePicker();
  const node = el("div", "sim-picker");
  node.setAttribute("role", "group");
  node.setAttribute("aria-label", "React to this message");
  for (const spec of TAPBACKS) {
    const b = el("button", spec.word ? "is-word" : "", spec.glyph);
    b.type = "button";
    b.setAttribute("aria-label", spec.label);
    b.setAttribute("aria-pressed", rec.tap === spec.type ? "true" : "false");
    b.addEventListener("click", (event) => {
      event.stopPropagation();
      const removed = rec.tap === spec.type;
      rec.tap = removed ? null : spec.type;
      drawTapback(rec);
      closePicker();
      // A reaction is only a turn when it plausibly answers something: a thumbs up or a heart on Troy's newest
      // text. Anything else is just shown, the way most tapbacks are just an acknowledgment.
      if (!removed && !ended && rec.bubble === lastTroy && (spec.type === "like" || spec.type === "love")) {
        say({ from: "me", reaction: { type: spec.type, onText: rec.text.slice(0, MAX_TEXT) } }, 700);
      }
    });
    node.append(b);
  }
  // Above the bubble when there is room, below it when the bubble is at the top of the screen.
  const room = rec.bubble.getBoundingClientRect().top - list.getBoundingClientRect().top;
  node.style.left = "0";
  if (room > 58) node.style.bottom = "calc(100% + 6px)";
  else node.style.top = "calc(100% + 6px)";
  rec.bubble.classList.add("is-picking");
  rec.bubble.append(node);
  picker = { node, rec, at: Date.now() };
  if (focusFirst) node.querySelector("button").focus();
  const over = node.getBoundingClientRect().bottom - list.getBoundingClientRect().bottom;
  if (over > 0) list.scrollTop += over + 8;
}

function wireReact(rec) {
  const bubble = rec.bubble;
  // A small button for pointers and keyboards.
  const open = el("button", "sim-react");
  open.type = "button";
  open.setAttribute("aria-label", "React to this message");
  open.addEventListener("click", (event) => {
    event.stopPropagation();
    if (picker && picker.rec === rec) closePicker();
    else openPicker(rec, event.detail === 0);
  });
  bubble.append(open);
  // Right-click, and the long press that phones turn into a context menu.
  bubble.addEventListener("contextmenu", (event) => {
    if (event.target.closest("button, a")) return;
    event.preventDefault();
    openPicker(rec);
  });
  // Long press, for touch screens that do not send contextmenu.
  let timer = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  bubble.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" || event.target.closest("button, a")) return;
    cancel();
    timer = setTimeout(() => { timer = null; openPicker(rec); }, 480);
  });
  for (const name of ["pointerup", "pointercancel", "pointerleave", "pointermove"]) {
    bubble.addEventListener(name, (event) => {
      if (name === "pointermove" && Math.abs(event.movementX) + Math.abs(event.movementY) < 6) return;
      cancel();
    });
  }
}

document.addEventListener("click", (event) => {
  // The click that can follow a long press must not close the picker it just opened.
  if (picker && Date.now() - picker.at > 500 && !event.target.closest(".sim-picker")) closePicker();
  if (!menu.hidden && !event.target.closest(".sim-plus-wrap")) closeMenu();
});

// ---------- Polls ----------

/** A native-looking poll. Each tap is a vote; votes made close together go to Troy as one turn. */
function pollBubble(poll) {
  const bubble = el("div", "bubble from-them is-poll");
  bubble.setAttribute("role", "group");
  bubble.setAttribute("aria-label", poll.question ? `Poll: ${poll.question}` : "Poll");
  bubble.append(el("span", "sim-poll-label", "Poll"));
  if (poll.question) bubble.append(el("span", "sim-poll-q", poll.question));
  const mine = new Set();
  poll.options.forEach((text) => {
    const b = el("button", "sim-poll-opt");
    b.type = "button";
    b.setAttribute("aria-pressed", "false");
    b.append(el("span", "tick"), el("span", "words", text), el("span", "n", "0"));
    b.addEventListener("click", () => {
      // A vote cannot be taken back here: it has already been said to Troy.
      if (mine.has(text) || ended) return;
      if (!canSay()) return;
      mine.add(text);
      b.setAttribute("aria-pressed", "true");
      b.querySelector(".n").textContent = "1";
      say({ from: "me", vote: { question: poll.question, option: text } }, 900);
    });
    bubble.append(b);
  });
  return bubble;
}

// ---------- Talking to Troy ----------

/** Troy's pace: he reads first, then types 1 to 2 seconds for a normal bubble and 3 to 4 for a long one. */
const typingMs = (text) => (text.length > 110 ? 3000 + Math.random() * 1000 : 1000 + Math.random() * 1000);

function canSay() {
  if (sentCount < MAX_MINE) return true;
  note(LIMIT_TEXT);
  return false;
}

/** Adds one of the visitor's turns to the conversation and gets Troy's answer after a short beat. */
function say(turn, delay = 0) {
  convo.push(turn);
  sentCount += 1;
  clearTimeout(pumpTimer);
  pumpTimer = setTimeout(pump, delay);
}

async function ask() {
  const res = await fetch("api/sim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Only the newest message may carry a photo: older ones are sent as words alone.
    body: JSON.stringify({
      messages: convo.map((m, i) => {
        if (i === convo.length - 1 || !m.imageBase64) return m;
        const { imageBase64, imageMime, ...rest } = m;
        return { ...rest, photo: true };
      }),
      ...(situation ? { situation } : {}),
    }),
    credentials: "omit",
    cache: "no-store",
  });
  const data = await res.json().catch(() => null);
  if (!data || typeof data !== "object") throw new Error("no answer");
  return data;
}

function failed(line) {
  showTyping(false);
  if (lastMine) {
    lastMine.classList.add("is-failed");
    if (!lastMine.querySelector(".sim-bang")) {
      const bang = el("span", "sim-bang", "!");
      bang.setAttribute("aria-hidden", "true");
      lastMine.append(bang);
    }
    setStatus("Not Delivered", true);
  }
  note(line);
}

/** One exchange: Read, the typing dots, the request, then Troy's bubbles one at a time. */
async function pump() {
  if (busy) return;
  const mine = epoch;
  let upTo = convo.length;
  if (!upTo || convo[upTo - 1].from !== "me") return;
  busy = true;
  const stale = () => mine !== epoch;
  try {
    if (ended) {
      // After STOP nothing shows as read. The function still answers an emergency, or START.
      const data = await ask().catch(() => null);
      if (stale()) return;
      if (data && data.ok && Array.isArray(data.bubbles) && data.bubbles.length) await play(data, stale);
      return;
    }
    await wait(500 + Math.random() * 500);
    if (stale()) return;
    setStatus(`Read ${clock(Date.now())}`);
    await wait(350);
    if (stale()) return;
    showTyping(true);
    let data = null;
    try {
      data = await ask();
    } catch {
      data = null;
    }
    if (stale()) return;
    if (!data || !data.ok) {
      // The turn was never answered, so it does not stay in the conversation that gets sent again.
      failed(data && data.error === "limit" ? LIMIT_TEXT : OFFLINE_TEXT);
      const dropped = trailingMine(upTo);
      convo.splice(upTo - dropped, dropped);
      upTo -= dropped;
      return;
    }
    await play(data, stale);
  } finally {
    if (mine === epoch) {
      busy = false;
      showTyping(false);
      if (convo.length > upTo && convo[convo.length - 1].from === "me") pump();
    }
  }
}

/** How many of the visitor's turns sit together at the end of the first `upTo` messages. */
function trailingMine(upTo) {
  let n = 0;
  while (n < upTo && convo[upTo - 1 - n].from === "me") n += 1;
  return n;
}

async function play(data, stale) {
  const wasEnded = ended;
  if (data.tapback && lastMine && TAPBACKS.some((t) => t.type === data.tapback.type)) {
    drawTapback({ bubble: lastMine, mine: true, tap: data.tapback.type });
  }
  // The gray line is the page's own label for an example, shown once when one starts. No example named means it ended.
  const example = typeof data.example === "string" ? data.example : "";
  if (example && example !== situation) note(`Example: ${example}. Nobody real is on the other end.`);
  if (!data.fixed) situation = example;
  const bubbles = Array.isArray(data.bubbles) ? data.bubbles.filter((b) => b && typeof b.text === "string" && b.text) : [];
  for (let i = 0; i < bubbles.length; i++) {
    const text = bubbles[i].text;
    // The safety lines go out at once, with no typing wait.
    if (!data.fixed || data.fixed === "start") {
      showTyping(true);
      await wait(typingMs(text));
      if (stale()) return;
    }
    showTyping(false);
    stamp(Date.now());
    const bubble = el("div", "bubble from-them");
    bubble.append(el("span", "sim-words", text));
    append(bubble, { stick: false });
    wireReact({ bubble, mine: false, tap: null, text });
    lastTroy = bubble;
    convo.push({ from: "troy", text, ...(typeof bubbles[i].sig === "string" ? { sig: bubbles[i].sig } : {}) });
    retail();
    if (i < bubbles.length - 1) await wait(280);
  }
  if (data.card) {
    await wait(500);
    if (stale()) return;
    const card = cardBubble("from-them", { picture: "assets/troy-avatar.svg", title: "Troy", caption: "Contact" });
    card.append(el("span", "sim-card-chev"));
    append(card, { stick: false });
    retail();
    // The real Troy leaves a beat after the card before the next bubble.
    await wait(1400);
    if (stale()) return;
  }
  if (data.poll && Array.isArray(data.poll.options) && data.poll.options.length >= 2) {
    showTyping(true);
    await wait(900);
    if (stale()) return;
    showTyping(false);
    const poll = { question: String(data.poll.question || ""), options: data.poll.options.map(String) };
    append(pollBubble(poll), { stick: false });
    convo.push({ from: "troy", poll, ...(typeof data.poll.sig === "string" ? { sig: data.poll.sig } : {}) });
    retail();
  }
  ended = data.ended === true;
  if (data.fixed === "start") ended = false;
  if (ended && !wasEnded) note(ENDED_TEXT);
}

/** Shows the visitor's bubbles at once (a photo with words is two), then says them to Troy as one turn. */
function send(turn, bubbles) {
  if (!canSay()) return false;
  stamp(Date.now());
  for (const b of bubbles) append(b);
  lastMine = bubbles[bubbles.length - 1];
  setStatus("");
  retail();
  const mine = lastMine;
  setTimeout(() => {
    if (lastMine === mine && !statusEl) setStatus("Delivered");
  }, 350);
  say(turn);
  return true;
}

// ---------- Composer ----------

function fit() {
  field.style.height = "auto";
  field.style.height = `${Math.min(field.scrollHeight, 110)}px`;
  sendBtn.disabled = !field.value.trim() && !attachment;
}

function clearAttachment() {
  attachment = null;
  attachBox.hidden = true;
  attachBox.replaceChildren();
  fileInput.value = "";
  fit();
}

function submit() {
  const text = field.value.trim();
  if (!text && !attachment) return;
  if (text.length > MAX_TEXT) {
    note(`That message is too long for the simulator. Keep it under ${MAX_TEXT} characters.`);
    return;
  }
  const bubbles = [];
  const payload = { from: "me" };
  if (attachment) {
    bubbles.push(photoBubble("from-me", attachment.url, "Photo you sent"));
    payload.imageBase64 = attachment.base64;
    payload.imageMime = attachment.mime;
  }
  if (text) {
    const words = el("div", "bubble from-me");
    words.append(el("span", "sim-words", text));
    bubbles.push(words);
    payload.text = text;
  }
  if (!send(payload, bubbles)) return;
  field.value = "";
  clearAttachment();
  field.focus();
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  submit();
});
field.addEventListener("input", fit);
field.addEventListener("keydown", (event) => {
  // Return sends, the way it does with a keyboard attached. Shift+Return is a new line.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
});

// ---------- The plus menu: a photo, or where you are ----------

function closeMenu() {
  menu.hidden = true;
  plus.setAttribute("aria-expanded", "false");
}
plus.addEventListener("click", () => {
  const open = menu.hidden;
  menu.hidden = !open;
  plus.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) menu.querySelector("button").focus();
});
menu.addEventListener("keydown", (event) => {
  const items = Array.from(menu.querySelectorAll("button"));
  const at = items.indexOf(document.activeElement);
  if (event.key === "Escape") { closeMenu(); plus.focus(); }
  else if (event.key === "ArrowDown") { event.preventDefault(); items[(at + 1) % items.length].focus(); }
  else if (event.key === "ArrowUp") { event.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
});
$("sim-menu-photo").addEventListener("click", () => {
  closeMenu();
  fileInput.click();
});
$("sim-menu-location").addEventListener("click", () => {
  closeMenu();
  shareLocation();
});

/** Reads a JPEG or PNG and makes it small enough to send: longest side 1024px and under 1 MB, drawn again as a JPEG when it has to shrink. */
async function prepareImage(file) {
  if (!file || (file.type !== "image/jpeg" && file.type !== "image/png")) return null;
  const blobUrl = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = blobUrl;
    await img.decode();
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const small = scale === 1 && file.size < MAX_IMAGE_BYTES;
    let dataUrl;
    let mime = file.type;
    if (small) {
      dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext("2d");
      // A PNG can be see-through; a JPEG cannot, so it gets a white ground.
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      // Lower the quality until it fits under the function's 1 MB limit.
      for (const quality of [0.85, 0.7, 0.55, 0.4]) {
        dataUrl = canvas.toDataURL("image/jpeg", quality);
        if (dataUrl.length * 0.75 < MAX_IMAGE_BYTES) break;
      }
      if (dataUrl.length * 0.75 >= MAX_IMAGE_BYTES) return null;
      mime = "image/jpeg";
    }
    return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1), mime, url: dataUrl };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  const ready = await prepareImage(file);
  if (!ready) {
    fileInput.value = "";
    note("That file could not be added. Photos need to be JPEG or PNG.");
    return;
  }
  attachment = ready;
  const box = el("div", "sim-attach-box");
  const img = el("img");
  img.src = ready.url;
  img.alt = "Photo ready to send";
  const drop = el("button", "", "×");
  drop.type = "button";
  drop.setAttribute("aria-label", "Remove the photo");
  drop.addEventListener("click", clearAttachment);
  box.append(img, drop);
  attachBox.replaceChildren(box);
  attachBox.hidden = false;
  fit();
  field.focus();
});

/**
 * Asks the browser where the visitor is, only on this tap. The coordinates never leave this page: there is nothing
 * real to locate against in a simulator, so Troy is only told something rough the page works out itself (near
 * campus or not, from the distance to USC). Nothing is watched afterwards.
 */
function shareLocation() {
  if (!("geolocation" in navigator)) {
    note("This browser cannot share a location. You can tell Troy where you are in words.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const rad = Math.PI / 180;
      const dLat = (pos.coords.latitude - USC.lat) * rad;
      const dLng = (pos.coords.longitude - USC.lng) * rad;
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(USC.lat * rad) * Math.cos(pos.coords.latitude * rad) * Math.sin(dLng / 2) ** 2;
      const km = 6371 * 2 * Math.asin(Math.sqrt(a));
      const rough = km < 1.5 ? "near campus" : "not near campus";
      send({ from: "me", location: rough }, [cardBubble("from-me", { pin: true, title: "Location", caption: rough === "near campus" ? "Near campus" : "Not near campus" })]);
    },
    () => note("Location was not shared. You can tell Troy where you are in words."),
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 },
  );
}

// ---------- Forgetting ----------

// Back from the browser's page cache: the conversation was dropped when the page went away, so the phone starts clean.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) reset();
});

// Closing the tab or reloading. Browsers do not allow a page to set the words of this prompt (they all show
// their own generic "Leave site?" text), so the exact sentence is only possible for clicks on links, below.
window.addEventListener("beforeunload", (event) => {
  if (leaving || sentCount === 0) return;
  event.preventDefault();
  event.returnValue = LEAVE_TEXT;
});

// Clicks on the page's own links (nav, brand, footer): the site's dialog with the exact sentence.
let leaveTo = null;
document.addEventListener("click", (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest && event.target.closest("a[href]");
  if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
  if (sentCount === 0) return;
  const url = new URL(link.href, location.href);
  // The link to this same page would only throw the conversation away, so it asks too.
  event.preventDefault();
  leaveTo = url.href;
  if (typeof leave.showModal === "function") {
    leave.showModal();           // a modal dialog keeps focus inside it and makes the rest of the page inert
    $("sim-stay").focus();
  } else if (window.confirm(LEAVE_TEXT)) {
    go();
  }
});

function go() {
  if (!leaveTo) return;
  leaving = true;                // the beforeunload prompt has already been answered here
  location.href = leaveTo;
}
$("sim-stay").addEventListener("click", () => leave.close());
$("sim-go").addEventListener("click", () => {
  leave.close();
  go();
});
// Escape closes a modal dialog by itself, which is "stay". A click on the dimmed page behind it is "stay" too.
leave.addEventListener("click", (event) => {
  if (event.target === leave) leave.close();
});
leave.addEventListener("close", () => {
  if (!leaving) leaveTo = null;
});

// ---------- Start ----------

function reset() {
  clearTimeout(pumpTimer);
  epoch += 1;
  convo = [];
  busy = false;
  sentCount = 0;
  situation = "";
  ended = false;
  leaving = false;
  lastStampAt = 0;
  lastMine = null;
  lastTroy = null;
  statusEl = null;
  typingEl = null;
  list.replaceChildren();
  field.value = "hey troy";
  clearAttachment();
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && picker) closePicker();
});

tickClock();
setInterval(tickClock, 15000);
fit();
