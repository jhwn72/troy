// Troy web simulator: the whole server side, one stateless request handler.
//
// It is connected to nothing. No Troy server, no database, no other users, no email, no offices. The browser
// holds the conversation and sends all of it with every request; this file answers and forgets. The only outside
// call is to the Claude API, for Troy's wording.
//
// Plain JavaScript on purpose: Vercel runs it as is (vercel-landing/api/), tests import it as is, and
// scripts/sim-dev.ts mounts it for local preview. The fixed safety copy, the phrase patterns and the system
// prompt are not in this file: scripts/build-sim.ts makes them from src/ and brain/ and passes them in as `data`.
//
// Names starting with an underscore are not turned into routes by Vercel, so only api/sim.js is public.

import { createHmac, timingSafeEqual } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";

export const LIMITS = {
  // Best effort, per running instance (memory only, nothing stored): model calls per visitor IP and in total per
  // window, and how many model calls may be in flight at once. The real brakes are the spend limit on the key and
  // TROY_SIM=off; this only slows one script down.
  windowMs: 10 * 60 * 1000,
  perIp: 40,
  perInstance: 600,
  inFlight: 20,
  bodyBytes: 1_500_000,
  messages: 60,
  mine: 25,
  textChars: 600,
  imageBytes: 1_000_000,
  sentToModel: 24,
  maxTokens: 500,
  timeoutMs: 20_000,
  bubbles: 4,
  welcomeBubbles: 5,
  bubbleChars: 240,
  pollOptions: 5,
  pollOptionChars: 60,
  pollQuestionChars: 120,
  exampleChars: 40,
};

export const MODEL = "claude-haiku-5-5";

const TAPBACKS = ["love", "like", "dislike", "laugh", "emphasize", "question"];
const TAPBACK_WORDS = { love: "a heart", like: "a thumbs up", dislike: "a thumbs down", laugh: "haha", emphasize: "!!", question: "a question mark" };
const IMAGE_MIMES = ["image/jpeg", "image/png"];
const LOCATIONS = ["near campus", "not near campus"];
/** The example names the brief gives. Anything else the page sends as `situation` is ignored, never put in the prompt. */
export const SITUATIONS = ["lost and found", "free food", "broken thing", "campus concern", "lax ride", "topics"];

// ---------- signed troy turns ----------
//
// The browser holds the conversation, so without a check it could hand back "troy" lines he never wrote (a fake
// "i filed it with fms", a made-up number) and the model would carry on from them. Every line troy sends carries a
// short HMAC; a troy line coming back without a valid one is refused. Stateless: the key is derived from
// TROY_SIM_SECRET, or from the API key (one way, so nothing about the API key can be learned from a signature).

function turnKey(env) {
  const material = env.TROY_SIM_SECRET || env.ANTHROPIC_API_KEY;
  if (!material) return null;
  return createHmac("sha256", String(material)).update("troy-sim-turn-v1").digest();
}

function turnPayload(m) {
  return m.poll ? `p\n${JSON.stringify([m.poll.question, m.poll.options])}` : `t\n${m.text}`;
}

/** The signature for one troy message ({ text } or { poll }), or "" when there is no key. */
export function signTurn(key, m) {
  if (!key) return "";
  return createHmac("sha256", key).update(turnPayload(m)).digest("base64url").slice(0, 32);
}

