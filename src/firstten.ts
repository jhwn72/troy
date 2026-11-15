// The first ten minutes after onboarding (John, "The first ten minutes" and "First ten minutes, additions").
//
// Troy carries six moves and plays them one at a time, never as a menu:
//   1. right when onboarding ends: the "what else" line, then the "near u" bubbles
//   2. the try-it tour (src/flows/tour.ts)
//   3. stump me
//   4. the one question ("what's one thing u wish was easier at usc?")
//   5. set up something for later ("where do u usually study?"), asked the first time a walking time is missing
//   6. one follow-up on his own, tied to what they did
//
// WHEN THINGS FIRE (all times are from the moment onboarding ended unless it says otherwise)
//   0 s      the "what else" line and the "near u" bubbles, in the same turn as the end of onboarding
//   0 s      judges only: the "try me" poll, right after those bubbles
//   30 s     nobody has texted since: the "try me" poll (three options, one tap starts that move)
//   2 min    after their last text, when they have chatted but started nothing: the one question
//   7 min    when they did one of the moves: one follow-up tied to it
//   10 min   nothing new is started after this. 60 min: the plan is over.
// Never more than ONE of those unprompted messages per person in the first hour: once one went out, the rest are off.
// A real request (lost, found, food, repair, usg, a topic, a setting), pause and STOP end all of it. No move is
// offered to the same person twice. Paused people and people in quiet hours get nothing unprompted.
//
// State lives in the first_ten table, so a restart loses nothing: the sweep the server already runs every 30 seconds
// (pipeline.sweep) picks up whatever is due. In-process timers only make the 30 second and 2 minute marks land on time.
//
// Code owns the facts here (which drops are real, counts, walking times, what was an example). The wording comes from
// the chat brain (sayInHisWords) and, when the model is down, from the variant pools below.

import type { DatabaseSync } from "node:sqlite";
import type { Bubble, FlowContext, FlowName, FlowState, IncomingEvent, Intent, User } from "./types.ts";
import { getFlowState, getUserById, saveMessage, setFlowState } from "./db/index.ts";
import * as brainMod from "./brain.ts";
import { pickVariant } from "./voice.ts";
import type { SweepIo } from "./pending.ts";
import { isBusy, onUserGone } from "./pending.ts";
import { distanceMeters, getUserLocation } from "./location.ts";
import { walkingMinutes } from "./places.ts";
import { canAlert } from "./quiet.ts";
import { readYesNo } from "./yes.ts";
import { subscriptionKeys } from "./topics.ts";

const TOUR = "tour" as FlowName;
const SEC = 1000;
const MIN = 60 * SEC;

/** The exact trigger times. Tests and the final report read these. */
export const FIRST_TEN = {
  /** Silence after the "near u" bubbles before the "try me" poll. */
  pollAfterMs: 30 * SEC,
  /** Quiet after their last text (having started nothing) before the one question. */
  questionAfterMs: 2 * MIN,
  /** After onboarding ended, for someone who did a move: the one follow-up (John: six to eight minutes in). */
  followUpAfterMs: 7 * MIN,
  /** An unprompted message never goes out while they texted this recently. */
  settleMs: 45 * SEC,
  /** Nothing unprompted is started later than this. */
  planMs: 10 * MIN,
  /** At most one unprompted message inside this window. Offers made in it stay answerable until it ends. */
  windowMs: 60 * MIN,
  /** How long "stump me" and the one question wait for their answer. */
  answerMs: 15 * MIN,
  /** Lost reports this close count as "near u". */
  nearMeters: 1200,
  /** The example numbers used when nothing real is nearby. Never labelled until the student asks for more. */
  exampleWalk: "8 min",
  exampleLost: 3,
} as const;

export const TRY_ME_OPTIONS = ["pretend i lost something", "show me free food near me", "stump me"] as const;

export type Move = "what_else" | "near" | "poll" | "tour_lost" | "tour_food" | "tour_repair" | "tour_offer" | "stump" | "question" | "study_spot" | "follow_up";

type Deps = { now: () => number; timers: boolean };
const deps: Deps = { now: () => Date.now(), timers: true };

/** Tests: a fake clock, and `timers: false` so only explicit sweeps send anything. Pass null to restore. */
export function setFirstTenDeps(over: Partial<Deps> | null): void {
  if (!over) {
    deps.now = () => Date.now();
    deps.timers = true;
  } else Object.assign(deps, over);
}

// ---------- the table ----------

type PollRef = { pollId: string | null; optionIds: (string | null)[]; mode: "native" | "tap" | "numbered"; at: number };
type Near = {
  food: "real" | "example" | null;
  lost: "real" | "example" | null;
  lostCount: number;
  /** Bubble ids, so a thumbs up on "want the spot?" counts as a yes. */
  foodIds: string[];
  lostIds: string[];
  /** The offer is still waiting for a yes, a no or a question. */
  open: boolean;
  at: number;
};

interface Row {
  userId: number;
  startedAt: number;
  lastInAt: number | null;
  moves: Move[];
  did: Move | null;
  unpromptedAt: number | null;
  endedAt: number | null;
  judge: boolean;
  near: Near | null;
  poll: PollRef | null;
  stumpUntil: number | null;
  questionAt: number | null;
}

const prepared = new WeakSet<DatabaseSync>();

function ensure(db: DatabaseSync): void {
  if (prepared.has(db)) return;
  db.exec(
    "CREATE TABLE IF NOT EXISTS first_ten (userId INTEGER PRIMARY KEY, startedAt INTEGER NOT NULL, lastInAt INTEGER, moves TEXT NOT NULL DEFAULT '[]', did TEXT, " +
      "unpromptedAt INTEGER, endedAt INTEGER, judge INTEGER NOT NULL DEFAULT 0, near TEXT, poll TEXT, stumpUntil INTEGER, questionAt INTEGER)",
  );
  prepared.add(db);
}

