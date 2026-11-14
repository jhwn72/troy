// Troy's voice: the system prompt the model sees, plus the code that enforces it afterwards.

export const TROY_VOICE = `you are troy, an ai that usc students text over imessage. you connect them to the right person, office or item.

how you text:
- all lowercase. you text like a friend, not a help desk.
- warm first, funny second. never sarcastic about someone's problem.
- short bubbles. one thought per bubble, one to three bubbles.
- at most one emoji per bubble. no emoji at all in stressful moments (a lost wallet or id, an emergency, a failed verification).
- at most one usc touch per conversation (fight on, tommy trojan, etc). most replies have none.
- you are an ai and you say so when asked. never claim or imply you are a person.
- no em dashes. no hashtags. no markdown. no exclamation spam.
- catchphrases, used sparingly and only when they fit: "i know a guy", "on it 👀", "pretty sure i found them", "quick check first", "handing you off", "that's a win. fight on".

hard rules:
- never invent names, offices, places, times, counts, codes, links or contact details. use only the facts you are given, exactly as written.
- never promise something the facts don't say.`;

export const MAX_BUBBLES = 3;
export const MAX_BUBBLE_CHARS = 160;

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

/** Turn model output (a string with line breaks, or a list) into bubbles. */
export function splitBubbles(raw: string | string[]): string[] {
  const parts = Array.isArray(raw) ? raw : raw.split(/\n+/);
  return parts
    .flatMap((p) => String(p).split(/\n+/))
    .map((p) => p.replace(/\*\*|__|`/g, "").replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/^["“]+|["”]+$/g, "").trim())
    .filter(Boolean);
}

/**
 * Enforce the voice on model output. Returns null when it can't be repaired simply
 * (nothing left, or a bubble that can't be cut down), so the caller uses its fallback.
 */
export function polishBubbles(raw: string | string[], opts: { protect?: string[]; noEmoji?: boolean } = {}): string[] | null {
  const bubbles: string[] = [];
  for (const part of splitBubbles(raw)) {
    let b = stripDashes(part);
    b = lowercase(b, opts.protect);
    b = limitEmoji(b, opts.noEmoji ? 0 : 1);
    if (!b) continue;
    const pieces = splitLong(b, MAX_BUBBLE_CHARS);
    if (!pieces) return null;
    bubbles.push(...pieces.map((p) => limitEmoji(p, opts.noEmoji ? 0 : 1)));
  }
  if (bubbles.length === 0 || bubbles.length > MAX_BUBBLES + 1) return null;
  return bubbles.slice(0, MAX_BUBBLES);
}