function validTurn(key, m) {
  if (typeof m.sig !== "string" || m.sig.length !== 32) return false;
  const want = Buffer.from(signTurn(key, m));
  const got = Buffer.from(m.sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** Exposed for tests: the same key the handler would use for this env. */
export function turnKeyFor(env) {
  return turnKey(env);
}

/**
 * What the visitor typed, made unable to pass as the page or code. Bracketed lines ("[tapped ...]", "[sent a photo]")
 * and the "(simulator context ...)" note are only ever written by this file, so typed brackets become parentheses
 * and the note's label is broken up.
 */
export function typed(text) {
  return String(text).replace(/\[/g, "(").replace(/\]/g, ")").replace(/simulator[\s_-]*context/gi, "simulator");
}

/** What the model must return. Flat, every field required, so the reply always parses. Code clamps it afterwards. */
export const REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["bubbles", "poll_question", "poll_options", "tapback", "card", "example"],
  properties: {
    bubbles: { type: "array", items: { type: "string" }, description: "troy's next texts, one to three short ones, in order" },
    poll_question: { type: "string", description: "the poll's question, or an empty string for no poll" },
    poll_options: { type: "array", items: { type: "string" }, description: "two to five short options, or an empty list for no poll" },
    tapback: { type: "string", enum: ["none", ...TAPBACKS], description: "a reaction on the visitor's last message. almost always none" },
    card: { type: "boolean", description: "true only on the turn troy asks them to save his contact" },
    example: { type: "string", description: "a two or three word name for the example situation being played, or an empty string" },
  },
};

// ---------- small helpers ----------

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
}

const bad = () => json(400, { ok: false, error: "bad_request" });
const busy = () => json(503, { ok: false, error: "busy" });
const limit = () => json(429, { ok: false, error: "limit" });

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v, max) => typeof v === "string" && v.length <= max;

