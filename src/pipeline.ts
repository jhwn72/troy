// The message pipeline. Every gated incoming event goes through handleEvent, one at a time per user.

import type { DatabaseSync } from "node:sqlite";
import type { Bubble, FlowContext, FlowHandler, FlowName, FlowState, IncomingEvent, Intent, MessagingAdapter, User } from "./types.ts";
import { isEnabled } from "./config.ts";
import { getFlowState, getOrCreateUser, getUserById, saveMessage, setFlowState, updateUser } from "./db/index.ts";
import { matchCommand, TEMPLATES } from "./commands.ts";
import type { CommandKind } from "./commands.ts";
import { handleOnboarding, needsOnboarding } from "./onboarding.ts";
import { getFlow } from "./flows/index.ts";
import { detectIntent as realDetectIntent } from "./ai.ts";
import { activeRelayFor, relayMessage } from "./relay.ts";
import { inQuietHours } from "./quiet.ts";
import type { SweepIo } from "./pending.ts";
import { deliverPending, isProtected, parkAsk, relayBypass, runSweeps, runUserGone } from "./pending.ts";

export type PipelineDeps = {
  db: DatabaseSync;
  getAdapter: () => MessagingAdapter;
  /** Test hooks. Defaults: the real intent call, real pauses, 3 seconds before an acknowledgement. */
  detectIntent?: typeof realDetectIntent;
  pause?: (ms: number) => Promise<void>;
  ackAfterMs?: number;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  const ackAfterMs = deps.ackAfterMs ?? 3000;
  const queues = new Map<string, Promise<void>>();
  /** Message ids of STOP texts that were applied the moment they arrived and still need their one confirmation. */
  const stopConfirm = new Set<string>();
  let ackTurn = 0;

  const isStopped = (userId: number) => !!getUserById(db, userId)?.stopped;
  const typePause = async (adapter: MessagingAdapter, chatId: string) => {
    await quiet(adapter.startTyping(chatId), undefined);
    await pause(800 + Math.random() * 1200);
  };

  /**
   * Send bubbles to one chat with typing and a short pause between them. Stopped users get nothing.
   * `continued` means something was already sent this turn, so the first bubble also gets typing and a pause.
   */
  async function send(to: User, chatId: string, bubbles: (string | Bubble)[], opts: { force?: boolean; continued?: boolean } = {}): Promise<(string | null)[]> {
    const adapter = deps.getAdapter();
    const ids: (string | null)[] = [];
    let sentAny = false;
    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      const bubble: Bubble = typeof b === "string" ? { text: b } : b;
      const stopped = () => !opts.force && isStopped(to.id);
      if (stopped()) {
        ids.push(null);
        continue;
      }
      if (i > 0 || opts.continued) await typePause(adapter, chatId);
      // Checked again after the pause, right before the send, so a STOP that lands mid-reply wins.
      if (stopped()) {
        ids.push(null);
        continue;
      }
      const sent = await quiet(adapter.sendMessage(chatId, bubble.text, bubble.effect ? { effect: bubble.effect } : undefined), null);
      if (sent) saveMessage(db, { userId: to.id, chatId, direction: "out", providerMessageId: sent.messageId, text: bubble.text });
      sentAny = sentAny || !!sent;
      ids.push(sent?.messageId ?? null);
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
   * dropped, and a contact card or poll that follows other bubbles in the same turn gets typing and a pause first.
   */
  function flowAdapter(turn: { sent: boolean }): MessagingAdapter {
    const real = deps.getAdapter();
    const lead = async (chatId: string) => {
      if (turn.sent) await typePause(real, chatId);
      turn.sent = true;
    };
    return {
      provider: real.provider,
      capabilities: () => real.capabilities(),
      sendMessage: async (chatId, text, opts) => (chatStopped(chatId) ? null : real.sendMessage(chatId, text, opts)),
      sendImage: async (chatId, path, caption) => (chatStopped(chatId) ? null : real.sendImage(chatId, path, caption)),
      async sendContactCard(chatId) {
        if (chatStopped(chatId)) return null;
        await lead(chatId);
        return chatStopped(chatId) ? null : real.sendContactCard(chatId);
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
        return chatStopped(chatId) ? none : real.sendPoll(chatId, question, options);
      },
      createGroupChat: (members, firstMessage) => real.createGroupChat(members, firstMessage),
      getLiveLocation: (handle) => real.getLiveLocation(handle),
      chatIdForHandle: (handle) => real.chatIdForHandle(handle),
    };
  }

  /** What flows get outside a conversation: timers, and the cleanup after STOP or "delete my data". */
  function sweepIo(): SweepIo {
    return {
      db,
      adapter: flowAdapter({ sent: false }),
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
  function makeContext(user: User, event: IncomingEvent, intent: Intent, state: FlowState | null, onSay: () => void, owner?: FlowName): FlowContext {
    const turn = { sent: false };
    return {
      db,
      user,
      event,
      intent,
      state,
      adapter: flowAdapter(turn),
      async say(...bubbles) {
        onSay();
        const continued = turn.sent;
        turn.sent = true;
        return send(user, event.chatId, bubbles, { continued });
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

  async function runCommand(kind: CommandKind, user: User, event: IncomingEvent): Promise<void> {
    const say = (bubbles: string[], force = false) => send(user, event.chatId, bubbles, { force });
    switch (kind) {
      // Safety replies go out even to someone who texted STOP earlier: silence on a fire text is the worse failure.
      case "emergency":
        await say(TEMPLATES.emergency, true);
        return;
      case "crisis":
        await say(TEMPLATES.crisis, true);
        return;
      case "stop":
        // Already applied in handleEvent the moment the text arrived. Clear whatever the reply that was
        // in flight left behind, then send the one text a stopped user still gets: the confirmation.
        updateUser(db, user.id, { stopped: 1 });
        setFlowState(db, user.id, null);
        await say(TEMPLATES.stop, true);
        // Whatever they were holding (a claim on a found item, a question to them) is let go, so nobody waits on them.
        await runUserGone(sweepIo(), user.id);
        return;
      case "start":
        if (!user.stopped) {
          await say(TEMPLATES.startAlready);
          return;
        }
        updateUser(db, user.id, { stopped: 0 });
        await say(TEMPLATES.start);
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
        for (const text of TEMPLATES.deleteData) await quiet(deps.getAdapter().sendMessage(event.chatId, text), null);
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
    if (event.reaction) {
      // Only tapbacks on Troy's own messages in this chat mean anything.
      const target = db
        .prepare("SELECT id FROM messages WHERE providerMessageId = ? AND chatId = ? AND direction = 'out' LIMIT 1")
        .get(event.reaction.targetMessageId, event.chatId);
      if (!target) return;
    }
    const intent: Intent = { flow: state?.flow ?? "food", action: event.reaction ? "reaction" : "poll_vote", details: {}, source: "fallback" };
    if (needsOnboarding(user, state)) {
      await handleOnboarding(makeContext(user, event, intent, state, () => {}, "onboarding"));
      return;
    }
    // A tapback on a food alert bubble is a claim, whatever else the person is in the middle of.
    const onFoodAlert = !!event.reaction && !!db.prepare("SELECT 1 FROM food_alert_bubbles WHERE messageId = ? AND userId = ? LIMIT 1").get(event.reaction.targetMessageId, user.id);
    const owner = (onFoodAlert && getFlow("food")) || (state && getFlow(state.flow)) || getFlow("food");
    if (owner) await owner.handle(makeContext(user, event, { ...intent, flow: owner.name }, state, () => {}, owner.name));
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

    // Opted out: nothing is saved, marked read or answered. Only START, the STOP confirmation and safety replies get through.
    if (user.stopped) {
      if (command?.kind === "stop") {
        if (stopConfirm.delete(event.messageId)) await runCommand("stop", user, event);
        return;
      }
      if (command?.kind === "start" || safety) await runCommand(command.kind, user, event);
      return;
    }

    // "delete my data" is the one message we don't keep.
    if (command?.kind !== "delete_data") {
      saveMessage(db, { userId: user.id, chatId: event.chatId, direction: "in", providerMessageId: event.messageId, text: event.text, media: event.images });
    }
    void quiet(adapter.markRead(event.chatId), undefined);

    if (command) {
      await runCommand(command.kind, user, event);
      await deliver();
      return;
    }

    let state = getFlowState(db, user.id);
    const idle: Intent = { flow: "onboarding", action: "", details: {}, source: "fallback" };
    if (needsOnboarding(user, state)) {
      await quiet(adapter.startTyping(event.chatId), undefined);
      const handled = await handleOnboarding(makeContext(user, event, idle, state, () => {}, "onboarding"));
      if (handled) return;
      // Onboarding finished without using this text (a real request typed at the last step): handle it normally.
      state = getFlowState(db, user.id);
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
        if (await relayMessage(makeContext(user, event, relayIntent, state, () => {}))) {
          await deliver();
          return;
        }
      }
    }

    let said = false;
    const cancelAck = startAckTimer(event, user, () => said);
    try {
      await quiet(adapter.startTyping(event.chatId), undefined);
      const notes = getNotes(db, user.id);
      const intent = await detectIntent({ text: event.text, hasImage: event.images.length > 0, state, notes });
      const handler = pickHandler(intent, state);
      await handler.handle(makeContext(user, event, intent, state, () => (said = true), handler.name));
      // An open flow that stays silent on a message meant for a different flow lets it through.
      // Its state is left alone, so its own question is still pending afterwards.
      if (!said && state && handler.name === state.flow && intent.flow !== handler.name) {
        const other = getFlow(intent.flow) ?? getFlow("smalltalk");
        if (other && other !== handler) await other.handle(makeContext(user, event, intent, null, () => (said = true), other.name));
      }
      await deliver();
    } finally {
      cancelAck();
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
