// What the repair flow and the USG flow share: directory lookups, the reports table, followers and
// "is this the same report" checks. Everything here is plain code, no model calls.

import type { DatabaseSync } from "node:sqlite";
import type { FlowContext, FlowName } from "../types.ts";

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

/** "1 other person" / "3 others". The count comes from the row, never from the model. */
export function othersPhrase(n: number): string {
  return n === 1 ? "1 other person" : `${n} others`;
}

// ---------- conversation helpers ----------

export const CANCEL = /^\s*(?:nvm|nvmd|never ?mind|cancel|forget it|forget that|drop it|no thanks|no thx|nah nvm|scratch that)\b/i;

export const CANCELLED = "all good, dropped it";

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
  await other.handle({ ...ctx, state: null });
  return true;
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