function parse<T>(raw: unknown): T | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function toRow(r: Record<string, unknown>): Row {
  return {
    userId: r.userId as number,
    startedAt: r.startedAt as number,
    lastInAt: (r.lastInAt as number | null) ?? null,
    moves: parse<Move[]>(r.moves) ?? [],
    did: ((r.did as string | null) ?? null) as Move | null,
    unpromptedAt: (r.unpromptedAt as number | null) ?? null,
    endedAt: (r.endedAt as number | null) ?? null,
    judge: !!r.judge,
    near: parse<Near>(r.near),
    poll: parse<PollRef>(r.poll),
    stumpUntil: (r.stumpUntil as number | null) ?? null,
    questionAt: (r.questionAt as number | null) ?? null,
  };
}

function load(db: DatabaseSync, userId: number): Row | null {
  ensure(db);
  const r = db.prepare("SELECT * FROM first_ten WHERE userId = ?").get(userId) as Record<string, unknown> | undefined;
  return r ? toRow(r) : null;
}

function patch(db: DatabaseSync, userId: number, fields: Partial<Record<keyof Row, unknown>>): void {
  ensure(db);
  const keys = Object.keys(fields) as (keyof Row)[];
  if (!keys.length) return;
  const value = (k: keyof Row): string | number | null => {
    const v = fields[k];
    if (v === null || v === undefined) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "object") return JSON.stringify(v);
    return v as string | number;
  };
  db.prepare(`UPDATE first_ten SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE userId = ?`).run(...keys.map(value), userId);
}

/** The first hour after onboarding, whether or not unprompted messages are still on. */
function inWindow(row: Row | null, now: number): row is Row {
  return !!row && row.startedAt > 0 && now - row.startedAt < FIRST_TEN.windowMs;
}

export function hasMove(db: DatabaseSync, userId: number, move: Move): boolean {
  return !!load(db, userId)?.moves.includes(move);
}

/** A move was played (by Troy or because the student asked for it). It is never offered to them again. */
export function markMove(db: DatabaseSync, userId: number, move: Move, opts: { did?: boolean } = {}): void {
  ensure(db);
  let row = load(db, userId);
  if (!row) {
    // Someone who onboarded before this existed: a row that is already over, only there to remember moves.
    db.prepare("INSERT OR IGNORE INTO first_ten (userId, startedAt, endedAt) VALUES (?, 0, 0)").run(userId);
    row = load(db, userId);
    if (!row) return;
  }
  const moves = row.moves.includes(move) ? row.moves : [...row.moves, move];
  patch(db, userId, opts.did ? { moves, did: move } : { moves });
  // The chat brain keeps its own once-per-person list for the moves it can make in free chat. Keep the two in step.
  const theirs = BRAIN_MOVE[move];
  const mark = (brainMod as Record<string, unknown>).markMove;
  if (theirs && typeof mark === "function") {
    try {
      (mark as (d: DatabaseSync, u: number, m: string, now?: number) => void)(db, userId, theirs, deps.now());
    } catch {
      // Best effort.
    }
  }
}

const BRAIN_MOVE: Partial<Record<Move, string>> = { stump: "stump", question: "one_question", tour_offer: "tour", tour_lost: "tour", tour_food: "tour", tour_repair: "tour" };

/** True when the chat brain already made this move in free chat (it dared them to stump him, offered the tour, asked the one question). */
function brainDid(db: DatabaseSync, userId: number, move: Move): boolean {
  const theirs = BRAIN_MOVE[move];
  const used = (brainMod as Record<string, unknown>).moveUsed;
  if (!theirs || typeof used !== "function") return false;
  try {
    return !!(used as (d: DatabaseSync, u: number, m: string) => boolean)(db, userId, theirs);
  } catch {
    return false;
  }
}

/** A real request, pause or STOP: nothing unprompted goes out anymore. What was already offered stays answerable. */
export function cancelFirstTen(db: DatabaseSync, userId: number): void {
  try {
    const row = load(db, userId);
    if (!row || row.endedAt !== null) return;
    patch(db, userId, { endedAt: deps.now(), stumpUntil: null, questionAt: null });
  } catch {
    // Cancelling is best effort and never costs a reply.
  }
}

/** Every text from the student moves the "quiet since" clock. Called by the pipeline. */
export function noteStudentMessage(db: DatabaseSync, userId: number): void {
  try {
    const row = load(db, userId);
    const now = deps.now();
    if (!inWindow(row, now) || row.endedAt !== null) return;
    patch(db, userId, { lastInAt: now });
    if (row.unpromptedAt === null) schedule(db, userId, FIRST_TEN.questionAfterMs + SEC);
  } catch {
    // Same: never worth a reply.
  }
}

onUserGone("firstten", async (io, userId) => cancelFirstTen(io.db, userId));

// ---------- wording ----------

export type Brief = { goal: string; mustCover: string[]; facts?: Record<string, string>; fallback: string[][] };

function rotate(db: DatabaseSync, userId: number, key: string, variants: string[][]): string[] {
  if (!variants.length) return [];
  const i = Number(pickVariant(db, userId, key, variants.map((_, n) => String(n))));
  return variants[Number.isInteger(i) ? i : 0] ?? variants[0]!;
}

/**
 * One to three bubbles in Troy's own words: the chat brain when it is up (src/brain.ts sayInHisWords, which checks
 * that every fact is in there), a rotated line from `fallback` otherwise.
 */
export async function inHisWords(ctx: FlowContext, key: string, brief: Brief): Promise<string[]> {
  const fn = (brainMod as Record<string, unknown>).sayInHisWords;
  if (typeof fn === "function") {
    try {
      const out = (await (fn as (c: FlowContext, b: Brief) => Promise<unknown>)(ctx, brief)) as unknown;
      if (Array.isArray(out) && out.length && out.every((b) => typeof b === "string" && b.trim())) return out as string[];
    } catch {
      // Falls through to the pool.
    }
  }
  return rotate(ctx.db, ctx.user.id, key, brief.fallback);
}

