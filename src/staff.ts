// Example mode for the people a report would go to: a technician (FMS, Housing) and a USG committee member.
//
// A phone is assigned to a role from the dashboard. None are real staff yet, so every assignment is labeled
// "example". When a report lands, the assigned person gets a text; their answer moves the report's status and
// texts the student. With nobody assigned nothing is sent, and the dashboard shows the text Troy would have sent.
//
// Code decides: who is texted, every count, the walking time, every status, who is asked to join a group chat
// and who ends up in it. Wording comes from small pools (pickVariant). The one fixed line is the contact-sharing
// warning. A staff contact is an ordinary user: the gate, STOP, pause and quiet hours all apply to them.
//
// How a staff answer finds its way back here: the person's flow_state points at the flow that owns the report
// (step "staff"). That step is protected, so other flows park it instead of clearing it, and the repair and usg
// handlers call handleStaffTurn first and restoreStaffPointer last.

import type { DatabaseSync } from "node:sqlite";
import type { FlowContext, Handle, IncomingEvent, MessagingAdapter, User } from "./types.ts";
import { config, normalizeHandle } from "./config.ts";
import { getFlowState, getUserByHandle, getUserById, setFlowState } from "./db/index.ts";
import { getUserLocation } from "./location.ts";
import { findPlace, walkingMinutes } from "./places.ts";
import { pickVariant } from "./voice.ts";
import { canAlert } from "./quiet.ts";
import { dropPending, isBusy, onSweep, onUserGone, parkAsk, pendingFor, registerPendingHooks } from "./pending.ts";
import { RELAY_COPY, startRelay } from "./relay.ts";
import { reportReference } from "./flows/reports-shared.ts";

type Row = Record<string, unknown>;

/** Sends bubbles to one person's own chat. False when nothing went out and nothing is waiting to. */
export type Tell = (userId: number, bubbles: string[]) => Promise<boolean | void>;

/** The open step that routes a staff contact's answers back here. */
export const STAFF_STEP = "staff";
/** The open step of a student who was asked to join a group chat with the usg member. */
export const TALK_STEP = "talk_consent";
/** A student who joined a concern gets one optional question (name or anonymous); the member's summary waits this long for it. */
export const NOTICE_DELAY_MS = 3 * 60 * 1000;
/** After this long the group chat is made with whoever said yes so far. */
export const TALK_WAIT_MS = 10 * 60 * 1000;

/**
 * The contact-sharing warning. Fixed, word for word, always its own bubble. A thumbs up counts as yes only on
 * this exact bubble.
 */
export const CONTACT_WARNING = "heads up, that shares ur contact info. ok?";

// ---------- tables ----------

const prepared = new WeakSet<DatabaseSync>();

