// The patched helper inside Messages (bluebubbles/README.md, "Troy control channel" and "Location").
// It does what BlueBubbles' own API can't: native polls, reading poll and Find My payloads, location requests.
//
// This wrapper is the only thing that talks to HelperClient, and it holds the same send lock as the adapter:
// every call for a chat first passes sendAllowed(). The helper is another way to act on a chat and gets no exception.
// (removeChat is the one call that works for a chat that isn't allowed: it only takes access away.)
//
// The real client starts only when MESSAGING_PROVIDER=bluebubbles and TROY_HELPER_TOKEN is set. Otherwise,
// and whenever the helper isn't connected, every method reports "not available" straight away and the adapter
// falls back. The token is never logged. Coordinates and handles are never logged.

import type { DatabaseSync } from "node:sqlite";
import type { Handle } from "../types.ts";
import { config, normalizeHandle } from "../config.ts";
import { sendAllowed } from "./gate.ts";
import { FINDMY_BALLOON_ID, HelperClient, POLL_BALLOON_ID, decodeFindMyPayload, decodePollPayload } from "./helper-client.ts";
import type { HelperCommand } from "./helper-client.ts";

export { FINDMY_BALLOON_ID, POLL_BALLOON_ID, decodeFindMyPayload, decodePollPayload };

/** The part of HelperClient this wrapper uses. Tests pass a fake, so no socket is ever opened there. */
export interface HelperClientLike {
  readonly connected: boolean;
  start(): void;
  stop(): void;
  allowChat(chatGuid: string): Promise<any>;
  removeChat(chatGuid: string): Promise<any>;
  request(cmd: HelperCommand, chatGuid: string, args: Record<string, unknown>, timeoutMs?: number): Promise<any>;
}

export interface Helper {
  /** True when a helper client exists at all (bluebubbles provider and a token). */
  readonly available: boolean;
  isConnected(): boolean;
  /** Starts listening for the helper. Registration of allowed chats runs each time the helper connects. */
  start(): void;
  stop(): void;
  /** allowChat for every allowed 1:1 chat (allow_list rows and ALLOWED_HANDLES). Returns how many are registered. */
  registerAllowedChats(): Promise<number>;
  allowChat(chatGuid: string): Promise<boolean>;
  removeChat(chatGuid: string): Promise<boolean>;
  sendPoll(chatGuid: string, options: string[], creatorHandle: string): Promise<{ guid: string; optionIdentifiers: string[] } | null>;
  /** A message's balloon payload as base64, or null. */
  getPayload(chatGuid: string, messageGuid: string): Promise<string | null>;
  /** Find My "ask to share" plus the "Requested Location" bubble in the chat. */
  requestLocation(chatGuid: string): Promise<boolean>;
  /** The other person's latest Find My fix while they are sharing, else null. */
  getLocation(chatGuid: string): Promise<{ lat: number; lng: number; at: number } | null>;
}

const ONE_TO_ONE = /^[^;]+;-;[^;]+$/;

function handleOf(chatGuid: string): Handle | null {
  const parts = typeof chatGuid === "string" ? chatGuid.split(";") : [];
  return parts.length === 3 && parts[1] === "-" ? normalizeHandle(parts[2]) : null;
}

/** A vote payload -> the picked option's identifier. Only the vote by `voter` counts when the payload names voters. */
export function decodePollVote(payloadBase64: string, voter?: Handle | null): string | null {
  const votes: unknown = decodePollPayload(payloadBase64)?.item?.votes;
  if (!Array.isArray(votes) || votes.length === 0) return null;
  const mine = voter ? votes.filter((v) => normalizeHandle(v?.participantHandle) === voter) : [];
  // UNCONFIRMED: whether a vote message can carry other people's votes too. The newest entry is used.
  const pick = (mine.length ? mine : votes).at(-1);
  return typeof pick?.voteOptionIdentifier === "string" ? pick.voteOptionIdentifier : null;
}

