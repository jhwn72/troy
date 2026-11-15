// Shared contracts for Troy. Every module builds against this file.
// Change it only on purpose, and update CLAUDE.md when you do.

import type { DatabaseSync } from "node:sqlite";

export type Provider = "webchat" | "bluebubbles" | "linq";

/** A handle is a normalized phone number (E.164, "+1XXXXXXXXXX") or a lowercase email. */
export type Handle = string;

export type TapbackType = "love" | "like" | "dislike" | "laugh" | "emphasize" | "question";

export type SendEffect = "confetti" | "fireworks" | "balloons" | "celebration" | "slam" | "loud" | "gentle";

export interface IncomingImage {
  /** Absolute local path of the downloaded image (JPEG or PNG). */
  path: string;
  mime: string;
}

/** The one internal shape every provider converts incoming events into. Only gated events ever become this. */
export interface IncomingEvent {
  provider: Provider;
  userHandle: Handle;
  chatId: string;
  /** True when the chat has more than two members. */
  isGroup: boolean;
  messageId: string;
  text: string;
  images: IncomingImage[];
  location?: { lat: number; lng: number };
  /** A tapback. targetMessageId is the provider id of the message that was reacted to. */
  reaction?: { targetMessageId: string; type: TapbackType; removed: boolean };
  pollVote?: { pollMessageId: string; optionIndex: number };
  receivedAt: number;
}

export interface SentMessage {
  /** Provider message id, or null if the provider did not give one. */
  messageId: string | null;
}

export interface AdapterCapabilities {
  tapbacks: boolean;
  typing: boolean;
  readReceipts: boolean;
  /** BlueBubbles: only true with BLUEBUBBLES_EDITS on (the patched helper). Callers always keep a fallback. */
  edits: boolean;
  effects: boolean;
  polls: boolean;
  groupChats: boolean;
  contactCard: boolean;
  liveLocation: boolean;
}

/**
 * One interface, one file per provider. Nothing outside src/adapters knows which provider is in use.
 * Every method must (1) refuse when Troy is disabled and (2) refuse for a chat that is not allowed.
 * Refusing means: do nothing, return null/false, log "send refused" with no handle and no text.
 * A method the provider can't do falls back gracefully and never throws for that reason.
 */
export interface MessagingAdapter {
  readonly provider: Provider;
  capabilities(): AdapterCapabilities;
  sendMessage(chatId: string, text: string, opts?: { effect?: SendEffect }): Promise<SentMessage | null>;
  sendImage(chatId: string, imagePath: string, caption?: string): Promise<SentMessage | null>;
  sendContactCard(chatId: string): Promise<SentMessage | null>;
  markRead(chatId: string): Promise<void>;
  startTyping(chatId: string): Promise<void>;
  stopTyping(chatId: string): Promise<void>;
  react(chatId: string, messageId: string, type: TapbackType): Promise<boolean>;
  /** Returns false when the edit was skipped (unsupported). Callers decide whether to send a new text. */
  editMessage(chatId: string, messageId: string, text: string): Promise<boolean>;
  /**
   * "native": a real poll. Every entry of optionMessageIds is the poll's id, and a vote arrives as IncomingEvent.pollVote.
   * "tap": one bubble per option to tapback; optionMessageIds are those bubbles in order. "numbered": a list to answer by number.
   */
  sendPoll(chatId: string, question: string, options: string[]): Promise<{ optionMessageIds: (string | null)[]; mode: "native" | "tap" | "numbered" }>;
  /** Returns the new chat id, or null when group chats aren't available (caller uses relay mode). */
  createGroupChat(members: Handle[], firstMessage: string): Promise<string | null>;
  /** The handle's current location if they are sharing it with Troy, else null. Never stored by the adapter. */
  getLiveLocation(handle: Handle): Promise<{ lat: number; lng: number; at: number } | null>;
  /**
   * Asks the person in a 1:1 chat to share their location (the Find My "Requested Location" bubble).
   * False when the provider can't do it right now; the caller then asks in text.
   */
  requestLocation(chatId: string): Promise<boolean>;
  /** Called by the pipeline right after a chat is newly allowed (opt-in), so the provider can register it. */
  onAllowed?(chatId: string): Promise<void>;
  /** Called on STOP and "delete my data". */
  onDisallowed?(chatId: string): Promise<void>;
  /** The 1:1 chat id for a handle (for messaging a user Troy isn't currently replying to). */
  chatIdForHandle(handle: Handle): string;
}

