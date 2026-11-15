// Troy's voice: the system prompt the model sees, plus the code that enforces it afterwards.

import type { DatabaseSync } from "node:sqlite";
import { getSetting, setSetting } from "./db/index.ts";

export const TROY_VOICE = `you are troy, an ai that usc students text over imessage. you connect them to the right person, office or item.

how you text:
- all lowercase. you text like a friend, not a help desk.
- write "u" and "ur", never "you" or "your".
- warm first, funny second. never sarcastic about someone's problem.
- short bubbles. one thought per bubble, one to three bubbles.
- at most one emoji per bubble. no emoji at all in stressful moments (a lost wallet or id, an emergency, a failed verification).
- at most one usc touch per conversation (fight on, tommy trojan, etc). most replies have none.
- you are an ai and you say so when asked. never claim or imply you are a person.
- no em dashes. no hashtags. no markdown. no exclamation spam.
- you never swear.
- when you tell someone the exact words to text, put those words in double quotes: text "forget my location", reply "STOP". no quotes when you are only describing what to do.
- never read a poll option or a topic name back as a label. say what will actually happen ("i'll text u when someone needs a ride").
- catchphrases, used sparingly and only when they fit: "i know a guy", "on it 👀", "pretty sure i found them", "quick check first", "handing u off", "that's a win. fight on".

hard rules:
- never invent names, offices, places, times, counts, codes, links or contact details. use only the facts you are given, exactly as written.
- never promise something the facts don't say.`;

export const MAX_BUBBLES = 3;
export const MAX_BUBBLE_CHARS = 160;
/** Free chat bubbles may run a little longer; the pipeline chunks anything over its own limit when sending. */
export const CHAT_BUBBLE_CHARS = 170;

const EMOJI = /(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*)/gu;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

/** Index of `needle` in `hay` as a whole token (not glued to letters or digits), or -1. */
export function indexOfToken(hay: string, needle: string, from = 0): number {
  if (!needle) return -1;
  let i = hay.indexOf(needle, from);
  while (i !== -1) {
    const before = isWordChar(needle[0]) && isWordChar(hay[i - 1]);
    const after = isWordChar(needle[needle.length - 1]) && isWordChar(hay[i + needle.length]);
    if (!before && !after) return i;
    i = hay.indexOf(needle, i + 1);
  }
  return -1;
}

/** Lowercase everything except the protected values (pickup codes, place names), which keep their exact form. */
export function lowercase(text: string, protect: string[] = []): string {
  let out = text.toLowerCase();
  // Longest first so "Leavey Library" wins over "Leavey".
  for (const value of [...protect].sort((a, b) => b.length - a.length)) {
    const low = value.toLowerCase();
    if (low === value || low.length !== value.length) continue;
    let i = indexOfToken(out, low);
    while (i !== -1) {
      out = out.slice(0, i) + value + out.slice(i + value.length);
      i = indexOfToken(out, low, i + value.length);
    }
  }
  return out;
}

export function countEmoji(text: string): number {
  return (text.match(EMOJI) || []).length;
}

/** Keep the first `max` emoji in a bubble and drop the rest. */
export function limitEmoji(text: string, max = 1): string {
  let seen = 0;
  const out = text.replace(EMOJI, (m) => (++seen <= max ? m : ""));
  return out.replace(/[ \t]{2,}/g, " ").replace(/ +([.,!?])/g, "$1").trim();
}

/** Em and en dashes become commas. */
export function stripDashes(text: string): string {
  return text.replace(/\s*[—–]\s*/g, ", ").replace(/\s+--\s+/g, ", ");
}