/** A Find My share payload -> where the person was when they shared. Null for requests and anything else. */
export function decodeFindMyShare(payloadBase64: string): { lat: number; lng: number } | null {
  const loc = decodeFindMyPayload(payloadBase64)?.initialLocation;
  const lat = loc?.latitude;
  const lng = loc?.longitude;
  if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

/** What everything gets when there is no helper: nothing works, nothing throws, nothing is sent. */
function noHelper(): Helper {
  return {
    available: false,
    isConnected: () => false,
    start() {},
    stop() {},
    registerAllowedChats: async () => 0,
    allowChat: async () => false,
    removeChat: async () => false,
    sendPoll: async () => null,
    getPayload: async () => null,
    requestLocation: async () => false,
    getLocation: async () => null,
  };
}

/**
 * `client` is for tests (a fake) or null to force "no helper". Left out, the real HelperClient is created
 * only for the bluebubbles provider with TROY_HELPER_TOKEN set.
 */
export function createHelper(opts: { db: DatabaseSync; client?: HelperClientLike | null }): Helper {
  const { db } = opts;
  /** Chats the helper has confirmed in its own allowlist during this run. */
  const registered = new Set<string>();
  /** Chats taken away with removeChat (STOP, delete my data). Only an explicit allowChat brings one back. */
  const removed = new Set<string>();
  /** Removals that couldn't reach the helper yet. Sent the next time it connects. Memory only. */
  const pendingRemovals = new Set<string>();

  let helper: Helper | null = null;
  let client: HelperClientLike | null = null;
  if (opts.client !== undefined) client = opts.client;
  else if (config.provider === "bluebubbles" && process.env.TROY_HELPER_TOKEN) {
    try {
      client = new HelperClient({
        token: process.env.TROY_HELPER_TOKEN,
        chatAllowlist: [],
        onConnect: () => void helper?.registerAllowedChats().catch(() => {}),
      });
    } catch {
      console.log("helper off: TROY_HELPER_TOKEN is too short"); // never the token itself
    }
  }
  if (!client) return noHelper();
  const c = client;

  /** The send lock, for helper calls. Group chats never pass: the helper is 1:1 only. */
  function locked(chatGuid: string): boolean {
    if (typeof chatGuid === "string" && ONE_TO_ONE.test(chatGuid) && sendAllowed(db, chatGuid, handleOf(chatGuid))) return false;
    console.log("send refused");
    return true;
  }

  async function allowChat(chatGuid: string): Promise<boolean> {
    if (locked(chatGuid) || !c.connected) return false;
    try {
      const r = await c.allowChat(chatGuid);
      // "chat does not exist in Messages yet" lands here too: fine, it is tried again when the chat is next used.
      if (!r?.ok) return false;
    } catch {
      return false;
    }
    // The lock is checked again: the kill switch or the allow-list may have changed while the helper answered.
    if (!sendAllowed(db, chatGuid, handleOf(chatGuid))) {
      void c.removeChat(chatGuid).catch(() => {});
      return false;
    }
    removed.delete(chatGuid);
    pendingRemovals.delete(chatGuid);
    registered.add(chatGuid);
    return true;
  }

  /** One helper request for a chat: lock, connection, registration, lock again, then the request. Null on any failure. */
  async function call(cmd: HelperCommand, chatGuid: string, args: Record<string, unknown>, timeoutMs: number): Promise<any | null> {
    if (locked(chatGuid) || !c.connected) return null;
    if (removed.has(chatGuid)) return null;
    if (!registered.has(chatGuid) && !(await allowChat(chatGuid))) return null;
    if (locked(chatGuid) || !c.connected) return null;
    try {
      const r = await c.request(cmd, chatGuid, args, timeoutMs);
      return r?.ok === true ? r : null;
    } catch {
      console.log("helper call failed"); // no details: an error could carry a chat guid
      return null;
    }
  }

  let registering: Promise<number> = Promise.resolve(0);

  async function registerOnce(): Promise<number> {
    if (!c.connected) return 0;
    for (const guid of [...pendingRemovals]) {
      try {
        await c.removeChat(guid);
        pendingRemovals.delete(guid);
      } catch {
        /* tried again on the next connection */
      }
    }
    const guids = new Set<string>();
    const rows = db.prepare("SELECT handle, chatId FROM allow_list WHERE reason != 'troy_group'").all() as { handle: string | null; chatId: string | null }[];
    for (const r of rows) {
      if (r.chatId?.startsWith("webchat;")) continue; // left over from development in the simulator
      if (r.chatId && ONE_TO_ONE.test(r.chatId)) guids.add(r.chatId);
      else if (r.handle) guids.add(`any;-;${r.handle}`);
    }
    for (const h of config.allowedHandles) guids.add(`any;-;${h}`);
    // People who said STOP keep their allow row (so Troy hears them come back) but leave the helper's list.
    const stopped = new Set((db.prepare("SELECT chatId FROM users WHERE stopped = 1").all() as { chatId: string }[]).map((u) => u.chatId));
    for (const guid of guids) {
      if (stopped.has(guid) || removed.has(guid) || registered.has(guid)) continue;
      await allowChat(guid);
    }
    return registered.size;
  }

  helper = {
    available: true,
    isConnected: () => c.connected,

    start() {
      c.start();
      if (c.connected) void helper?.registerAllowedChats().catch(() => {});
    },

    stop() {
      c.stop();
    },

    // One pass at a time: a reconnect during a pass waits its turn instead of doubling every call.
    registerAllowedChats() {
      const next = registering.then(registerOnce, registerOnce);
      registering = next.catch(() => 0);
      return next;
    },

    allowChat(chatGuid) {
      removed.delete(chatGuid); // an explicit opt-in undoes an earlier removal
      return allowChat(chatGuid);
    },

    // No lock here on purpose: this only narrows what the helper may touch, and it runs right after STOP.
    async removeChat(chatGuid) {
      if (typeof chatGuid !== "string" || !ONE_TO_ONE.test(chatGuid)) return false;
      registered.delete(chatGuid);
      removed.add(chatGuid);
      if (!c.connected) {
        pendingRemovals.add(chatGuid);
        return false;
      }
      try {
        const r = await c.removeChat(chatGuid);
        return r?.ok === true;
      } catch {
        pendingRemovals.add(chatGuid);
        return false;
      }
    },

    async sendPoll(chatGuid, options, creatorHandle) {
      if (options.length < 2 || options.length > 12 || options.some((o) => typeof o !== "string" || !o) || !creatorHandle) return null;
      const r = await call("send-poll", chatGuid, { options, creatorHandle }, 15_000);
      const ids: unknown = r?.optionIdentifiers;
      if (!r || typeof r.guid !== "string" || !r.guid) return null;
      if (!Array.isArray(ids) || ids.length !== options.length || ids.some((i) => typeof i !== "string")) return null;
      return { guid: r.guid, optionIdentifiers: ids as string[] };
    },

    async getPayload(chatGuid, messageGuid) {
      const r = await call("get-payload", chatGuid, { messageGuid }, 8_000);
      return typeof r?.payloadBase64 === "string" && r.payloadBase64 ? r.payloadBase64 : null;
    },

    async requestLocation(chatGuid) {
      // The reply waits up to 10 s for Find My's answer to the invite. The bubble is what the student sees,
      // so the request counts as made when the bubble went out, whatever the invite said.
      const r = await call("location-request", chatGuid, {}, 20_000);
      return !!r && typeof r.bubbleGuid === "string" && r.bubbleGuid.length > 0;
    },

    async getLocation(chatGuid) {
      const r = await call("location-get", chatGuid, {}, 15_000);
      const loc = r?.sharingWithMe === true ? r.location : null;
      if (!loc || typeof loc.latitude !== "number" || typeof loc.longitude !== "number") return null;
      if (!Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude) || (loc.latitude === 0 && loc.longitude === 0)) return null;
      const t = Number(loc.timestamp); // unix seconds per the README
      if (!Number.isFinite(t) || t <= 0) return null; // no time means no way to tell an old fix from a new one
      return { lat: loc.latitude, lng: loc.longitude, at: t < 1e12 ? Math.round(t * 1000) : t };
    },
  };
  return helper;
}
