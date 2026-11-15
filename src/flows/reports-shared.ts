// What the repair flow and the USG flow share: directory lookups, the reports table, followers and
// "is this the same report" checks. Everything here is plain code, no model calls.

import type { DatabaseSync } from "node:sqlite";
import type { Bubble, FlowContext, FlowName, FlowState } from "../types.ts";
import { getFlowState, getSetting, saveMessage, setFlowState, setSetting } from "../db/index.ts";
import { pickVariant } from "../voice.ts";

type Row = Record<string, unknown>;

// ---------- words ----------

const STOPWORDS = new Set(
  "a an the and or but so of to in on at by for from with is are was were be been it its this that these those there here i im my me we our u ur you your they them their he she his her do does did doesnt dont why how what when where who which can could would should will just really very too also some any all not no yes pls please hey hi troy usc campus like get got has have had about into out up as if than then rn still again one thing something".split(" "),
);

/** Lowercase words with apostrophes dropped and a trailing plural "s" removed, so "lights" and "light" compare equal. */
export function words(text: string): string[] {
  return (text ?? "")
    .toLowerCase()
    .replace(/[‘’'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** The words that carry meaning ("village", "dining", "close", "early"). */
export function contentWords(text: string): Set<string> {
  return new Set(words(text).filter((w) => w.length > 1 && !STOPWORDS.has(w)));
}

/** Shared meaningful words and their share of all meaningful words in either text (Jaccard). */
export function overlap(a: string, b: string): { shared: number; ratio: number } {
  const x = contentWords(a);
  const y = contentWords(b);
  if (!x.size || !y.size) return { shared: 0, ratio: 0 };
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return { shared, ratio: shared / (x.size + y.size - shared) };
}

/** Conservative on purpose: a missed merge makes one extra dashboard row, a wrong merge loses a report. */
export function similarText(a: string, b: string): boolean {
  const o = overlap(a, b);
  return o.shared >= 2 && o.ratio >= 0.5;
}

// ---------- directory ----------

export interface DirectoryRow {
  id: number;
  kind: "office" | "usg_committee" | "usg_program";
  name: string;
  topics: string[];
  contactMethod: string | null;
  url: string | null;
  details: string | null;
  isExample: boolean;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function parseList(raw: unknown): string[] {
  try {
    const v = JSON.parse(typeof raw === "string" ? raw : "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function directoryRows(db: DatabaseSync, kind?: DirectoryRow["kind"]): DirectoryRow[] {
  const rows = (kind ? db.prepare("SELECT * FROM directory WHERE kind = ? ORDER BY id").all(kind) : db.prepare("SELECT * FROM directory ORDER BY id").all()) as Row[];
  return rows.map((r) => ({
    id: r.id as number,
    kind: r.kind as DirectoryRow["kind"],
    name: r.name as string,
    topics: parseList(r.topics),
    contactMethod: text(r.contactMethod),
    url: text(r.url),
    details: text(r.details),
    isExample: !!r.isExample,
  }));
}

/** The row that lists this topic word for word ("dining", "dorm", "club funding"). First row wins. */
export function rowForTopic(rows: DirectoryRow[], topic: string): DirectoryRow | null {
  const want = topic.trim().toLowerCase();
  return rows.find((r) => r.topics.some((t) => t.trim().toLowerCase() === want)) ?? null;
}

/** Topic words too common to prove a row fits on their own ("the food at evk" is not about the farmers market). */
const WEAK_TOPICS = new Set(["food", "shuttle", "flight", "clothe", "clothes", "budget", "funding", "produce", "grocerie", "groceries", "other", "general", "room", "broken", "repair", "community", "health", "safety", "dining", "housing", "classe", "classes", "lights", "light"]);

/**
 * The directory row whose topics (or name) are mentioned in the text, or null.
 * A topic counts when every one of its words is in the text. A single common word only counts when
 * `allowWeak` is set (the student named usg, so "usg funding" can mean the funding program).
 */
export function rowMentioned(rows: DirectoryRow[], message: string, allowWeak = false): DirectoryRow | null {
  const have = new Set(words(message));
  let best: { row: DirectoryRow; score: number } | null = null;
  for (const row of rows) {
    const nameWords = words(row.name).filter((w) => w !== "usg" && !STOPWORDS.has(w));
    for (const phrase of [...row.topics.map((t) => words(t)), nameWords]) {
      if (!phrase.length || !phrase.every((w) => have.has(w))) continue;
      const weak = phrase.length === 1 && WEAK_TOPICS.has(phrase[0]!);
      if (weak && !allowWeak) continue;
      // Longer phrases beat shorter ones; a weak word only wins when nothing else matched.
      const score = weak ? 0.5 : phrase.length;
      if (!best || score > best.score) best = { row, score };
    }
  }
  return best?.row ?? null;
}

// ---------- reports ----------

export interface ReportRow {
  id: number;
  userId: number;
  kind: "repair" | "usg_concern";
  anonymous: boolean;
  category: string | null;
  description: string | null;
  locationText: string | null;
  routedTo: string | null;
  status: string;
  followers: number[];
}

/** Statuses where a report is still being worked on, so a new one about the same thing joins it. */
export const OPEN_STATUSES = ["received", "in_progress", "on_agenda"];

function toReport(r: Row): ReportRow {
  let followers: number[] = [];
  try {
    const v = JSON.parse((r.followers as string) || "[]");
    if (Array.isArray(v)) followers = v.filter((x): x is number => typeof x === "number" && Number.isInteger(x));
  } catch {
    // a bad followers value counts as none
  }
  return {
    id: r.id as number,
    userId: r.userId as number,
    kind: r.kind as ReportRow["kind"],
    anonymous: !!r.anonymous,
    category: text(r.category),
    description: text(r.description),
    locationText: text(r.locationText),
    routedTo: text(r.routedTo),
    status: r.status as string,
    followers,
  };
}

/** Open reports a new one can be joined to. Example rows are left out: a real student is never counted with made-up people. */
export function openReports(db: DatabaseSync, kind: ReportRow["kind"]): ReportRow[] {
  const marks = OPEN_STATUSES.map(() => "?").join(", ");
  return (db.prepare(`SELECT * FROM reports WHERE kind = ? AND isExample = 0 AND status IN (${marks}) ORDER BY id`).all(kind, ...OPEN_STATUSES) as Row[]).map(toReport);
}

/**
 * Writes one row the way the staff dashboard (src/web/api.ts) reads it: userId is the reporter, followers
 * is a JSON list of user ids, routedTo is the group heading, photoUrl is a local file path.
 */
export function insertReport(
  db: DatabaseSync,
  r: { userId: number; kind: ReportRow["kind"]; anonymous?: boolean; category: string | null; description: string; locationText?: string | null; photoUrl?: string | null; routedTo: string },
): number {
  const res = db
    .prepare("INSERT INTO reports (userId, kind, anonymous, category, description, photoUrl, locationText, routedTo, status, followers, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'received', '[]', ?)")
    .run(r.userId, r.kind, r.anonymous ? 1 : 0, r.category, r.description, r.photoUrl ?? null, r.locationText ?? null, r.routedTo, Date.now());
  return Number(res.lastInsertRowid);
}

/**
 * Adds a student to an open report instead of making a new row. The dashboard's status buttons text the
 * reporter and every follower. Returns "already" when they are the reporter or already follow it.
 */
export function follow(db: DatabaseSync, report: ReportRow, userId: number): { result: "added" | "already"; others: number } {
  // Everyone else on the report: the reporter plus followers, not counting this student.
  const others = new Set([report.userId, ...report.followers].filter((id) => id !== userId)).size;
  if (report.userId === userId || report.followers.includes(userId)) return { result: "already", others };
  db.prepare("UPDATE reports SET followers = ? WHERE id = ?").run(JSON.stringify([...report.followers, userId]), report.id);
  return { result: "added", others };
}

/** One line a status text can use to say which report it is about. Built from stored fields, all lowercase. */
export function reportReference(report: { kind: string; category: unknown; description: unknown; locationText: unknown }): string {
  const clean = (v: unknown) => (text(v) ?? "").replace(/\s+/g, " ").replace(/—|–/g, "-").trim().toLowerCase();
  let what = clean(report.description) || clean(report.category);
  if (what.length > 60) what = `${what.slice(0, 57).trimEnd()}...`;
  const where = clean(report.locationText);
  if (report.kind === "repair") {
    if (what && where) return `update on "${what}" at ${where}`;
    if (what) return `update on "${what}"`;
    return where ? `update on the repair report at ${where}` : "update on the repair report";
  }
  return what ? `update on the usg concern "${what}"` : "update on the usg concern";
}

/** "1 other person" / "3 others". The count comes from the row, never from the model. */
export function othersPhrase(n: number): string {
  return n === 1 ? "1 other person" : `${n} others`;
}

// ---------- conversation helpers ----------

export const CANCEL = /^\s*(?:nvm|nvmd|never ?mind|cancel|forget it|forget that|drop it|no thanks|no thx|nah nvm|scratch that)\b/i;

export const CANCELLED = "all good, dropped it";
/** The variants of CANCELLED, shared by the flows that use it. */
export const CANCELLED_POOL: readonly string[] = [CANCELLED, "no worries, dropped it", "all good, i dropped it", "ok, dropped it"];

/** An open question older than this is forgotten, so a text hours later is read as a new message. */
export const STATE_TTL_MS = 30 * 60 * 1000;

export function isFresh(state: { updatedAt: number } | null): boolean {
  return !!state && Date.now() - state.updatedAt < STATE_TTL_MS;
}

export function userNotes(db: DatabaseSync, userId: number): string[] {
  return (db.prepare("SELECT text FROM user_notes WHERE userId = ? ORDER BY id").all(userId) as { text: string }[]).map((n) => n.text);
}

export function noEmoji(notes: string[]): boolean {
  return notes.some((n) => /no emoji/i.test(n));
}

/**
 * The student has an open question from this flow but their new text starts something else ("found a wallet").
 * The pipeline keeps the open flow when the intent came from keyword rules, so the flow re-dispatches itself:
 * clear the state and hand the message to the flow it belongs to. Returns false when no such flow is registered.
 */
export async function passToOtherFlow(ctx: FlowContext, self: FlowName): Promise<boolean> {
  const wanted = ctx.intent.flow;
  if (wanted === self || wanted === "smalltalk" || wanted === "onboarding") return false;
  // Loaded here, not at the top: the registry imports the flows, and the flows import this file.
  const { getFlow } = await import("./index.ts");
  const other = getFlow(wanted);
  if (!other || other.name === self) return false;
  ctx.setState(null);
  // The other flow speaks in its own words, so it gets the plain context back.
  await other.handle({ ...unvoiced(ctx), state: null });
  return true;
}

// ---------- offers: a chat never files anything on its own ----------
//
// When a conversation turns into something Troy could send somewhere, the flow says what it could do and waits.
// The offer is the flow's own open step (OFFER_STEP), holding what he understood and the student's own words so
// far. Only a yes starts anything. A no, a change of subject or silence drops it.

export const OFFER_STEP = "offer";
/** An offer nobody answered lapses after this long. */
export const OFFER_TTL_MS = 10 * 60 * 1000;

/** The row id of the newest thing Troy sent in a chat, or null. */
export function newestOutId(db: DatabaseSync, chatId: string): number | null {
  try {
    const row = db.prepare("SELECT id FROM messages WHERE chatId = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(chatId) as { id: number } | undefined;
    return row ? Number(row.id) : null;
  } catch {
    return null;
  }
}

/**
 * True while an offer (or the confirmation after it) can still be answered: it was asked recently, and it is still
 * the last thing Troy said in that chat. Once anything else of his went out, a "yes" belongs to that, not to this.
 */
export function offerLive(db: DatabaseSync, chatId: string, state: Pick<FlowState, "data" | "updatedAt">, now: number = Date.now()): boolean {
  if (now - state.updatedAt >= OFFER_TTL_MS) return false;
  const last = state.data.lastOut;
  return typeof last !== "number" || newestOutId(db, chatId) === last;
}

const CLAIMS_DONE = /✅|\b(?:i|i've|ive|i have|just|already|it's|its|it is|that's|thats|been|got it|all)\s+(?:just |already |now |been )?(?:sent|reported|passed|filed|flagged|submitted|logged|forwarded|told|let)\b|\b(?:is|was|got|been) (?:sent|reported|filed|submitted|passed (?:on|along))\b/;

/**
 * True when an offer's wording says the thing is already done ("i reported it", "it's sent"). An offer is a
 * question about something that has not happened: wording that claims otherwise is never sent, and the
 * hand-written question goes out instead.
 */
export function claimsDone(bubbles: string[]): boolean {
  return bubbles.some((b) => CLAIMS_DONE.test((b ?? "").toLowerCase().replace(/[‘’]/g, "'")));
}

/** How many times an offer may be kept standing while they keep talking, before it is let go. */
const OFFER_KEEPS = 3;

/**
 * They kept talking about it instead of answering, and troy just replied without asking anything: the offer stays
 * open, so a later yes is still a yes to it. Their new words are added to what he understood. False (and nothing
 * changed) when there is no open offer for this person or it has been kept often enough; the caller drops it then.
 */
export function keepOfferStanding(db: DatabaseSync, userId: number, chatId: string, text: string): boolean {
  try {
    const state = getFlowState(db, userId);
    if (!state || state.step !== OFFER_STEP) return false;
    const kept = Number(state.data.kept ?? 0);
    if (kept >= OFFER_KEEPS) return false;
    const said = (text ?? "").replace(/\s+/g, " ").trim();
    const before = typeof state.data.description === "string" ? state.data.description : "";
    // Only a concern's description is their running words. A repair's is the broken thing, and stays as it was.
    const description = state.flow === "usg" && said && !BARE_ANSWER.test(said) && !before.includes(said) ? joinWords([before, said]) : before;
    setFlowState(db, userId, { flow: state.flow, step: state.step, data: { ...state.data, description, kept: kept + 1, standing: true, lastOut: newestOutId(db, chatId) } });
    return true;
  } catch {
    return false;
  }
}

const BARE_ANSWER = /^(?:yes+|yeah+|yea|yep|yup|ya|sure|ok+|okay|k+|bet|no+|nah+|nope|lol|lmao|haha+|thanks?|thx|ty|cool|nice|idk|hm+|pls|please|do it|go ahead)[.!? ]*$/i;
/** How far back a student's own words still count as the same conversation. */
const THREAD_MS = 20 * 60 * 1000;

/**
 * The student's own recent words in this chat, oldest first, ending with `current`: what a report or concern that
 * began in a chat is filled in with, so they are never asked for it again. Bare answers ("yes", "ok", "lol") are
 * left out. Only their words: nothing of Troy's and nothing passed along.
 */
export function ownWords(db: DatabaseSync, chatId: string, current: string, max = 4): string[] {
  const clean = (t: string) => t.replace(/\s+/g, " ").trim();
  const out: string[] = [];
  try {
    const rows = db.prepare("SELECT text, createdAt FROM messages WHERE chatId = ? AND direction = 'in' ORDER BY id DESC LIMIT 12").all(chatId) as { text: string | null; createdAt: number }[];
    const newest = rows[0]?.createdAt ?? 0;
    for (const r of rows) {
      const t = clean(r.text ?? "");
      if (!t || BARE_ANSWER.test(t) || newest - r.createdAt > THREAD_MS) continue;
      if (!out.includes(t)) out.push(t);
      if (out.length >= max) break;
    }
  } catch {
    // The message in hand still carries it.
  }
  out.reverse();
  const now = clean(current ?? "");
  if (now && !BARE_ANSWER.test(now) && !out.includes(now)) out.push(now);
  return out.slice(-max);
}

/** Several of a student's texts as one line for a report: their words, joined, never reworded. */
export function joinWords(parts: string[], max = 300): string {
  return parts.map((p) => p.replace(/\s+/g, " ").trim().replace(/[.,;]+$/, "")).filter(Boolean).join(". ").slice(0, max);
}

// ---------- the demo note ----------

/** One short line, the first time a person files anything: where it is logged, and that the office's own system isn't connected yet. */
export const DEMO_NOTE = "(heads up: that's logged on the staff dashboard. the office's real system isn't connected yet)";
export const DEMO_NOTE_POOL: readonly string[] = [
  DEMO_NOTE,
  "(fyi it's on the staff dashboard for now. the office's own system isn't hooked up yet)",
  "(one note: it's logged on the staff dashboard, since the real office system isn't connected yet)",
];

/** True exactly once per person: the first time they file a report or a concern. Marks it as said. */
export function firstFiling(db: DatabaseSync, userId: number): boolean {
  const key = `demo_note:${userId}`;
  try {
    if (getSetting(db, key)) return false;
    setSetting(db, key, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

/** Break a stored text into bubbles at sentence ends. Joining the bubbles with a space gives the text back unchanged. */
export function sentenceBubbles(stored: string, max = 220): string[] {
  const sentences = stored.trim().split(/(?<=[.!?])\s+(?=\S)/);
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (!cur) cur = s;
    else if (cur.length + 1 + s.length <= max) cur = `${cur} ${s}`;
    else {
      out.push(cur);
      cur = s;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ---------- wording variants: facts locked, wording varied ----------
//
// Every flow keeps writing its fixed lines exactly as before (the canonical wording, with every code, count,
// place and name put in by code). On the way out, a line that is the canonical form of a pool is swapped for
// one of that pool's hand-written variants, with the same values carried over untouched. Lines that are in no
// pool (emergency and danger lines, the contact-sharing warning, the confetti line, anyone's quoted words,
// directory text) go out word for word.
//
// SECURITY: the variant is chosen from (user, pool name) and the picker's own rotation, nothing else. No
// score, match or verification result is ever passed in, so wording can't be read as a signal.

/**
 * A pool is the variants of one line. Variant 0 is the canonical wording the flow code writes.
 * - A list: each variant is one bubble, or a list of bubbles (every variant has the same number of bubbles).
 * - A function of the line's values (all strings): returns the one-bubble variants with the values put in.
 *   No logic inside, only wording, so the same values always land in every variant.
 */
export type PoolDef = readonly (string | readonly string[])[] | ((...slots: string[]) => readonly string[]);
export type Pools = Record<string, PoolDef>;
export type VariantPicker = (db: DatabaseSync, userId: number, key: string, variants: string[]) => string;

let picker: VariantPicker | null = null;

/** Tests swap the picker (to pin a variant, or to record exactly what a choice was made from). Null puts the real one back. */
export function setVariantPicker(fn: VariantPicker | null): void {
  picker = fn;
}

const MARK = "\u0001";
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A regex that matches a template with its value marks, capturing each value (a repeated value must repeat). */
function templateRe(template: string): RegExp {
  const seen = new Set<string>();
  const body = template
    .split(new RegExp(`(${MARK}\\d+${MARK})`))
    .map((part) => {
      const m = part.match(new RegExp(`^${MARK}(\\d+)${MARK}$`));
      if (!m) return escapeRe(part);
      if (seen.has(m[1]!)) return `\\k<s${m[1]}>`;
      seen.add(m[1]!);
      return `(?<s${m[1]}>.+?)`;
    })
    .join("");
  return new RegExp(`^${body}$`, "s");
}

interface Hit {
  key: string;
  /** Which bubble of the pool's variants this line is. */
  j: number;
  /** Every variant as bubbles, with this line's own values put in. */
  variants: string[][];
}

export interface Voice {
  readonly ns: string;
  readonly pools: Pools;
  /** One line for one person: a variant when the line is a pool's canonical wording, else the line itself. */
  line(db: DatabaseSync, userId: number, text: string): string;
  /** A whole reply. Bubbles of the same pool stay on the same variant. Bubble objects ({ text }) pass through untouched. */
  bubbles<T extends string | Bubble>(db: DatabaseSync, userId: number, list: T[]): T[];
  /** The canonical wording of any variant, values kept. Anything that is not a variant comes back unchanged. */
  canonical(text: string): string;
  /** Every wording a canonical line may go out as (itself included). */
  variantsOf(text: string): string[];
  /** The same context, with say / sayTo / sayToOwed speaking through this voice. */
  wrap(ctx: FlowContext): FlowContext;
}

const RAW = Symbol("unvoiced");
type Speak = Pick<FlowContext, "say" | "sayTo" | "sayToOwed">;

/** The context as the pipeline made it, for handing a message to another flow. */
export function unvoiced(ctx: FlowContext): FlowContext {
  const raw = (ctx as FlowContext & { [RAW]?: Speak })[RAW];
  return raw ? { ...ctx, ...raw } : ctx;
}

export function makeVoice(ns: string, pools: Pools): Voice {
  const exact = new Map<string, Hit>();
  const back = new Map<string, string>();
  const forward: { re: RegExp; key: string; fn: (...slots: string[]) => readonly string[] }[] = [];
  const backward: { re: RegExp; fn: (...slots: string[]) => readonly string[] }[] = [];

  for (const [key, def] of Object.entries(pools)) {
    if (typeof def === "function") {
      const marks = Array.from({ length: def.length }, (_, i) => `\u0001${i}\u0001`);
      const templates = def(...marks);
      forward.push({ re: templateRe(templates[0]!), key, fn: def });
      for (const t of templates) backward.push({ re: templateRe(t), fn: def });
      continue;
    }
    const variants = def.map((v) => (typeof v === "string" ? [v] : [...v]));
    variants[0]!.forEach((line, j) => {
      if (!exact.has(line)) exact.set(line, { key, j, variants });
    });
    for (const v of variants) v.forEach((line, j) => {
      if (!back.has(line)) back.set(line, variants[0]![j] ?? line);
    });
  }

  const slotsOf = (m: RegExpMatchArray, n: number): string[] => Array.from({ length: n }, (_, i) => m.groups?.[`s${i}`] ?? "");

  function find(text: string): Hit | null {
    const hit = exact.get(text);
    if (hit) return hit;
    for (const f of forward) {
      const m = text.match(f.re);
      if (m) return { key: f.key, j: 0, variants: f.fn(...slotsOf(m, f.fn.length)).map((v) => [v]) };
    }
    return null;
  }

  function bubbles<T extends string | Bubble>(db: DatabaseSync, userId: number, list: T[]): T[] {
    const picked = new Map<string, number>();
    return list.map((b) => {
      if (typeof b !== "string") return b;
      const hit = find(b);
      if (!hit) return b;
      let i = picked.get(hit.key);
      if (i === undefined) {
        const joined = hit.variants.map((v) => v.join("\n"));
        // Only the person and the pool's name go in. See SECURITY above.
        const got = (picker ?? pickVariant)(db, userId, `${ns}.${hit.key}`, joined);
        i = Math.max(0, joined.indexOf(got));
        picked.set(hit.key, i);
      }
      return (hit.variants[i]?.[hit.j] ?? b) as T;
    });
  }

  function canonical(text: string): string {
    const known = back.get(text);
    if (known !== undefined) return known;
    for (const b of backward) {
      const m = text.match(b.re);
      if (m) return b.fn(...slotsOf(m, b.fn.length))[0]!;
    }
    return text;
  }

  const voice: Voice = {
    ns,
    pools,
    bubbles,
    canonical,
    line: (db, userId, text) => bubbles(db, userId, [text])[0]!,
    variantsOf(text) {
      const hit = find(text);
      return hit ? hit.variants.map((v) => v[hit.j]!) : [text];
    },
    wrap(ctx) {
      const plain = unvoiced(ctx);
      const raw: Speak = { say: plain.say, sayTo: plain.sayTo, sayToOwed: plain.sayToOwed };
      const wrapped: FlowContext & { [RAW]?: Speak } = {
        ...plain,
        say: (...b) => raw.say(...bubbles(plain.db, plain.user.id, b)),
        sayTo: (userId, ...b) => raw.sayTo(userId, ...bubbles(plain.db, userId, b)),
        sayToOwed: (userId, ...b) => raw.sayToOwed(userId, ...bubbles(plain.db, userId, b)),
      };
      wrapped[RAW] = raw;
      return wrapped;
    },
  };
  return voice;
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/**
 * Everything that would make a pool unsafe to ship, as plain sentences (empty when all is well): fewer than 3 or
 * more than 5 variants, a variant with a different number of bubbles, a variant that drops or adds a value,
 * capitals, em dashes, more than one emoji, an emoji the canonical line doesn't have, the same wording twice,
 * or a line two pools would both claim.
 */
export function poolProblems(pools: Pools): string[] {
  const out: string[] = [];
  const owner = new Map<string, string>();
  const voice = makeVoice("check", pools);
  for (const [key, def] of Object.entries(pools)) {
    const fn = typeof def === "function" ? def : null;
    const marks = fn ? Array.from({ length: fn.length }, (_, i) => `\u0001${i}\u0001`) : [];
    const variants = (fn ? fn(...marks).map((v) => [v]) : (def as readonly (string | readonly string[])[]).map((v) => (typeof v === "string" ? [v] : [...v])));
    if (variants.length < 3 || variants.length > 5) out.push(`${key}: ${variants.length} variants, want 3 to 5`);
    const first = variants[0]!;
    const seen = new Set<string>();
    for (const [i, v] of variants.entries()) {
      const whole = v.join("\n");
      if (seen.has(whole)) out.push(`${key}: variant ${i} repeats another one`);
      seen.add(whole);
      if (v.length !== first.length) out.push(`${key}: variant ${i} has ${v.length} bubbles, the first has ${first.length}`);
      v.forEach((line, j) => {
        const plain = line.replace(new RegExp(`${MARK}\\d+${MARK}`, "g"), "");
        if (/[A-Z]/.test(plain.replace(/\b(?:STOP|HUMAN)\b/g, ""))) out.push(`${key}: variant ${i} has capitals`);
        if (/[\u2014\u2013]|--/.test(plain)) out.push(`${key}: variant ${i} has a dash`);
        const emoji = (plain.match(EMOJI_RE) ?? []).length;
        const firstEmoji = ((first[j] ?? "").match(EMOJI_RE) ?? []).length;
        if (emoji > 1) out.push(`${key}: variant ${i} has more than one emoji in a bubble`);
        if (emoji > firstEmoji) out.push(`${key}: variant ${i} adds an emoji the first wording doesn't have`);
        const slots = (t: string) => [...new Set(t.match(new RegExp(`${MARK}\\d+${MARK}`, "g")) ?? [])].sort().join(",");
        if (slots(line) !== slots(first[j] ?? "")) out.push(`${key}: variant ${i} bubble ${j} carries different values`);
        if (fn && slots(line).split(",").filter(Boolean).length !== fn.length) out.push(`${key}: variant ${i} doesn't use every value`);
        const sample = line.replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), "v$1");
        const claimed = owner.get(sample);
        if (claimed && claimed !== key) out.push(`${key}: "${sample}" is also in ${claimed}`);
        owner.set(sample, key);
        if (i === 0 && voice.variantsOf(sample).length !== variants.length) out.push(`${key}: its first wording isn't found as its own pool`);
        if (voice.canonical(sample) !== (first[j] ?? "").replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), "v$1")) out.push(`${key}: variant ${i} bubble ${j} reads back as another line`);
      });
    }
  }
  return out;
}

// ---------- one-tap asks (John, second live test (5)) ----------
//
// A yes/no or pick-one ask goes out as a native poll when the provider has polls, so it is one tap. When the
// provider falls back, the tap mode gets exactly one hint after the options and the numbered mode answers by number.
// Never "tap ❤️ on ur pick", and never two different tap instructions in one message: the question itself names
// no way to tap. Without polls at all the caller asks in words as before (a thumbs up on the question still counts).

export type AskPoll = { pollId: string | null; optionIds: (string | null)[]; mode: "native" | "tap" | "numbered"; options: string[] };

export const POLL_TAP_HINT: readonly string[] = ["heart the one u want", "heart or thumbs up the one u want"];
export const POLL_NUMBER_HINT: readonly string[] = ["text the number", "just text the number"];

/** The question bubble may not carry a tap instruction of its own: the poll (or the one hint) is the instruction. */
const TAP_WORDS = /\s*\b(?:tap|heart|thumbs up)\b[^.?!]*(?:one|it|pick|this|that)\b[.!]?\s*$/i;

/**
 * Sends `question` with `options` as a poll and saves what went out, so "is this still his last word" checks see it.
 * Returns null (and sends nothing) when the provider has no polls or the send failed: the caller asks in words.
 */
export async function askPoll(ctx: FlowContext, question: string, options: string[], key: string): Promise<AskPoll | null> {
  const adapter = ctx.adapter;
  if (typeof adapter?.sendPoll !== "function" || typeof adapter.capabilities !== "function" || !adapter.capabilities().polls) return null;
  const chatId = ctx.user.chatId || ctx.event.chatId;
  const q = question.replace(TAP_WORDS, "").trim() || question;
  let poll: Awaited<ReturnType<typeof adapter.sendPoll>>;
  try {
    poll = await adapter.sendPoll(chatId, q, options);
  } catch {
    // Nothing went out: the caller asks in words.
    return null;
  }
  // From here the question is out. Never null again, or the caller would ask the same thing a second time in words.
  const asked: AskPoll = { pollId: null, optionIds: poll.optionMessageIds, mode: poll.mode, options };
  try {
    const save = (providerMessageId: string | null, text: string) => saveMessage(ctx.db, { userId: ctx.user.id, chatId, direction: "out", providerMessageId, text });
    if (poll.mode === "native") {
      const pollId = poll.optionMessageIds.find((id) => !!id) ?? null;
      save(pollId, `[poll] ${q}: ${options.join(" / ")}`);
      return { ...asked, pollId };
    }
    save(null, q);
    options.forEach((o, i) => save(poll.optionMessageIds[i] ?? null, o));
    // Exactly one instruction: the provider adds none of its own.
    if (poll.mode === "tap") await ctx.say(pickVariant(ctx.db, ctx.user.id, `poll:${key}:tap`, POLL_TAP_HINT as string[]));
    else await ctx.say(pickVariant(ctx.db, ctx.user.id, `poll:${key}:numbered`, POLL_NUMBER_HINT as string[]));
  } catch {
    // Saving or the hint failed; the poll itself is out.
  }
  return asked;
}

/** Reads a stored AskPoll back from flow state data. */
export function pollOf(raw: unknown): AskPoll | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<AskPoll>;
  if (!Array.isArray(p.optionIds) || !Array.isArray(p.options) || (p.mode !== "native" && p.mode !== "tap" && p.mode !== "numbered")) return null;
  return { pollId: typeof p.pollId === "string" ? p.pollId : null, optionIds: p.optionIds, mode: p.mode, options: p.options };
}

/**
 * Which option this event picks: a vote on the poll, a heart or thumbs up on an option's bubble (tap mode), or a
 * typed number or option (any mode). -1 when it picks nothing.
 */
export function pollPick(event: { pollVote?: { pollMessageId: string; optionIndex: number }; reaction?: { targetMessageId: string; type: string; removed: boolean }; text: string }, poll: AskPoll | null): number {
  if (!poll) return -1;
  if (event.pollVote) {
    if (poll.mode !== "native") return -1;
    if (event.pollVote.pollMessageId && poll.pollId && event.pollVote.pollMessageId !== poll.pollId) return -1;
    const i = event.pollVote.optionIndex;
    return Number.isInteger(i) && i >= 0 && i < poll.options.length ? i : -1;
  }
  if (event.reaction) {
    const r = event.reaction;
    if (r.removed || (r.type !== "love" && r.type !== "like")) return -1;
    return poll.optionIds.findIndex((id) => !!id && id === r.targetMessageId);
  }
  const t = (event.text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return -1;
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= poll.options.length) return n - 1;
  return poll.options.findIndex((o) => o.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim() === t);
}
