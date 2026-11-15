// Local web chat: simulates several phones talking to Troy. Development and demo fallback only.
// It goes through the same gate and send lock as the real provider.

import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterCapabilities, Handle, IncomingEvent, MessagingAdapter, SendEffect, SentMessage, TapbackType } from "../types.ts";
import { isEnabled, normalizeHandle } from "../config.ts";
import { allowChat, decide, isAllowedChat, sendAllowed } from "./gate.ts";
import type { AdapterDeps } from "./index.ts";
import { SIGNUP_NOTICE_TEXT, consumeSignupNotice } from "../signups.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const DOWNLOADS = join(ROOT, "tmp-downloads");
const PAGE = join(ROOT, "public", "webchat.html");
const MAX_ENTRIES = 500;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// Changes on every server start, so an open page knows its transcript is gone.
const BOOT = randomUUID();
const TAPBACKS: TapbackType[] = ["love", "like", "dislike", "laugh", "emphasize", "question"];

export type TranscriptKind = "message" | "image" | "contact" | "tapback" | "typing" | "read" | "edit" | "location" | "poll" | "poll_vote";

/** One thing that happened in a chat. Edits and tapbacks point at an earlier entry through targetId. */
export interface TranscriptEntry {
  id: string;
  seq: number;
  at: number;
  chatId: string;
  /** "troy" or the handle of the simulated phone. */
  from: "troy" | Handle;
  kind: TranscriptKind;
  text?: string;
  imageUrl?: string;
  effect?: SendEffect;
  targetId?: string;
  tapback?: TapbackType;
  removed?: boolean;
  on?: boolean;
  location?: { lat: number; lng: number };
  /** kind "poll": the options in order. */
  options?: string[];
  /** kind "poll_vote": which option, on the poll in targetId. */
  optionIndex?: number;
  /** kind "location": true for a share bubble (+ > Location > Share), not set for a dropped pin. */
  shared?: boolean;
}

interface Phone {
  handle: Handle;
  /** Simulates a chat that already had messages before go-live (can never opt in by phrase). */
  hasOldHistory: boolean;
  location: { lat: number; lng: number; at: number } | null;
  /** A Find My location request from Troy that this phone has not accepted yet (lives in Find My, not in the chat). */
  findMyRequestAt: number | null;
}

export interface WebchatAdapter extends MessagingAdapter {
  /** Test and route helper: everything in a chat with seq greater than since. */
  transcript(chatId: string, since?: number): TranscriptEntry[];
}

const oneToOne = (handle: Handle) => `webchat;-;${handle}`;
const isGroupId = (chatId: string) => chatId.startsWith("webchat;+;");
const handleOf = (chatId: string): Handle | null => (chatId.startsWith("webchat;-;") ? chatId.slice("webchat;-;".length) : null);