// ---------- users, state ----------

export type ContactMode = "direct" | "relay_only" | "no_contact";

export interface User {
  id: number;
  handle: Handle;
  chatId: string;
  name: string | null;
  uscEmail: string | null;
  verifiedAt: number | null;
  /** "usc_email" for real students, "judge_skip" for the hackathon demo skip. Null until verified. */
  verifiedVia: "usc_email" | "judge_skip" | null;
  contactMode: ContactMode;
  groupChatsAllowed: boolean;
  subscriptions: string[];
  usualSpots: string[];
  alertMinutes: number;
  quietHours: { start: string; end: string } | null;
  bannedFromPosting: boolean;
  paused: boolean;
  stopped: boolean;
  createdAt: number;
}

export type FlowName = "onboarding" | "lost_found" | "food" | "repair" | "usg" | "rides" | "notes" | "smalltalk" | "topics" | "tour";

/** A command the student meant without typing the exact word ("leave me alone", "stop the food texts"). */
export type CommandName = "stop" | "start" | "pause" | "resume" | "delete_data" | "forget_location" | "help" | "unsubscribe_topic";

export interface IntentCommand {
  name: CommandName;
  /** Only for unsubscribe_topic: the topic in the student's own words ("food", "pickup games"). Match it with findTopic. */
  topic?: string;
  /** "clear": act on it (code still confirms anything that destroys data). "unsure": ask one short question first. */
  certainty: "clear" | "unsure";
}

/** A user's open conversation state. One row per user at most; null means idle. */
export interface FlowState {
  flow: FlowName;
  step: string;
  data: Record<string, unknown>;
  updatedAt: number;
}

export interface Intent {
  flow: FlowName;
  /** Short machine label inside the flow, e.g. "report_found", "report_lost", "post_food", "claim". */
  action: string;
  /** Details the model pulled out: category, place, time, count, etc. */
  details: Record<string, unknown>;
  /** "ai" or "fallback" (keyword rules, used when the API call fails or there is no key). */
  source: "ai" | "fallback";
  /**
   * Set when the message means a command without using the exact word. The exact words never get here (src/commands.ts
   * handles them first). Code performs the action and sends the fixed confirmation; this only says which one was meant.
   */
  command?: IntentCommand;
}

/** One outgoing bubble. Code inserts every exact value before this point. */
export interface Bubble {
  text: string;
  effect?: SendEffect;
}

export interface FlowContext {
  db: DatabaseSync;
  user: User;
  event: IncomingEvent;
  intent: Intent;
  state: FlowState | null;
  /** Send bubbles to the current user with pauses and typing between them. Returns provider ids in order. */
  say(...bubbles: (string | Bubble)[]): Promise<(string | null)[]>;
  /** Send bubbles to another user's 1:1 chat (finder, poster, follower). Respects STOP and quiet hours. */
  sayTo(userId: number, ...bubbles: (string | Bubble)[]): Promise<(string | null)[]>;
  /**
   * Like sayTo, for a text the other person is owed as part of an exchange on their own open request
   * (a claim on their lost report, the item they found). Not held back by quiet hours. Still never sent after STOP.
   */
  sayToOwed(userId: number, ...bubbles: (string | Bubble)[]): Promise<(string | null)[]>;
  /** Save or clear the current user's flow state. */
  setState(state: Omit<FlowState, "updatedAt"> | null): void;
  /** Save or clear another user's flow state (e.g. put the finder into "finder_check"). */
  setStateFor(userId: number, state: Omit<FlowState, "updatedAt"> | null): void;
  adapter: MessagingAdapter;
}

export interface FlowHandler {
  name: FlowName;
  handle(ctx: FlowContext): Promise<void>;
}