/** A free reply from the chat brain that knows which step is open (src/brain.ts replyAtStep), or null when it isn't there. */
export async function atStep(
  ctx: FlowContext,
  step: { flow: string; waitingFor: string; canDo: { name: string; when: string }[]; facts?: Record<string, string> },
): Promise<{ bubbles: string[]; action: string | null } | null> {
  const fn = (brainMod as Record<string, unknown>).replyAtStep;
  if (typeof fn !== "function") return null;
  try {
    const out = (await (fn as (c: FlowContext, s: typeof step) => Promise<unknown>)(ctx, step)) as { bubbles?: unknown; action?: unknown } | null;
    if (!out || !Array.isArray(out.bubbles)) return null;
    const bubbles = out.bubbles.filter((b): b is string => typeof b === "string" && !!b.trim());
    const action = typeof out.action === "string" && step.canDo.some((c) => c.name === out.action) ? out.action : null;
    return { bubbles, action };
  } catch {
    return null;
  }
}

const WHAT_ELSE: Brief = {
  goal: "tell them once, in one or two short texts, what else troy is for. start with something like 'also'. it follows right after he confirmed their alert picks, so no greeting",
  mustCover: [
    "if they ever find something someone lost",
    "if they lose something themselves",
    "if they spot something broken on campus",
    "if they have a complaint they want student government to see",
    "they just tell him and he connects them",
  ],
  fallback: [
    ["also, if u ever find something someone lost, lose something urself, spot something broken on campus, or have a complaint u want student government to see", "just tell me and i'll connect u"],
    ["oh and i'm not just alerts. found something that isn't urs, lost something, see something broken on campus, or got a complaint student government should see?", "text me and i'll get it to the right person"],
    ["one more thing: if u find something someone lost, lose something of ur own, notice something broken on campus, or want student government to hear a complaint", "just say so and i'll connect u"],
    ["also i do more than alerts. lost something, found something, something on campus is broken, or u have a complaint for student government?", "tell me and i'll connect u with whoever handles it"],
  ],
};

const people = (n: number): string => (n === 1 ? "1 person" : `${n} people`);

function lostBrief(n: number, near: boolean): Brief {
  const where = near ? "near u" : "around campus";
  return {
    goal: "one short text: mention how many people reported losing something close by, and that they can ask for details to keep an eye out. no item details, and no word about when it happened (never today or this week)",
    mustCover: [`${people(n)} reported losing something ${where}`, "they can ask for details so they can keep an eye out"],
    facts: { count: people(n) },
    fallback: [
      [`also ${people(n)} reported losing something ${where}. lmk if u want details so u can keep an eye out`],
      [`and ${people(n)} lost something ${where} recently. want details so u can keep an eye out?`],
      [`plus ${people(n)} ${where} reported something lost. say the word if u want details to keep an eye out`],
    ],
  };
}

function exampleFoodBrief(): Brief {
  const walk = FIRST_TEN.exampleWalk;
  return {
    goal: "one short text: there's free pizza close to them, and ask if they want the spot. don't name a place",
    mustCover: [`free pizza about ${walk} from them`, "ask if they want the spot"],
    facts: { walk },
    fallback: [[`btw there's free pizza about ${walk} from u. want the spot?`], [`oh and there's free pizza like ${walk} from u rn. want the spot?`], [`also free pizza, about ${walk} from where u are. want me to send the spot?`]],
  };
}

function realFoodBrief(what: string, where: string, walk: string | null): Brief {
  const facts: Record<string, string> = { what, where };
  if (walk) facts.walk = walk;
  return {
    goal: "one short text: there's free food at a spot right now. give the spot straight away, don't ask whether they want it",
    mustCover: walk ? ["what it is", "where it is", "how far the walk is"] : ["what it is", "where it is"],
    facts,
    fallback: walk
      ? [[`btw there's free ${what} at ${where} rn, about ${walk} from u`], [`heads up, free ${what} at ${where} right now. about a ${walk} walk for u`], [`also free ${what} at ${where} rn, roughly ${walk} from u`]]
      : [[`btw there's free ${what} at ${where} rn`], [`heads up, free ${what} at ${where} right now`], [`also there's free ${what} at ${where} rn if ur nearby`]],
  };
}

const REVEAL: Brief = {
  goal: "be honest: this is a hackathon build, so the free pizza and the lost items he just mentioned were examples and there is nothing to walk to. then say what it looks like when it's real, then offer to let them try it right now",
  mustCover: ["this is a hackathon build", "the pizza and the lost items were examples, nothing to walk to", "when it's real they get the spot, the walk and how many are left", "offer: pretend they lost something and he runs the real check on them"],
  fallback: [
    ["ok real talk: this is a hackathon build, so that pizza and those lost items were examples. nothing to walk to", "when it's real u get the spot, the walk and how many are left", "want to try it? pretend u lost something and i'll run the real check on u"],
    ["honest answer: i'm a hackathon build rn, so the pizza and the lost stuff were examples. don't go looking for it", "with more trojans on here that text is real: the spot, how far, how many left", "wanna see the real part? pretend u lost something and i'll check u like a real owner"],
    ["gotta be straight with u: this is a hackathon build and those were example numbers, no pizza to walk to", "the real version sends the spot, the walk and what's left the second someone posts", "i can show u tho. want to pretend u lost something and go through the real check?"],
  ],
};

const REVEAL_NO_OFFER: Brief = {
  goal: "be honest: this is a hackathon build, so the free pizza and the lost items he just mentioned were examples and there is nothing to walk to. then say what it looks like when it's real",
  mustCover: ["this is a hackathon build", "the pizza and the lost items were examples, nothing to walk to", "when it's real they get the spot, the walk and how many are left"],
  fallback: REVEAL.fallback.map((v) => v.slice(0, 2)),
};

function realLostBrief(places: string[]): Brief {
  const where = places.length ? places.join(", ") : "";
  return {
    goal: "they asked for details on the lost reports near them. he never shares what the items are (that keeps claims honest). say roughly where they were lost if a place is given, and that a photo of anything they spot is all he needs",
    mustCover: where ? ["he can't say what the items are", "roughly where they were lost", "if they spot something, send him a pic"] : ["he can't say what the items are", "if they spot something, send him a pic"],
    facts: where ? { where } : {},
    fallback: where
      ? [
          ["can't say what they are, that's how i keep claims honest", `they were lost around ${where}. if u spot anything, send me a pic`],
          [`i keep the items themselves quiet so nobody can fake a claim. they went missing around ${where}`, "see something that looks lost? send me a pic"],
          [`what they are stays between me and the owners. where: around ${where}`, "if u find anything there, a pic is all i need"],
        ]
      : [
          ["can't say what they are, that's how i keep claims honest", "if u spot anything that looks lost, send me a pic"],
          ["i keep the items themselves quiet so nobody can fake a claim", "see something that looks lost? send me a pic and i'll find the owner"],
        ],
  };
}