export function createWebchatAdapter(deps: AdapterDeps): { adapter: WebchatAdapter; routes: Hono } {
  const { db } = deps;
  const phones = new Map<Handle, Phone>();
  const transcripts = new Map<string, TranscriptEntry[]>();
  const groups = new Map<string, Handle[]>();
  const media = new Map<string, { path: string; mime: string }>();
  let seq = 0;

  function phone(handle: Handle): Phone {
    let p = phones.get(handle);
    if (!p) phones.set(handle, (p = { handle, hasOldHistory: false, location: null, findMyRequestAt: null }));
    return p;
  }

  function add(chatId: string, from: TranscriptEntry["from"], kind: TranscriptKind, rest: Partial<TranscriptEntry> = {}): TranscriptEntry {
    const entry: TranscriptEntry = { id: randomUUID(), seq: ++seq, at: Date.now(), chatId, from, kind, ...rest };
    const list = transcripts.get(chatId) ?? [];
    list.push(entry);
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
    transcripts.set(chatId, list);
    return entry;
  }

  /** The send lock. Every outgoing method calls this first. */
  function canSend(chatId: string): boolean {
    if (sendAllowed(db, chatId, handleOf(chatId))) return true;
    console.log("send refused");
    return false;
  }

  function mediaUrl(path: string, mime: string): string {
    const id = randomUUID();
    media.set(id, { path, mime });
    return `/webchat/media/${id}`;
  }

  const chatsFor = (handle: Handle) => [oneToOne(handle), ...[...groups].filter(([, m]) => m.includes(handle)).map(([id]) => id)];

  const adapter: WebchatAdapter = {
    provider: "webchat",

    capabilities(): AdapterCapabilities {
      const liveLocation = [...phones.values()].some((p) => p.location !== null);
      return { tapbacks: true, typing: true, readReceipts: true, edits: true, effects: true, polls: true, groupChats: true, contactCard: true, liveLocation };
    },

    async sendMessage(chatId, text, opts): Promise<SentMessage | null> {
      if (!canSend(chatId)) return null;
      return { messageId: add(chatId, "troy", "message", { text, effect: opts?.effect }).id };
    },

    async sendImage(chatId, imagePath, caption): Promise<SentMessage | null> {
      if (!canSend(chatId)) return null;
      const mime = imagePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      return { messageId: add(chatId, "troy", "image", { imageUrl: mediaUrl(imagePath, mime), text: caption }).id };
    },

    async sendContactCard(chatId): Promise<SentMessage | null> {
      if (!canSend(chatId)) return null;
      return { messageId: add(chatId, "troy", "contact", { text: "Troy" }).id };
    },

    async markRead(chatId): Promise<void> {
      if (canSend(chatId)) add(chatId, "troy", "read");
    },

    async startTyping(chatId): Promise<void> {
      if (canSend(chatId)) add(chatId, "troy", "typing", { on: true });
    },

    async stopTyping(chatId): Promise<void> {
      if (canSend(chatId)) add(chatId, "troy", "typing", { on: false });
    },

    async react(chatId, messageId, type): Promise<boolean> {
      if (!canSend(chatId)) return false;
      if (!transcripts.get(chatId)?.some((e) => e.id === messageId)) return false;
      add(chatId, "troy", "tapback", { targetId: messageId, tapback: type, removed: false });
      return true;
    },

    async editMessage(chatId, messageId, text): Promise<boolean> {
      if (!canSend(chatId)) return false;
      const target = transcripts.get(chatId)?.find((e) => e.id === messageId && e.from === "troy" && e.kind === "message");
      if (!target) return false;
      target.text = text;
      add(chatId, "troy", "edit", { targetId: messageId, text });
      return true;
    },

    // Like the real provider: the question as a normal bubble, then a native poll card the phone votes on
    // (POST /webchat/vote). Every option id is the poll's id. WEBCHAT_POLLS=tap gives the fallback shape instead:
    // one bubble per option to tapback.
    async sendPoll(chatId, question, options) {
      if (!canSend(chatId)) return { optionMessageIds: options.map(() => null), mode: "tap" as const };
      add(chatId, "troy", "message", { text: question });
      if ((process.env.WEBCHAT_POLLS || "").trim().toLowerCase() === "tap" || options.length < 2) {
        return { optionMessageIds: options.map((o) => add(chatId, "troy", "message", { text: o }).id), mode: "tap" as const };
      }
      const poll = add(chatId, "troy", "poll", { options: [...options] });
      return { optionMessageIds: options.map(() => poll.id), mode: "native" as const };
    },

    // Like the real provider: a Find My request with no bubble in the chat. It waits on the simulated phone
    // (the "Find My request" control) until the phone accepts it (POST /webchat/findmy/accept). A second
    // request while one is waiting counts as sent too, the way "error 7" does. 1:1 chats only.
    async requestLocation(chatId): Promise<boolean> {
      if (!canSend(chatId)) return false;
      const h = handleOf(chatId);
      if (isGroupId(chatId) || !h) return false;
      const p = phone(h);
      if (p.findMyRequestAt === null) p.findMyRequestAt = Date.now();
      return true;
    },

    // The one send that skips the allow-list: the fixed line for a new chat turned away by the sign-up switch or
    // cap. The gate's one-time grant for this exact chat and kind is the lock (it also checks the kill switch).
    // Only the bubble itself lands in the simulated phone's transcript: no read mark, no typing, nothing saved.
    async sendSignupNotice(chatId, kind): Promise<boolean> {
      const text = Object.hasOwn(SIGNUP_NOTICE_TEXT, kind) ? SIGNUP_NOTICE_TEXT[kind] : null;
      if (!text || isGroupId(chatId) || !handleOf(chatId) || !consumeSignupNotice(db, chatId, handleOf(chatId), kind)) {
        console.log("send refused");
        return false;
      }
      add(chatId, "troy", "message", { text });
      return true;
    },

    // Nothing to register: the simulator has no second allowlist.
    async onAllowed(): Promise<void> {},
    async onDisallowed(): Promise<void> {},

    async createGroupChat(members, firstMessage): Promise<string | null> {
      const handles = [...new Set(members.map(normalizeHandle).filter((h): h is Handle => h !== null))];
      // Troy only starts a group with people whose own chat with him is already allowed.
      if (!isEnabled(db) || handles.length < 2 || !handles.every((h) => isAllowedChat(db, oneToOne(h), h))) {
        console.log("send refused");
        return null;
      }
      const chatId = `webchat;+;${randomUUID().slice(0, 8)}`;
      groups.set(chatId, handles);
      for (const h of handles) phone(h);
      allowChat(db, { handle: null, chatId, reason: "troy_group" });
      await adapter.sendMessage(chatId, firstMessage);
      return chatId;
    },

    async getLiveLocation(handle) {
      const h = normalizeHandle(handle);
      if (!h || !sendAllowed(db, oneToOne(h), h)) return null;
      const loc = phones.get(h)?.location;
      return loc ? { ...loc } : null;
    },

    chatIdForHandle: oneToOne,

    transcript(chatId, since = 0) {
      return (transcripts.get(chatId) ?? []).filter((e) => e.seq > since);
    },
  };

  /** Run the gate for something a simulated phone did. Denied means dropped, with nothing kept. */
  async function gate(handle: Handle, chatId: string, text: string): Promise<boolean> {
    const d = await decide(db, {
      isFromMe: false,
      handle,
      chatId,
      isGroup: isGroupId(chatId),
      text,
      hasHistoryBeforeGoLive: async () => phone(handle).hasOldHistory,
    });
    if (!d.allow) {
      if (d.notice) await adapter.sendSignupNotice?.(chatId, d.notice);
      console.log("ignored event");
      return false;
    }
    return true;
  }

  function dispatch(e: IncomingEvent): void {
    deps.onEvent(e).catch((err) => console.error("webchat onEvent failed:", err instanceof Error ? err.message : "error"));
  }

  /** Resolve which chat a phone is acting in: its own 1:1 by default, or a group it belongs to. */
  function resolveChat(handle: Handle, chatId: unknown): string | null {
    if (typeof chatId !== "string" || !chatId || chatId === oneToOne(handle)) return oneToOne(handle);
    return groups.get(chatId)?.includes(handle) ? chatId : null;
  }

  const routes = new Hono();
  const bad = (msg: string) => new Response(JSON.stringify({ ok: false, error: msg }), { status: 400, headers: { "content-type": "application/json" } });

  routes.get("/webchat", (c) => c.html(readFileSync(PAGE, "utf8")));

  routes.post("/webchat/send", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const handle = normalizeHandle(body?.handle);
    if (!body || !handle) return bad("handle must be a phone number or email");
    phone(handle);
    const chatId = resolveChat(handle, body.chatId);
    if (!chatId) return bad("not a member of that chat");
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const loc = body.location as { lat?: unknown; lng?: unknown } | undefined;
    const location = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng) ? { lat: loc.lat as number, lng: loc.lng as number } : undefined;
    const imageBase64 = typeof body.imageBase64 === "string" ? body.imageBase64.replace(/^data:[^,]*,/, "") : "";
    const mime = body.imageMime === "image/png" ? "image/png" : "image/jpeg";
    if (imageBase64 && body.imageMime !== "image/png" && body.imageMime !== "image/jpeg") return bad("image must be JPEG or PNG");
    if (!text && !imageBase64 && !location) return bad("nothing to send");

    if (!(await gate(handle, chatId, text))) return c.json({ ok: true, accepted: false });

    const images: IncomingEvent["images"] = [];
    let imageUrl: string | undefined;
    if (imageBase64) {
      const bytes = Buffer.from(imageBase64, "base64");
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return bad("image is empty or over 10 MB");
      mkdirSync(DOWNLOADS, { recursive: true });
      const path = join(DOWNLOADS, `webchat-${randomUUID()}.${mime === "image/png" ? "png" : "jpg"}`);
      writeFileSync(path, bytes);
      images.push({ path, mime });
      imageUrl = mediaUrl(path, mime);
    }
    const entry = add(chatId, handle, imageUrl ? "image" : location && !text ? "location" : "message", { text: text || undefined, imageUrl, location });
    dispatch({ provider: "webchat", userHandle: handle, chatId, isGroup: isGroupId(chatId), messageId: entry.id, text, images, location, receivedAt: entry.at });
    return c.json({ ok: true, accepted: true, messageId: entry.id });
  });

  routes.post("/webchat/react", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const handle = normalizeHandle(body?.handle);
    if (!body || !handle) return bad("handle must be a phone number or email");
    const type = body.type as TapbackType;
    if (!TAPBACKS.includes(type)) return bad("unknown tapback type");
    const chatId = chatsFor(handle).find((id) => transcripts.get(id)?.some((e) => e.id === body.messageId));
    if (!chatId) return bad("message not found");
    if (!(await gate(handle, chatId, ""))) return c.json({ ok: true, accepted: false });
    const removed = body.removed === true;
    const entry = add(chatId, handle, "tapback", { targetId: body.messageId as string, tapback: type, removed });
    dispatch({
      provider: "webchat",
      userHandle: handle,
      chatId,
      isGroup: isGroupId(chatId),
      messageId: entry.id,
      text: "",
      images: [],
      reaction: { targetMessageId: body.messageId as string, type, removed },
      receivedAt: entry.at,
    });
    return c.json({ ok: true, accepted: true });
  });

  // The simulated phone votes on a native poll card.
  routes.post("/webchat/vote", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const handle = normalizeHandle(body?.handle);
    if (!body || !handle) return bad("handle must be a phone number or email");
    const find = (id: string) => transcripts.get(id)?.find((e) => e.id === body.pollId && e.kind === "poll");
    const chatId = chatsFor(handle).find((id) => find(id));
    const poll = chatId ? find(chatId) : undefined;
    if (!chatId || !poll) return bad("poll not found");
    const optionIndex = body.optionIndex;
    if (typeof optionIndex !== "number" || !Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= (poll.options?.length ?? 0)) return bad("no such option");
    if (!(await gate(handle, chatId, ""))) return c.json({ ok: true, accepted: false });
    const entry = add(chatId, handle, "poll_vote", { targetId: poll.id, optionIndex });
    dispatch({
      provider: "webchat",
      userHandle: handle,
      chatId,
      isGroup: isGroupId(chatId),
      messageId: entry.id,
      text: "",
      images: [],
      pollVote: { pollMessageId: poll.id, optionIndex },
      receivedAt: entry.at,
    });
    return c.json({ ok: true, accepted: true });
  });

  // The simulated phone shares from the chat (+ > Location > Share): a share bubble in its 1:1 chat.
  // Troy gets one event with the location and no text, and the phone keeps sharing after.
  routes.post("/webchat/share", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const handle = normalizeHandle(body?.handle);
    if (!body || !handle) return bad("handle must be a phone number or email");
    const lat = body.lat;
    const lng = body.lng;
    if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return bad("lat and lng must be numbers");
    const chatId = oneToOne(handle);
    // Gate first: a chat that hasn't opted in changes nothing, not even the simulated phone's sharing state.
    if (!(await gate(handle, chatId, ""))) return c.json({ ok: true, accepted: false });
    const location = { lat, lng };
    const p = phone(handle);
    p.location = { ...location, at: Date.now() };
    p.findMyRequestAt = null; // sharing answers a waiting request too
    const entry = add(chatId, handle, "location", { location, shared: true });
    dispatch({ provider: "webchat", userHandle: handle, chatId, isGroup: false, messageId: entry.id, text: "", images: [], location, receivedAt: entry.at });
    return c.json({ ok: true, accepted: true, messageId: entry.id });
  });

  // The simulated phone accepts Troy's request inside Find My. Like the real thing: sharing starts, nothing
  // shows up in the chat and Troy gets no event. He finds out when he next looks (the background refresh,
  // or "done" at the onboarding step).
  routes.post("/webchat/findmy/accept", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const handle = normalizeHandle(body?.handle);
    if (!body || !handle) return bad("handle must be a phone number or email");
    const lat = body.lat;
    const lng = body.lng;
    if (typeof lat !== "number" || typeof lng !== "number" || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return bad("lat and lng must be numbers");
    const p = phones.get(handle);
    if (!p || p.findMyRequestAt === null) return bad("no Find My request to accept");
    p.findMyRequestAt = null;
    p.location = { lat, lng, at: Date.now() };
    return c.json({ ok: true, sharing: true });
  });

  // Find My on the simulated phone, with no chat bubble: start sharing, move (each call is a new fix with a new
  // time, which is what the background refresh looks for), or stop with lat: null.
  routes.post("/webchat/location", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const handle = normalizeHandle(body?.handle);
    if (!body || !handle) return bad("handle must be a phone number or email");
    if (body.lat === null) {
      phone(handle).location = null;
      return c.json({ ok: true, sharing: false });
    }
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return bad("lat and lng must be numbers");
    phone(handle).location = { lat, lng, at: Date.now() };
    return c.json({ ok: true, sharing: true });
  });

  // Dev toggle: pretend this phone's chat already had messages before go-live.
  routes.post("/webchat/history", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const handle = normalizeHandle(body?.handle);
    if (!body || !handle) return bad("handle must be a phone number or email");
    phone(handle).hasOldHistory = body.hasOldHistory === true;
    return c.json({ ok: true, hasOldHistory: phone(handle).hasOldHistory });
  });

  routes.get("/webchat/transcript", (c) => {
    const handle = normalizeHandle(c.req.query("handle"));
    if (!handle) return bad("handle must be a phone number or email");
    const since = Number(c.req.query("since")) || 0;
    const chats = chatsFor(handle);
    const entries = chats.flatMap((id) => adapter.transcript(id, since)).sort((a, b) => a.seq - b.seq);
    const p = phones.get(handle);
    return c.json({
      ok: true,
      boot: BOOT,
      cursor: seq,
      entries,
      chats: chats.map((id) => ({ chatId: id, isGroup: isGroupId(id), members: groups.get(id) ?? [handle] })),
      phone: {
        handle,
        hasOldHistory: p?.hasOldHistory ?? false,
        sharingLocation: !!p?.location,
        /** True while a Find My request from Troy waits on this phone. */
        findMyRequest: (p?.findMyRequestAt ?? null) !== null,
        // Lets the page hide the judge button once it has nothing left to skip.
        verified: !!(db.prepare("SELECT verifiedAt FROM users WHERE handle = ?").get(handle) as { verifiedAt: number | null } | undefined)?.verifiedAt,
      },
    });
  });

  routes.get("/webchat/phones", (c) =>
    c.json({
      ok: true,
      phones: [...phones.values()].map((p) => ({
        handle: p.handle,
        chatId: oneToOne(p.handle),
        hasOldHistory: p.hasOldHistory,
        sharingLocation: !!p.location,
        findMyRequest: p.findMyRequestAt !== null,
        groups: chatsFor(p.handle).filter(isGroupId),
      })),
    }),
  );

  routes.get("/webchat/media/:id", (c) => {
    const m = media.get(c.req.param("id"));
    if (!m || !existsSync(m.path)) return c.notFound();
    return new Response(readFileSync(m.path), { headers: { "content-type": m.mime, "cache-control": "no-store" } });
  });

  return { adapter, routes };
}
