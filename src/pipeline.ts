// The message pipeline. Every gated incoming event goes through handleEvent, one at a time per user.

import type { DatabaseSync } from "node:sqlite";
import type { Bubble, FlowContext, FlowHandler, FlowName, FlowState, IncomingEvent, Intent, MessagingAdapter, User } from "./types.ts";
import { isEnabled } from "./config.ts";
import { getFlowState, getOrCreateUser, getSetting, getUserById, saveMessage, setFlowState, setSetting, updateUser } from "./db/index.ts";
import { COMMAND_POOLS, endsPlayful, isHeyTroy, matchCommand, meantCommand, safetySignal, TEMPLATES } from "./commands.ts";
import type { CommandKind } from "./commands.ts";
import * as onboardingMod from "./onboarding.ts";
import { handleOnboarding, needsOnboarding } from "./onboarding.ts";
import { getFlow } from "./flows/index.ts";
import * as aiMod from "./ai.ts";
import { detectIntent as realDetectIntent, modelReady } from "./ai.ts";
import * as brainMod from "./brain.ts";
import { keepVerbatim, pickVariant, toPlain } from "./voice.ts";
import { forgetJudge, handleToneTap, handleToneText, isJudge, judgeWrapUp, plainTone, tourWasFinished, wrapUpSent } from "./judge.ts";
import { COPY as LOST_FOUND_COPY } from "./flows/lostfound/handler.ts";
import { DANGER_LINE } from "./flows/repair.ts";
import { noteOpenQuestion, openQuestionId, readYesNo } from "./yes.ts";
import { adjustIntent, cancelFirstTen, firstTenChat, firstTenIntercept, firstTenTap, inHisWords, noteStudentMessage, setFirstTenIo, setFirstTenQueue, sweepFirstTen } from "./firstten.ts";
import * as topics from "./topics.ts";
import { activeRelayFor, relayMessage } from "./relay.ts";
import { inQuietHours } from "./quiet.ts";
import type { SweepIo } from "./pending.ts";
import { deliverPending, isProtected, parkAsk, relayBypass, runSweeps, runUserGone } from "./pending.ts";
import { forgetUserLocation, saveUserLocation } from "./location.ts";
import { releaseSeat } from "./signups.ts";

/** The two calls the pipeline needs from src/location.ts. */
export type LocationStore = {
  saveUserLocation(db: DatabaseSync, userId: number, loc: { lat: number; lng: number }, source: "find_my" | "pin" | "asked"): void;
  forgetUserLocation(db: DatabaseSync, userId: number): void;
};

export type PipelineDeps = {
  db: DatabaseSync;
  getAdapter: () => MessagingAdapter;
  /** Test hooks. Defaults: the real intent call, real pauses, 3 seconds before an acknowledgement. */
  detectIntent?: typeof realDetectIntent;
  pause?: (ms: number) => Promise<void>;
  ackAfterMs?: number;
  /** Picks a point inside each timing range. Default Math.random. */
  random?: () => number;
  /** Default: src/location.ts. */
  location?: LocationStore;
  /**
   * The model's read of an ambiguous message (a joke, real worry, a crisis). Default: readSafety in src/ai.ts when a
   * model can be reached. Null means "no model": ambiguous messages with self-harm words then get the fixed line.
   */
  readSafety?: SafetyReader | null;
};

export type SafetyRead = "none" | "joke" | "concern" | "crisis";
export type SafetyReader = (input: { text: string; history: { from: "student" | "troy"; text: string }[] }) => Promise<SafetyRead>;

/** A bubble with a longer beat after it: `pauseAfterMs` is waited once it has landed, before the next one is typed. */
export type PacedBubble = Bubble & { pauseAfterMs?: number };

/** How long Troy's own short questions (a confirmation, a check-in) stay answerable. */
export const ASK_TTL_MS = 10 * 60 * 1000;
export const CHECKIN_TTL_MS = 30 * 60 * 1000;
/** After a safety read of "concern" or a fixed safety line, replies stay gentle this long (minutes). */
export const HEAVY_MINUTES = 60;

/** Steps of the try-it tour where every text is the answer, whatever intent detection made of it. Mirrors TOUR_HOLDS in src/flows/tour.ts. */
const TOUR_HOLD_STEPS = new Set(["describe", "repair_photo", "study_spot"]);

type AskKind = "stop" | "start" | "pause" | "resume" | "forget_location" | "delete_data" | "unsubscribe_topic" | "checkin";
/** One short question of Troy's own that is waiting for a yes or a no (kept in settings, so it survives a restart). */
type OpenAsk = {
  kind: AskKind;
  topicId?: number;
  qid: string | null;
  at: number;
  /**
   * The row id of the newest thing Troy had sent in this chat when he asked (the question itself). A typed yes only
   * answers the question while that is still the last thing he said: once anything else of his went out (a poll
   * pick's reply, a parked question, something he started on his own), a "yes" belongs to that, not to this.
   */
  lastOut?: number | null;
};

