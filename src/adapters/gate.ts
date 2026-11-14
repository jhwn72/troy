// The privacy gate. Pure decisions about which chats Troy may see and answer.
// Troy runs on John's personal Apple ID, so everything that is not explicitly allowed is dropped.
// See "Privacy rules" in CLAUDE.md. Never weaken these.

import type { DatabaseSync } from "node:sqlite";
import type { Handle } from "../types.ts";
import { config, isEnabled } from "../config.ts";
import { getSetting, setSetting } from "../db/index.ts";

export type AllowReason = "opt_in_phrase" | "manual" | "troy_group";

/** True when the first two words are "hey troy". Case, spacing and punctuation don't matter. */
export function isOptInPhrase(text: string): boolean {
  if (typeof text !== "string") return false;
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ");
  return words[0] === "hey" && words[1] === "troy";
}

/** BlueBubbles group chat guids contain ";+;". Anything that looks like a group never matches by handle. */
function looksLikeGroup(chatId: string): boolean {
  return chatId.includes(";+;");
}

/**
 * Is this chat allowed?
 * - group chats: only a troy_group row for this exact chatId (added when Troy creates the group).
 * - 1:1 chats: an allow_list row for this chatId or this handle, or the handle is on the manual env list.
 * A handle never makes a group chat allowed.
 */
export function isAllowedChat(db: DatabaseSync, chatId: string, handle: Handle | null): boolean {
  if (!chatId) return false;
  if (looksLikeGroup(chatId)) {
    return !!db.prepare("SELECT 1 FROM allow_list WHERE chatId = ? AND reason = 'troy_group' LIMIT 1").get(chatId);
  }
  if (db.prepare("SELECT 1 FROM allow_list WHERE chatId = ? LIMIT 1").get(chatId)) return true;
  if (!handle) return false;
  if (db.prepare("SELECT 1 FROM allow_list WHERE handle = ? LIMIT 1").get(handle)) return true;
  return config.allowedHandles.includes(handle);
}

export function allowChat(db: DatabaseSync, entry: { handle: Handle | null; chatId: string | null; reason: AllowReason }): void {
  if (!entry.handle && !entry.chatId) return;
  // UNIQUE doesn't catch duplicates when one side is NULL, so check with IS.
  const exists = db.prepare("SELECT 1 FROM allow_list WHERE handle IS ? AND chatId IS ? AND reason = ? LIMIT 1").get(entry.handle, entry.chatId, entry.reason);
  if (exists) return;
  db.prepare("INSERT OR IGNORE INTO allow_list (handle, chatId, reason, addedAt) VALUES (?, ?, ?, ?)").run(entry.handle, entry.chatId, entry.reason, Date.now());
}

/** Removes every allow_list row for the handle. The env list (ALLOWED_HANDLES) can only be changed in .env. */
export function removeFromAllowList(db: DatabaseSync, handle: Handle): void {
  db.prepare("DELETE FROM allow_list WHERE handle = ?").run(handle);
}

/** The send lock: Troy is on and the chat is allowed. */
export function sendAllowed(db: DatabaseSync, chatId: string, handle: Handle | null): boolean {
  return isEnabled(db) && isAllowedChat(db, chatId, handle);
}

/** When Troy went live (ms). Set to now the first time it's asked for. */
export function getGoLiveAt(db: DatabaseSync): number {
  const saved = Number(getSetting(db, "go_live_at"));
  if (Number.isFinite(saved) && saved > 0) return saved;
  const now = Date.now();
  setSetting(db, "go_live_at", String(now));
  return now;
}

export type GateInput = {
  isFromMe: boolean;
  handle: Handle | null;
  chatId: string | null;
  isGroup: boolean;
  text: string;
  /** Looks up only the date of the chat's earliest message. Called only for a 1:1 "hey troy" from a chat that isn't allowed yet. */
  hasHistoryBeforeGoLive: () => Promise<boolean>;
};

export type GateDecision = { allow: true; newlyOptedIn: boolean } | { allow: false };

const DENY: GateDecision = { allow: false };

export async function decide(db: DatabaseSync, input: GateInput): Promise<GateDecision> {
  // 1. John's own messages, always first. Anything not clearly from someone else counts as John's.
  if (input.isFromMe !== false) return DENY;
  // 2. Kill switch.
  if (!isEnabled(db)) return DENY;
  // 3. Need to know who and where.
  if (!input.handle || !input.chatId) return DENY;

  const isGroup = input.isGroup || looksLikeGroup(input.chatId);

  // 4 and 5. A group is allowed only if Troy created it. Handles and the manual list don't count there.
  if (isGroup) {
    const row = db.prepare("SELECT 1 FROM allow_list WHERE chatId = ? AND reason = 'troy_group' LIMIT 1").get(input.chatId);
    return row ? { allow: true, newlyOptedIn: false } : DENY;
  }

  // 4. Already allowed 1:1 chat.
  if (isAllowedChat(db, input.chatId, input.handle)) return { allow: true, newlyOptedIn: false };

  // 6. "hey troy" in a 1:1 chat with nothing from before go-live.
  if (!isOptInPhrase(input.text)) return DENY;
  let hasHistory: boolean;
  try {
    hasHistory = await input.hasHistoryBeforeGoLive();
  } catch {
    return DENY;
  }
  if (hasHistory !== false) return DENY;
  // The kill switch may have been flipped while the lookup ran.
  if (!isEnabled(db)) return DENY;
  allowChat(db, { handle: input.handle, chatId: input.chatId, reason: "opt_in_phrase" });
  return { allow: true, newlyOptedIn: true };
}