/** Same cleaning the real commands use (src/commands.ts clean): lowercase, apostrophes dropped, punctuation to spaces. */
export function clean(text) {
  return String(text)
    .toLowerCase()
    .replace(/[‘’'`]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compile(data) {
  const re = (p) => new RegExp(p.source, p.flags);
  return {
    emergency: data.patterns.emergency.map(re),
    crisis: data.patterns.crisis.map(re),
    laughWords: re(data.patterns.laughWords),
    laughEmoji: re(data.patterns.laughEmoji),
    smallCause: re(data.patterns.smallCause),
    conditional: re(data.patterns.conditional),
  };
}

/**
 * What code can tell about one message by itself: "crisis", "emergency", "stop", "start" or null.
 * Crisis is unmistakable only (a plain first-person statement with nothing light around it); everything
 * ambiguous is left to the model, which has the persona's guidance.
 */
export function fixedKind(text, data, compiled = compile(data)) {
  if (typeof text !== "string") return null;
  const t = clean(text);
  if (!t) return null;
  const light = compiled.laughWords.test(t) || compiled.laughEmoji.test(text) || compiled.smallCause.test(t) || compiled.conditional.test(t);
  if (compiled.crisis.some((p) => p.test(t)) && !light) return "crisis";
  if (compiled.emergency.some((p) => p.test(t))) return "emergency";
  if (data.stopWords.includes(t)) return "stop";
  if (data.startWords.includes(t) || /^hey+ troy\b/.test(t)) return "start";
  return null;
}

/** The request's own origin, or null. Only browsers on this same site (or the same local server) may call. */
function sameOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let from;
  try {
    from = new URL(origin);
  } catch {
    return false;
  }
  if (from.protocol !== "https:" && from.protocol !== "http:") return false;
  const host = (request.headers.get("x-forwarded-host") || request.headers.get("host") || "").split(",")[0].trim().toLowerCase();
  return !!host && from.host.toLowerCase() === host;
}

function base64Bytes(b64) {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

/** Checks the first bytes say what the mime says, so nothing but a JPEG or PNG is ever passed on. */
function looksLike(b64, mime) {
  if (mime === "image/jpeg") return b64.startsWith("/9j/");
  if (mime === "image/png") return b64.startsWith("iVBORw0KGgo");
  return false;
}

/** Validates the body. Returns { messages, situation } or "bad_request" | "limit". */
export function readBody(body) {
  if (!isObject(body) || !Array.isArray(body.messages) || body.messages.length === 0) return "bad_request";
  if (body.situation !== undefined && !isText(body.situation, LIMITS.exampleChars)) return "bad_request";
  const list = body.messages;
  if (list.length > LIMITS.messages) return "limit";
  const out = [];
  let mine = 0;
  // What troy has said so far, so a vote or a reaction can only be on something he really sent.
  const polls = [];
  const troyTexts = new Set();
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const last = i === list.length - 1;
    if (!isObject(m) || (m.from !== "me" && m.from !== "troy")) return "bad_request";
    const item = { from: m.from };
    if (m.text !== undefined) {
      if (typeof m.text !== "string") return "bad_request";
      if (m.text.length > LIMITS.textChars) return "bad_request";
      if (m.text.trim()) item.text = m.text.trim();
    }
    if (m.from === "me") {
      mine += 1;
      if (m.imageBase64 !== undefined || m.imageMime !== undefined) {
        // One image at most, and only on the newest message: older photos are never sent again.
        if (!last) return "bad_request";
        if (typeof m.imageBase64 !== "string" || !IMAGE_MIMES.includes(m.imageMime)) return "bad_request";
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(m.imageBase64) || m.imageBase64.length % 4 !== 0) return "bad_request";
        if (base64Bytes(m.imageBase64) > LIMITS.imageBytes) return "bad_request";
        if (!looksLike(m.imageBase64, m.imageMime)) return "bad_request";
        item.imageBase64 = m.imageBase64;
        item.imageMime = m.imageMime;
      }
      // An older photo is sent again as a flag only; the page never resends its bytes.
      if (m.photo !== undefined) {
        if (m.photo !== true || item.imageBase64) return "bad_request";
        item.photo = true;
      }
      // A location share is only ever the rough line the page works out; no coordinates.
      if (m.location !== undefined) {
        if (!LOCATIONS.includes(m.location)) return "bad_request";
        item.location = m.location;
      }
      if (m.vote !== undefined) {
        if (!isObject(m.vote) || !isText(m.vote.question, LIMITS.pollQuestionChars * 2) || !isText(m.vote.option, LIMITS.pollOptionChars * 2) || !m.vote.option.trim()) return "bad_request";
        item.vote = { question: m.vote.question.trim(), option: m.vote.option.trim() };
        // Only an option of a poll troy actually sent earlier in this conversation.
        if (!polls.some((p) => p.question === item.vote.question && p.options.includes(item.vote.option))) return "bad_request";
      }
      if (m.reaction !== undefined) {
        if (!isObject(m.reaction) || !TAPBACKS.includes(m.reaction.type) || !isText(m.reaction.onText, LIMITS.textChars)) return "bad_request";
        item.reaction = { type: m.reaction.type, onText: m.reaction.onText.trim() };
        if (!troyTexts.has(item.reaction.onText)) return "bad_request";
      }
      if (!item.text && !item.imageBase64 && !item.photo && !item.location && !item.vote && !item.reaction) return "bad_request";
    } else {
      if (m.imageBase64 !== undefined || m.vote !== undefined || m.reaction !== undefined || m.photo !== undefined || m.location !== undefined) return "bad_request";
      if (m.sig !== undefined) {
        if (typeof m.sig !== "string" || m.sig.length > 64) return "bad_request";
        item.sig = m.sig;
      }
      if (m.poll !== undefined) {
        const p = m.poll;
        if (!isObject(p) || !isText(p.question, LIMITS.pollQuestionChars * 2) || !Array.isArray(p.options) || p.options.length > LIMITS.pollOptions) return "bad_request";
        if (!p.options.every((o) => isText(o, LIMITS.pollOptionChars * 2))) return "bad_request";
        // A troy message is one bubble or one poll, the way the page stores them; that is also what the signature covers.
        if (item.text) return "bad_request";
        item.poll = { question: p.question, options: [...p.options] };
        polls.push(item.poll);
      }
      if (!item.text && !item.poll) return "bad_request";
      if (item.text) {
        // Signed and compared exactly as sent.
        if (item.text !== m.text) return "bad_request";
        troyTexts.add(item.text);
      }
    }
    out.push(item);
  }
  if (out[out.length - 1].from !== "me") return "bad_request";
  if (mine > LIMITS.mine) return "limit";
  const situation = typeof body.situation === "string" ? body.situation.trim().toLowerCase() : "";
  return { messages: out, situation: SITUATIONS.includes(situation) ? situation : "" };
}

