// Questions that have to wait their turn, and the hooks flows use to protect an open question.
//
// flow_state holds one open step per user. A flow that needs an answer from someone who is in the middle
// of something else (a finder answering about another item, a poster drafting a food post) must not replace
// that step: the person's next "yes" would land on the wrong question. Such a question is parked here and
// delivered, bubbles and state together, once the person is free. A protected step that another flow
// displaces is parked the same way and asked again afterwards.
//
// Only ids and the fixed question bubbles are stored. Rows go away on delivery, on STOP and on "delete my data".

import type { DatabaseSync } from "node:sqlite";
import type { Bubble, FlowName, FlowState, IncomingEvent, MessagingAdapter, User } from "./types.ts";
import { getFlowState, getUserById, setFlowState } from "./db/index.ts";

/** A step from another flow that was touched this recently still owns the conversation. */
export const BUSY_MS = 10 * 60 * 1000;

type OpenState = Omit<FlowState, "updatedAt">;

export interface PendingHooks {
  /** True when this open step is a question that must survive other flows (never cleared or replaced silently). */
  protects?(db: DatabaseSync, state: OpenState): boolean;
  /** True when a new question for this person has to wait behind this step. Defaults to `protects`. */
  blocks?(db: DatabaseSync, state: OpenState): boolean;
  /** False when a parked step no longer makes sense (the thing it asks about moved on). It is dropped then. */
  valid?(db: DatabaseSync, state: OpenState): boolean;
  /** The bubbles that put a displaced step back in front of the person. Empty means restore it silently. */
  reprompt?(db: DatabaseSync, state: OpenState): string[];
  /** While the user is in relay mode: true when this text answers the flow's own open question, so it is not relayed. */
  keepsFromRelay?(db: DatabaseSync, user: User, state: FlowState | null, event: IncomingEvent, relayContext: string): boolean;
}

const hooks = new Map<FlowName, PendingHooks>();

export function registerPendingHooks(flow: FlowName, h: PendingHooks): void {
  hooks.set(flow, { ...hooks.get(flow), ...h });
}

export function isProtected(db: DatabaseSync, state: OpenState | null): boolean {
  if (!state) return false;
  try {
    return !!hooks.get(state.flow)?.protects?.(db, state);
  } catch {
    return false;
  }
}

/** The flow that should get this text instead of the relay, or null to relay it. */
export function relayBypass(db: DatabaseSync, user: User, state: FlowState | null, event: IncomingEvent, relayContext: string): FlowName | null {
  for (const [flow, h] of hooks) {
    try {
      if (h.keepsFromRelay?.(db, user, state, event, relayContext)) return flow;
    } catch {
      // A broken hook never blocks the relay.
    }
  }
  return null;
}

/** Someone who is busy keeps their open step; a question for them waits. */
export function isBusy(db: DatabaseSync, userId: number, now = Date.now()): boolean {
  const cur = getFlowState(db, userId);
  if (!cur) return false;
  const h = hooks.get(cur.flow);
  try {
    if (h?.blocks ? h.blocks(db, cur) : !!h?.protects?.(db, cur)) return true;
    // A protected step that doesn't block (waiting for a pickup) steps aside for a question.
    if (h?.protects?.(db, cur)) return false;
  } catch {
    // A broken hook counts as not protected.
  }
  return now - cur.updatedAt < BUSY_MS;
}

// ---------- the queue ----------

const prepared = new WeakSet<DatabaseSync>();

function ensure(db: DatabaseSync): void {
  if (prepared.has(db)) return;
  db.exec(
    "CREATE TABLE IF NOT EXISTS pending_asks (id INTEGER PRIMARY KEY, userId INTEGER NOT NULL, flow TEXT NOT NULL, step TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}', bubbles TEXT NOT NULL DEFAULT '[]', createdAt INTEGER NOT NULL);" +
      "CREATE INDEX IF NOT EXISTS pending_asks_user ON pending_asks(userId, id);",
  );
  prepared.add(db);
}

interface PendingRow {
  id: number;
  userId: number;
  flow: FlowName;
  step: string;
  data: Record<string, unknown>;
  bubbles: string[];
}

function rows(db: DatabaseSync, userId?: number): PendingRow[] {
  ensure(db);
  const raw = (userId === undefined ? db.prepare("SELECT * FROM pending_asks ORDER BY id").all() : db.prepare("SELECT * FROM pending_asks WHERE userId = ? ORDER BY id").all(userId)) as Record<string, unknown>[];
  return raw.map((r) => {
    let data: Record<string, unknown> = {};
    let bubbles: string[] = [];
    try {
      data = JSON.parse(String(r.data)) as Record<string, unknown>;
      bubbles = (JSON.parse(String(r.bubbles)) as unknown[]).filter((b): b is string => typeof b === "string");
    } catch {
      // An unreadable row is delivered as an empty step and dropped by the flow's own checks.
    }
    return { id: r.id as number, userId: r.userId as number, flow: r.flow as FlowName, step: String(r.step), data, bubbles };
  });
}

