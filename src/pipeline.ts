// The message pipeline. Every gated incoming event goes through handleEvent, one at a time per user.

import type { DatabaseSync } from "node:sqlite";
import type { Bubble, FlowContext, FlowHandler, FlowName, FlowState, IncomingEvent, Intent, MessagingAdapter, User } from "./types.ts";
import { isEnabled } from "./config.ts";
import { getFlowState, getOrCreateUser, getUserById, saveMessage, setFlowState, updateUser } from "./db/index.ts";
import { isHeyTroy, matchCommand, TEMPLATES } from "./commands.ts";
import type { CommandKind } from "./commands.ts";
import { handleOnboarding, needsOnboarding } from "./onboarding.ts";
import { getFlow } from "./flows/index.ts";
import { detectIntent as realDetectIntent } from "./ai.ts";
import { activeRelayFor, relayMessage } from "./relay.ts";
import { inQuietHours } from "./quiet.ts";
import type { SweepIo } from "./pending.ts";
import { deliverPending, isProtected, parkAsk, relayBypass, runSweeps, runUserGone } from "./pending.ts";
import { forgetUserLocation, saveUserLocation } from "./location.ts";

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
    bubbles: (string | Bubble)[],
    opts: { force?: boolean; turn?: Turn; instant?: boolean; noSave?: boolean } = {},
  ): Promise<(string | null)[]> {
    const adapter = deps.getAdapter();
    const turn = opts.turn;
    const ids: (string | null)[] = [];
    const stopped = () => !opts.force && isStopped(to.id);
    let sentAny = false;
    let first = true;
    let continued = !!turn?.sent;
    if (turn) turn.sent = true;
    for (const b of bubbles) {
      const bubble: Bubble = typeof b === "string" ? { text: b } : b;
      const pieces = chunkBubble(bubble.text);
      let id: string | null = null;
      for (let k = 0; k < pieces.length; k++) {
        const text = pieces[k];
        if (stopped()) break;
        const instant = first && !!opts.instant;
        if (first && turn && !instant) await turn.ready;
        if (continued) await pause(between(TIMING.gap, random()));
        first = false;
        continued = true;
        if (!instant) {
          if (stopped()) break;
          await quiet(adapter.startTyping(chatId), undefined);
          await pause(typingMs(text, random()));
        }
        // Checked again after the pause, right before the send, so a STOP that lands mid-reply wins.
        if (stopped()) break;
        const effect = bubble.effect && k === pieces.length - 1 ? { effect: bubble.effect } : undefined;
        const sent = await quiet(adapter.sendMessage(chatId, text, effect), null);
        if (sent && !opts.noSave) saveMessage(db, { userId: to.id, chatId, direction: "out", providerMessageId: sent.messageId, text });
        sentAny = sentAny || !!sent;
        id = sent?.messageId ?? null;
      }
      ids.push(id);
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
      await turn.ready;
      if (turn.sent) await pause(between(TIMING.gap, random()));
      turn.sent = true;
      if (chatStopped(chatId)) return;
      await quiet(real.startTyping(chatId), undefined);
      await pause(between(TIMING.attachment, random()));
    };
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
      sendMessage: async (chatId, text, opts) => (chatStopped(chatId) ? null : real.sendMessage(chatId, text, opts)),
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
        return chatStopped(chatId) ? none : landed(chatId, real.sendPoll(chatId, question, options));
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
        return send(other, other.chatId, bubbles);
      },
    };
  }

  /** Parked questions go out to whoever is free now. */
  const deliver = (now?: number) => deliverPending(db, (to, bubbles) => send(to, to.chatId, bubbles), now);

  /**
   * `owner` is the flow this context is handed to. A flow may only clear or replace its own open step:
   * another flow's protected question (a finder being asked how to hand an item off) is left alone when a
   * different flow says "done", and parked to be asked again when a different flow opens a step of its own.
   */
  function makeContext(user: User, event: IncomingEvent, intent: Intent, state: FlowState | null, onSay: () => void, owner: FlowName | undefined, turn: Turn): FlowContext {
    return {
      db,
      user,
      event,
      intent,
      state,
      adapter: flowAdapter(turn),
      async say(...bubbles) {
        onSay();
        return send(user, event.chatId, bubbles, { turn });
      },
      async sayTo(userId, ...bubbles) {
        const other = getUserById(db, userId);
        if (!other || other.stopped || inQuietHours(other)) return bubbles.map(() => null);
        return send(other, other.chatId, bubbles);
      },
      async sayToOwed(userId, ...bubbles) {
        const other = getUserById(db, userId);
        if (!other || other.stopped) return bubbles.map(() => null);
        return send(other, other.chatId, bubbles);
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

  async function runCommand(kind: CommandKind, user: User, event: IncomingEvent, turn: Turn): Promise<void> {
    const say = (bubbles: string[], force = false) => send(user, event.chatId, bubbles, { force, turn });
    const adapter = deps.getAdapter();
    switch (kind) {
      // Safety replies go out even to someone who texted STOP earlier: silence on a fire text is the worse failure.
      // The first bubble (call 911, text 988) goes out at once, with no read beat and no typing wait.
      case "emergency":
        await send(user, event.chatId, TEMPLATES.emergency, { force: true, turn, instant: true });
        return;
      case "crisis":
        await send(user, event.chatId, TEMPLATES.crisis, { force: true, turn, instant: true });
        return;
      case "stop":
        // Already applied in handleEvent the moment the text arrived. Clear whatever the reply that was
        // in flight left behind, then send the one text a stopped user still gets: the confirmation.
        updateUser(db, user.id, { stopped: 1 });
        setFlowState(db, user.id, null);
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
        // Not saved: nothing of theirs stays in the messages table.
        await send(user, event.chatId, TEMPLATES.deleteData, { turn, noSave: true });
        await quiet(Promise.resolve(adapter.onDisallowed?.(event.chatId)), undefined);
        await runUserGone(sweepIo(), user.id);
        return;
    }
  }

  /** Exactly one acknowledgement, and only if the handler is still quiet when the timer fires. */
  function startAckTimer(event: IncomingEvent, user: User, hasSaid: () => boolean): () => void {
    const timer = setTimeout(async () => {
      if (hasSaid() || isStopped(user.id)) return;
      try {
        const adapter = deps.getAdapter();
        if (adapter.capabilities().tapbacks && (await adapter.react(event.chatId, event.messageId, event.images.length ? "love" : "like"))) return;
        if (hasSaid() || isStopped(user.id)) return;
        const line = TEMPLATES.acks[ackTurn++ % TEMPLATES.acks.length];
        const sent = await adapter.sendMessage(event.chatId, line);
        if (sent) saveMessage(db, { userId: user.id, chatId: event.chatId, direction: "out", providerMessageId: sent.messageId, text: line });
      } catch {
        // An acknowledgement is optional.
      }
    }, ackAfterMs);
    return () => clearTimeout(timer);
  }

  function pickHandler(intent: Intent, state: FlowState | null): FlowHandler {
    const smalltalk = getFlow("smalltalk")!;
    const open = state ? getFlow(state.flow) : null;
    const wanted = getFlow(intent.flow);
    // The open flow keeps the conversation unless the model is sure this starts something else.
    const startsNew = intent.source === "ai" && intent.flow !== "smalltalk" && intent.flow !== state?.flow && !!wanted;
    if (open && !startsNew) return open;
    return wanted ?? smalltalk;
  }

  async function handleTap(user: User, event: IncomingEvent, state: FlowState | null): Promise<void> {
    // A tap is not a text: no read receipt, so no read beat either.
    const turn = freeTurn();
    if (event.reaction) {
      // Only tapbacks on Troy's own messages in this chat mean anything.
      const target = db
        .prepare("SELECT id FROM messages WHERE providerMessageId = ? AND chatId = ? AND direction = 'out' LIMIT 1")
        .get(event.reaction.targetMessageId, event.chatId);
      if (!target) return;
    }
    const intent: Intent = { flow: state?.flow ?? "food", action: event.reaction ? "reaction" : "poll_vote", details: {}, source: "fallback" };
    if (needsOnboarding(user, state)) {
      await handleOnboarding(makeContext(user, event, intent, state, () => {}, "onboarding", turn), { saveLocation });
      return;
    }
    // A tapback on a food alert bubble is a claim, whatever else the person is in the middle of.
    const onFoodAlert = !!event.reaction && !!db.prepare("SELECT 1 FROM food_alert_bubbles WHERE messageId = ? AND userId = ? LIMIT 1").get(event.reaction.targetMessageId, user.id);
    const owner = (onFoodAlert && getFlow("food")) || (state && getFlow(state.flow)) || getFlow("food");
    if (owner) await owner.handle(makeContext(user, event, { ...intent, flow: owner.name }, state, () => {}, owner.name, turn));
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

    // Opted out: nothing is saved, marked read or answered. Only START (or "hey troy"), the STOP confirmation and safety replies get through.
    if (user.stopped) {
      if (command?.kind === "stop") {
        if (stopConfirm.delete(event.messageId)) await runCommand("stop", user, event, freeTurn());
        return;
      }
      if (safety) await runCommand(command.kind, user, event, freeTurn());
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

    if (command) {
      await runCommand(command.kind, user, event, turn);
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
      const handled = await handleOnboarding(makeContext(user, event, idle, state, () => {}, "onboarding", turn), { saveLocation });
      if (handled) return;
      // Onboarding finished without using this text (a real request typed at the last step): handle it normally.
      state = getFlowState(db, user.id);
    }

    if (bareShare) {
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

    let said = false;
    const cancelAck = startAckTimer(event, user, () => said);
    try {
      // Typing shows while Troy works, but only once the read beat is over and only if nothing has gone out yet.
      void turn.ready.then(() => (turn.done || turn.sent ? undefined : quiet(adapter.startTyping(event.chatId), undefined)));
      const notes = getNotes(db, user.id);
      const intent = await detectIntent({ text: event.text, hasImage: event.images.length > 0, state, notes });
      const handler = pickHandler(intent, state);
      await handler.handle(makeContext(user, event, intent, state, () => (said = true), handler.name, turn));
      // An open flow that stays silent on a message meant for a different flow lets it through.
      // Its state is left alone, so its own question is still pending afterwards.
      if (!said && state && handler.name === state.flow && intent.flow !== handler.name) {
        const other = getFlow(intent.flow) ?? getFlow("smalltalk");
        if (other && other !== handler) await other.handle(makeContext(user, event, intent, null, () => (said = true), other.name, turn));
      }
      await deliver();
    } finally {
      cancelAck();
      turn.done = true;
      // say() already turns typing off after its last bubble.
      const spoke = said;
      said = true;
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

  function handleEvent(event: IncomingEvent): Promise<void> {
    try {
      applyStopNow(event);
    } catch (err) {
      console.error("pipeline error:", describe(err));
    }
    const key = event.userHandle;
    const prev = queues.get(key) ?? Promise.resolve();
    // One bad message never breaks the queue or the process. No text or handles in the log.
    const next = prev
      .then(() => process(event))
      .catch((err) => console.error("pipeline error:", describe(err)))
      .finally(() => {
        if (queues.get(key) === next) queues.delete(key);
      });
    queues.set(key, next);
    return next;
  }

  /** Timers: flows release what went stale, then parked questions go to whoever is free. Safe to call any time. */
  async function sweep(now = Date.now()): Promise<void> {
    if (!isEnabled(db)) return;
    await runSweeps(sweepIo(), now);
    await deliver(now);
  }

  return { handleEvent, sweep };
}