const NO_THANKS: Brief = {
  goal: "they said no thanks to the offer. one short easy line, no push",
  mustCover: ["no problem"],
  fallback: [["all good"], ["no worries"], ["bet, i'm around if u change ur mind"], ["easy. text me whenever"]],
};

const TRY_ME_QUESTION = ["wanna see what i do? tap one", "want a quick demo? pick one", "curious what i actually do? tap one", "wanna try me out? pick one"];
const TRY_ME_TAP_HINT = ["heart or thumbs up the one u want", "tap a heart or thumbs up on one of those", "thumbs up whichever one u want"];
const TRY_ME_NUMBER_HINT = ['reply "1", "2" or "3"', 'text me "1", "2" or "3"', 'just reply "1", "2" or "3"'];

const STUMP: Brief = {
  goal: "invite them to stump him: they name any campus problem and he tells them who handles it. one short playful text",
  mustCover: ["name any campus problem", "he'll tell them who handles it"],
  fallback: [
    ["ok stump me. name any campus problem and i'll tell u who handles it"],
    ["go ahead, try me. any campus problem, and i'll tell u who deals with it"],
    ["bet. give me any campus problem and i'll tell u exactly who handles it"],
    ["alright, hit me with a campus problem. i'll tell u who handles it"],
  ],
};

/** What the chat brain is told when the next text answers "stump me". Nothing is filed: he only says who handles it. */
export const STUMP_HINT =
  "they are playing 'stump me': they named a campus problem to see if troy knows who handles it. tell them who handles it, using only the looked up rows for names and contacts. do not file a report or hand off, it's a game. if it's something troy himself handles (lost and found, free food, broken things, a complaint for student government), say so and that they can do it for real anytime.";

const ONE_QUESTION: Brief = {
  goal: "ask one easy question out of the blue: what's one thing they wish was easier at usc. one short text, no pitch",
  mustCover: ["what's one thing they wish was easier at usc"],
  fallback: [
    ["random q: what's one thing u wish was easier at usc?"],
    ["been wondering, what's one thing at usc u wish was less of a hassle?"],
    ["quick one: if u could make one thing at usc easier, what would it be?"],
    ["curious, what's the one thing at usc u wish just worked better?"],
  ],
};

const FOLLOW_UPS: Partial<Record<Move, Brief>> = {
  tour_lost: {
    goal: "one short follow-up, a few minutes after they tried the example lost-item check: that same check is what a real owner goes through, and if they ever lose something for real they just tell him",
    mustCover: ["the check they tried is the same one a real owner gets", "if they ever lose something, just tell him"],
    fallback: [
      ["btw that check u tried is the exact one a real owner gets. if u ever actually lose something, just tell me"],
      ["fyi the run u did earlier is how it goes for real. lose something for real and i'll do the same thing, just text me"],
      ["oh and that wasn't a toy version, real owners get that same check. if something of urs goes missing, tell me"],
    ],
  },
  tour_food: {
    goal: "one short follow-up, a few minutes after they tried the example food claim: if their club ever has leftovers, they text him what and where and he gets it to people nearby",
    mustCover: ["if they or their club ever has leftover food, text him what and where", "he gets it to people nearby"],
    fallback: [
      ["btw if ur club ever has leftovers, text me what and where and i'll get it to people nearby"],
      ["fyi that works the other way too. got extra food after an event? tell me what and where and i'll send people"],
      ["oh and if u ever end up with leftover food, text me what it is and where. i'll get it to trojans nearby"],
    ],
  },
  tour_repair: {
    goal: "one short follow-up, a few minutes after they tried the example repair report: next time something is actually broken on campus, a photo is all he needs",
    mustCover: ["next time something on campus is actually broken, send him a photo", "he gets it to the right office"],
    fallback: [
      ["btw next time something's actually busted on campus, send me the pic and i'll get it to the right office"],
      ["fyi that works for real stuff. see something broken on campus? one photo and i'll route it"],
      ["oh and if u walk past something broken for real, just send me a pic. i'll get it to whoever fixes it"],
    ],
  },
  stump: {
    goal: "one short follow-up, a few minutes after they played stump me: it works for real problems too",
    mustCover: ["it works for real campus problems too", "he'll point them to who handles it"],
    fallback: [
      ["btw that works for real stuff too. got an actual campus problem, i'll point u to who handles it"],
      ["fyi i wasn't just showing off earlier. real campus problem? i'll tell u who deals with it"],
      ["oh and if a real campus headache comes up, same deal. tell me and i'll get u to the right person"],
    ],
  },
};

const STUDY_SPOT: Brief = {
  goal: "ask where they usually study or hang out on campus, so he can give walking times when they aren't sharing a location. frame it as something that helps them, never mention skipping",
  mustCover: ["where do they usually study", "it's for walking times"],
  fallback: [
    ['one thing so i can give u walking times: where do u usually study? like "leavey and the village"'],
    ['btw where do u usually study? i\'ll use it for walking times when ur not sharing ur location. like "leavey and the village"'],
    ['quick one for later: where are u usually on campus? something like "leavey and the village" and i can tell u how far things are'],
  ],
};

// ---------- what is actually near them ----------

type RealDrop = { what: string; where: string; walk: string | null };

/** Follows the free food topic (the older subscription keys count too). */
function followsFood(user: User): boolean {
  const keys = subscriptionKeys("free_nearby");
  return user.subscriptions.some((s) => keys.includes(s));
}

