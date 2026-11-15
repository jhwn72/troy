// Judge mode (John, "Judge mode" and "Judge mode, additions (b)").
//
// A judge is someone who took the hackathon skip (verifiedVia 'judge_skip'). Knowing that changes a few things, and
// Troy says so early on so they have context:
//   - he types faster for them (the pipeline does this, see JUDGE_PACE in src/pipeline.ts)
//   - a tone switch: one tap (or "formal" / "drop the slang") turns on plain, spelled-out English; "slang back on"
//     reverses it. The conversion itself is toPlain in src/voice.ts, applied by the pipeline to everything he sends them.
//   - after a step, at most ONE short parenthetical bubble: a behind-the-scenes aside (what the AI just did, with the
//     real numbers the caller passes in) or a decision note (one entry of docs/design-decisions.md). Never both, never
//     the same one twice for a person, never two for one incoming message, never anything from the verification answer key.
//   - a wrap-up after the try-it tour: that was the short version, John is around for the full walkthrough, his email.
//
// Code owns the facts here (who is a judge, which notes were used, the numbers, the email). The wording is his own:
// every line goes through sayInHisWords (src/brain.ts) with hand-written fallbacks for when the model is down.
// Everything is a no-op for students.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { FlowContext, User } from "./types.ts";
import { getSetting, getUserById, setSetting } from "./db/index.ts";
import { sayInHisWords } from "./brain.ts";
import type { Brief } from "./brain.ts";
import { pickVariant } from "./voice.ts";

export const JOHN_EMAIL = "johnwang@usc.edu";

// ---------- who is a judge, and their tone ----------

export function isJudge(user: User): boolean {
  return !!user && user.verifiedVia === "judge_skip";
}

const plainKey = (userId: number): string => `judge:plain:${userId}`;
const introKey = (userId: number): string => `judge:intro:${userId}`;
const toneKey = (userId: number): string => `judge:tone:${userId}`;
const asideKey = (userId: number): string => `judge:asides:${userId}`;
const wrapKey = (userId: number): string => `judge:wrap:${userId}`;
const tourDoneKey = (userId: number): string => `judge:tourdone:${userId}`;

function read(db: DatabaseSync, key: string): string | null {
  try {
    return getSetting(db, key);
  } catch {
    return null;
  }
}
function write(db: DatabaseSync, key: string, value: string): void {
  try {
    setSetting(db, key, value);
  } catch {
    // A flag that could not be saved never costs a reply.
  }
}

/** True when this judge asked for plain, spelled-out English (the tap, or "formal" / "drop the slang"). */
export function plainTone(db: DatabaseSync, userId: number): boolean {
  return read(db, plainKey(userId)) === "1";
}

export function setPlainTone(db: DatabaseSync, userId: number, on: boolean): void {
  write(db, plainKey(userId), on ? "1" : "");
}

/** "delete my data": nothing about this person's judge mode is kept. */
export function forgetJudge(db: DatabaseSync, userId: number): void {
  for (const key of [plainKey(userId), introKey(userId), toneKey(userId), asideKey(userId), wrapKey(userId), tourDoneKey(userId)]) write(db, key, "");
}

// ---------- wording ----------

type Composer = (ctx: FlowContext, brief: Brief) => Promise<string[]>;
let composer: Composer | null = null;

/** Tests: replace the chat brain's sayInHisWords. Pass null to go back to the real one. */
export function setJudgeDeps(next: { sayInHisWords?: Composer } | null): void {
  composer = next?.sayInHisWords ?? null;
}

function rotate(ctx: Pick<FlowContext, "db" | "user">, key: string, variants: string[][]): string[] {
  const pool = variants.filter((v) => Array.isArray(v) && v.length);
  if (!pool.length) return [];
  const i = Number(pickVariant(ctx.db, ctx.user.id, `judge:${key}`, pool.map((_, n) => String(n))));
  return pool[Number.isInteger(i) ? i : 0] ?? pool[0]!;
}