/** Park a step for later. `bubbles` are sent with it on delivery; none means the flow's reprompt is used. */
export function parkAsk(db: DatabaseSync, userId: number, state: OpenState, bubbles: (string | Bubble)[] = []): void {
  ensure(db);
  const texts = bubbles.map((b) => (typeof b === "string" ? b : b.text));
  db.prepare("INSERT INTO pending_asks (userId, flow, step, data, bubbles, createdAt) VALUES (?, ?, ?, ?, ?, ?)").run(userId, state.flow, state.step, JSON.stringify(state.data), JSON.stringify(texts), Date.now());
}

/** Drop parked steps: all of a user's, or only those a flow says belong to something that ended. */
export function dropPending(db: DatabaseSync, userId: number, match?: (state: OpenState) => boolean): void {
  ensure(db);
  for (const r of rows(db, userId)) {
    if (!match || match({ flow: r.flow, step: r.step, data: r.data })) db.prepare("DELETE FROM pending_asks WHERE id = ?").run(r.id);
  }
}

export function pendingFor(db: DatabaseSync, userId: number): OpenState[] {
  return rows(db, userId).map((r) => ({ flow: r.flow, step: r.step, data: r.data }));
}

type Send = (user: User, bubbles: string[]) => Promise<(string | null)[]>;

/**
 * Give every free person their oldest parked step: the bubbles go out and the step becomes their open state,
 * with `qid` set to the id of the last bubble (the question). One step per person per call.
 */
export async function deliverPending(db: DatabaseSync, send: Send, now = Date.now()): Promise<number> {
  ensure(db);
  let delivered = 0;
  const seen = new Set<number>();
  for (const r of rows(db)) {
    if (seen.has(r.userId)) continue;
    const user = getUserById(db, r.userId);
    if (!user || user.stopped) {
      db.prepare("DELETE FROM pending_asks WHERE id = ?").run(r.id);
      continue;
    }
    const state: OpenState = { flow: r.flow, step: r.step, data: r.data };
    const h = hooks.get(r.flow);
    if (h?.valid && !h.valid(db, state)) {
      db.prepare("DELETE FROM pending_asks WHERE id = ?").run(r.id);
      continue;
    }
    seen.add(r.userId);
    if (isBusy(db, r.userId, now)) continue;
    const bubbles = r.bubbles.length ? r.bubbles : (h?.reprompt?.(db, state) ?? []);
    db.prepare("DELETE FROM pending_asks WHERE id = ?").run(r.id);
    const ids = bubbles.length ? await send(user, bubbles) : [];
    // A question that could not be sent is not open: nobody may answer what they never saw.
    if (bubbles.length && !ids.some((id) => id !== null)) continue;
    // A waiting step that was open (not a question) comes back after this one.
    const cur = getFlowState(db, r.userId);
    if (cur && isProtected(db, cur)) parkAsk(db, r.userId, { flow: cur.flow, step: cur.step, data: cur.data });
    const qid = ids.length ? (ids[ids.length - 1] ?? null) : (r.data.qid ?? null);
    setFlowState(db, r.userId, { flow: r.flow, step: r.step, data: { ...r.data, qid } });
    delivered++;
  }
  return delivered;
}

// ---------- sweeps and people leaving ----------

/** What a flow gets when it runs outside a conversation (a timer, or right after someone texts STOP). */
export interface SweepIo {
  db: DatabaseSync;
  /** Send to a person's own 1:1 chat as part of an exchange they are in. Never to a stopped user. */
  sayTo(userId: number, ...bubbles: (string | Bubble)[]): Promise<(string | null)[]>;
  adapter: MessagingAdapter;
}

type Sweep = (io: SweepIo, now: number) => Promise<void>;
type Gone = (io: SweepIo, userId: number) => Promise<void>;
const sweeps = new Map<string, Sweep>();
const goners = new Map<string, Gone>();

/** Run on a timer by the server (and by tests). Keyed so a module that loads twice registers once. */
export function onSweep(key: string, fn: Sweep): void {
  sweeps.set(key, fn);
}

/** Run when a person texts STOP or "delete my data", so nothing they were holding stays locked. */
export function onUserGone(key: string, fn: Gone): void {
  goners.set(key, fn);
}

export async function runSweeps(io: SweepIo, now = Date.now()): Promise<void> {
  for (const fn of sweeps.values()) await fn(io, now);
}

export async function runUserGone(io: SweepIo, userId: number): Promise<void> {
  dropPending(io.db, userId);
  for (const fn of goners.values()) await fn(io, userId);
}