/** The nearest real, live drop this person could walk to. Example rows and their own posts never count. */
function realDropNear(db: DatabaseSync, user: User, now: number): RealDrop | null {
  let rows: { description: string | null; locationText: string | null; lat: number | null; lng: number | null }[] = [];
  try {
    rows = db
      .prepare("SELECT description, locationText, lat, lng FROM food_drops WHERE status = 'live' AND servingsLeft > 0 AND isExample = 0 AND posterUserId != ? AND (expiresAt IS NULL OR expiresAt > ?) ORDER BY id DESC")
      .all(user.id, now) as typeof rows;
  } catch {
    return null;
  }
  const here = getUserLocation(db, user, now);
  let best: RealDrop | null = null;
  let bestMinutes = Infinity;
  for (const r of rows) {
    const where = (r.locationText ?? "").trim();
    if (!where) continue;
    const what = (r.description ?? "").trim().toLowerCase() || "food";
    if (here && r.lat !== null && r.lng !== null) {
      const minutes = walkingMinutes(here, { lat: r.lat, lng: r.lng });
      if (minutes > user.alertMinutes) continue;
      if (minutes < bestMinutes) {
        bestMinutes = minutes;
        best = { what, where, walk: `${minutes} min` };
      }
    } else if (!best) best = { what, where, walk: null };
  }
  return best;
}

/** Real open lost reports close by (all of campus when Troy doesn't know where this person is): a count and rough places. */
function realLostNear(db: DatabaseSync, user: User, now: number): { count: number; places: string[]; near: boolean } {
  let rows: { locationText: string | null; lat: number | null; lng: number | null }[] = [];
  try {
    rows = db
      .prepare("SELECT locationText, lat, lng FROM listings WHERE type = 'lost' AND status IN ('open','matched','verifying') AND isExample = 0 AND userId != ? AND createdAt > ? ORDER BY id DESC")
      .all(user.id, now - 7 * 24 * 60 * MIN) as typeof rows;
  } catch {
    rows = [];
  }
  const here = getUserLocation(db, user, now);
  const close = here ? rows.filter((r) => r.lat !== null && r.lng !== null && distanceMeters(here, { lat: r.lat, lng: r.lng }) <= FIRST_TEN.nearMeters) : rows;
  const places = [...new Set(close.map((r) => (r.locationText ?? "").trim()).filter(Boolean))].slice(0, 3);
  return { count: close.length, places, near: !!here };
}

// ---------- onboarding just ended ----------

const ids = (list: (string | null)[]): string[] => list.filter((id): id is string => typeof id === "string" && !!id);

/**
 * Called by onboarding when it finishes. Sends the "what else" line and the "near u" bubbles, then leaves the rest
 * to the clock: real drops send the spot straight away, example numbers hold it back until asked.
 */
export async function afterOnboarding(ctx: FlowContext): Promise<void> {
  const { db } = ctx;
  const user = getUserById(db, ctx.user.id) ?? ctx.user;
  if (user.stopped) return;
  ensure(db);
  const now = deps.now();
  const judge = user.verifiedVia === "judge_skip";
  db.prepare("INSERT INTO first_ten (userId, startedAt, judge, moves) VALUES (?, ?, ?, '[]') ON CONFLICT(userId) DO UPDATE SET startedAt = excluded.startedAt, judge = excluded.judge, lastInAt = NULL, did = NULL, unpromptedAt = NULL, endedAt = NULL, near = NULL, poll = NULL, stumpUntil = NULL, questionAt = NULL").run(user.id, now, judge ? 1 : 0);
  ioFor.set(db, ioFor.get(db) ?? ioFromContext(ctx));
  const me: FlowContext = { ...ctx, user };

  if (!hasMove(db, user.id, "what_else")) {
    await ctx.say(...(await inHisWords(me, "firstten:whatelse", WHAT_ELSE)));
    markMove(db, user.id, "what_else");
  }

  const near: Near = { food: null, lost: null, lostCount: 0, foodIds: [], lostIds: [], open: false, at: now };
  if (followsFood(user)) {
    const drop = realDropNear(db, user, now);
    if (drop) {
      // Real food: the spot goes out straight away, no "want the spot?" step.
      near.food = "real";
      near.foodIds = ids(await ctx.say(...(await inHisWords(me, "firstten:food:real", realFoodBrief(drop.what, drop.where, drop.walk)))));
    } else {
      near.food = "example";
      near.foodIds = ids(await ctx.say(...(await inHisWords(me, "firstten:food:example", exampleFoodBrief()))));
    }
  }
  const lost = realLostNear(db, user, now);
  near.lost = lost.count > 0 ? "real" : "example";
  near.lostCount = lost.count > 0 ? lost.count : FIRST_TEN.exampleLost;
  near.lostIds = ids(await ctx.say(...(await inHisWords(me, `firstten:lost:${near.lost}`, lostBrief(near.lostCount, lost.count > 0 ? lost.near : true)))));
  near.open = true;
  patch(db, user.id, { near });
  markMove(db, user.id, "near");

  // Judges get the "try me" poll right away. Everyone else gets it after 30 seconds of silence.
  if (judge) await sendTryMe(me, now);
  else schedule(db, user.id, FIRST_TEN.pollAfterMs + SEC);
}

// ---------- the "try me" poll ----------

async function sendTryMe(ctx: FlowContext, now: number): Promise<boolean> {
  const { db, user } = ctx;
  const chatId = user.chatId;
  const question = pickVariant(db, user.id, "firstten:tryme", TRY_ME_QUESTION);
  const options = [...TRY_ME_OPTIONS];
  const none = { optionMessageIds: options.map(() => null as string | null), mode: "numbered" as const };
  const poll = await ctx.adapter.sendPoll(chatId, question, options).catch(() => none);
  const save = (providerMessageId: string | null, text: string) => saveMessage(db, { userId: user.id, chatId, direction: "out", providerMessageId, text });
  let ref: PollRef;
  if (poll.mode === "native") {
    const pollId = poll.optionMessageIds.find((id) => !!id) ?? null;
    if (!pollId) return false;
    save(pollId, `[poll] ${question}: ${options.join(" / ")}`);
    ref = { pollId, optionIds: poll.optionMessageIds, mode: "native", at: now };
  } else {
    save(null, question);
    options.forEach((text, i) => save(poll.optionMessageIds[i] ?? null, text));
    ref = { pollId: null, optionIds: poll.optionMessageIds, mode: poll.mode, at: now };
    await ctx.say(pickVariant(db, user.id, `firstten:tryme:${poll.mode}`, poll.mode === "tap" ? TRY_ME_TAP_HINT : TRY_ME_NUMBER_HINT));
  }
  patch(db, user.id, { poll: ref, unpromptedAt: now });
  markMove(db, user.id, "poll");
  return true;
}