const YOU_FORMS: [RegExp, string][] = [
  [/\byou(?:'|’)?re\b/gi, "ur"],
  // The model sometimes half-converts: "u're" is not a thing anyone texts.
  [/\bu(?:'|’)re\b/gi, "ur"],
  [/\byourselves\b/gi, "urselves"],
  [/\byourself\b/gi, "urself"],
  [/\byours\b/gi, "urs"],
  [/\byour\b/gi, "ur"],
  [/\byou\b/gi, "u"],
];

/**
 * "you", "your" and "you're" become "u", "ur" and "ur", as whole words only ("youth" and "youtube" are left alone).
 * Links, emails and the protected values (facts code inserted) keep their exact form.
 */
export function youToU(text: string, protect: string[] = []): string {
  const kept: string[] = [];
  const hold = (m: string) => `\u0000${kept.push(m) - 1}\u0000`;
  let out = text;
  for (const value of [...protect].sort((a, b) => b.length - a.length)) {
    if (!/you/i.test(value)) continue;
    let i = indexOfToken(out, value);
    while (i !== -1) {
      const mark = hold(value);
      out = out.slice(0, i) + mark + out.slice(i + value.length);
      i = indexOfToken(out, value, i + mark.length);
    }
  }
  out = out.replace(/(?:https?:\/\/|www\.)\S+|\S+@\S+\.\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*/gi, (m) => (/you/i.test(m) ? hold(m) : m));
  for (const [re, to] of YOU_FORMS) out = out.replace(re, to);
  return out.replace(/\u0000(\d+)\u0000/g, (_, n: string) => kept[Number(n)] ?? "");
}

/** A message from the student that reads as distress: Troy drops emoji and jokes for the reply. */
export function isDistress(text: string): boolean {
  const t = (text ?? "").toLowerCase().replace(/[‘’]/g, "'");
  return /\b(?:stress(?:ed|ful|ing)?|anxi(?:ous|ety)|overwhelm(?:ed|ing)|panic(?:king|ked)?|freaking out|scared|terrified|afraid|crying|cried|sobbing|depress(?:ed|ing|ion)|lonely|homesick|heartbroken|broke up|dumped me|burn(?:t|ed) out|exhausted|miserable|hopeless|worthless|devastated|failing|failed|flunk(?:ed|ing)?|can'?t (?:sleep|breathe|do this|take (?:it|this))|hate my(?:self| life)|worst (?:day|week|night)|so sad|really sad|upset|grie(?:f|ving)|passed away|died|funeral|in the hospital|got robbed|stolen|lost my (?:wallet|id|passport|phone|keys|laptop)|kicked out|evicted|on probation|struggling|having a (?:hard|rough|bad|terrible) (?:time|day|week))\b/.test(t);
}

/** Moments where Troy drops emoji entirely. */
export function isStressful(goal: string): boolean {
  return /wallet|\bid\b|passport|keys|emergency|urgent|hurt|unsafe|scared|verif|fail|denied|wrong answer|stolen|sorry|apolog|ban|fake/i.test(goal);
}

/** Split one long bubble at sentence ends so each part fits. Returns null if a single sentence is too long. */
function splitLong(text: string, max: number): string[] | null {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + s).trim().length <= max) cur += s;
    else {
      if (cur.trim()) out.push(cur.trim());
      cur = s;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.every((b) => b.length <= max) ? out : null;
}

/**
 * Quotes the model put around a whole bubble come off. Quotes that belong to the text stay: a bubble that opens or
 * ends with an exact phrase to type ('"forget my location" erases it', 'text "on it" or "can't"') keeps both marks.
 */
function unwrapQuotes(p: string): string {
  const t = p.trim();
  const marks = t.match(/["“”]/g)?.length ?? 0;
  if (marks === 2 && /^["“]/.test(t) && /["”]$/.test(t)) return t.slice(1, -1);
  // One stray mark at either end, with no partner anywhere: the model's wrapping, half cut off.
  if (marks === 1) return t.replace(/^["“]|["”]$/g, "");
  return t;
}

/** Turn model output (a string with line breaks, or a list) into bubbles. */
export function splitBubbles(raw: string | string[]): string[] {
  const parts = Array.isArray(raw) ? raw : raw.split(/\n+/);
  return parts
    .flatMap((p) => String(p).split(/\n+/))
    .map((p) => unwrapQuotes(p.replace(/\*\*|__|`/g, "").replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")).trim())
    .filter(Boolean);
}

/**
 * Enforce the voice on model output. Returns null when it can't be repaired simply
 * (nothing left, or a bubble that can't be cut down), so the caller uses its fallback.
 */
export function polishBubbles(raw: string | string[], opts: { protect?: string[]; noEmoji?: boolean; maxChars?: number; strictCount?: boolean } = {}): string[] | null {
  const max = opts.maxChars ?? MAX_BUBBLE_CHARS;
  const bubbles: string[] = [];
  for (const part of splitBubbles(raw)) {
    let b = stripDashes(part);
    b = lowercase(b, opts.protect);
    b = youToU(b, opts.protect);
    b = limitEmoji(b, opts.noEmoji ? 0 : 1);
    if (!b) continue;
    const pieces = splitLong(b, max);
    if (!pieces) return null;
    bubbles.push(...pieces.map((p) => limitEmoji(p, opts.noEmoji ? 0 : 1)));
  }
  // strictCount (free chat): more than three bubbles is a rejection, never a silent cut that could drop "double check".
  if (bubbles.length === 0 || bubbles.length > (opts.strictCount ? MAX_BUBBLES : MAX_BUBBLES + 1)) return null;
  return bubbles.slice(0, MAX_BUBBLES);
}

// ---------- variation ----------

function hashText(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h;
}

/**
 * One of `variants`, rotated per user and key so the same person never gets the same line twice in a row.
 * Different people start at different places in the list. The last index used is kept in the settings
 * table under "var:<userId>:<key>" (a number only, nothing personal).
 */
export function pickVariant(db: DatabaseSync, userId: number, key: string, variants: string[]): string {
  if (variants.length === 0) return "";
  if (variants.length === 1) return variants[0]!;
  const slot = `var:${userId}:${key}`;
  let next = (userId + hashText(key)) % variants.length;
  try {
    const raw = getSetting(db, slot);
    const last = raw === null ? NaN : Number(raw);
    if (Number.isInteger(last) && last >= 0) next = (last + 1) % variants.length;
    setSetting(db, slot, String(next));
  } catch {
    // A missing table or a locked file must never cost a reply: the line still goes out.
  }
  return variants[next]!;
}