// ---------- the conversation, as the model sees it ----------

/** One of the visitor's turns in words. Bracketed lines are what the page saw them do, not something they typed. */
function mineAsText(m) {
  const parts = [];
  // Votes and reactions are checked against troy's own signed texts and polls, so their words are his.
  if (m.vote) parts.push(`[tapped the poll option "${m.vote.option}"${m.vote.question ? ` on "${m.vote.question}"` : ""}]`);
  if (m.reaction) parts.push(`[reacted with ${TAPBACK_WORDS[m.reaction.type]} to troy's text "${m.reaction.onText}"]`);
  if (m.imageBase64 || m.photo) parts.push("[sent a photo]");
  if (m.location) parts.push(`[shared their location: ${m.location}]`);
  if (m.text) parts.push(typed(m.text));
  return parts.join("\n");
}

/** Troy's earlier turns go back in the same shape he writes them, so the format never wavers. */
function troyAsJson(group) {
  const poll = group.find((m) => m.poll)?.poll;
  return JSON.stringify({
    bubbles: group.filter((m) => m.text).map((m) => m.text),
    poll_question: poll ? poll.question : "",
    poll_options: poll ? poll.options : [],
    tapback: "none",
    card: false,
    example: "",
  });
}

/** The last 24 messages as API messages: runs from one side become one turn, and the first turn is the visitor's. */
export function toApiMessages(messages, situation) {
  let recent = messages.slice(-LIMITS.sentToModel);
  while (recent.length && recent[0].from !== "me") recent = recent.slice(1);
  const out = [];
  let i = 0;
  while (i < recent.length) {
    const from = recent[i].from;
    const group = [];
    while (i < recent.length && recent[i].from === from) group.push(recent[i++]);
    if (from === "troy") {
      out.push({ role: "assistant", content: troyAsJson(group) });
      continue;
    }
    const content = [];
    for (const m of group) {
      if (m.imageBase64) content.push({ type: "image", source: { type: "base64", media_type: m.imageMime, data: m.imageBase64 } });
      const text = mineAsText(m);
      if (text) content.push({ type: "text", text });
    }
    out.push({ role: "user", content });
  }
  // What changes per request goes last, after everything that can be cached.
  const notes = [];
  // Code knows where the conversation is, so it says so instead of leaving the model to work it out.
  if (!messages.some((m) => m.from === "troy")) {
    notes.push('this is their first message, so this reply is the welcome turn from "The first messages": the welcome points across the bubbles, the last bubble asks them to save his contact, card is true, and the poll asks student or judge with the options "usc student" and "hackathon judge"');
  }
  if (situation) notes.push(`example situation in progress: ${situation}`);
  if (messages.length > recent.length) notes.push("earlier messages in this conversation are not shown");
  if (notes.length && out.length) out[out.length - 1].content.push({ type: "text", text: `[simulator context, not from the visitor: ${notes.join(". ")}]` });
  return out;
}

// ---------- the reply, checked ----------