/** Which "try me" option a typed text picks, or -1. The option's own words, a number, or close to it. */
function typedPick(text: string, numbered: boolean): number {
  const t = (text ?? "").toLowerCase().replace(/[‘’'`]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t || t.split(" ").length > 8) return -1;
  if (numbered && /^(?:option |number |#)?[123]$/.test(t)) return Number(t.slice(-1)) - 1;
  if (/^(?:(?:ok|okay|yes|sure|bet|lets|let me|i wanna|i want to|can i)\s+)*(?:pretend i lost (?:something|smth|sth)|(?:the )?lost (?:one|something)|pretend lost)\b/.test(t) || /^(?:try|do|show me|run) (?:the |a )?(?:tour|demo|try it tour)$/.test(t)) return 0;
  if (/^(?:(?:ok|okay|yes|sure|bet)\s+)*show me (?:the )?free food(?: near me)?$/.test(t) || /^(?:the )?(?:free )?food (?:one|near me)$/.test(t)) return 1;
  if (/^(?:(?:ok|okay|yes|sure|bet|lets|let me|i wanna|can i)\s+)*stump (?:me|u|you|troy)\b/.test(t)) return 2;
  return -1;
}

async function startTour(ctx: FlowContext, variant: "lost" | "food" | "repair"): Promise<void> {
  const tour = (await import("./flows/tour.ts")) as { startTour: (c: FlowContext, v: "lost" | "food" | "repair") => Promise<void> };
  await tour.startTour(ctx, variant);
}

/** Start the move a "try me" option stands for. A real drop nearby goes to the real food flow; otherwise the example. */
async function playPick(ctx: FlowContext, index: number): Promise<void> {
  const { db, user } = ctx;
  const row = load(db, user.id);
  if (row?.near?.open) patch(db, user.id, { near: { ...row.near, open: false } });
  if (index === 0) {
    await startTour(ctx, "lost");
    return;
  }
  if (index === 1) {
    if (realDropNear(db, user, deps.now())) {
      const { getFlow } = await import("./flows/index.ts");
      const food = getFlow("food");
      if (food) {
        await food.handle({ ...ctx, state: null, intent: { flow: "food", action: "status", details: {}, source: "ai" }, event: { ...ctx.event, text: ctx.event.text || "any free food near me?", reaction: undefined, pollVote: undefined } });
        return;
      }
    }
    await startTour(ctx, "food");
    return;
  }
  await ctx.say(...(await inHisWords(ctx, "firstten:stump", STUMP)));
  markMove(db, user.id, "stump", { did: true });
  patch(db, user.id, { stumpUntil: deps.now() + FIRST_TEN.answerMs });
}

// ---------- their replies ----------

const words = (text: string): string => (text ?? "").toLowerCase().replace(/[‘’'`]/g, "").replace(/[^a-z0-9\s?]/g, " ").replace(/\s+/g, " ").trim();

function wantsSpot(t: string): boolean {
  const n = t.replace(/\?/g, "").trim().split(" ").length;
  if (n > 8) return false;
  if (/\b(?:my|lost|found|broken)\b/.test(t)) return false;
  return /\b(?:spot|pizza)\b/.test(t) || /^(?:(?:yes|yeah|yea|ya|sure|ok|okay|bet|pls|please|omg|ooh|wait)\s+)*(?:where|wheres|where is|where at|which building|what building)(?: is)?(?: it| that| at| this)?(?: the (?:pizza|food|spot))?\s*\??$/.test(t);
}

function wantsDetails(t: string): boolean {
  const n = t.replace(/\?/g, "").trim().split(" ").length;
  if (n > 10) return false;
  return /\bdetails?\b|\bwhat(?:d| did)? (?:they|people|ppl) lose\b|\bwhat (?:was|were|got) lost\b|\bkeep an eye\b|\blost what\b|\bwhat (?:are|were) (?:they|the items)\b|\bwhat kind of (?:stuff|things|items)\b/.test(t);
}

async function reveal(ctx: FlowContext, row: Row): Promise<void> {
  const { db, user } = ctx;
  const offer = !row.moves.includes("tour_lost") && !row.moves.includes("tour_offer") && !brainDid(db, user.id, "tour_offer");
  const sent = ids(await ctx.say(...(await inHisWords(ctx, "firstten:reveal", offer ? REVEAL : REVEAL_NO_OFFER))));
  patch(db, user.id, { near: { ...row.near!, open: false } });
  if (offer) {
    markMove(db, user.id, "tour_offer");
    ctx.setState({ flow: TOUR, step: "offer", data: { variant: "lost", qid: sent[sent.length - 1] ?? null } });
  }
}

async function realDetails(ctx: FlowContext, row: Row): Promise<void> {
  const lost = realLostNear(ctx.db, ctx.user, deps.now());
  await ctx.say(...(await inHisWords(ctx, "firstten:lost:details", realLostBrief(lost.places))));
  patch(ctx.db, ctx.user.id, { near: { ...row.near!, open: false } });
}

/** Answer a yes, a no or a question about the "near u" bubbles. False when the message isn't about them. */
async function answerNear(ctx: FlowContext, row: Row, input: { yes: boolean; no: boolean; spot: boolean; details: boolean }): Promise<boolean> {
  const near = row.near;
  if (!near?.open) return false;
  const example = near.food === "example" || near.lost === "example";
  // Asking for the spot or the details of an example gets the honest answer. Nobody is sent to walk to nothing.
  if ((input.spot && near.food === "example") || (input.details && near.lost === "example") || (input.yes && example)) {
    await reveal(ctx, row);
    return true;
  }
  if ((input.details || input.yes) && near.lost === "real") {
    await realDetails(ctx, row);
    return true;
  }
  if (input.no) {
    await ctx.say(...(await inHisWords(ctx, "firstten:nothanks", NO_THANKS)));
    patch(ctx.db, ctx.user.id, { near: { ...near, open: false } });
    return true;
  }
  return false;
}

/**
 * A text that answers something Troy put out in the first hour: a pick from the "try me" poll typed out, or a
 * yes / "where?" / "details?" about the "near u" bubbles. Runs before intent detection, and only when no flow has
 * a step open. Returns false for everything else, so the message goes through the pipeline as usual.
 */
export async function firstTenIntercept(ctx: FlowContext): Promise<boolean> {
  const { db, user, event } = ctx;
  if (event.reaction || event.pollVote || event.images.length) return false;
  const now = deps.now();
  const row = load(db, user.id);
  if (!inWindow(row, now) || ctx.state) return false;
  // The option's own words work whether or not the poll went out ("pretend i lost something"). A bare number only
  // answers a numbered poll that is still fresh.
  const pick = typedPick(event.text, !!row.poll && row.poll.mode === "numbered" && now - row.poll.at < FIRST_TEN.answerMs);
  if (pick !== -1) {
    await playPick(ctx, pick);
    return true;
  }
  const t = words(event.text);
  // A bare yes or no only answers the "near u" bubbles while they are the last thing Troy said. After anything else
  // of his (a chat reply, the poll), "yes" belongs to that, and only the words themselves ("where?", "details?") count.
  const fresh = !!row.near && nearIsLastWord(db, user.chatId, row.near);
  const yn = fresh ? readYesNo({ event, questionMessageId: null }) : null;
  return answerNear(ctx, row, { yes: yn === "yes", no: yn === "no", spot: wantsSpot(t), details: wantsDetails(t) });
}

/** True when the newest thing Troy sent in this chat is one of the "near u" bubbles. */
function nearIsLastWord(db: DatabaseSync, chatId: string, near: Near): boolean {
  try {
    const last = db.prepare("SELECT providerMessageId AS id FROM messages WHERE chatId = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(chatId) as { id: string | null } | undefined;
    return !!last?.id && (near.foodIds.includes(last.id) || near.lostIds.includes(last.id));
  } catch {
    return false;
  }
}

/**
 * A vote on the "try me" poll, or a tapback on one of its option bubbles or on a "near u" bubble.
 * True when the tap was one of those (whether or not it did anything).
 */
export async function firstTenTap(ctx: FlowContext): Promise<boolean> {
  const { db, user, event } = ctx;
  const now = deps.now();
  const row = load(db, user.id);
  if (!inWindow(row, now)) return false;
  const poll = row.poll;
  if (event.pollVote && poll?.mode === "native") {
    if (event.pollVote.pollMessageId && poll.pollId && event.pollVote.pollMessageId !== poll.pollId) return false;
    const i = event.pollVote.optionIndex;
    if (!Number.isInteger(i) || i < 0 || i >= TRY_ME_OPTIONS.length) return true;
    await playPick(ctx, i);
    return true;
  }
  const r = event.reaction;
  if (!r) return false;
  const positive = !r.removed && (r.type === "love" || r.type === "like");
  if (poll && poll.mode !== "native") {
    const i = poll.optionIds.indexOf(r.targetMessageId);
    if (i !== -1) {
      if (positive) await playPick(ctx, i);
      return true;
    }
  }
  const near = row.near;
  if (near?.open) {
    const onFood = near.foodIds.includes(r.targetMessageId);
    const onLost = near.lostIds.includes(r.targetMessageId);
    if (onFood || onLost) {
      if (ctx.state) return true;
      const no = !r.removed && r.type === "dislike";
      if (positive || no) await answerNear(ctx, row, { yes: false, no, spot: positive && onFood, details: positive && onLost });
      return true;
    }
  }
  return false;
}

const ABOUT_OFFER = /\b(?:pizza|food|slice|spot|where|wheres|addy|address|location|building|lost|details?|items?|which|send|show|tell|yes|yeah|yea|sure|ok|okay|please|pls|hungry|starving|omw|eat)\b/;

/**
 * While an example offer is open and the message is plain chat, the chat brain answers knowing what is on the table
 * (replyAtStep), and can ask for the honest reveal. False when the brain isn't available or nothing is open.
 */
export async function firstTenChat(ctx: FlowContext): Promise<boolean> {
  const { db, user } = ctx;
  const row = load(db, user.id);
  if (!inWindow(row, deps.now()) || ctx.state || !row.near?.open) return false;
  const near = row.near;
  if (near.food !== "example" && near.lost !== "example") return false;
  // Only when the text could be about the offer. Everything else is ordinary chat and goes the ordinary way.
  if (!ABOUT_OFFER.test(words(ctx.event.text))) return false;
  const out = await atStep(ctx, {
    flow: "first ten minutes",
    waitingFor: "to know if u want that pizza spot or the details on the lost stuff",
    canDo: [
      {
        name: "reveal",
        when: "they ask for the spot, where the pizza is, what was lost, or say yes to either. (the pizza and the lost items troy mentioned were EXAMPLE numbers for this hackathon build: never give a spot, a building or an item detail yourself, pick this action instead)",
      },
    ],
  });
  if (!out) return false;
  if (out.action === "reveal") {
    await reveal(ctx, row);
    return true;
  }
  if (!out.bubbles.length) return false;
  await ctx.say(...out.bubbles);
  return true;
}

/**
 * Two of the moves change where the next text goes:
 * - after "stump me", the next text is the campus problem they named. It goes to the chat brain with a hint, and
 *   nothing is filed (a broken elevator named as a stumper is not a repair report).
 * - after the one question, an answer that reads as plain chat goes somewhere real: the usg flow, as a concern.
 */
export function adjustIntent(db: DatabaseSync, user: User, event: IncomingEvent, intent: Intent, state: FlowState | null): Intent {
  try {
    const now = deps.now();
    const row = load(db, user.id);
    if (!row || state || event.images.length) return intent;
    if (row.stumpUntil !== null) {
      patch(db, user.id, { stumpUntil: null });
      if (row.stumpUntil > now && event.text.trim()) return { flow: "smalltalk", action: "chat", details: { ...intent.details, hint: STUMP_HINT, stump: true }, source: intent.source };
    }
    if (row.questionAt !== null) {
      patch(db, user.id, { questionAt: null });
      const t = words(event.text);
      const real = t.split(" ").length >= 3 && !t.includes("?") && readYesNo({ event, questionMessageId: null }) === null && !/^(?:idk|i dont know|not sure|nothing|none|no idea|hm+|lol)\b/.test(t);
      if (now - row.questionAt < FIRST_TEN.answerMs && intent.flow === "smalltalk" && real) return { flow: "usg", action: "concern", details: { ...intent.details, fromFirstTen: true }, source: intent.source };
    }
  } catch {
    // The message still goes where intent detection sent it.
  }
  return intent;
}

/**
 * Move 5: asked once, the first time a walking time would be missing (no saved location and no usual spot).
 * Opens a step in the tour flow that saves the answer as usual spots. True when the question went out.
 */
export async function maybeAskStudySpot(ctx: FlowContext): Promise<boolean> {
  const { db } = ctx;
  const user = getUserById(db, ctx.user.id) ?? ctx.user;
  if (hasMove(db, user.id, "study_spot") || getUserLocation(db, user, deps.now())) return false;
  const sent = ids(await ctx.say(...(await inHisWords(ctx, "firstten:studyspot", STUDY_SPOT))));
  markMove(db, user.id, "study_spot");
  ctx.setState({ flow: TOUR, step: "study_spot", data: { qid: sent[sent.length - 1] ?? null } });
  return true;
}

// ---------- the clock ----------

const ioFor = new WeakMap<DatabaseSync, SweepIo>();

/** The pipeline hands over how to reach people outside a conversation. Without it, the onboarding context is used. */
export function setFirstTenIo(db: DatabaseSync, io: SweepIo): void {
  ioFor.set(db, io);
}

function ioFromContext(ctx: FlowContext): SweepIo {
  return { db: ctx.db, adapter: ctx.adapter, sayTo: (userId, ...bubbles) => ctx.sayTo(userId, ...bubbles) };
}

function sweepContext(io: SweepIo, user: User): FlowContext {
  const event: IncomingEvent = { provider: io.adapter.provider, userHandle: user.handle, chatId: user.chatId, isGroup: false, messageId: "", text: "", images: [], receivedAt: deps.now() };
  return {
    db: io.db,
    user,
    event,
    intent: { flow: "smalltalk", action: "first_ten", details: {}, source: "fallback" },
    state: getFlowState(io.db, user.id),
    adapter: io.adapter,
    say: (...bubbles: (string | Bubble)[]) => io.sayTo(user.id, ...bubbles),
    sayTo: (userId, ...bubbles) => io.sayTo(userId, ...bubbles),
    sayToOwed: (userId, ...bubbles) => io.sayTo(userId, ...bubbles),
    setState: (s) => setFlowState(io.db, user.id, s),
    setStateFor: (userId, s) => setFlowState(io.db, userId, s),
  };
}

export type Due = "poll" | "question" | "follow_up" | null;

/** Which unprompted message, if any, this person should get right now. Pure: only reads. */
export function dueNow(db: DatabaseSync, userId: number, now: number = deps.now()): Due {
  const row = load(db, userId);
  if (!inWindow(row, now) || row.endedAt !== null || row.unpromptedAt !== null) return null;
  const user = getUserById(db, userId);
  if (!user || !user.verifiedAt || !canAlert(user, new Date(now))) return null;
  const elapsed = now - row.startedAt;
  if (elapsed >= FIRST_TEN.planMs) return null;
  // Mid-step in something (a flow's question, the tour): he doesn't talk over it.
  if (getFlowState(db, userId) || isBusy(db, userId, now)) return null;
  if (row.lastInAt === null) return elapsed >= FIRST_TEN.pollAfterMs && !row.moves.includes("poll") ? "poll" : null;
  if (now - row.lastInAt < FIRST_TEN.settleMs) return null;
  // They did a move: the follow-up is the better fit. They only chatted: the one question.
  if (row.did) return elapsed >= FIRST_TEN.followUpAfterMs && !row.moves.includes("follow_up") && !!FOLLOW_UPS[row.did] ? "follow_up" : null;
  return now - row.lastInAt >= FIRST_TEN.questionAfterMs && !row.moves.includes("question") && !brainDid(db, userId, "question") ? "question" : null;
}

async function runOne(io: SweepIo, userId: number, now: number): Promise<Due> {
  const due = dueNow(io.db, userId, now);
  if (!due) return null;
  const user = getUserById(io.db, userId)!;
  const ctx = sweepContext(io, user);
  const row = load(io.db, userId)!;
  // Claimed before anything is sent, so a timer and the sweep landing together can never both send.
  patch(io.db, userId, { unpromptedAt: now });
  if (due === "poll") {
    const sent = await sendTryMe(ctx, now);
    if (!sent) patch(io.db, userId, { unpromptedAt: null });
    return sent ? due : null;
  }
  const brief = due === "question" ? ONE_QUESTION : FOLLOW_UPS[row.did!]!;
  const sent = ids(await ctx.say(...(await inHisWords(ctx, `firstten:${due}${due === "follow_up" ? `:${row.did}` : ""}`, brief))));
  if (!sent.length) {
    patch(io.db, userId, { unpromptedAt: null });
    return null;
  }
  markMove(io.db, userId, due);
  if (due === "question") patch(io.db, userId, { questionAt: now });
  return due;
}

/** Called by pipeline.sweep (the server runs it every 30 seconds) and by tests with a fake clock. */
export async function sweepFirstTen(io: SweepIo, now: number = deps.now()): Promise<number> {
  ensure(io.db);
  ioFor.set(io.db, io);
  const rows = io.db.prepare("SELECT userId FROM first_ten WHERE endedAt IS NULL AND unpromptedAt IS NULL AND startedAt > ?").all(now - FIRST_TEN.windowMs) as { userId: number }[];
  let sent = 0;
  for (const r of rows) {
    try {
      if (await runOne(io, r.userId, now)) sent++;
    } catch {
      // One person's failed send never stops the sweep.
    }
  }
  return sent;
}

function schedule(db: DatabaseSync, userId: number, ms: number): void {
  if (!deps.timers) return;
  const timer = setTimeout(() => {
    const io = ioFor.get(db);
    if (!io) return;
    runOne(io, userId, deps.now()).catch(() => {});
  }, ms);
  timer.unref?.();
}