export function ensureStaffTables(db: DatabaseSync): void {
  if (prepared.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff_contacts (
      id INTEGER PRIMARY KEY,
      role TEXT NOT NULL UNIQUE,
      handle TEXT NOT NULL,
      userId INTEGER,
      label TEXT,
      isExample INTEGER NOT NULL DEFAULT 1,
      createdAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS staff_log (
      id INTEGER PRIMARY KEY,
      reportId INTEGER NOT NULL,
      toUserId INTEGER,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      sentText TEXT,
      example INTEGER NOT NULL DEFAULT 0,
      photoUrl TEXT,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS staff_log_report ON staff_log(reportId, id);
    CREATE TABLE IF NOT EXISTS staff_jobs (
      id INTEGER PRIMARY KEY,
      reportId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'asked',
      people INTEGER NOT NULL DEFAULT 1,
      named INTEGER NOT NULL DEFAULT 0,
      talk TEXT,
      talkAt INTEGER,
      askedAt INTEGER NOT NULL,
      UNIQUE (reportId, userId)
    );
    CREATE TABLE IF NOT EXISTS report_people (
      reportId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      named INTEGER NOT NULL DEFAULT 0,
      talk TEXT,
      PRIMARY KEY (reportId, userId)
    );
    CREATE TABLE IF NOT EXISTS staff_notices (reportId INTEGER PRIMARY KEY, dueAt INTEGER NOT NULL);
  `);
  prepared.add(db);
}

// ---------- roles ----------

export type StaffRole = string;

/** "fms", "housing" or "usg:<committee name>" for a report, from where it was routed. */
export function reportRole(report: { kind: unknown; routedTo: unknown }): StaffRole | null {
  const routed = typeof report.routedTo === "string" ? report.routedTo.trim() : "";
  if (report.kind === "repair") return /housing/i.test(routed) ? "housing" : "fms";
  if (report.kind === "usg_concern") return routed ? `usg:${routed}` : null;
  return null;
}

export function roleLabel(role: StaffRole): string {
  if (role === "fms") return "FMS";
  if (role === "housing") return "Housing";
  return role.startsWith("usg:") ? role.slice(4) : role;
}

function committeeNames(db: DatabaseSync): string[] {
  try {
    return (db.prepare("SELECT name FROM directory WHERE kind = 'usg_committee' ORDER BY id").all() as { name: string }[]).map((r) => r.name);
  } catch {
    return [];
  }
}

/** Every role a phone can be assigned to: the two repair offices, then each usg committee in the directory. */
export function staffRoles(db: DatabaseSync): { role: StaffRole; label: string }[] {
  return [{ role: "fms", label: "FMS" }, { role: "housing", label: "Housing" }, ...committeeNames(db).map((name) => ({ role: `usg:${name}`, label: name }))];
}

/** The stored form of a role, or null. A committee has to be one the directory lists (its name comes back as stored). */
export function parseRole(db: DatabaseSync, raw: unknown): StaffRole | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (/^fms$/i.test(s)) return "fms";
  if (/^housing$/i.test(s)) return "housing";
  const m = /^usg:\s*(.+)$/i.exec(s);
  if (!m) return null;
  const want = m[1]!.trim().toLowerCase();
  const name = committeeNames(db).find((n) => n.toLowerCase() === want);
  return name ? `usg:${name}` : null;
}

// ---------- assignments ----------

export interface StaffContact {
  id: number;
  role: StaffRole;
  handle: Handle;
  userId: number | null;
  label: string | null;
  isExample: boolean;
  createdAt: number;
}

const toContact = (r: Row): StaffContact => ({
  id: r.id as number,
  role: r.role as string,
  handle: r.handle as string,
  userId: typeof r.userId === "number" ? r.userId : null,
  label: typeof r.label === "string" && r.label ? r.label : null,
  isExample: !!r.isExample,
  createdAt: r.createdAt as number,
});

/** A label is how the person is introduced ("sam", "the night tech"): letters and spaces only, never a number or an email. */
function cleanLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 30);
  return s && /^[a-z][a-z .'-]*$/.test(s) ? s : null;
}

function handleAllowed(db: DatabaseSync, handle: Handle): boolean {
  return config.allowedHandles.includes(handle) || !!db.prepare("SELECT 1 FROM allow_list WHERE handle = ? LIMIT 1").get(handle);
}

export type AssignResult = { ok: true; contact: StaffContact; addedToAllowList: boolean } | { ok: false; error: "bad_handle" | "bad_role" };

/**
 * Puts one phone on a role (one phone per role; a new one replaces the old). The handle is normalized, and when
 * its chat isn't allowed yet it goes on the manual allow-list in the same step. Always labeled as an example.
 */
export function assignStaff(db: DatabaseSync, input: { role: unknown; handle: unknown; label?: unknown }): AssignResult {
  ensureStaffTables(db);
  const handle = normalizeHandle(input.handle);
  if (!handle) return { ok: false, error: "bad_handle" };
  const role = parseRole(db, input.role);
  if (!role) return { ok: false, error: "bad_role" };
  let addedToAllowList = false;
  if (!handleAllowed(db, handle)) {
    db.prepare("INSERT INTO allow_list (handle, chatId, reason, addedAt) VALUES (?, NULL, 'manual', ?)").run(handle, Date.now());
    addedToAllowList = true;
  }
  const user = getUserByHandle(db, handle);
  const before = db.prepare("SELECT * FROM staff_contacts WHERE role = ?").get(role) as Row | undefined;
  // Whoever held the role before hands their open jobs back.
  if (before && before.handle !== handle && typeof before.userId === "number") releaseJobsOf(db, before.userId, role);
  db.prepare(
    "INSERT INTO staff_contacts (role, handle, userId, label, isExample, createdAt) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(role) DO UPDATE SET handle = excluded.handle, userId = excluded.userId, label = excluded.label, isExample = 1, createdAt = excluded.createdAt",
  ).run(role, handle, user?.id ?? null, cleanLabel(input.label), Date.now());
  return { ok: true, contact: toContact(db.prepare("SELECT * FROM staff_contacts WHERE role = ?").get(role) as Row), addedToAllowList };
}

export function removeStaff(db: DatabaseSync, id: number): boolean {
  ensureStaffTables(db);
  const row = db.prepare("SELECT * FROM staff_contacts WHERE id = ?").get(id) as Row | undefined;
  if (!row) return false;
  if (typeof row.userId === "number") releaseJobsOf(db, row.userId, row.role as string);
  db.prepare("DELETE FROM staff_contacts WHERE id = ?").run(id);
  return true;
}

export function listStaff(db: DatabaseSync): StaffContact[] {
  ensureStaffTables(db);
  return (db.prepare("SELECT * FROM staff_contacts ORDER BY role").all() as Row[]).map(toContact);
}

/** The person on a role. Their user row is looked up by handle each time, so someone who texted Troy after being assigned is found. */
export function staffFor(db: DatabaseSync, role: StaffRole | null): (StaffContact & { user: User | null }) | null {
  if (!role) return null;
  ensureStaffTables(db);
  const row = db.prepare("SELECT * FROM staff_contacts WHERE role = ?").get(role) as Row | undefined;
  if (!row) return null;
  const contact = toContact(row);
  const user = getUserByHandle(db, contact.handle);
  if ((user?.id ?? null) !== contact.userId) db.prepare("UPDATE staff_contacts SET userId = ? WHERE id = ?").run(user?.id ?? null, contact.id);
  return { ...contact, userId: user?.id ?? null, user };
}

// ---------- the dashboard's log ----------

export interface StaffLogEntry {
  id: number;
  kind: string;
  text: string;
  example: boolean;
  hasPhoto: boolean;
  createdAt: number;
}

/**
 * `text` is what the dashboard shows. `sentText` is the exact text that went out when it differs: the walking time
 * is the technician's own location in another form, so it is in their text and never on a dashboard.
 */
function log(db: DatabaseSync, reportId: number, e: { toUserId?: number | null; kind: string; text: string; sentText?: string; example?: boolean; photoUrl?: string | null }): void {
  db.prepare("INSERT INTO staff_log (reportId, toUserId, kind, text, sentText, example, photoUrl, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    reportId,
    e.toUserId ?? null,
    e.kind,
    e.text,
    e.sentText && e.sentText !== e.text ? e.sentText : null,
    e.example ? 1 : 0,
    e.photoUrl ?? null,
    Date.now(),
  );
}

/** What Troy texted to staff about one report, and what they did, oldest first. Example rows are texts nobody got. */
export function staffLogFor(db: DatabaseSync, reportId: number): StaffLogEntry[] {
  ensureStaffTables(db);
  return (db.prepare("SELECT * FROM staff_log WHERE reportId = ? ORDER BY id").all(reportId) as Row[]).map((r) => ({
    id: r.id as number,
    kind: r.kind as string,
    text: r.text as string,
    example: !!r.example,
    hasPhoto: typeof r.photoUrl === "string" && !!r.photoUrl,
    createdAt: r.createdAt as number,
  }));
}

// ---------- who is behind a report ----------

interface Report {
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
  createdAt: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

function toReport(r: Row): Report {
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
    kind: r.kind as Report["kind"],
    anonymous: !!r.anonymous,
    category: str(r.category),
    description: str(r.description),
    locationText: str(r.locationText),
    routedTo: str(r.routedTo),
    status: r.status as string,
    followers,
    createdAt: (r.createdAt as number) ?? Date.now(),
  };
}

function getReport(db: DatabaseSync, id: number): Report | null {
  const r = db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as Row | undefined;
  return r ? toReport(r) : null;
}

/** Records whether one student behind a concern shared their name. A later "anonymous" takes the name back off. */
export function recordPerson(db: DatabaseSync, reportId: number, userId: number, named: boolean): void {
  ensureStaffTables(db);
  db.prepare("INSERT INTO report_people (reportId, userId, named) VALUES (?, ?, ?) ON CONFLICT(reportId, userId) DO UPDATE SET named = excluded.named").run(reportId, userId, named ? 1 : 0);
}

/** How many students are behind a report, and how many of them shared their name. Counts only, never who. */
export function reportCounts(db: DatabaseSync, report: { id: number; userId: number; anonymous: boolean; followers: number[] }): { people: number; named: number } {
  ensureStaffTables(db);
  const everyone = new Set([report.userId, ...report.followers]);
  const rows = db.prepare("SELECT userId, named FROM report_people WHERE reportId = ?").all(report.id) as { userId: number; named: number }[];
  const known = new Map(rows.map((r) => [r.userId, !!r.named]));
  let named = 0;
  for (const id of everyone) {
    // The reporter's own choice is on the report row; a follower counts only once they said to use their name.
    if (known.has(id) ? known.get(id) : id === report.userId && !report.anonymous) named++;
  }
  return { people: everyone.size, named };
}

function namedPeople(db: DatabaseSync, report: Report): number[] {
  const rows = db.prepare("SELECT userId, named FROM report_people WHERE reportId = ?").all(report.id) as { userId: number; named: number }[];
  const known = new Map(rows.map((r) => [r.userId, !!r.named]));
  return [...new Set([report.userId, ...report.followers])].filter((id) => (known.has(id) ? known.get(id) : id === report.userId && !report.anonymous));
}

// ---------- the texts ----------

const short = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").replace(/[—–]/g, "-").replace(/"/g, "'").trim().toLowerCase();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
};

/** "a broken light" when the category reads that way, otherwise the student's own words in quotes. */
function whatBroke(report: Report): string {
  const cat = (report.category ?? "").toLowerCase().trim();
  if (/^(?:broken|leaking|clogged) [a-z ]+$/.test(cat)) return `a ${cat}`;
  if (cat === "leak") return "a leak";
  if (cat === "elevator out") return "an elevator that's out";
  if (cat === "wifi down") return "the wifi being down";
  const said = short(report.description ?? report.category ?? "", 70);
  return said ? `"${said}"` : "something broken";
}

const officeWord = (role: StaffRole | null): string => (role === "housing" ? "housing" : "facilities");

/** The repair ask, every wording. `walk` is the whole clause (", about 6 minutes' walk from u") or empty. */
function repairAskVariants(what: string, where: string | null, walk: string): string[] {
  const at = where ? ` at ${where}` : "";
  return [
    `someone reported ${what}${at}${walk}. can u take it?`,
    `heads up, someone reported ${what}${at}${walk}. can u take this one?`,
    `new one for u: someone reported ${what}${at}${walk}. can u take it?`,
  ];
}

const REPAIR_HOW = [
  `text "on it" if u got it, or "can't" and i'll hand it back`,
  `if u got it, text "on it". if not, text "can't" and i'll hand it back`,
  `"on it" means it's urs. "can't" and i'll give it to someone else`,
];

/** The walking clause, exactly as walkClause writes it, for taking it back out of a text. */
const WALK_CLAUSE = /, about a \d+ minute walk from u/g;
const withoutWalk = (text: string): string => text.replace(WALK_CLAUSE, "");

function walkClause(db: DatabaseSync, report: Report, tech: User | null): string {
  if (!tech) return "";
  const place = findPlace(db, report.locationText ?? "") ?? findPlace(db, report.description ?? "");
  const from = getUserLocation(db, tech);
  if (!place || !from) return "";
  const n = walkingMinutes(from, place);
  return `, about ${n === 1 ? "a 1 minute" : `a ${n} minute`} walk from u`;
}

function usgSummaryVariants(report: Report, counts: { people: number; named: number }, askChat: boolean): string[] {
  const n = counts.people;
  const who = n === 1 ? "1 trojan" : `${n} trojans`;
  const week = Date.now() - report.createdAt < 7 * 24 * 60 * 60 * 1000 ? " this week" : "";
  const what = short(report.description ?? report.category ?? "a concern", 90);
  const k = counts.named;
  const tail = k === 0 ? "nobody shared their name, so there's no one to loop in yet" : askChat ? `${k === 1 ? "1 wants" : `${k} want`} to talk. want a group chat with them?` : `${k === 1 ? "1 wants" : `${k} want`} to talk`;
  return [`${who} raised "${what}"${week}. ${tail}`, `heads up, ${who} brought up "${what}"${week}. ${tail}`, `"${what}" came up from ${who}${week}. ${tail}`];
}

const USG_HOW = [
  `u can also text me a status like "on the agenda" or "we fixed it" and i'll let them know`,
  `text me a status anytime, like "on the agenda" or "we fixed it", and i'll pass it on`,
  `if it moves, text me something like "on the agenda" or "we fixed it" and i'll tell them`,
];

/** What goes to the person on the role (or would, when nobody is). `userId` picks the wording; null gives the first one. */
function staffBubbles(db: DatabaseSync, report: Report, tech: User | null, job: Row | null): string[] {
  const pick = (key: string, variants: string[]) => (tech ? pickVariant(db, tech.id, `staff.${key}`, variants) : variants[0]!);
  if (report.kind === "repair") {
    const where = report.locationText ? short(report.locationText, 60) : null;
    return [pick("repairAsk", repairAskVariants(whatBroke(report), where, walkClause(db, report, tech))), pick("repairHow", REPAIR_HOW)];
  }
  const counts = reportCounts(db, report);
  const askChat = !job || job.talk === null || job.talk === undefined;
  const bubbles = [pick("usgSummary", usgSummaryVariants(report, counts, askChat))];
  // How to send a status is said once, with the first summary.
  if (!job) bubbles.push(pick("usgHow", USG_HOW));
  return bubbles;
}

/** The exact text Troy would send about this report if someone were on the role right now. */
export function exampleTextFor(db: DatabaseSync, reportRow: Row): string {
  ensureStaffTables(db);
  return staffBubbles(db, toReport(reportRow), null, null).join("\n");
}

// ---------- sending ----------

const notifiers = new WeakMap<DatabaseSync, Tell>();

/** The server hands over the outbox notifier, so staff and status texts wait out quiet hours instead of being dropped. */
export function setStaffNotifier(db: DatabaseSync, fn: Tell | null): void {
  if (fn) notifiers.set(db, fn);
  else notifiers.delete(db);
}

/** The outbox when the server set one, else the flow's own sayTo (which drops a text in quiet hours). */
export function tellerFor(ctx: Pick<FlowContext, "db" | "sayTo">): Tell {
  return notifiers.get(ctx.db) ?? (async (userId, bubbles) => (await ctx.sayTo(userId, ...bubbles)).some((id) => id !== null));
}

function jobFor(db: DatabaseSync, reportId: number, userId: number): Row | null {
  return (db.prepare("SELECT * FROM staff_jobs WHERE reportId = ? AND userId = ?").get(reportId, userId) as Row | undefined) ?? null;
}

const OPEN_JOB = "state IN ('asked','accepted')";

function openJobs(db: DatabaseSync, userId: number): Row[] {
  return db.prepare(`SELECT * FROM staff_jobs WHERE userId = ? AND ${OPEN_JOB} ORDER BY askedAt DESC, id DESC`).all(userId) as Row[];
}

function releaseJobsOf(db: DatabaseSync, userId: number, role?: StaffRole): void {
  for (const j of openJobs(db, userId)) {
    const report = getReport(db, j.reportId as number);
    if (role && report && reportRole(report) !== role) continue;
    db.prepare("UPDATE staff_jobs SET state = 'declined' WHERE id = ?").run(j.id as number);
    if (report?.kind === "repair" && j.state === "accepted" && report.status === "in_progress") db.prepare("UPDATE reports SET status = 'received' WHERE id = ?").run(report.id);
  }
}

/** A report that reached its last status (from the dashboard or from staff) needs nobody anymore. */
export function closeJobsFor(db: DatabaseSync, reportId: number): void {
  ensureStaffTables(db);
  db.prepare(`UPDATE staff_jobs SET state = 'done' WHERE reportId = ? AND ${OPEN_JOB}`).run(reportId);
  db.prepare("DELETE FROM staff_notices WHERE reportId = ?").run(reportId);
}

/** Points the staff contact's open step at the flow that owns their newest job, without touching a step they are in the middle of. */
export function restoreStaffPointer(db: DatabaseSync, userId: number): void {
  ensureStaffTables(db);
  const cur = getFlowState(db, userId);
  // A student who still owes an answer about a group chat gets that question back first.
  const owed = db.prepare("SELECT p.reportId FROM report_people p JOIN staff_jobs j ON j.reportId = p.reportId WHERE p.userId = ? AND p.talk = 'asked' AND j.talk = 'asked' LIMIT 1").get(userId) as { reportId: number } | undefined;
  if (owed) {
    if (!cur) setFlowState(db, userId, { flow: "usg", step: TALK_STEP, data: { reportId: owed.reportId } });
    return;
  }
  const jobs = openJobs(db, userId);
  if (!jobs.length) return;
  const pointer = { flow: jobs[0]!.kind === "repair" ? ("repair" as const) : ("usg" as const), step: STAFF_STEP, data: {} };
  if (!cur) {
    setFlowState(db, userId, pointer);
    return;
  }
  if (cur.step === STAFF_STEP) return;
  // Busy with something else: the pointer waits its turn, once.
  if (!pendingFor(db, userId).some((s) => s.step === STAFF_STEP)) parkAsk(db, userId, pointer);
}

/**
 * Texts the person assigned to this report's office or committee, or records what Troy would have sent when
 * nobody is. Called when a report is filed and when more students get behind a concern; a concern that hasn't
 * grown since the last summary sends nothing. `sentTo` is the staff contact's user id, or null when nothing went out.
 */
export async function notifyStaffOfReport(deps: { db: DatabaseSync; notify: Tell }, reportId: number): Promise<{ sentTo: number | null; exampleText: string }> {
  const { db } = deps;
  ensureStaffTables(db);
  db.prepare("DELETE FROM staff_notices WHERE reportId = ?").run(reportId);
  const report = getReport(db, reportId);
  if (!report) return { sentTo: null, exampleText: "" };
  const contact = staffFor(db, reportRole(report));
  const tech = contact?.user && !contact.user.stopped ? contact.user : null;

  if (!tech) {
    // Nobody to text. The dashboard shows this, marked as an example; one row per report, kept current.
    const exampleText = staffBubbles(db, report, null, null).join("\n");
    const old = db.prepare("SELECT id, text FROM staff_log WHERE reportId = ? AND example = 1 ORDER BY id DESC LIMIT 1").get(reportId) as { id: number; text: string } | undefined;
    if (!old) log(db, reportId, { kind: report.kind === "repair" ? "ask" : "summary", text: exampleText, example: true });
    else if (old.text !== exampleText) db.prepare("UPDATE staff_log SET text = ?, createdAt = ? WHERE id = ?").run(exampleText, Date.now(), old.id);
    return { sentTo: null, exampleText };
  }

  const job = jobFor(db, reportId, tech.id);
  const counts = reportCounts(db, report);
  if (job) {
    // A repair is asked once. A concern is summarized again only when more students are behind it or want to talk.
    const grew = report.kind === "usg_concern" && job.state !== "declined" && (counts.people > (job.people as number) || counts.named > (job.named as number));
    if (!grew) return { sentTo: tech.id, exampleText: staffBubbles(db, report, null, job).join("\n") };
  }
  const bubbles = staffBubbles(db, report, tech, job);
  const text = bubbles.join("\n");
  let ok: boolean | void = false;
  try {
    ok = await deps.notify(tech.id, bubbles);
  } catch {
    ok = false;
  }
  if (ok === false) {
    log(db, reportId, { toUserId: tech.id, kind: "unsent", text: withoutWalk(text), example: true });
    return { sentTo: null, exampleText: text };
  }
  log(db, reportId, { toUserId: tech.id, kind: report.kind === "repair" ? "ask" : "summary", text: withoutWalk(text), sentText: text });
  if (job) db.prepare("UPDATE staff_jobs SET people = ?, named = ?, askedAt = ?, state = CASE WHEN state = 'done' THEN 'asked' ELSE state END WHERE id = ?").run(counts.people, counts.named, Date.now(), job.id as number);
  else db.prepare("INSERT INTO staff_jobs (reportId, userId, kind, state, people, named, askedAt) VALUES (?, ?, ?, 'asked', ?, ?, ?)").run(reportId, tech.id, report.kind, counts.people, counts.named, Date.now());
  restoreStaffPointer(db, tech.id);
  return { sentTo: tech.id, exampleText: text };
}

/** The member's summary waits a little for a joiner's name answer; the sweep sends it if they never answer. */
export function queueStaffNotice(db: DatabaseSync, reportId: number, delayMs: number = NOTICE_DELAY_MS): void {
  ensureStaffTables(db);
  db.prepare("INSERT INTO staff_notices (reportId, dueAt) VALUES (?, ?) ON CONFLICT(reportId) DO UPDATE SET dueAt = excluded.dueAt").run(reportId, Date.now() + delayMs);
}

// ---------- reading an answer ----------

type Word = "accept" | "done" | "cant" | "agenda" | "closed" | "cancel" | "yes" | "no";

const YES_WORDS = /^(?:yes|yea|yeah|yep|yup|ya|ye|y|sure|ok|okay|k|kk|bet|do it|please do|pls do|go ahead|go for it|sounds good|lets do it|let's do it)(?: (?:please|pls|thanks|thx|ty))?$/;
const NO_WORDS = /^(?:no|nah|nope|n|no thanks|no thx|not rn|not now|i'm good|im good|pass)$/;

/** Plain words only: lowercase, emoji and punctuation dropped. */
function flat(text: string): string {
  return (text ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** A question is never an answer ("ok but why?"), and neither is a long message. */
export function readStaffWord(text: string): Word | null {
  if ((text ?? "").includes("?")) return null;
  const t = flat(text);
  if (!t || t.split(" ").length > 9) return null;
  if (/^(?:cancel|nvm|never ?mind|scratch that)\b/.test(t)) return "cancel";
  if (/\b(?:can'?t|cannot|can not|not me|hand it back|someone else|too busy|i'?m busy|not today|won'?t make it)\b/.test(t)) return "cant";
  if (/\bagenda\b/.test(t)) return "agenda";
  if (/\bclos(?:e|ed|ing)\b/.test(t)) return "closed";
  if (/^(?:all |it'?s |its |it is |that'?s |we |i |just |ok |okay )*(?:done|fixed|finished|completed?|resolved|handled|sorted)\b|\bfixed (?:it|that|this)\b|\btook care of (?:it|that)\b|\bacted on\b|\ball set\b/.test(t)) return "done";
  if (/^(?:ok |okay |yes |yep |sure |bet )*(?:on it|omw|on my way|i'?ll take it|ill take it|i got it|got it|taking it|i can take it|can do|heading over|headed there|mine)\b/.test(t)) return "accept";
  if (YES_WORDS.test(t)) return "yes";
  if (NO_WORDS.test(t)) return "no";
  return null;
}

type YesNoReader = (input: { event: IncomingEvent; questionMessageId: string | null; allowTapback?: boolean }) => "yes" | "no" | null;
let sharedYesNo: YesNoReader | null | undefined;

/** The shared yes/no reader (src/yes.ts) when it is there, else the same rules in small. */
async function yesNo(event: IncomingEvent): Promise<"yes" | "no" | null> {
  if (sharedYesNo === undefined) {
    try {
      const path = "./yes.ts"; // a variable on purpose: the file is another builder's and may not exist yet
      const mod = (await import(path)) as { readYesNo?: YesNoReader };
      sharedYesNo = typeof mod.readYesNo === "function" ? mod.readYesNo : null;
    } catch {
      sharedYesNo = null;
    }
  }
  if (sharedYesNo) {
    try {
      const got = sharedYesNo({ event: { ...event, reaction: undefined }, questionMessageId: null, allowTapback: false });
      if (got) return got;
    } catch {
      // fall through to the local rules
    }
  }
  if (event.text.includes("?")) return null;
  const t = flat(event.text);
  return YES_WORDS.test(t) ? "yes" : NO_WORDS.test(t) ? "no" : null;
}

/** The text of one of Troy's own bubbles in this person's chat. */
function bubbleText(db: DatabaseSync, userId: number, messageId: string): string | null {
  const row = db.prepare("SELECT text FROM messages WHERE providerMessageId = ? AND userId = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(messageId, userId) as { text: string | null } | undefined;
  return row?.text ?? null;
}

/** The open job whose ask or summary this bubble is part of (a long bubble may have gone out in pieces). */
function jobForBubble(db: DatabaseSync, userId: number, messageId: string, jobs: Row[]): Row | null {
  const text = bubbleText(db, userId, messageId);
  if (!text || text.length < 12) return null;
  const hit = db
    .prepare("SELECT reportId FROM staff_log WHERE toUserId = ? AND example = 0 AND kind IN ('ask','summary') AND instr(COALESCE(sentText, text), ?) > 0 ORDER BY id DESC LIMIT 1")
    .get(userId, text) as { reportId: number } | undefined;
  return hit ? (jobs.find((j) => j.reportId === hit.reportId) ?? null) : null;
}

// ---------- acting on a staff answer ----------

interface StaffIo {
  db: DatabaseSync;
  adapter: MessagingAdapter | null;
  tell: Tell;
}

/** Texts the reporter and every follower one status line. Returns how many it reached (or queued for). */
async function tellStudents(io: StaffIo, report: Report, lineFor: (userId: number) => string, photo?: string | null): Promise<number> {
  let reached = 0;
  for (const userId of new Set([report.userId, ...report.followers])) {
    try {
      if ((await io.tell(userId, [`${reportReference(report)}: ${lineFor(userId)}`])) === false) continue;
      reached++;
      const u = photo ? getUserById(io.db, userId) : null;
      // The technician's photo of the fix follows the text, never on its own and never into quiet hours.
      if (u && photo && io.adapter && canAlert(u)) await io.adapter.sendImage(u.chatId, photo).catch(() => null);
    } catch {
      // one failed text never blocks the others or the saved status
    }
  }
  return reached;
}

const told = (n: number): string => (n === 1 ? "1 person" : `${n} people`);

async function acceptRepair(io: StaffIo, me: User, job: Row, report: Report): Promise<string[]> {
  if (job.state === "accepted") return [pickVariant(io.db, me.id, "staff.already", ["u already got that one", "that one's already urs", "already marked as urs"])];
  io.db.prepare("UPDATE staff_jobs SET state = 'accepted' WHERE id = ?").run(job.id as number);
  if (report.status === "received") io.db.prepare("UPDATE reports SET status = 'in_progress' WHERE id = ?").run(report.id);
  const office = officeWord(reportRole(report));
  const n = await tellStudents(io, report, (uid) => pickVariant(io.db, uid, "staff.onIt", [`${office} is on it 🔧`, `someone from ${office} is on it 🔧`, `${office} picked it up 🔧`]));
  log(io.db, report.id, { toUserId: me.id, kind: "action", text: `said on it. status set to in progress, ${told(n)} texted` });
  return [
    pickVariant(io.db, me.id, "staff.accepted", [
      `bet, marked it in progress and told them. text "done" when it's fixed`,
      `got it, it's urs and they know. text "done" once it's fixed`,
      `marked in progress, and i let them know. text "done" when ur finished`,
    ]),
  ];
}

async function finishRepair(io: StaffIo, me: User, job: Row, report: Report, photo: string | null): Promise<string[]> {
  io.db.prepare("UPDATE staff_jobs SET state = 'done' WHERE id = ?").run(job.id as number);
  if (report.status !== "closed") io.db.prepare("UPDATE reports SET status = 'fixed' WHERE id = ?").run(report.id);
  const office = officeWord(reportRole(report));
  const n = await tellStudents(io, report, (uid) => pickVariant(io.db, uid, "staff.fixed", ["fixed ✅", "it's fixed ✅", `${office} says it's fixed ✅`]), photo);
  log(io.db, report.id, { toUserId: me.id, kind: "action", text: `said done${photo ? " with a photo" : ""}. status set to fixed, ${told(n)} texted`, photoUrl: photo });
  return [pickVariant(io.db, me.id, "staff.finished", ["nice, marked it fixed and let them know", "marked fixed, and they know. thanks", "it's marked fixed and i told them. appreciate u"])];
}

async function declineRepair(io: StaffIo, me: User, job: Row, report: Report): Promise<string[]> {
  io.db.prepare("UPDATE staff_jobs SET state = 'declined' WHERE id = ?").run(job.id as number);
  if (job.state === "accepted" && report.status === "in_progress") io.db.prepare("UPDATE reports SET status = 'received' WHERE id = ?").run(report.id);
  log(io.db, report.id, { toUserId: me.id, kind: "action", text: "handed it back. it's waiting on the dashboard" });
  return [pickVariant(io.db, me.id, "staff.handedBack", ["no worries, it's back on the dashboard for someone else", "all good, i handed it back", "ok, it's back in the queue for someone else"])];
}

const USG_STATUS: Record<"on_agenda" | "acted_on" | "closed", { said: string; variants: string[] }> = {
  on_agenda: { said: "on the agenda", variants: ["it's on the agenda", "usg put it on the agenda", "it's on the agenda now"] },
  acted_on: { said: "acted on", variants: ["usg acted on it ✅", "acted on ✅", "usg took action on it ✅"] },
  closed: { said: "closed", variants: ["usg closed it", "it's closed now", "usg closed it out"] },
};

async function usgStatus(io: StaffIo, me: User, job: Row, report: Report, status: keyof typeof USG_STATUS): Promise<string[]> {
  if (report.status === status) return [pickVariant(io.db, me.id, "staff.sameStatus", ["it's already marked that way", "that's what it's marked as already", "already got it down as that"])];
  io.db.prepare("UPDATE reports SET status = ? WHERE id = ?").run(status, report.id);
  if (status !== "on_agenda") io.db.prepare("UPDATE staff_jobs SET state = 'done' WHERE id = ?").run(job.id as number);
  const copy = USG_STATUS[status];
  const n = await tellStudents(io, report, (uid) => pickVariant(io.db, uid, `staff.usg.${status}`, copy.variants));
  log(io.db, report.id, { toUserId: me.id, kind: "action", text: `said ${copy.said}. status updated, ${told(n)} texted` });
  return [
    pickVariant(io.db, me.id, "staff.statusSaved", [
      `marked it ${copy.said} and let ${told(n)} know`,
      `got it, it's ${copy.said} now. ${told(n)} got the update`,
      `it's down as ${copy.said}, and i told ${told(n)}`,
    ]),
  ];
}

function memberLabel(db: DatabaseSync, report: Report): { label: string | null; committee: string } {
  const contact = staffFor(db, reportRole(report));
  return { label: contact?.label ?? null, committee: (report.routedTo ?? "usg").toLowerCase() };
}

/** Who the group chat (or relay) would put them with, by role. Committee names are the directory's own. */
function introLine(db: DatabaseSync, report: Report): string {
  const { label, committee } = memberLabel(db, report);
  return label ? `meet ${label} from the ${committee}` : `meet ur contact from the ${committee}`;
}

/** The member said yes: every student who shared their name is asked, with the warning, whether they want in. */
async function askStudents(io: StaffIo, me: User, job: Row, report: Report): Promise<string[]> {
  const { db } = io;
  const { committee } = memberLabel(db, report);
  const what = short(report.description ?? "ur concern", 70);
  let asked = 0;
  for (const userId of namedPeople(db, report)) {
    if (userId === me.id) continue;
    const u = getUserById(db, userId);
    recordPerson(db, report.id, userId, true);
    // Contact rules win: someone who doesn't share contact info, or left, is never asked and never added.
    if (!u || u.stopped || u.contactMode !== "direct" || !u.groupChatsAllowed) {
      db.prepare("UPDATE report_people SET talk = 'no' WHERE reportId = ? AND userId = ?").run(report.id, userId);
      continue;
    }
    const bubbles = [
      pickVariant(db, userId, "staff.talkLead", [
        `someone from the ${committee} saw ur concern ("${what}") and wants to talk it through. i can put u in a group chat with them`,
        `the ${committee} picked up ur concern ("${what}") and wants to hear more. i can add u to a group chat with them`,
        `ur concern ("${what}") got someone's attention at the ${committee}. they'd like to talk, and i can start a group chat`,
      ]),
      pickVariant(db, userId, "staff.talkExample", [
        "(for the hackathon that's a stand-in, not a real usg member yet)",
        "(they're a stand-in for the hackathon. no real usg members are on here yet)",
        "(note: the person on the usg side is an example for the hackathon)",
      ]),
      CONTACT_WARNING,
    ];
    const step = { flow: "usg" as const, step: TALK_STEP, data: { reportId: report.id } };
    if (isBusy(db, userId)) {
      parkAsk(db, userId, step, bubbles);
    } else {
      let ok: boolean | void = false;
      try {
        ok = await io.tell(userId, bubbles);
      } catch {
        ok = false;
      }
      // A question that never went out is not open: nobody can say yes to a warning they didn't see.
      if (ok === false) {
        db.prepare("UPDATE report_people SET talk = 'no' WHERE reportId = ? AND userId = ?").run(report.id, userId);
        continue;
      }
      setFlowState(db, userId, step);
    }
    db.prepare("UPDATE report_people SET talk = 'asked' WHERE reportId = ? AND userId = ?").run(report.id, userId);
    asked++;
  }
  if (!asked) {
    db.prepare("UPDATE staff_jobs SET talk = 'none' WHERE id = ?").run(job.id as number);
    log(db, report.id, { toUserId: me.id, kind: "action", text: "said yes to a group chat. nobody could be asked right now" });
    return [pickVariant(db, me.id, "staff.nobodyToAsk", ["i can't reach any of them for a group chat rn. i'll text u if that changes", "none of them can be added to a group chat rn. i'll let u know if that changes", "nobody's reachable for a group chat rn, sorry. i'll text u if it changes"])];
  }
  db.prepare("UPDATE staff_jobs SET talk = 'asked', talkAt = ? WHERE id = ?").run(Date.now(), job.id as number);
  log(db, report.id, { toUserId: me.id, kind: "action", text: `said yes to a group chat. ${told(asked)} asked to join` });
  return [
    pickVariant(db, me.id, "staff.asking", [
      `bet, asking ${asked === 1 ? "them" : `all ${asked}`} now. the group chat shares ur number with them too, so text "cancel" if that's not ok`,
      `on it, i'm checking with ${asked === 1 ? "them" : `the ${asked} of them`}. heads up, a group chat shows them ur number too. text "cancel" if u'd rather not`,
      `asking ${asked === 1 ? "them" : `${asked} of them`} now. they'd see ur number in the group chat, so text "cancel" if that's a problem`,
    ]),
  ];
}

/** Takes the consent question away from anyone who hasn't answered it. */
function clearTalkAsks(db: DatabaseSync, reportId: number): void {
  const waiting = db.prepare("SELECT userId FROM report_people WHERE reportId = ? AND talk = 'asked'").all(reportId) as { userId: number }[];
  for (const w of waiting) {
    const cur = getFlowState(db, w.userId);
    if (cur?.flow === "usg" && cur.step === TALK_STEP && cur.data.reportId === reportId) setFlowState(db, w.userId, null);
    dropPending(db, w.userId, (s) => s.flow === "usg" && s.step === TALK_STEP && s.data.reportId === reportId);
  }
  db.prepare("UPDATE report_people SET talk = 'no' WHERE reportId = ? AND talk = 'asked'").run(reportId);
}

/**
 * Makes the group chat with the member and the students who said yes, once everyone asked has answered (or the
 * wait ran out). Only people who said yes, and who still allow it at this moment, are ever added. When a group
 * chat can't be made, the first student who agreed is connected through relay mode instead.
 */
async function finishTalk(io: StaffIo, reportId: number, force: boolean): Promise<void> {
  const { db } = io;
  const report = getReport(db, reportId);
  const job = report ? (db.prepare("SELECT * FROM staff_jobs WHERE reportId = ? AND talk = 'asked' ORDER BY id DESC LIMIT 1").get(reportId) as Row | undefined) : undefined;
  if (!report || !job) return;
  const people = db.prepare("SELECT userId, talk FROM report_people WHERE reportId = ? AND named = 1").all(reportId) as { userId: number; talk: string | null }[];
  if (!force && people.some((p) => p.talk === "asked")) return;
  clearTalkAsks(db, reportId);
  const member = getUserById(db, job.userId as number);
  const agreed = people
    .filter((p) => p.talk === "yes")
    .map((p) => getUserById(db, p.userId))
    .filter((u): u is User => !!u && !u.stopped && u.contactMode === "direct" && u.groupChatsAllowed);
  if (!member || member.stopped) {
    db.prepare("UPDATE staff_jobs SET talk = 'none' WHERE id = ?").run(job.id as number);
    return;
  }
  if (!agreed.length) {
    db.prepare("UPDATE staff_jobs SET talk = 'none' WHERE id = ?").run(job.id as number);
    log(db, reportId, { toUserId: member.id, kind: "action", text: "nobody said yes to the group chat" });
    await io.tell(member.id, [pickVariant(db, member.id, "staff.nobodyIn", ["nobody's up for a group chat on that one rn. i'll text u if that changes", "none of them wanted a group chat this time. i'll let u know if that changes", "no takers for the group chat rn. i'll text u if someone changes their mind"])]);
    return;
  }
  const intro = introLine(db, report);
  const first = `${intro}. they're looking at the concern u raised, so take it from here. i'll step back now`;
  let chatId: string | null = null;
  if (io.adapter?.capabilities().groupChats) chatId = await io.adapter.createGroupChat([member.handle, ...agreed.map((u) => u.handle)], first).catch(() => null);
  if (chatId) {
    db.prepare("UPDATE staff_jobs SET talk = 'made' WHERE id = ?").run(job.id as number);
    db.prepare("UPDATE report_people SET talk = 'in' WHERE reportId = ? AND talk = 'yes'").run(reportId);
    log(db, reportId, { toUserId: member.id, kind: "action", text: `group chat started with ${told(agreed.length)} who said yes` });
    return;
  }
  // No group chats here: one student is connected through Troy, numbers stay private.
  const [one, ...rest] = agreed;
  startRelay(db, member.id, one!.id, `usg:${reportId}`, { a: "usg", b: "the student" });
  db.prepare("UPDATE staff_jobs SET talk = 'relay' WHERE id = ?").run(job.id as number);
  db.prepare("UPDATE report_people SET talk = 'in' WHERE reportId = ? AND userId = ?").run(reportId, one!.id);
  log(db, reportId, { toUserId: member.id, kind: "action", text: `couldn't make a group chat, so 1 student is connected through troy${rest.length ? ` (${told(rest.length)} more said yes)` : ""}` });
  await io.tell(one!.id, [pickVariant(db, one!.id, "staff.relayStudent", [`couldn't make the group chat, so ${intro} right here instead`, `the group chat didn't work, so ${intro} through me instead`, `no group chat rn, so ${intro} right here`]), ...RELAY_COPY.start]);
  await io.tell(member.id, [
    pickVariant(db, member.id, "staff.relayMember", [
      `couldn't make a group chat here, so i connected u with ${rest.length ? "one of them" : "them"} through me`,
      `group chats aren't working rn, so u and ${rest.length ? "one of them" : "the student"} can talk through me`,
      `no group chat rn. i put u through to ${rest.length ? "one of them" : "them"} right here instead`,
    ]),
    ...RELAY_COPY.start,
  ]);
  for (const u of rest) await io.tell(u.id, [pickVariant(db, u.id, "staff.relayOthers", ["couldn't make the group chat rn, sorry. i'll text u when they pick ur concern up", "the group chat didn't work this time. i'll text u when ur concern moves", "no group chat rn, sorry. i'll let u know when they pick it up"])]);
}

// ---------- the chat brain, for anything that isn't a plain answer ----------

export type StepReply = (ctx: FlowContext, step: { flow: string; waitingFor: string; canDo: { name: string; when: string }[]; facts?: Record<string, string> }) => Promise<{ bubbles: string[]; action: string | null }>;
let brainStep: StepReply | null | undefined;

/** Tests pass their own (or null for none). Undefined goes back to looking for replyAtStep in src/brain.ts. */
export function setStaffBrain(fn: StepReply | null | undefined): void {
  brainStep = fn;
}

async function stepReply(): Promise<StepReply | null> {
  if (brainStep === undefined) {
    try {
      const path = "./brain.ts"; // a variable on purpose: replyAtStep is another builder's and may not be there yet
      const mod = (await import(path)) as { replyAtStep?: StepReply };
      brainStep = typeof mod.replyAtStep === "function" ? mod.replyAtStep : null;
    } catch {
      brainStep = null;
    }
  }
  return brainStep;
}

// ---------- one turn ----------

const TALK_FRESH_MS = 24 * 60 * 60 * 1000;

async function talkAnswer(ctx: FlowContext, data: Record<string, unknown>): Promise<boolean> {
  const { db, user, event } = ctx;
  const reportId = typeof data.reportId === "number" ? data.reportId : -1;
  const person = db.prepare("SELECT talk FROM report_people WHERE reportId = ? AND userId = ?").get(reportId, user.id) as { talk: string | null } | undefined;
  const job = db.prepare("SELECT * FROM staff_jobs WHERE reportId = ? AND talk = 'asked' LIMIT 1").get(reportId) as Row | undefined;
  const open = !!job && person?.talk === "asked" && Date.now() - ((job.talkAt as number) ?? 0) < TALK_FRESH_MS;
  if (!open) {
    // Settled without them (it timed out, or the member called it off). Their message is handled as a new one.
    setFlowState(db, user.id, null);
    return !!(event.reaction || event.pollVote);
  }
  let answer: "yes" | "no" | null = null;
  if (event.pollVote) return true;
  if (event.reaction) {
    // Only on the warning bubble itself, and only the newest one.
    const target = bubbleText(db, user.id, event.reaction.targetMessageId);
    const newest = db.prepare("SELECT providerMessageId FROM messages WHERE userId = ? AND direction = 'out' AND text = ? ORDER BY id DESC LIMIT 1").get(user.id, CONTACT_WARNING) as { providerMessageId: string | null } | undefined;
    if (event.reaction.removed || target !== CONTACT_WARNING || newest?.providerMessageId !== event.reaction.targetMessageId) return true;
    answer = event.reaction.type === "love" || event.reaction.type === "like" ? "yes" : event.reaction.type === "dislike" ? "no" : null;
    if (!answer) return true;
  } else {
    answer = /^\s*(?:nvm|never ?mind|cancel|no thanks|no thx)\b/i.test(event.text) ? "no" : await yesNo(event);
  }
  if (!answer) {
    // A question about it gets a real answer and the question stays open. Anything else goes where it belongs.
    if (/\?|^(?:who|what|why|how|which|is|are|will|would|does|do|can)\b/i.test(event.text.trim())) {
      const report = getReport(db, reportId);
      const reply = await stepReply();
      if (reply && report) {
        const out = await reply(ctx, {
          flow: "usg",
          waitingFor: "a yes or no: do they want to join a group chat with the usg member about their concern. joining shares their contact info with that person",
          canDo: [{ name: "join", when: "they clearly say yes" }, { name: "decline", when: "they clearly say no" }],
          facts: { committee: (report.routedTo ?? "usg").toLowerCase(), note: "the usg member is a stand-in for the hackathon, not a real member yet" },
        });
        if (out.bubbles.length) await ctx.say(...out.bubbles);
        if (out.action === "join") answer = "yes";
        else if (out.action === "decline") answer = "no";
        else return true;
      } else {
        await ctx.say(
          pickVariant(db, user.id, "staff.talkExplain", [
            "it'd be u, anyone else who said yes, and the person looking at ur concern on the usg side. everyone in it can see each other's number. want in?",
            "a group chat with the person on the usg side who picked up ur concern. they'd see ur number and u'd see theirs. u in?",
            "it's a group chat with whoever's handling ur concern at usg. numbers are visible to everyone in it. want me to add u?",
          ]),
        );
        return true;
      }
    } else {
      // Not about this. The pipeline hands it to the flow it belongs to; the question stays open.
      return ctx.intent.flow !== "usg";
    }
  }
  db.prepare("UPDATE report_people SET talk = ? WHERE reportId = ? AND userId = ?").run(answer, reportId, user.id);
  setFlowState(db, user.id, null);
  if (answer === "yes") await ctx.say(pickVariant(db, user.id, "staff.talkYes", ["bet, i'll add u as soon as it's set up", "ok, ur in. i'll add u when it starts", "got u, adding u once it's ready"]));
  else await ctx.say(pickVariant(db, user.id, "staff.talkNo", ["all good, i'll keep u out of it. ur concern still counts", "no worries, u stay out of it. the concern's still in", "ok, no group chat for u. ur concern still stands"]));
  await finishTalk({ db, adapter: ctx.adapter, tell: tellerFor(ctx) }, reportId, false);
  restoreStaffPointer(db, user.id);
  return true;
}

/**
 * Called first by the repair and usg handlers. True when this message was a staff contact's answer (or a
 * student's answer about a group chat) and has been dealt with, or should be left for another flow; false when
 * the flow should handle it as an ordinary message.
 */
export async function handleStaffTurn(ctx: FlowContext): Promise<boolean> {
  const { db, user, event } = ctx;
  ensureStaffTables(db);
  const state = ctx.state;
  if (state?.flow === "usg" && state.step === TALK_STEP) return talkAnswer(ctx, state.data);

  const onPointer = state?.step === STAFF_STEP;
  const jobs = openJobs(db, user.id);
  if (!jobs.length) {
    if (onPointer) setFlowState(db, user.id, null);
    return false;
  }
  const io: StaffIo = { db, adapter: ctx.adapter, tell: tellerFor(ctx) };
  const reportOf = (j: Row) => getReport(db, j.reportId as number);
  const repairJobs = jobs.filter((j) => j.kind === "repair");
  const usgJobs = jobs.filter((j) => j.kind === "usg_concern");
  /** A member's summary still waiting on "want a group chat with them?". */
  const chatOpen = (j: Row) => j.kind === "usg_concern" && (j.talk === null || j.talk === undefined) && (j.named as number) > 0;

  let word: Word | null = null;
  let job: Row | null = null;
  if (event.pollVote) return onPointer;
  if (event.reaction) {
    job = event.reaction.removed ? null : jobForBubble(db, user.id, event.reaction.targetMessageId, jobs);
    word = event.reaction.type === "love" || event.reaction.type === "like" ? "yes" : event.reaction.type === "dislike" ? "no" : null;
    // A tapback only answers the bubble it is on, and only while that bubble still asks something.
    if (!job || !word || !(job.kind === "repair" ? job.state === "asked" : chatOpen(job))) return onPointer;
  } else {
    // Mid something else (a repair report of their own, a question from another flow): that step keeps the message.
    if (state && !onPointer) return false;
    word = readStaffWord(event.text);
    if (word === "accept") job = repairJobs.find((j) => j.state === "asked") ?? repairJobs[0] ?? null;
    else if (word === "cant") job = repairJobs[0] ?? usgJobs.find(chatOpen) ?? null;
    else if (word === "done") job = repairJobs.find((j) => j.state === "accepted") ?? repairJobs[0] ?? usgJobs[0] ?? null;
    else if (word === "agenda") job = usgJobs[0] ?? null;
    else if (word === "closed") job = usgJobs[0] ?? null;
    else if (word === "cancel") job = usgJobs.find((j) => j.talk === "asked") ?? null;
    else if (word === "yes" || word === "no") job = jobs.find((j) => (j.kind === "repair" ? j.state === "asked" : chatOpen(j))) ?? null;
  }

  if (!word || !job) {
    if (!onPointer) return false;
    // Their own flow's kind of message (a technician reporting something broken): handled as a new report. The
    // router keeps an open step's flow with action "answer" for anything that isn't clearly new, so "answer" alone
    // is not a report: it needs a photo or the keyword rules to agree. Otherwise "wait which floor again" would be
    // filed as a broken thing.
    const sameFlow = ctx.intent.flow === state!.flow;
    let fresh = false;
    if (sameFlow) {
      fresh = ctx.intent.action !== "answer" || event.images.length > 0;
      if (!fresh) {
        try {
          fresh = (await import("./ai.ts")).fallbackIntent({ text: event.text ?? "", hasImage: false, state: null }).flow === state!.flow;
        } catch {
          fresh = false;
        }
      }
    }
    if (sameFlow && fresh) return false;
    // A question or a remark about the job: the chat brain answers it, knowing the job. Without it, free chat does.
    const reply = ctx.intent.flow === "smalltalk" || sameFlow ? await stepReply() : null;
    const latest = jobs[0]!;
    const report = reportOf(latest);
    if (!reply || !report) return true;
    const repairJob = latest.kind === "repair";
    const out = await reply(ctx, {
      flow: repairJob ? "repair" : "usg",
      waitingFor: repairJob ? "the technician's answer on a repair job troy texted them" : "the usg member's answer on a concern summary troy texted them",
      canDo: repairJob
        ? [{ name: "accept", when: "they say they'll take the job" }, { name: "done", when: "they say it's fixed" }, { name: "cant", when: "they can't take it" }]
        : [{ name: "chat", when: "they want the group chat" }, { name: "agenda", when: "they say it's on the agenda" }, { name: "done", when: "they say it was fixed or acted on" }],
      facts: { what: short(report.description ?? report.category ?? "", 90), where: report.locationText ? short(report.locationText, 60) : "not given", status: report.status.replace(/_/g, " ") },
    });
    if (out.bubbles.length) await ctx.say(...out.bubbles);
    const act: Record<string, Word> = { accept: "accept", done: "done", cant: "cant", chat: "yes", agenda: "agenda" };
    word = out.action ? (act[out.action] ?? null) : null;
    if (!word) return true;
    job = latest;
  }

  const report = reportOf(job);
  if (!report) {
    db.prepare("UPDATE staff_jobs SET state = 'done' WHERE id = ?").run(job.id as number);
    return true;
  }
  let bubbles: string[] = [];
  const photo = event.images[0]?.path ?? null;
  if (job.kind === "repair") {
    if (word === "accept" || word === "yes") bubbles = await acceptRepair(io, user, job, report);
    else if (word === "done" || word === "closed") bubbles = await finishRepair(io, user, job, report, photo);
    else if (word === "cant" || word === "no") bubbles = await declineRepair(io, user, job, report);
    else return onPointer;
  } else if (word === "agenda") bubbles = await usgStatus(io, user, job, report, "on_agenda");
  else if (word === "done") bubbles = await usgStatus(io, user, job, report, "acted_on");
  else if (word === "closed") bubbles = await usgStatus(io, user, job, report, "closed");
  else if (word === "yes") bubbles = await askStudents(io, user, job, report);
  else if (word === "no" || word === "cant") {
    db.prepare("UPDATE staff_jobs SET talk = 'declined' WHERE id = ?").run(job.id as number);
    log(db, report.id, { toUserId: user.id, kind: "action", text: "said no to a group chat" });
    bubbles = [pickVariant(db, user.id, "staff.noChat", [`all good, no group chat. u can still text me a status like "on the agenda"`, `no worries, skipping the group chat. a status like "on the agenda" still works anytime`, `ok, no group chat. text me "on the agenda" or "we fixed it" whenever it moves`])];
  } else if (word === "cancel") {
    clearTalkAsks(db, report.id);
    db.prepare("UPDATE staff_jobs SET talk = 'declined' WHERE id = ?").run(job.id as number);
    log(db, report.id, { toUserId: user.id, kind: "action", text: "called the group chat off" });
    bubbles = [pickVariant(db, user.id, "staff.cancelled", ["ok, called it off. nobody gets added", "done, no group chat. ur number stays with me", "cancelled it. nobody's being added"])];
  } else return onPointer;

  if (bubbles.length) await ctx.say(...bubbles);
  // The step stays pointed here while they still hold a job.
  const after = getFlowState(db, user.id);
  if (after?.step === STAFF_STEP && !openJobs(db, user.id).length) setFlowState(db, user.id, null);
  else restoreStaffPointer(db, user.id);
  return true;
}

// ---------- hooks: protected steps, timers, people leaving ----------

for (const flow of ["repair", "usg"] as const) {
  registerPendingHooks(flow, {
    // Other flows park these steps instead of clearing them. The pointer never makes anyone wait; the consent question does.
    protects: (_db, s) => s.step === STAFF_STEP || s.step === TALK_STEP,
    blocks: (_db, s) => s.step === TALK_STEP,
    valid: (db, s) => {
      if (s.step !== TALK_STEP) return true;
      ensureStaffTables(db);
      return !!db.prepare("SELECT 1 FROM staff_jobs WHERE reportId = ? AND talk = 'asked' LIMIT 1").get(typeof s.data.reportId === "number" ? s.data.reportId : -1);
    },
    reprompt: () => [],
  });
}

onSweep("staff", async (io, now) => {
  const { db } = io;
  ensureStaffTables(db);
  // Quiet hours and pause are honored here too: the outbox when the server set one, else skip until they end.
  const tell: Tell =
    notifiers.get(db) ??
    (async (userId, bubbles) => {
      const u = getUserById(db, userId);
      if (!u || !canAlert(u)) return false;
      return (await io.sayTo(userId, ...bubbles)).some((id) => id !== null);
    });
  for (const n of db.prepare("SELECT reportId FROM staff_notices WHERE dueAt <= ? ORDER BY dueAt").all(now) as { reportId: number }[]) {
    await notifyStaffOfReport({ db, notify: tell }, n.reportId);
  }
  for (const j of db.prepare("SELECT reportId FROM staff_jobs WHERE talk = 'asked' AND talkAt <= ?").all(now - TALK_WAIT_MS) as { reportId: number }[]) {
    await finishTalk({ db, adapter: io.adapter, tell }, j.reportId, true);
  }
});

onUserGone("staff", async (io, userId) => {
  ensureStaffTables(io.db);
  // A staff contact who left hands everything back; a student who left is out of every group chat question.
  releaseJobsOf(io.db, userId);
  io.db.prepare("UPDATE report_people SET talk = 'no', named = 0 WHERE userId = ?").run(userId);
});