const DASHES = /\s*[\u2012\u2013\u2014\u2015]\s*/g;
const CONTACT = /(?:https?:\/\/|www\.)[^\s"')]+|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\b[a-z0-9-]+\.(?:com|org|edu|net|gov|io|app|co)\b[^\s"')]*|(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/gi;

// The same polish the real Troy's bubbles get in code (src/voice.ts youToU, stripDashes, limitEmoji), in small:
// "you" and "your" as whole words become "u" and "ur" (links and emails keep their form), and one emoji at most.
const YOU_FORMS = [
  [/\byou(?:'|’)?re\b/gi, "ur"],
  [/\bu(?:'|’)re\b/gi, "ur"],
  [/\byourselves\b/gi, "urselves"],
  [/\byourself\b/gi, "urself"],
  [/\byours\b/gi, "urs"],
  [/\byour\b/gi, "ur"],
  [/\byou\b/gi, "u"],
];
const EMOJI = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})(?:[\uFE0F\u{1F3FB}-\u{1F3FF}]|\u200D\p{Extended_Pictographic})*/gu;

export function polish(text) {
  const kept = [];
  let out = String(text).replace(/(?:https?:\/\/|www\.)\S+|\S+@\S+\.\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*/gi, (m) => (/you/i.test(m) ? `\u0000${kept.push(m) - 1}\u0000` : m));
  for (const [re, to] of YOU_FORMS) out = out.replace(re, to);
  out = out.replace(/\u0000(\d+)\u0000/g, (_, n) => kept[Number(n)] ?? "");
  // The exact words to text go in double quotes (John, "Quotes around exact words to type").
  out = out.replace(/(^|[^"\w])(STOP|START)(?![\w"])/g, '$1"$2"');
  let seen = 0;
  return out.replace(EMOJI, (m) => (++seen <= 1 ? m : "")).replace(/[ \t]{2,}/g, " ").replace(/ +([.,!?])/g, "$1").trim();
}

function tidy(text, max) {
  let t = polish(String(text).replace(DASHES, ", ")).replace(/\s+/g, " ").trim();
  if (t.length > max) {
    const cut = t.slice(0, max);
    const at = cut.lastIndexOf(" ");
    t = (at > max * 0.6 ? cut.slice(0, at) : cut).trim();
  }
  return t;
}

/**
 * Long replies go out as smaller chunks, like the real Troy's: a bubble over 130 characters is cut where one
 * sentence ends and the next begins, into two bubbles of about the same weight. One sentence stays whole.
 */
export function splitLong(text, max = 130) {
  if (text.length <= max) return [text];
  const cuts = [];
  for (const m of text.matchAll(/[.?!]["')]?\s+(?=[a-z"'(])/gi)) cuts.push(m.index + m[0].length);
  if (!cuts.length) return [text];
  const mid = text.length / 2;
  const at = cuts.reduce((best, c) => (Math.abs(c - mid) < Math.abs(best - mid) ? c : best));
  const head = text.slice(0, at).trim();
  const tail = text.slice(at).trim();
  return head && tail ? [head, tail] : [text];
}

/** A contact detail (a link, an email, a phone number) may only be one the prompt itself carries. The model never supplies one. */
function inventsContact(text, allowed) {
  for (const hit of text.match(CONTACT) ?? []) {
    const key = hit.toLowerCase().replace(/[\s().-]/g, "");
    if (!allowed.has(key)) return true;
  }
  return false;
}

export function allowedContacts(system) {
  const set = new Set();
  for (const hit of system.match(CONTACT) ?? []) set.add(hit.toLowerCase().replace(/[\s().-]/g, ""));
  return set;
}

/** Clamps whatever came back: at most 4 bubbles of 240 characters, at most 5 poll options, no invented contacts, no dashes. */
export function clampReply(raw, data, allowed = allowedContacts(data.system)) {
  if (!isObject(raw)) return null;
  // The welcome (the turn with the contact card) carries five points and may split into one more bubble, so the
  // "save my contact" line at its end is never the one cut off.
  const cap = raw.card === true ? LIMITS.welcomeBubbles : LIMITS.bubbles;
  const bubbles = [];
  let dropped = false;
  for (const b of Array.isArray(raw.bubbles) ? raw.bubbles : []) {
    if (typeof b !== "string") continue;
    const text = tidy(b, LIMITS.bubbleChars);
    if (!text) continue;
    if (inventsContact(text, allowed)) {
      dropped = true;
      continue;
    }
    for (const part of splitLong(text)) {
      if (bubbles.length < cap) bubbles.push({ text: part });
    }
    if (bubbles.length === cap) break;
  }
  if (dropped && bubbles.length === 0) bubbles.push({ text: data.fixed.noContact });

  const out = { ok: true, bubbles };
  const question = typeof raw.poll_question === "string" ? tidy(raw.poll_question, LIMITS.pollQuestionChars) : "";
  const options = [];
  for (const o of Array.isArray(raw.poll_options) ? raw.poll_options : []) {
    if (typeof o !== "string") continue;
    const text = tidy(o, LIMITS.pollOptionChars);
    if (!text || options.includes(text) || inventsContact(text, allowed)) continue;
    options.push(text);
    if (options.length === LIMITS.pollOptions) break;
  }
  if (options.length >= 2 && !inventsContact(question, allowed)) out.poll = { question, options };
  if (raw.card === true) out.card = true;
  const example = typeof raw.example === "string" ? tidy(raw.example, LIMITS.exampleChars).toLowerCase() : "";
  if (example && !inventsContact(example, allowed)) out.example = example;
  // No reactions inside an example: the visitor is answering his questions (a description, a day, a place), and a
  // heart on "white airpods with a dent" reads wrong. The model kept adding one, so code decides.
  if (!out.example && typeof raw.tapback === "string" && TAPBACKS.includes(raw.tapback)) out.tapback = { type: raw.tapback, onLast: true };
  if (!out.bubbles.length && !out.poll) return null;
  return out;
}

// ---------- the model call ----------

/**
 * The real call. Tests and nothing else replace it (createSimHandler's callModel).
 * The key is read here, from the environment, and goes nowhere but the SDK.
 */
export async function callClaude({ system, messages, apiKey }) {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: LIMITS.timeoutMs });
  const res = await client.messages.create(
    {
      model: MODEL,
      max_tokens: LIMITS.maxTokens,
      // Short texts in a set shape: no thinking, on the fast model, to keep a public page cheap.
      thinking: { type: "disabled" },
      output_config: { effort: "medium", format: { type: "json_schema", schema: REPLY_SCHEMA } },
      // The large fixed prompt is the same bytes for every visitor, so it is cached.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
    },
    { timeout: LIMITS.timeoutMs, maxRetries: 0 },
  );
  if (res.stop_reason !== "end_turn") return null;
  const text = res.content.find((b) => b.type === "text");
  return text ? JSON.parse(text.text) : null;
}

/**
 * Builds the handler.
 *   data: what scripts/build-sim.ts made ({ system, fixed, patterns, stopWords, startWords }).
 *   callModel: the model call, replaceable in tests.
 *   env: where TROY_SIM and ANTHROPIC_API_KEY are read from (process.env on Vercel).
 */
/** Reads at most `max` bytes of the body; null when it is longer. A body with no length header is never read whole first. */
async function readCapped(request, max) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

/** The visitor's IP as the platform reports it (Vercel sets these and overwrites what a client sends). */
function clientIp(request) {
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  const fwd = request.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "local";
}

/** Counts model calls in memory for this instance only. Returns a function that takes a slot, or false when full. */
function makeLimiter(now = () => Date.now()) {
  let windowStart = now();
  let total = 0;
  let inFlight = 0;
  const perIp = new Map();
  return function take(ip) {
    const t = now();
    if (t - windowStart >= LIMITS.windowMs) {
      windowStart = t;
      total = 0;
      perIp.clear();
    }
    const used = perIp.get(ip) ?? 0;
    if (used >= LIMITS.perIp || total >= LIMITS.perInstance || inFlight >= LIMITS.inFlight) return false;
    // A flood of new addresses cannot grow memory without end.
    if (perIp.size > 50_000) perIp.clear();
    perIp.set(ip, used + 1);
    total += 1;
    inFlight += 1;
    let done = false;
    return () => {
      if (!done) inFlight -= 1;
      done = true;
    };
  };
}

export function createSimHandler({ data, callModel = callClaude, env = process.env, now }) {
  const compiled = compile(data);
  const allowed = allowedContacts(data.system);
  const key = turnKey(env);
  const take = makeLimiter(now);
  // Every troy line that goes out carries its signature, so it can come back in the next request.
  const signed = (out) => ({
    ...out,
    bubbles: out.bubbles.map((b) => (key ? { ...b, sig: signTurn(key, { text: b.text }) } : b)),
    ...(out.poll ? { poll: key ? { ...out.poll, sig: signTurn(key, { poll: out.poll }) } : out.poll } : {}),
  });
  const fixed = (lines, extra = {}) => json(200, signed({ ok: true, bubbles: lines.map((text) => ({ text })), ...extra }));

  return async function handle(request) {
    try {
      if (request.method !== "POST") {
        const res = bad();
        return new Response(res.body, { status: 405, headers: { ...Object.fromEntries(res.headers), allow: "POST" } });
      }
      if (!sameOrigin(request)) return json(403, { ok: false, error: "bad_request" });
      // The kill switch: nothing is read and nothing is called.
      if (String(env.TROY_SIM ?? "").trim().toLowerCase() === "off") return busy();

      const declared = Number(request.headers.get("content-length") ?? 0);
      if (declared > LIMITS.bodyBytes) return json(413, { ok: false, error: "bad_request" });
      const type = (request.headers.get("content-type") || "").toLowerCase();
      if (!type.startsWith("application/json")) return bad();
      let raw;
      try {
        raw = await readCapped(request, LIMITS.bodyBytes);
      } catch {
        return bad();
      }
      if (raw === null) return json(413, { ok: false, error: "bad_request" });
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return bad();
      }
      const read = readBody(body);
      if (read === "limit") return limit();
      if (read === "bad_request") return bad();
      const { messages, situation } = read;
      // A troy line he never sent is refused. With no key there is nothing to protect: only the fixed lines answer.
      if (key && messages.some((m) => m.from === "troy" && !validTurn(key, m))) return bad();

      // Hard rules, decided by code before any model call and never worded by the model.
      // After STOP the conversation is over until START or "hey troy"; emergency and crisis replies still go out.
      let stopped = false;
      for (const m of messages.slice(0, -1)) {
        if (m.from !== "me" || !m.text) continue;
        const kind = fixedKind(m.text, data, compiled);
        if (kind === "stop") stopped = true;
        else if (kind === "start") stopped = false;
      }
      const latest = messages[messages.length - 1];
      const kind = latest.text ? fixedKind(latest.text, data, compiled) : null;
      if (kind === "crisis") return fixed(data.fixed.crisis, { fixed: "crisis", ...(stopped ? { ended: true } : {}) });
      if (kind === "emergency") return fixed(data.fixed.emergency, { fixed: "emergency", ...(stopped ? { ended: true } : {}) });
      if (kind === "stop") return fixed(stopped ? [] : data.fixed.stop, { fixed: "stop", ended: true });
      if (stopped) {
        if (kind === "start") return fixed(data.fixed.start, { fixed: "start" });
        return json(200, { ok: true, bubbles: [], ended: true });
      }

      // The first reply is the welcome, which the real Troy sends from code, not the model: one of the dictated
      // versions, then "save my contact", the card and the student-or-judge poll. No model call, so it never drifts.
      if (!messages.some((m) => m.from === "troy") && data.fixed.welcome?.length) {
        const pick = data.fixed.welcome[Math.floor(Math.random() * data.fixed.welcome.length)];
        return json(200, signed({
          ok: true,
          bubbles: pick.bubbles.map((text) => ({ text: polish(text) })),
          card: true,
          poll: { question: pick.question.trim(), options: [...data.fixed.welcomeOptions] },
        }));
      }

      const apiKey = env.ANTHROPIC_API_KEY;
      if (!apiKey && callModel === callClaude) return busy();

      const release = take(clientIp(request));
      if (!release) return limit();
      let reply;
      let timeout;
      try {
        const timer = new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error("timeout")), LIMITS.timeoutMs + 500);
        });
        reply = await Promise.race([callModel({ system: data.system, messages: toApiMessages(messages, situation), apiKey }), timer]);
      } catch {
        return busy();
      } finally {
        clearTimeout(timeout);
        release();
      }
      const out = clampReply(reply, data, allowed);
      return out ? json(200, signed(out)) : busy();
    } catch {
      // Never a stack trace, the prompt or anything from the environment.
      return busy();
    }
  };
}