/** His own words for a brief, or a rotated hand-written version. `say` lets a caller lend its own composer (onboarding does). */
async function compose(ctx: FlowContext, key: string, brief: Brief, say?: Composer): Promise<string[]> {
  try {
    const out = await (say ?? composer ?? sayInHisWords)(ctx, brief);
    const bubbles = Array.isArray(out) ? out.filter((b): b is string => typeof b === "string" && !!b.trim()) : [];
    if (bubbles.length) return bubbles;
  } catch {
    // The hand-written version below still goes out.
  }
  return rotate(ctx, key, brief.fallback);
}

// ---------- the intro, right after the skip ----------

const DIFFERENT: Brief = {
  goal: "they just said they are a hackathon judge. in one short bubble (two at most), tell them what is different for them so they have context. no greeting, no thanks (he just said that)",
  mustCover: [
    "he is typing a bit faster to save them time",
    "a student would see him at a normal texting pace",
    "he is built for students, so he texts casually",
    "they can ask him to say anything straight",
  ],
  fallback: [
    ["heads up, i'm typing a bit faster to save u time. a student would see me at a normal texting pace", "i'm built for students so i text casually. ask me to say anything straight and i will"],
    ["two things for judges: i'm typing a bit faster to save u time, a student would see me at a normal texting pace", "and i text casually since i'm built for students. u can ask me to say anything straight"],
    ["quick context: i type a bit faster for judges to save u time, students see me at a normal texting pace", "i'm built for students, so i text casually. if u want anything said straight, just ask"],
  ],
};

// One bubble, because the tap has to land on it.
const TONE_TAP = ["tap ❤️ on this if u want me to drop the slang", "want me to drop the slang? tap ❤️ on this one", "heart this text if u'd rather i drop the slang"];

const TONE_PLAIN: Brief = {
  goal: "the judge asked him to drop the slang. confirm in one short bubble that he will write in plain english from here, and say how to switch back",
  mustCover: ["plain english from here, no slang", "how to switch back"],
  facts: { "words to text to switch back": '"slang back on"' },
  fallback: [
    ['done, no slang from here. text "slang back on" if u want it back'],
    ['ok, plain english from now on. text "slang back on" to switch back'],
    ['got it, i\'ll keep it plain. "slang back on" brings it back anytime'],
  ],
};

const TONE_SLANG: Brief = {
  goal: "the judge asked for the casual student voice back. confirm in one short bubble and say how to switch again",
  mustCover: ["the casual voice is back", "how to switch to plain english again"],
  facts: { "words to text to switch": '"drop the slang"' },
  fallback: [
    ['slang is back on. text "drop the slang" if u want it gone again'],
    ['bet, back to how i text students. "drop the slang" switches it off again'],
    ['ok, casual again. text "drop the slang" anytime to switch'],
  ],
};

/**
 * Sent once, right after the judge line and before the alerts poll: what is different for a judge, then one bubble
 * to tap for plain English. A no-op for students and for a judge who already got it.
 */
export async function judgeIntro(ctx: FlowContext, say?: Composer): Promise<boolean> {
  const { db } = ctx;
  const user = getUserById(db, ctx.user.id) ?? ctx.user;
  if (!isJudge(user) || read(db, introKey(user.id))) return false;
  write(db, introKey(user.id), String(Date.now()));
  await ctx.say(...(await compose(ctx, "different", DIFFERENT, say)));
  const ids = await ctx.say(pickVariant(db, user.id, "judge:tonetap", TONE_TAP));
  write(db, toneKey(user.id), JSON.stringify({ ids: ids.filter((id): id is string => !!id), at: Date.now() }));
  return true;
}

async function switchTone(ctx: FlowContext, plain: boolean): Promise<void> {
  setPlainTone(ctx.db, ctx.user.id, plain);
  await ctx.say(...(await compose(ctx, plain ? "tone:plain" : "tone:slang", plain ? TONE_PLAIN : TONE_SLANG)));
}