const CHECK_IN = {
  goal: "they said something that might be real distress. check in like a person who cares: one direct, kind question asking whether they are okay or thinking about hurting themselves. nothing else. no hotline, no advice, no emoji, no joke",
  mustCover: ["one direct, kind question: are they okay, are they thinking about hurting themselves"],
  fallback: [
    ["hey, real question. are u ok? are u thinking about hurting urself?"],
    ["wait, i wanna check on u for real. are u thinking about hurting urself?"],
    ["that sounded heavy. are u ok, like actually? any thoughts of hurting urself?"],
    ["hold on, i'm taking that seriously. are u thinking about hurting urself?"],
  ],
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Texting feel, all in milliseconds. "Read" shows first, then typing for a time that fits the bubble, then the
 * bubble, then a short gap before typing the next one. No single typing wait is longer than maxTypingMs.
 */
export const TIMING = {
  /** Between the read receipt and the first typing indicator. */
  readBeat: [800, 1400],
  /** Typing shown for a bubble of up to longBubbleChars characters. */
  typingShort: [1000, 2000],
  /** Typing shown for a longer bubble. */
  typingLong: [3000, 4000],
  longBubbleChars: 80,
  /** After a bubble lands, before typing starts for the next one. */
  gap: [400, 900],
  /** Typing shown before something that isn't typed out: the contact card, a poll, a location request. */
  attachment: [600, 1000],
  maxTypingMs: 4000,
  /** Bubbles longer than this are split (see chunkBubble). */
  chunkChars: 160,
} as const;

/**
 * Judges get the same texting feel, faster (John, "Judge mode" (1)): typing times, the gaps between bubbles and any
 * longer beat are this share of what a student sees. "Read" still shows first, with its full beat.
 */
export const JUDGE_PACE = 0.45;

// The rest of the safety list, word for word in every tone: the contact-sharing warning and the dangerous-item lines.
keepVerbatim(LOST_FOUND_COPY.dangerous, LOST_FOUND_COPY.consent, LOST_FOUND_COPY.consentHow, DANGER_LINE);

const between = (range: readonly [number, number] | readonly number[], r: number) => Math.round(range[0] + (range[1] - range[0]) * Math.min(Math.max(r, 0), 1));

/** How long typing shows before a bubble with this text. */
export function typingMs(text: string, r = Math.random()): number {
  const range = [...text].length > TIMING.longBubbleChars ? TIMING.typingLong : TIMING.typingShort;
  return Math.min(between(range, r), TIMING.maxTypingMs);
}

// ---------- chunking ----------

// Spans a break may never land inside: phone numbers written with spaces, and "pickup code M4WKYM".
// URLs and emails have no spaces in them, and breaks only ever happen at a space, so they are safe already.
const NO_BREAK = [/\+?\(?\d[\d().-]*(?: [\d().-]*\d[\d().-]*)+/g, /\bcode(?: is| was|:)? [A-Za-z0-9]*\d[A-Za-z0-9]*\b/g, /\bcode(?: is| was|:)? [A-Z0-9]{4,10}\b/g];
const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|vs|dr|mr|mrs|ms|st|approx|etc|no)\.$/i;
const MIN_CHUNK = 25;

/** How good a place to break the space at `i` is: 3 end of sentence, 2 clause, 1 between words, 0 never. */
function breakRank(text: string, i: number, blocked: [number, number][]): number {
  if (blocked.some(([a, b]) => i > a && i < b)) return 0;
  const left = text.slice(0, i);
  const right = text.slice(i + 1);
  // A space inside a link's query or right after "http" can't happen; a space after "." in "usc.edu. next" is a real sentence end.
  if (/[.!?…]["')\]]?$/.test(left) && !ABBREVIATION.test(left)) return 3;
  const depth = (left.match(/\(/g) ?? []).length - (left.match(/\)/g) ?? []).length;
  if (/[,;:]$/.test(left) || /\)$/.test(left) || /^\(/.test(right)) return depth > 0 ? 1.2 : 2;
  if (/^(?:but|so|because|and then|then|or just) /i.test(right)) return depth > 0 ? 1.1 : 1.5;
  return 1;
}

function splitLine(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text.trim();
  while ([...rest].length > max) {
    const blocked: [number, number][] = [];
    for (const re of NO_BREAK) for (const m of rest.matchAll(re)) blocked.push([m.index, m.index + m[0].length]);
    let best = -1;
    let bestRank = 0;
    for (let i = MIN_CHUNK; i <= max && i < rest.length; i++) {
      if (rest[i] !== " ") continue;
      const rank = breakRank(rest, i, blocked);
      // The latest break of the best kind, so chunks stay as full as they can.
      if (rank > 0 && rank >= bestRank) {
        best = i;
        bestRank = rank;
      }
    }
    if (best === -1) {
      // One unbroken run longer than a bubble (a long link): keep it whole and break at the first space after it.
      for (let i = max + 1; i < rest.length; i++) {
        if (rest[i] === " " && breakRank(rest, i, blocked) > 0) {
          best = i;
          break;
        }
      }
      if (best === -1) break;
    }
    // Nothing is reworded: the pieces joined by a space are the original text, except that a comma or
    // semicolon left hanging at the end of a bubble is dropped (a bubble never ends on a comma).
    out.push(rest.slice(0, best).trim().replace(/[,;]$/, ""));
    rest = rest.slice(best + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Splits one long bubble into several at sentence ends, then clause boundaries, then (last resort) between words.
 * Never mid-word, and never inside a link, an email, a phone number or a pickup code. A bubble that ends up
 * ending on a comma loses that comma; no other character changes. A bubble that fits is
 * returned as is. A short option list (one short item per line) becomes one bubble per item; other multi-line
 * text keeps its lines together as far as they fit.
 */
export function chunkBubble(text: string, max: number = TIMING.chunkChars): string[] {
  if ([...text].length <= max) return [text];
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) return splitLine(text, max);
  if (lines.every((l) => l.length <= 60)) return lines;
  const out: string[] = [];
  let cur = "";
  for (const line of lines) {
    if (cur && cur.length + 1 + line.length <= max) {
      cur += "\n" + line;
      continue;
    }
    if (cur) out.push(cur);
    cur = "";
    if (line.length <= max) cur = line;
    else {
      const parts = splitLine(line, max);
      cur = parts.pop() ?? "";
      out.push(...parts);
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** What one turn said: whether anything went out, and the id of the last bubble (the open question, if a step is left open). */
type Track = { said: boolean; lastId: string | null; on: (ids?: (string | null)[]) => void };
function newTrack(): Track {
  const t: Track = {
    said: false,
    lastId: null,
    on(ids) {
      t.said = true;
      for (const id of ids ?? []) if (id) t.lastId = id;
    },
  };
  return t;
}

/** One incoming message's reply. `ready` resolves once "Read" has had its beat; nothing is typed or sent before it. */
type Turn = { sent: boolean; ready: Promise<void>; done: boolean };
const freeTurn = (): Turn => ({ sent: false, ready: Promise.resolve(), done: false });

/** Adapter calls that are nice to have (typing, read receipts) must never break a reply. */
async function quiet<T>(p: Promise<T>, fallback: T): Promise<T> {
  try {
    return await p;
  } catch {
    return fallback;
  }
}

/** Error name and where it happened. The message is left out because it could quote user text. */
export function describe(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  const where = (err.stack ?? "").split("\n").find((l) => l.trim().startsWith("at ")) ?? "";
  return `${err.name} ${where.trim()}`;
}

export function getNotes(db: DatabaseSync, userId: number): string[] {
  return (db.prepare("SELECT text FROM user_notes WHERE userId = ? ORDER BY id").all(userId) as { text: string }[]).map((n) => n.text);
}

export function createPipeline(deps: PipelineDeps): { handleEvent(e: IncomingEvent): Promise<void>; sweep(now?: number): Promise<void> } {
  const { db } = deps;
  const detectIntent = deps.detectIntent ?? realDetectIntent;
  const pause = deps.pause ?? sleep;
  const random = deps.random ?? Math.random;
  const ackAfterMs = deps.ackAfterMs ?? 3000;
  const queues = new Map<string, Promise<void>>();
  /** Message ids of STOP texts that were applied the moment they arrived and still need their one confirmation. */
  const stopConfirm = new Set<string>();
  let ackTurn = 0;

  const isStopped = (userId: number) => !!getUserById(db, userId)?.stopped;

  /** Saved locations go through src/location.ts (tests can pass their own store). */
  async function locationStore(): Promise<LocationStore | null> {
    return deps.location ?? { saveUserLocation, forgetUserLocation };
  }
  async function saveLocation(userId: number, loc: { lat: number; lng: number }): Promise<void> {
    if (!Number.isFinite(loc?.lat) || !Number.isFinite(loc?.lng)) return;
    try {
      const store = await locationStore();
      if (store) store.saveUserLocation(db, userId, { lat: loc.lat, lng: loc.lng }, "find_my");
      else console.error("pipeline error: location store missing");
    } catch (err) {
      console.error("pipeline error:", describe(err));
    }
  }
  async function forgetLocation(userId: number): Promise<void> {
    try {
      const store = await locationStore();
      if (store) store.forgetUserLocation(db, userId);
      else console.error("pipeline error: location store missing");
    } catch (err) {
      console.error("pipeline error:", describe(err));
    }
  }

  /** 1 for a student, JUDGE_PACE for a judge. */
  const paceOf = (userId: number): number => {
    const u = getUserById(db, userId);
    return u && isJudge(u) ? JUDGE_PACE : 1;
  };
  /** Pace and tone for whoever owns a chat (for the adapter calls flows make directly: polls, the contact card). */
  function chatOwner(chatId: string): { pace: number; plain: boolean } {
    const row = db.prepare("SELECT id FROM users WHERE chatId = ? LIMIT 1").get(chatId) as { id: number } | undefined;
    return row ? { pace: paceOf(row.id), plain: plainTone(db, row.id) } : { pace: 1, plain: false };
  }

  /** A new turn: the read beat starts now (the caller has just marked the chat read). */
  const newTurn = (): Turn => ({ sent: false, ready: pause(between(TIMING.readBeat, random())).catch(() => {}), done: false });

  /**
   * Send bubbles to one chat. Each one: typing for a time that fits its length, the bubble, then a short gap
   * before typing the next. Long bubbles are split first. Stopped users get nothing.
   * `turn` is the incoming message being answered: its first bubble waits for the read beat, and anything
   * after the first send of the turn gets the gap. `instant` sends the first bubble with no wait at all
   * (emergency and crisis replies). Returns one id per bubble passed in (the last piece's, when it was split).
   */
  async function send(
    to: User,
    chatId: string,
    bubbles: (string | PacedBubble)[],
    opts: { force?: boolean; turn?: Turn; instant?: boolean; noSave?: boolean; notice?: boolean } = {},
  ): Promise<(string | null)[]> {
    const adapter = deps.getAdapter();
    const turn = opts.turn;
    const ids: (string | null)[] = [];
    const stopped = () => !opts.force && isStopped(to.id);
    // Read fresh: the person may have become a judge, or tapped "drop the slang", earlier in this same turn.
    const pace = paceOf(to.id);
    const plain = plainTone(db, to.id);
    let sentAny = false;
    let first = true;
    let continued = !!turn?.sent;
    if (turn) turn.sent = true;
    for (let n = 0; n < bubbles.length; n++) {
      const b = bubbles[n]!;
      const bubble: PacedBubble = typeof b === "string" ? { text: b } : b;
      // Plain tone: spelled-out standard English for this person. The safety list comes back untouched.
      // Someone else's words (a relayed message, a thank-you note) are passed along exactly as written.
      const pieces = chunkBubble(plain && !bubble.verbatim ? toPlain(bubble.text) : bubble.text);
      let id: string | null = null;
      for (let k = 0; k < pieces.length; k++) {
        const text = pieces[k];
        if (stopped()) break;
        const instant = first && !!opts.instant;
        if (first && turn && !instant) await turn.ready;
        if (continued) await pause(Math.round(between(TIMING.gap, random()) * pace));
        first = false;
        continued = true;
        if (!instant) {
          if (stopped()) break;
          await quiet(adapter.startTyping(chatId), undefined);
          await pause(Math.round(typingMs(text, random()) * pace));
        }
        // Checked again after the pause, right before the send, so a STOP that lands mid-reply wins.
        if (stopped()) break;
        const effect = bubble.effect && k === pieces.length - 1 ? { effect: bubble.effect } : undefined;
        const sent = await quiet(adapter.sendMessage(chatId, text, effect), null);
        // `notice`: not a reply in this person's own turn, so free chat must not read it back as Troy's own words.
        if (sent && !opts.noSave) saveMessage(db, { userId: to.id, chatId, direction: "out", providerMessageId: sent.messageId, text, notice: opts.notice });
        sentAny = sentAny || !!sent;
        id = sent?.messageId ?? null;
      }
      ids.push(id);
      // A longer beat the caller asked for (after the contact card line, before a change of subject). Only between
      // bubbles: nothing waits after the last one.
      const beat = Number(bubble.pauseAfterMs);
      if (id && Number.isFinite(beat) && beat > 0 && n < bubbles.length - 1 && !stopped()) {
        await quiet(adapter.stopTyping(chatId), undefined);
        await pause(Math.round(Math.min(beat, 15_000) * pace));
      }
    }
    if (sentAny || !isStopped(to.id)) await quiet(adapter.stopTyping(chatId), undefined);
    return ids;
  }

  /** Who a chat belongs to, for the STOP check on direct adapter calls. */
  function chatStopped(chatId: string): boolean {
    const row = db.prepare("SELECT stopped FROM users WHERE chatId = ? LIMIT 1").get(chatId) as { stopped: number } | undefined;
    return !!row?.stopped;
  }

  /**
   * The adapter that flows and onboarding get. Same adapter, but anything aimed at a stopped user's chat is
   * dropped, and a contact card, poll or location request gets typing and a pause first. Typing is turned off again
   * right after it: when one of these is the last thing in a reply, nothing else would clear the indicator.
   */
  function flowAdapter(turn: Turn): MessagingAdapter {
    const real = deps.getAdapter();
    const lead = async (chatId: string) => {
      const { pace } = chatOwner(chatId);
      await turn.ready;
      if (turn.sent) await pause(Math.round(between(TIMING.gap, random()) * pace));
      turn.sent = true;
      if (chatStopped(chatId)) return;
      await quiet(real.startTyping(chatId), undefined);
      await pause(Math.round(between(TIMING.attachment, random()) * pace));
    };
    const worded = (chatId: string, text: string): string => (chatOwner(chatId).plain ? toPlain(text) : text);
    const landed = async <T>(chatId: string, sending: Promise<T>): Promise<T> => {
      try {
        return await sending;
      } finally {
        await quiet(real.stopTyping(chatId), undefined);
      }
    };
    return {
      provider: real.provider,
      capabilities: () => real.capabilities(),
      sendMessage: async (chatId, text, opts) => (chatStopped(chatId) ? null : real.sendMessage(chatId, worded(chatId, text), opts)),
      sendImage: async (chatId, path, caption) => (chatStopped(chatId) ? null : real.sendImage(chatId, path, caption)),
      async sendContactCard(chatId) {
        if (chatStopped(chatId)) return null;
        await lead(chatId);
        return chatStopped(chatId) ? null : landed(chatId, real.sendContactCard(chatId));
      },
      markRead: async (chatId) => (chatStopped(chatId) ? undefined : real.markRead(chatId)),
      startTyping: async (chatId) => (chatStopped(chatId) ? undefined : real.startTyping(chatId)),
      stopTyping: (chatId) => real.stopTyping(chatId),
      react: async (chatId, messageId, type) => (chatStopped(chatId) ? false : real.react(chatId, messageId, type)),
      editMessage: async (chatId, messageId, text) => (chatStopped(chatId) ? false : real.editMessage(chatId, messageId, text)),
      async sendPoll(chatId, question, options) {
        const none = { optionMessageIds: options.map(() => null), mode: "tap" as const };
        if (chatStopped(chatId)) return none;
        await lead(chatId);
        if (chatStopped(chatId)) return none;
        // A poll's question and options are bubbles too.
        return landed(chatId, real.sendPoll(chatId, worded(chatId, question), options.map((o) => worded(chatId, o).replace(/\.$/, ""))));
      },
      createGroupChat: (members, firstMessage) => real.createGroupChat(members, firstMessage),
      getLiveLocation: (handle) => real.getLiveLocation(handle),
      async requestLocation(chatId) {
        if (chatStopped(chatId) || typeof real.requestLocation !== "function") return false;
        await lead(chatId);
        return chatStopped(chatId) ? false : landed(chatId, quiet(real.requestLocation(chatId), false));
      },
      onAllowed: async (chatId) => quiet(Promise.resolve(real.onAllowed?.(chatId)), undefined),
      onDisallowed: async (chatId) => quiet(Promise.resolve(real.onDisallowed?.(chatId)), undefined),
      chatIdForHandle: (handle) => real.chatIdForHandle(handle),
    };
  }

  /** What flows get outside a conversation: timers, and the cleanup after STOP or "delete my data". */
  function sweepIo(): SweepIo {
    return {
      db,
      adapter: flowAdapter(freeTurn()),
      async sayTo(userId, ...bubbles) {
        const other = getUserById(db, userId);
        if (!other || other.stopped) return bubbles.map(() => null);
        return send(other, other.chatId, bubbles, { notice: true });
      },
    };
  }

  /**
   * For what Troy starts on his own in the first ten minutes. Unlike sweepIo these are his own words (not a notice),
   * so the chat brain reads them back as things he said. Held back by quiet hours like any unprompted text.
   */
  function firstTenIo(): SweepIo {
    return {
      db,
      // Looked up when used, not when this is built: the server creates the pipeline before the adapter exists.
      get adapter() {
        return flowAdapter(freeTurn());
      },
      async sayTo(userId, ...bubbles) {
        const other = getUserById(db, userId);
        if (!other || other.stopped || inQuietHours(other)) return bubbles.map(() => null);
        return send(other, other.chatId, bubbles);
      },
    };
  }

  /** Parked questions go out to whoever is free now. */
  const deliver = (now?: number) => deliverPending(db, (to, bubbles) => send(to, to.chatId, bubbles, { notice: true }), now);

  /**
   * `owner` is the flow this context is handed to. A flow may only clear or replace its own open step:
   * another flow's protected question (a finder being asked how to hand an item off) is left alone when a
   * different flow says "done", and parked to be asked again when a different flow opens a step of its own.
   */
  function makeContext(user: User, event: IncomingEvent, intent: Intent, state: FlowState | null, onSay: (ids?: (string | null)[]) => void, owner: FlowName | undefined, turn: Turn): FlowContext {
    return {
      db,
      user,
      event,
      intent,
      state,
      adapter: flowAdapter(turn),
      async say(...bubbles) {
        onSay();
        const sent = await send(user, event.chatId, bubbles, { turn });
        onSay(sent);
        return sent;
      },
      async sayTo(userId, ...bubbles) {
        const other = getUserById(db, userId);
        if (!other || other.stopped || inQuietHours(other)) return bubbles.map(() => null);
        // To someone else's chat: a relayed message, an alert, a question about their item. Saved as a notice.
        return send(other, other.chatId, bubbles, { notice: other.id !== user.id });
      },
      async sayToOwed(userId, ...bubbles) {
        const other = getUserById(db, userId);
        if (!other || other.stopped) return bubbles.map(() => null);
        return send(other, other.chatId, bubbles, { notice: other.id !== user.id });
      },
      setState: (s) => {
        const cur = getFlowState(db, user.id);
        if (owner && cur && cur.flow !== owner && isProtected(db, cur)) {
          if (!s) return;
          parkAsk(db, user.id, { flow: cur.flow, step: cur.step, data: cur.data });
        }
        setFlowState(db, user.id, s);
      },
      setStateFor: (userId, s) => setFlowState(db, userId, s),
    };
  }

  // ---------- Troy's own short questions (a confirmation, a check-in) ----------

  const askSlot = (userId: number) => `ask:${userId}`;

  /** The question of Troy's own this person has open, if it hasn't lapsed. */
  function openAsk(userId: number, now = Date.now()): OpenAsk | null {
    try {
      const raw = getSetting(db, askSlot(userId));
      if (!raw) return null;
      const ask = JSON.parse(raw) as OpenAsk;
      if (!ask || typeof ask.kind !== "string" || typeof ask.at !== "number") return null;
      return now - ask.at < (ask.kind === "checkin" ? CHECKIN_TTL_MS : ASK_TTL_MS) ? ask : null;
    } catch {
      return null;
    }
  }
  /** The row id of the newest thing Troy sent in a chat, or null. */
  function newestOut(chatId: string): number | null {
    try {
      const row = db.prepare("SELECT id FROM messages WHERE chatId = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(chatId) as { id: number } | undefined;
      return row ? Number(row.id) : null;
    } catch {
      return null;
    }
  }
  /** True while the question is still the last thing Troy said in that chat. */
  function askIsLastWord(ask: OpenAsk, chatId: string): boolean {
    return ask.lastOut === undefined || ask.lastOut === null || newestOut(chatId) === ask.lastOut;
  }
  function setAsk(userId: number, ask: OpenAsk | null): void {
    try {
      setSetting(db, askSlot(userId), ask ? JSON.stringify(ask) : "");
    } catch {
      // A question that could not be remembered is simply not open.
    }
  }

  /** One reply from a command pool, never the wording this person got last time. "|" splits it into bubbles. */
  function vary(user: User, key: keyof typeof COMMAND_POOLS, values: Record<string, string> = {}): string[] {
    let line = pickVariant(db, user.id, `cmd:${key}`, [...COMMAND_POOLS[key]]);
    for (const [k, v] of Object.entries(values)) line = line.replaceAll(`{${k}}`, v);
    return line.split("|").map((b) => b.trim()).filter(Boolean);
  }

  /** Replies stay gentle for the next hour (the chat brain reads this flag on every free reply). */
  function markHeavy(userId: number): void {
    const fn = (brainMod as Record<string, unknown>).markHeavy;
    if (typeof fn !== "function") return;
    try {
      (fn as (d: DatabaseSync, u: number, minutes?: number) => void)(db, userId, HEAVY_MINUTES);
    } catch {
      // Never worth losing a reply over.
    }
  }

  /** The model's read of an ambiguous message, or null when there is no model to ask. */
  function safetyReader(): SafetyReader | null {
    if (deps.readSafety !== undefined) return deps.readSafety;
    const fn = (aiMod as Record<string, unknown>).readSafety;
    return typeof fn === "function" && modelReady() ? (fn as SafetyReader) : null;
  }

  /** The last few texts of this chat, oldest first, without the one being read. */
  function recentTexts(chatId: string, exceptMessageId: string): { from: "student" | "troy"; text: string }[] {
    try {
      const rows = db.prepare("SELECT direction, providerMessageId, text FROM messages WHERE chatId = ? ORDER BY id DESC LIMIT 9").all(chatId) as { direction: string; providerMessageId: string | null; text: string | null }[];
      return rows
        .filter((r) => !(r.direction === "in" && r.providerMessageId === exceptMessageId) && !!r.text?.trim())
        .slice(0, 8)
        .reverse()
        .map((r) => ({ from: r.direction === "in" ? ("student" as const) : ("troy" as const), text: String(r.text).slice(0, 300) }));
    } catch {
      return [];
    }
  }

  /**
   * A message code can't call either way ("kms", a dark line with a laugh in it, something heavy): the model reads
   * it in its conversation. With no model, anything with self-harm words in it falls back to the fixed line.
   */
  async function readAmbiguous(event: IncomingEvent, selfHarmWords: boolean): Promise<SafetyRead> {
    const reader = safetyReader();
    const failSafe: SafetyRead = selfHarmWords ? "crisis" : "none";
    if (!reader) return failSafe;
    try {
      const read = await reader({ text: event.text, history: recentTexts(event.chatId, event.messageId) });
      return read === "joke" || read === "concern" || read === "crisis" || read === "none" ? read : failSafe;
    } catch {
      return failSafe;
    }
  }

  /**
   * Their answer to Troy's check-in question. A yes or a dodge gets the fixed crisis line; only a clear "no, i'm
   * fine" goes back to normal chat (which stays gentle for the next hour).
   */
  async function readCheckInAnswer(event: IncomingEvent): Promise<"crisis" | "fine"> {
    const signal = safetySignal(event.text);
    const answer = readYesNo({ event, questionMessageId: null });
    if (answer === "yes" || signal.level === "crisis") return "crisis";
    if (answer === "no" && !signal.selfHarmWords) return "fine";
    const reader = safetyReader();
    if (reader) {
      try {
        const read = await reader({ text: event.text, history: recentTexts(event.chatId, event.messageId) });
        return read === "joke" || read === "none" ? "fine" : "crisis";
      } catch {
        // Falls through to the rule below.
      }
    }
    // No model: a plain denial with nothing dark in it is taken at its word. Anything else is a dodge.
    const t = event.text.toLowerCase().replace(/[‘’]/g, "'").trim();
    const denies = /^(?:no+|nah+|nope|i'?m (?:ok|okay|fine|good|alright)|im (?:ok|okay|fine|good|alright)|jk|just (?:kidding|joking)|not (?:at all|really|like that)|all good)\b/.test(t);
    return denies && !signal.selfHarmWords ? "fine" : "crisis";
  }

  async function runCommand(kind: CommandKind, user: User, event: IncomingEvent, turn: Turn): Promise<void> {
    const say = (bubbles: string[], force = false) => send(user, event.chatId, bubbles, { force, turn });
    const adapter = deps.getAdapter();
    // Any exact command closes whatever question of Troy's own was open.
    setAsk(user.id, null);
    switch (kind) {
      // Safety replies go out even to someone who texted STOP earlier: silence on a fire text is the worse failure.
      // The first bubble (call 911, text 988) goes out at once, with no read beat and no typing wait.
      case "emergency":
        markHeavy(user.id);
        await send(user, event.chatId, TEMPLATES.emergency, { force: true, turn, instant: true });
        return;
      case "crisis":
        markHeavy(user.id);
        cancelFirstTen(db, user.id);
        await send(user, event.chatId, TEMPLATES.crisis, { force: true, turn, instant: true });
        return;
      case "stop":
        // Already applied in handleEvent the moment the text arrived. Clear whatever the reply that was
        // in flight left behind, then send the one text a stopped user still gets: the confirmation.
        updateUser(db, user.id, { stopped: 1 });
        setFlowState(db, user.id, null);
        cancelFirstTen(db, user.id);
        await say(TEMPLATES.stop, true);
        await forgetLocation(user.id);
        // After the confirmation, so the provider still lets that one text out.
        await quiet(Promise.resolve(adapter.onDisallowed?.(event.chatId)), undefined);
        // Whatever they were holding (a claim on a found item, a question to them) is let go, so nobody waits on them.
        await runUserGone(sweepIo(), user.id);
        return;
      case "start":
        if (!user.stopped) {
          await say(TEMPLATES.startAlready);
          return;
        }
        updateUser(db, user.id, { stopped: 0 });
        await quiet(Promise.resolve(adapter.onAllowed?.(event.chatId)), undefined);
        await say(TEMPLATES.start);
        return;
      case "forget_location":
        await forgetLocation(user.id);
        await say(TEMPLATES.forgetLocation);
        return;
      case "help":
        await say(TEMPLATES.help);
        return;
      case "pause":
        updateUser(db, user.id, { paused: 1 });
        cancelFirstTen(db, user.id);
        await say(TEMPLATES.pause);
        return;
      case "resume":
        updateUser(db, user.id, { paused: 0 });
        await say(TEMPLATES.resume);
        return;
      case "human":
        await say(TEMPLATES.human);
        return;
      case "settings":
        await say(TEMPLATES.settings(user));
        return;
      case "delete_data":
        // Listings and reports stay (other people depend on them) but nothing personal does.
        db.prepare("DELETE FROM messages WHERE userId = ?").run(user.id);
        db.prepare("DELETE FROM user_notes WHERE userId = ?").run(user.id);
        db.prepare("DELETE FROM note_effects WHERE userId = ?").run(user.id);
        db.prepare("DELETE FROM verification_codes WHERE userId = ?").run(user.id);
        setFlowState(db, user.id, null);
        cancelFirstTen(db, user.id);
        forgetJudge(db, user.id);
        updateUser(db, user.id, {
          name: null,
          uscEmail: null,
          verifiedAt: null,
          verifiedVia: null,
          subscriptions: "[]",
          usualSpots: "[]",
          quietHours: null,
          alertMinutes: 15,
          paused: 0,
        });
        await forgetLocation(user.id);
        // Their spot under the sign-up cap is free until they text again (the gate takes it back then).
        releaseSeat(db, user.handle);
        // Not saved: nothing of theirs stays in the messages table.
        await send(user, event.chatId, TEMPLATES.deleteData, { turn, noSave: true });
        await quiet(Promise.resolve(adapter.onDisallowed?.(event.chatId)), undefined);
        await runUserGone(sweepIo(), user.id);
        return;
    }
  }

  // ---------- commands by meaning ----------

  /**
   * Do what a command means, once code is sure it was meant (a clear read, or a yes to Troy's question).
   * STOP and delete go through the same code as the exact words and get the same fixed confirmation. The settings
   * (pause, resume, forget my location, one topic) are confirmed in varied words.
   */
  async function performCommand(kind: Exclude<AskKind, "checkin">, user: User, event: IncomingEvent, turn: Turn, topicId?: number): Promise<void> {
    const say = (bubbles: string[]) => send(user, event.chatId, bubbles, { turn });
    switch (kind) {
      case "stop":
      case "start":
      case "delete_data":
        await runCommand(kind, user, event, turn);
        return;
      case "pause":
        updateUser(db, user.id, { paused: 1 });
        cancelFirstTen(db, user.id);
        await say(vary(user, "pause"));
        return;
      case "resume":
        updateUser(db, user.id, { paused: 0 });
        await say(vary(user, "resume"));
        return;
      case "forget_location":
        await forgetLocation(user.id);
        await say(vary(user, "forgetLocation"));
        return;
      case "unsubscribe_topic": {
        const topic = typeof topicId === "number" ? topics.getTopic(db, topicId) : null;
        if (!topic) {
          await say(vary(user, "whichTopic"));
          return;
        }
        topics.unsubscribe(db, user.id, topic.id);
        // What he says is what will actually happen, in plain words. Never the poll label.
        await say(vary(user, "unsubscribed", { what: topic.plain }));
        return;
      }
    }
  }

  const ASK_POOL: Record<"stop" | "start" | "pause" | "resume" | "forget_location", keyof typeof COMMAND_POOLS> = { stop: "askStop", start: "askStart", pause: "askPause", resume: "askResume", forget_location: "askForgetLocation" };

  /**
   * The model read this message as a command worded another way ("leave me alone", "stop the food texts").
   * It only says which one was meant: code decides whether to act, ask first or do nothing, and code does it.
   * Returns false when nothing was done, so the message is handled like any other.
   */
  async function handleMeantCommand(command: NonNullable<Intent["command"]>, user: User, event: IncomingEvent, turn: Turn): Promise<boolean> {
    // "stop lol", "omg stop 😂": never acted on unless the read was certain.
    if (command.certainty !== "clear" && endsPlayful(event.text)) return false;
    // Asking how to control him is a question. The chat brain answers it; the exact word HELP still gets the fixed list.
    if (command.name === "help") return false;
    const ask = async (bubbles: string[], open: Omit<OpenAsk, "qid" | "at">): Promise<boolean> => {
      const ids = await send(user, event.chatId, bubbles, { turn });
      const last = [...ids].reverse().find((id) => !!id) ?? null;
      // The bubble is kept for every question, the delete one too: a tapback still never answers that one
      // (answerAsk refuses it), but a tap anywhere else is how code knows they moved on.
      setAsk(user.id, { ...open, qid: last, at: Date.now(), lastOut: newestOut(event.chatId) });
      return true;
    };
    // Anything that destroys data asks once first, however sure the read was.
    if (command.name === "delete_data") return ask(vary(user, "askDelete"), { kind: "delete_data" });
    if (command.name === "unsubscribe_topic") {
      const topic = command.topic ? topics.findTopic(db, command.topic) : null;
      if (!topic) {
        // One short question. Their answer ("the food ones") comes back through the same read.
        await send(user, event.chatId, vary(user, "whichTopic"), { turn });
        return true;
      }
      if (!topics.isSubscribed(db, user.id, topic)) {
        await send(user, event.chatId, vary(user, "notSubscribed"), { turn });
        return true;
      }
      if (command.certainty !== "clear") return ask(vary(user, "askUnsubscribe", { what: topic.plain }), { kind: "unsubscribe_topic", topicId: topic.id });
      await performCommand("unsubscribe_topic", user, event, turn, topic.id);
      return true;
    }
    if (command.name === "start" && !user.stopped) return false;
    if (command.certainty !== "clear") return ask(vary(user, ASK_POOL[command.name]), { kind: command.name });
    await performCommand(command.name, user, event, turn);
    return true;
  }

  /**
   * An answer to one of Troy's own yes/no questions. True when it was one (a yes performs, a no leaves things as
   * they are). Anything else lets the question lapse and the message is handled normally. Deleting data only ever
   * takes a typed yes.
   */
  async function answerAsk(ask: OpenAsk, user: User, event: IncomingEvent, turn: Turn): Promise<boolean> {
    if (ask.kind === "checkin") return false;
    // Something else of his went out since he asked (they tapped a poll and he answered, a parked question was
    // delivered, he started something himself): a typed "yes" now answers that, never this. The question is closed.
    if (!event.reaction && !askIsLastWord(ask, event.chatId)) {
      setAsk(user.id, null);
      return false;
    }
    const answer = readYesNo({ event, questionMessageId: ask.qid, allowTapback: ask.kind !== "delete_data" });
    if (event.reaction && !answer) return false;
    setAsk(user.id, null);
    if (answer === "yes") {
      await performCommand(ask.kind, user, event, turn, ask.topicId);
      return true;
    }
    if (answer === "no") {
      await send(user, event.chatId, vary(user, ask.kind === "delete_data" ? "keptData" : "kept"), { turn });
      return true;
    }
    return false;
  }

  /** Exactly one acknowledgement, and only if the handler is still quiet when the timer fires. */
  function startAckTimer(event: IncomingEvent, user: User, hasSaid: () => boolean): () => void {
    const timer = setTimeout(async () => {
      if (hasSaid() || isStopped(user.id)) return;
      try {
        const adapter = deps.getAdapter();
        if (adapter.capabilities().tapbacks && (await adapter.react(event.chatId, event.messageId, event.images.length ? "love" : "like"))) return;
        if (hasSaid() || isStopped(user.id)) return;
        const ack = TEMPLATES.acks[ackTurn++ % TEMPLATES.acks.length]!;
        const line = plainTone(db, user.id) ? toPlain(ack) : ack;
        const sent = await adapter.sendMessage(event.chatId, line);
        if (sent) saveMessage(db, { userId: user.id, chatId: event.chatId, direction: "out", providerMessageId: sent.messageId, text: line });
      } catch {
        // An acknowledgement is optional.
      }
    }, ackAfterMs);
    return () => clearTimeout(timer);
  }

  const TOUR = "tour" as FlowName;

  function pickHandler(intent: Intent, state: FlowState | null): FlowHandler {
    const smalltalk = getFlow("smalltalk")!;
    const open = state ? getFlow(state.flow) : null;
    const wanted = getFlow(intent.flow);
    // Mid-example, a description that says "lost" or "broken" is still the description: the tour keeps it and
    // leaves by itself when they say it's for real. Nothing typed into the example may file a real report.
    if (open && state?.flow === TOUR && TOUR_HOLD_STEPS.has(state.step)) return open;
    // The open flow keeps the conversation unless the model is sure this starts something else.
    const startsNew = intent.source === "ai" && intent.flow !== "smalltalk" && intent.flow !== state?.flow && !!wanted;
    if (open && !startsNew) return open;
    return wanted ?? smalltalk;
  }

  /** Flows whose turn means the student asked for something real, which ends the first-ten-minutes plan. */
  const isRealRequest = (flow: FlowName) => flow !== "smalltalk" && flow !== TOUR && flow !== "onboarding";

  async function handleTap(user: User, event: IncomingEvent, state: FlowState | null): Promise<void> {
    // A tap is not a text: no read receipt, so no read beat either.
    const turn = freeTurn();
    if (event.reaction) {
      // Only tapbacks on Troy's own messages in this chat mean anything.
      const target = db
        .prepare("SELECT id FROM messages WHERE providerMessageId = ? AND chatId = ? AND direction = 'out' LIMIT 1")
        .get(event.reaction.targetMessageId, event.chatId);
      if (!target) return;
      // A thumbs up or down on one of Troy's own yes/no questions (never the delete question, never the check-in).
      const ask = openAsk(user.id);
      if (ask && (await answerAsk(ask, user, event, turn))) return;
    }
    // "want me to delete everything?" does not stay armed through a tap on anything else: a poll vote, or a tapback
    // on some other bubble, means they moved on, and a later "yes" must never be read as the answer to it.
    // (A tapback on the delete question itself changes nothing either way: it only ever takes a typed yes.)
    const armed = openAsk(user.id);
    if (armed?.kind === "delete_data" && !(event.reaction && !!armed.qid && event.reaction.targetMessageId === armed.qid)) setAsk(user.id, null);
    // Which bubble is this person's open question, and whether this tap answers it: a heart or thumbs up on exactly
    // that bubble is a yes, a thumbs down a no. A tap anywhere else is only an acknowledgement. Flows read it from
    // intent.details.yesNo; a step that can't be answered by a tap (a description, a code, a name) ignores it.
    const qid = openQuestionId(db, user.id, state);
    const yesNo = readYesNo({ event, questionMessageId: qid });
    const details: Record<string, unknown> = {};
    if (yesNo) details.yesNo = yesNo;
    if (event.reaction) details.onOpenQuestion = !!qid && event.reaction.targetMessageId === qid;
    const intent: Intent = { flow: state?.flow ?? "food", action: event.reaction ? "reaction" : "poll_vote", details, source: "fallback" };
    // A judge's tap on the "drop the slang" bubble, at any point (it is sent in the middle of onboarding).
    if (event.reaction && (await handleToneTap(makeContext(user, event, intent, state, () => {}, undefined, turn)))) return;
    if (needsOnboarding(user, state)) {
      const track = newTrack();
      await handleOnboarding(makeContext(user, event, intent, state, track.on, "onboarding", turn), { saveLocation });
      noteOpenQuestion(db, user.id, getFlowState(db, user.id), track.lastId);
      return;
    }
    const track = newTrack();
    const plain = makeContext(user, event, intent, state, track.on, undefined, turn);
    try {
      // The alerts poll stays live: a vote added or removed at any time is saved and acknowledged briefly.
      const alertVote = (onboardingMod as Record<string, unknown>).handleAlertPollVote;
      if (typeof alertVote === "function" && (await (alertVote as (c: FlowContext) => Promise<boolean>)(plain))) return;
      // The "try me" poll and the "near u" bubbles.
      if (await firstTenTap(plain)) return;
      // A tapback on a food alert bubble is a claim, whatever else the person is in the middle of.
      const onFoodAlert = !!event.reaction && !!db.prepare("SELECT 1 FROM food_alert_bubbles WHERE messageId = ? AND userId = ? LIMIT 1").get(event.reaction.targetMessageId, user.id);
      const owner = (onFoodAlert && getFlow("food")) || (state && getFlow(state.flow)) || getFlow("food");
      if (owner) {
        if (isRealRequest(owner.name) && (onFoodAlert || state)) cancelFirstTen(db, user.id);
        await owner.handle(makeContext(user, event, { ...intent, flow: owner.name }, state, track.on, owner.name, turn));
      }
    } finally {
      noteOpenQuestion(db, user.id, getFlowState(db, user.id), track.lastId);
    }
    await judgeAfterTour(user, event, intent, state, turn);
  }

  /**
   * The judge's wrap-up (John, "Judge mode" (6)): once, when a judge who went through the try-it tour has nothing
   * left open. `before` is the state this message arrived in, so it only fires on the turn that closed something.
   */
  async function judgeAfterTour(user: User, event: IncomingEvent, intent: Intent, before: FlowState | null, turn: Turn): Promise<void> {
    try {
      // Only when this message closed a step of the tour itself, and a run actually reached its end: a judge who
      // backs out ("stop the example") gets no wrap-up and keeps it for when they do finish. A real flow closing never counts.
      if (!before || before.flow !== TOUR || getFlowState(db, user.id)) return;
      const now = getUserById(db, user.id);
      if (!now || !isJudge(now) || now.stopped || wrapUpSent(db, now.id)) return;
      if (!tourWasFinished(db, now.id)) return;
      await judgeWrapUp(makeContext(now, event, intent, null, () => {}, undefined, turn));
    } catch (err) {
      console.error("pipeline error:", describe(err));
    }
  }

  async function process(event: IncomingEvent): Promise<void> {
    if (!isEnabled(db)) return;
    // Troy steps back once a handoff group chat exists.
    if (event.isGroup) return;
    const adapter = deps.getAdapter();
    const user = getOrCreateUser(db, event.userHandle, event.chatId);
    const tap = !!(event.reaction || event.pollVote);

    if (tap) {
      if (!user.stopped) {
        await handleTap(user, event, getFlowState(db, user.id));
        await deliver();
      }
      return;
    }

    const command = matchCommand(event.text);
    const safety = command?.kind === "emergency" || command?.kind === "crisis";
    // What code can't call either way. Read by the model below; never the fixed line on the pattern alone.
    const signal = command ? null : safetySignal(event.text);

    // Opted out: nothing is saved, marked read or answered. Only START (or "hey troy"), the STOP confirmation and safety replies get through.
    if (user.stopped) {
      if (command?.kind === "stop") {
        if (stopConfirm.delete(event.messageId)) await runCommand("stop", user, event, freeTurn());
        return;
      }
      if (safety) await runCommand(command.kind, user, event, freeTurn());
      // Their texts are never sent anywhere after STOP, the model included: self-harm words alone get the fixed line.
      else if (signal?.level === "ambiguous" && signal.selfHarmWords) await runCommand("crisis", user, event, freeTurn());
      else if (command?.kind === "start" || (!command && isHeyTroy(event.text))) {
        void quiet(adapter.markRead(event.chatId), undefined);
        await runCommand("start", user, event, newTurn());
      }
      return;
    }

    // "delete my data" is the one message we don't keep.
    if (command?.kind !== "delete_data") {
      saveMessage(db, { userId: user.id, chatId: event.chatId, direction: "in", providerMessageId: event.messageId, text: event.text, media: event.images });
    }
    // "Read" first. Nothing is typed or sent until the read beat is over (safety replies excepted).
    void quiet(adapter.markRead(event.chatId), undefined);
    const turn = newTurn();
    noteStudentMessage(db, user.id);

    if (command) {
      await runCommand(command.kind, user, event, turn);
      await deliver();
      return;
    }

    // A question of Troy's own is open: his check-in, or "want me to ...? reply "yes"".
    const ask = openAsk(user.id);
    if (ask?.kind === "checkin") {
      setAsk(user.id, null);
      if ((await readCheckInAnswer(event)) === "crisis") {
        await runCommand("crisis", user, event, turn);
        await deliver();
        return;
      }
      // A clear "no, i'm fine": the message goes on as usual, and replies stay gentle for the hour.
    } else if (ask && (await answerAsk(ask, user, event, turn))) {
      await deliver();
      return;
    }

    // Jokes versus real distress: the model reads anything ambiguous in its conversation.
    if (signal?.level === "ambiguous" && ask?.kind !== "checkin") {
      const read = await readAmbiguous(event, signal.selfHarmWords);
      if (read === "crisis") {
        await runCommand("crisis", user, event, turn);
        await deliver();
        return;
      }
      if (read === "concern") {
        // He checks in like a person: one direct, kind question. No hotline wall, no emoji. A yes or a dodge to it
        // gets the fixed crisis line (see readCheckInAnswer).
        markHeavy(user.id);
        cancelFirstTen(db, user.id);
        const idle: Intent = { flow: "smalltalk", action: "check_in", details: {}, source: "fallback" };
        const ctx = makeContext(user, event, idle, getFlowState(db, user.id), () => {}, undefined, turn);
        const bubbles = (await inHisWords(ctx, "safety:checkin", CHECK_IN)).map((b) => b.replace(/(?:\p{Extended_Pictographic}|\p{Regional_Indicator})[️‍\u{1F3FB}-\u{1F3FF}]*/gu, "").trim()).filter(Boolean);
        const ids = await send(user, event.chatId, bubbles.length ? bubbles : CHECK_IN.fallback[0]!, { turn });
        setAsk(user.id, { kind: "checkin", qid: [...ids].reverse().find((id) => !!id) ?? null, at: Date.now() });
        await deliver();
        return;
      }
      // "joke" or "none": a normal reply.
    }

    // A command code can read from the words alone ("delete me pls", "how do i delete my data"): he confirms or
    // offers to do it, at any point, and never answers with the words to type instead.
    const plainlyMeant = event.images.length ? null : meantCommand(event.text);
    if (plainlyMeant && (await handleMeantCommand(plainlyMeant, user, event, turn))) {
      await deliver();
      return;
    }
    // A judge asking for plain English, or for the slang back, in words. Works mid-onboarding: the open step stays open.
    if (await handleToneText(makeContext(user, event, { flow: "smalltalk", action: "tone", details: {}, source: "fallback" }, getFlowState(db, user.id), () => {}, undefined, turn))) {
      await deliver();
      return;
    }

    // Every share or pin replaces the saved fix. A share with no words gets one fixed line and nothing else.
    if (event.location) await saveLocation(user.id, event.location);
    const bareShare = !!event.location && !event.text.trim() && !event.images.length;

    let state = getFlowState(db, user.id);
    const idle: Intent = { flow: "onboarding", action: "", details: {}, source: "fallback" };
    if (needsOnboarding(user, state)) {
      // Mid-onboarding but not at the location question: thanks, and the open question stays open.
      if (bareShare && state?.flow === "onboarding" && state.step !== "location") {
        await send(user, event.chatId, [TEMPLATES.locationSaved], { turn });
        return;
      }
      const onboardingTrack = newTrack();
      const handled = await handleOnboarding(makeContext(user, event, idle, state, onboardingTrack.on, "onboarding", turn), { saveLocation });
      noteOpenQuestion(db, user.id, getFlowState(db, user.id), onboardingTrack.lastId);
      if (handled) return;
      // Onboarding finished without using this text (a real request typed at the last step): handle it normally.
      state = getFlowState(db, user.id);
    }

    if (bareShare && state?.flow !== TOUR) {
      await send(user, event.chatId, [TEMPLATES.locationSaved], { turn });
      await deliver();
      return;
    }

    // Relay mode: while two people are connected through Troy, their texts go to each other, not to a flow.
    // The one text that isn't passed along: the owner saying the item is back, which closes the handoff (and the relay with it).
    const closesHandoff = state?.flow === "lost_found" && state.step === "await_pickup" && !event.images.length && /^(?:i )?(?:got|have) (?:it|them)(?: back)?[.! ]*$/i.test(event.text.trim());
    // Neither is a text that plainly answers a flow's own open question or updates the person's own post
    // ("we're out" from a food poster): those go to that flow, or they would be swallowed for as long as the relay runs.
    const relay = closesHandoff ? null : activeRelayFor(db, user.id);
    if (relay) {
      if (!relayBypass(db, user, state, event, relay.context)) {
        const relayIntent: Intent = { flow: "smalltalk", action: "relay", details: {}, source: "fallback" };
        if (await relayMessage(makeContext(user, event, relayIntent, state, () => {}, undefined, turn))) {
          await deliver();
          return;
        }
      }
    }

    const track = newTrack();
    const cancelAck = startAckTimer(event, user, () => track.said);
    const before = state;
    try {
      // Typing shows while Troy works, but only once the read beat is over and only if nothing has gone out yet.
      void turn.ready.then(() => (turn.done || turn.sent ? undefined : quiet(adapter.startTyping(event.chatId), undefined)));

      // A typed pick from the "try me" poll, or a yes / "where?" / "details?" about the "near u" bubbles.
      const chatIntent: Intent = { flow: "smalltalk", action: "chat", details: {}, source: "fallback" };
      if (!state && (await firstTenIntercept(makeContext(user, event, chatIntent, null, track.on, undefined, turn)))) {
        await deliver();
        return;
      }

      const notes = getNotes(db, user.id);
      let intent = await detectIntent({ text: event.text, hasImage: event.images.length > 0, state, notes });
      // A command worded another way: the model says which, code decides and acts.
      if (intent.command) {
        const meant = intent.command;
        if (await handleMeantCommand(meant, user, event, turn)) {
          track.said = true;
          await deliver();
          return;
        }
        // Not acted on (playful, or a question about how to do it): he just answers like a person.
        intent = { flow: state?.flow ?? "smalltalk", action: state ? "answer" : "chat", details: intent.details, source: intent.source };
      }
      // "stump me" and the one question send the next text somewhere specific.
      intent = adjustIntent(db, user, event, intent, state);
      // An example offer is on the table and this is plain chat: the brain answers knowing the numbers were examples.
      if (!state && intent.flow === "smalltalk" && !intent.details.stump && modelReady() && event.text.trim().split(/\s+/).length <= 12) {
        if (await firstTenChat(makeContext(user, event, intent, null, track.on, undefined, turn))) {
          await deliver();
          return;
        }
      }
      const handler = pickHandler(intent, state);
      // A real request ends the first-ten-minutes plan.
      if (isRealRequest(handler.name)) cancelFirstTen(db, user.id);
      await handler.handle(makeContext(user, event, intent, state, track.on, handler.name, turn));
      // An open flow that stays silent lets the message through, and its state is left alone, so its own question
      // is still pending afterwards. A message meant for a different flow goes to that flow. A message that is
      // only chat (a question asked in the middle of a step) goes to the chat brain, so nobody is left on read.
      if (!track.said && state && handler.name === state.flow && (event.text.trim() || event.images.length)) {
        const elsewhere = intent.flow !== handler.name;
        const other = (elsewhere ? getFlow(intent.flow) : null) ?? getFlow("smalltalk");
        const passed: Intent = elsewhere ? intent : { flow: "smalltalk", action: "chat", details: { ...intent.details, midFlow: state.flow }, source: intent.source };
        if (other && other !== handler) {
          if (isRealRequest(other.name)) cancelFirstTen(db, user.id);
          await other.handle(makeContext(user, event, passed, null, track.on, other.name, turn));
        }
      }
      await judgeAfterTour(user, event, intent, before, turn);
      await deliver();
    } finally {
      cancelAck();
      turn.done = true;
      noteOpenQuestion(db, user.id, getFlowState(db, user.id), track.lastId);
      // say() already turns typing off after its last bubble.
      const spoke = track.said;
      track.said = true;
      if (!spoke) await quiet(adapter.stopTyping(event.chatId), undefined);
    }
  }

  /**
   * STOP takes effect the moment it arrives, not when its turn in the queue comes up, so the bubbles of a
   * reply that is still going out are dropped. The queued job then only sends the confirmation.
   */
  function applyStopNow(event: IncomingEvent): void {
    if (event.isGroup || event.reaction || event.pollVote || !isEnabled(db)) return;
    if (matchCommand(event.text)?.kind !== "stop") return;
    const user = getOrCreateUser(db, event.userHandle, event.chatId);
    if (user.stopped) return;
    updateUser(db, user.id, { stopped: 1 });
    setFlowState(db, user.id, null);
    stopConfirm.add(event.messageId);
  }

  /** One job at a time per person, in arrival order. One bad job never breaks the queue or the process. No text or handles in the log. */
  function enqueue(key: string, job: () => Promise<void>): Promise<void> {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev
      .then(job)
      .catch((err) => console.error("pipeline error:", describe(err)))
      .finally(() => {
        if (queues.get(key) === next) queues.delete(key);
      });
    queues.set(key, next);
    return next;
  }

  function handleEvent(event: IncomingEvent): Promise<void> {
    try {
      applyStopNow(event);
    } catch (err) {
      console.error("pipeline error:", describe(err));
    }
    return enqueue(event.userHandle, () => process(event));
  }

  /** Timers: flows release what went stale, then parked questions go to whoever is free. Safe to call any time. */
  async function sweep(now = Date.now()): Promise<void> {
    if (!isEnabled(db)) return;
    await runSweeps(sweepIo(), now);
    // The first ten minutes: the "try me" poll, the one question or the follow-up, whichever is due.
    try {
      await sweepFirstTen(firstTenIo(), now);
    } catch (err) {
      console.error("pipeline error:", describe(err));
    }
    await deliver(now);
  }

  setFirstTenIo(db, firstTenIo());
  // What he starts on his own waits its turn behind any reply still going out to that person.
  setFirstTenQueue(db, async (userId, job) => {
    const who = getUserById(db, userId);
    if (!who) return;
    await enqueue(who.handle, job);
  });

  return { handleEvent, sweep };
}