/** A heart or thumbs up on the "drop the slang" bubble. True when the event was that tap (and the tone is now plain). */
export async function handleToneTap(ctx: FlowContext): Promise<boolean> {
  const r = ctx.event.reaction;
  if (!r) return false;
  const user = getUserById(ctx.db, ctx.user.id) ?? ctx.user;
  if (!isJudge(user)) return false;
  let ids: unknown = [];
  try {
    ids = (JSON.parse(read(ctx.db, toneKey(user.id)) || "{}") as { ids?: unknown }).ids;
  } catch {
    ids = [];
  }
  if (!Array.isArray(ids) || !ids.includes(r.targetMessageId)) return false;
  // Taking the tap back, or a thumbs down, changes nothing. It is still about this bubble, so nothing else reads it.
  if (r.removed || (r.type !== "love" && r.type !== "like" && r.type !== "emphasize")) return true;
  if (!plainTone(ctx.db, user.id)) await switchTone(ctx, true);
  return true;
}

/** What a typed tone request asks for: "formal", "drop the slang", "slang back on". Null for anything else. */
export function readToneSwitch(text: string): "plain" | "slang" | null {
  const t = (text ?? "").toLowerCase().replace(/[‘’'`]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.length > 70) return null;
  const core = t.replace(/^(?:(?:hey|ok|okay|troy|pls|please|actually|yes|yeah|can u|can you|could u|could you|would u|would you)\s+)+/, "").replace(/(?:\s+(?:pls|please|thanks|thank you|thank u|troy|for me|now))+$/, "");
  if (/^(?:turn (?:the )?slang back on|slang back on|slang back|bring (?:back )?(?:the )?slang(?: back)?|(?:u|you) can use slang(?: again)?|slang (?:is )?(?:ok|okay|fine)(?: again)?|(?:be|go|talk|text) casual(?:ly)?(?: again)?|casual(?: again)?|talk like (?:before|a student|u did|you did)|back to (?:slang|casual|normal))$/.test(core)) return "slang";
  if (
    /^(?:formal|be (?:more )?formal|plain english|standard english|proper english|no slang|drop the slang|lose the slang|cut the slang|stop (?:with )?the slang|stop using slang|without (?:the )?slang|less slang)$/.test(core) ||
    /^(?:be|talk|text|speak|write|type|say (?:it|things|everything)) (?:more )?(?:formal(?:ly)?|normal(?:ly)?|proper(?:ly)?|professional(?:ly)?|straight|plainly|in (?:plain|standard|proper|normal|full|real) (?:english|sentences|words))(?: (?:to|with) me)?$/.test(core)
  ) {
    return "plain";
  }
  return null;
}

/** A typed tone request from a judge. True when the message was one (and it was acted on). Students: always false. */
export async function handleToneText(ctx: FlowContext): Promise<boolean> {
  if (ctx.event.reaction || ctx.event.pollVote || ctx.event.images.length) return false;
  const user = getUserById(ctx.db, ctx.user.id) ?? ctx.user;
  if (!isJudge(user)) return false;
  const want = readToneSwitch(ctx.event.text);
  if (!want) return false;
  await switchTone(ctx, want === "plain");
  return true;
}

// ---------- the decision list ----------

export type Decision = { n: number; title: string; reason: string; body: string };

const DECISIONS_PATH = fileURLToPath(new URL("../docs/design-decisions.md", import.meta.url));
let cached: { path: string; list: Decision[] } | null = null;

/** The numbered entries of docs/design-decisions.md: "N. **Title.** The reason, then the proof." Read once. */
export function loadDecisions(path: string = DECISIONS_PATH): Decision[] {
  if (cached && cached.path === path) return cached.list;
  let list: Decision[] = [];
  try {
    list = parseDecisions(readFileSync(path, "utf8"));
  } catch {
    list = [];
  }
  cached = { path, list };
  return list;
}

export function parseDecisions(markdown: string): Decision[] {
  const out: Decision[] = [];
  for (const line of markdown.split("\n")) {
    const m = line.match(/^\s*(\d+)\.\s+\*\*(.+?)\*\*\s*(.*)$/);
    if (!m) continue;
    const body = m[3]!.trim();
    const title = m[2]!.trim().replace(/[.:]+$/, "");
    // The reason is the first sentence or two; the proof (test counts and the like) stays on the page.
    const sentences = body.match(/[^.!?]+[.!?]+(?=\s|$)/g)?.map((s) => s.trim()) ?? (body ? [body] : []);
    out.push({ n: Number(m[1]), title, reason: sentences[0] ?? "", body });
  }
  return out;
}

// Short names flows can use instead of a number, so a renumbered list never points at the wrong entry.
const DECISION_KEYS: Record<string, string> = {
  no_app: "no app",
  steps_back: "steps back",
  photo: "photo replaces",
  location: "location decides",
  finder_chooses: "finder chooses",
  texts_first: "texts first",
  person: "sounds like a person",
  short: "short on purpose",
  prove_first: "prove it",
  contact: "contact info",
  dangerous: "dangerous items",
  privacy_gate: "privacy gate",
  facts: "code owns the facts",
  two_models: "two models",
  ai_down: "keeps working",
  one_engine: "one engine",
  tested: "tested like software",
};

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The entry a number ("9", 9) or a key ("prove_first", "finder chooses") names, or null. */
export function findDecision(which: string | number, list: Decision[] = loadDecisions()): Decision | null {
  const raw = String(which ?? "").trim();
  if (!raw) return null;
  if (/^#?\d+$/.test(raw)) return list.find((d) => d.n === Number(raw.replace("#", ""))) ?? null;
  const needle = slug(DECISION_KEYS[raw.toLowerCase()] ?? raw);
  if (!needle) return null;
  return list.find((d) => slug(d.title).includes(needle)) ?? null;
}

// ---------- asides ----------

export type JudgeNote = { step: string; behind?: { did: string; numbers?: Record<string, number | string> }; decision?: string | number };

type AsideLog = { steps: string[]; decisions: number[]; last: "behind" | "decision" | null; event: string | null };

function loadLog(db: DatabaseSync, userId: number): AsideLog {
  const empty: AsideLog = { steps: [], decisions: [], last: null, event: null };
  try {
    const p = JSON.parse(read(db, asideKey(userId)) || "{}") as Partial<AsideLog>;
    return {
      steps: Array.isArray(p.steps) ? p.steps.map(String) : [],
      decisions: Array.isArray(p.decisions) ? p.decisions.map(Number).filter(Number.isFinite) : [],
      last: p.last === "behind" || p.last === "decision" ? p.last : null,
      event: typeof p.event === "string" ? p.event : null,
    };
  } catch {
    return empty;
  }
}

// How the blind check decides is never said out loud: how many tries, what passes, which details are held back.
const ANSWER_KEY = /\b(?:tr(?:y|ies)|attempts?|threshold|cut ?off|answer key|pass(?:es|ing)? (?:at|mark|score|line)|score(?:s|d)? (?:of|at|above|over|under|below)|out of 100|\d+ ?(?:points?|percent|%)|(?:hidden|held back|secret|withheld) (?:details?|marks?|features?)|(?:details?|marks?) (?:i|he|troy) (?:hid|hides|hold|holds|held|keeps?|kept) back|needs? \d+ (?:to|of)|\d+ or (?:more|higher) (?:to|passes))\b/i;

/** True when a line would give away part of the verification answer key. Asides that do are never sent. */
export function leaksAnswerKey(text: string): boolean {
  return ANSWER_KEY.test(text ?? "");
}

/** An aside is ONE bubble. Anything longer than this would be split in two when it is sent (TIMING.chunkChars in src/pipeline.ts). */
export const ASIDE_MAX = 160;

const fill = (text: string, numbers: Record<string, number | string>): string => text.replace(/\{(\w+)\}/g, (m, k: string) => (k in numbers ? String(numbers[k]) : m));

/** One bubble, in parentheses. */
function parenthetical(bubbles: string[]): string {
  const joined = bubbles.map((b) => b.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const inner = joined.replace(/^\(+\s*/, "").replace(/\s*\)+$/, "").replace(/[()]/g, "").trim();
  return inner ? `(${inner})` : "";
}

const inVoice = (s: string): string => s.replace(/\byou(?:'|’)re\b/gi, "ur").replace(/\byour\b/gi, "ur").replace(/\byou\b/gi, "u").toLowerCase();

function behindBrief(did: string, numbers: Record<string, string>): Brief {
  return {
    goal: "a short behind-the-scenes aside for a hackathon judge, as ONE bubble wrapped in parentheses, saying what the ai just did in this step. plain and specific, no bragging, nothing about how the ownership check decides",
    mustCover: [`what he just did: ${did}`],
    facts: numbers,
    // One bubble: a long one drops its lead-in rather than being split in two.
    fallback: [[`(behind the scenes: ${did})`], [`(what just happened on my end: ${did})`], [`(under the hood: ${did})`]].map((v) => (v[0]!.length > ASIDE_MAX ? [`(${did})`] : v)),
  };
}

function decisionBrief(d: Decision): Brief {
  const title = inVoice(d.title);
  const reason = inVoice(d.reason).replace(/[.!?]+$/, "");
  return {
    goal: "a short decision note for a hackathon judge, as ONE bubble wrapped in parentheses: one or two plain sentences on a choice behind what they just saw and why it was made. no numbers that aren't given",
    mustCover: [`the choice: ${title}`, `the reason: ${reason}`],
    // One bubble: when the title plus the reason would be split in two, the reason alone goes out.
    fallback: [[`(why it works this way: ${title}. ${reason})`], [`(a choice behind that: ${title}. ${reason})`], [`(design note: ${title}. ${reason})`]].map((v) => (v[0]!.length > ASIDE_MAX ? [`(why: ${reason})`] : v)),
  };
}

/**
 * For judges only, sends at most ONE short parenthetical bubble after a step: a behind-the-scenes aside built from
 * note.behind (what the AI just did; put the real numbers in `did` itself or as {name} placeholders filled from
 * `numbers`), or a decision note (note.decision is the number or key of an entry in docs/design-decisions.md).
 * When a note carries both, the kind he did not use last time is picked, so the two alternate across steps.
 * Never both, never the same step's aside or the same decision twice for a person, never a second one for the same
 * incoming message, and never anything from the verification answer key. A no-op for students. Never throws.
 */
export async function judgeAside(ctx: FlowContext, note: JudgeNote): Promise<void> {
  try {
    const { db } = ctx;
    const user = getUserById(db, ctx.user.id) ?? ctx.user;
    if (!isJudge(user) || user.stopped || !note || typeof note.step !== "string" || !note.step.trim()) return;
    const step = note.step.trim();
    const log = loadLog(db, user.id);
    // One per step, and one per message of theirs: a second call in the same turn says nothing.
    const eventId = ctx.event?.messageId ? String(ctx.event.messageId) : null;
    if (log.steps.includes(step) || (eventId && log.event === eventId)) return;

    const numbers: Record<string, string> = {};
    for (const [k, v] of Object.entries(note.behind?.numbers ?? {})) if (v !== null && v !== undefined && String(v).trim()) numbers[k] = String(v);
    const did = note.behind?.did ? fill(note.behind.did.trim(), numbers).replace(/^\(+|\)+$/g, "").trim() : "";
    const behindOk = !!did && !leaksAnswerKey(did);
    const decision = note.decision !== undefined && note.decision !== null ? findDecision(note.decision) : null;
    const decisionOk = !!decision && !log.decisions.includes(decision.n);
    if (!behindOk && !decisionOk) return;
    const tooLong = (text: string): boolean => [...text].length > ASIDE_MAX;
    let kind: "behind" | "decision" = behindOk && decisionOk ? (log.last === "behind" ? "decision" : "behind") : behindOk ? "behind" : "decision";
    const written = (k: "behind" | "decision"): { brief: Brief; safe: string } => {
      const brief = k === "behind" ? behindBrief(did, numbers) : decisionBrief(decision!);
      return { brief, safe: parenthetical(rotate({ db, user }, `aside:${k}`, brief.fallback)) };
    };
    let { brief, safe } = written(kind);
    let line = parenthetical(await compose({ ...ctx, user }, `aside:${kind}`, brief));
    // His own version has to keep every number as given, stay off the answer key and fit ONE bubble (anything longer
    // is split in two when sent); otherwise the plain one goes out.
    const numbersKept = kind !== "behind" || (did.match(/\d[\d,.]*/g) ?? []).every((n) => line.includes(n));
    if (!line || tooLong(line) || leaksAnswerKey(line) || !numbersKept) line = safe;
    // The plain one is too long as well: the other kind, when this note carries one.
    if ((!line || tooLong(line)) && (kind === "behind" ? decisionOk : behindOk)) {
      kind = kind === "behind" ? "decision" : "behind";
      ({ brief, safe } = written(kind));
      line = safe;
    }
    if (!line || tooLong(line) || leaksAnswerKey(line)) return;

    // Marked before the send, so nothing can go out twice.
    log.steps.push(step);
    if (kind === "decision") log.decisions.push(decision!.n);
    log.last = kind;
    log.event = eventId;
    write(db, asideKey(user.id), JSON.stringify(log));
    await ctx.say(line);
  } catch {
    // An aside is optional. It never breaks the step it follows.
  }
}

// ---------- the wrap-up after the tour ----------

const WRAP_UP: Brief = {
  goal: "the judge just finished the try-it tour. wrap up in one or two short bubbles: that was the short version, john is around for the full walkthrough, and how to reach him. no new offers, no question",
  mustCover: ["that was the short version", "john is around for the full walkthrough"],
  facts: { "john's email": JOHN_EMAIL },
  fallback: [
    ["that was the short version", `john's around if u want the full walkthrough: ${JOHN_EMAIL}`],
    ["and that's the short version of what i do", `for the full walkthrough john is around, ${JOHN_EMAIL}`],
    ["so that was the short version. john is around for the full walkthrough", `u can reach him at ${JOHN_EMAIL}`],
  ],
};

/**
 * The try-it tour calls this when a run reached its end (the check and handoff played out, a serving was claimed,
 * a repair was read), never when the person backed out. The wrap-up waits for it.
 */
export function noteTourFinished(db: DatabaseSync, userId: number): void {
  write(db, tourDoneKey(userId), String(Date.now()));
}

/** True once this person finished a run of the try-it tour. */
export function tourWasFinished(db: DatabaseSync, userId: number): boolean {
  return !!read(db, tourDoneKey(userId));
}

/** True once this judge has had the wrap-up. */
export function wrapUpSent(db: DatabaseSync, userId: number): boolean {
  return !!read(db, wrapKey(userId));
}

/**
 * The wrap-up after the try-it tour, once per judge: that was the short version, John is around for the full
 * walkthrough, johnwang@usc.edu. A no-op for students and for a judge who already got it. Returns true when it sent.
 */
export async function judgeWrapUp(ctx: FlowContext): Promise<boolean> {
  try {
    const { db } = ctx;
    const user = getUserById(db, ctx.user.id) ?? ctx.user;
    if (!isJudge(user) || user.stopped || wrapUpSent(db, user.id)) return false;
    write(db, wrapKey(user.id), String(Date.now()));
    let bubbles = await compose({ ...ctx, user }, "wrap", WRAP_UP);
    // The email is the point of the message: a version without it is replaced by one that has it.
    if (!bubbles.join(" ").includes(JOHN_EMAIL)) bubbles = rotate({ db, user }, "wrap", WRAP_UP.fallback);
    await ctx.say(...bubbles);
    return true;
  } catch {
    return false;
  }
}

/**
 * The tour's completion hook. src/flows/tour.ts may call this the moment a judge's tour ends; the pipeline also
 * calls it when it sees a judge's tour state close, so the wrap-up goes out either way, and only once.
 */
export const tourFinished = judgeWrapUp;
