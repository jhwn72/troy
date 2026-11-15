// BlueBubbles adapter (Server 1.9.12, Private API). The server sees every iMessage on John's Apple ID,
// so this file is where the privacy rules are enforced:
//   - incoming: decide() runs before anything is downloaded, saved, built or logged
//   - outgoing: every request goes through guardedSend(), which holds the send lock
//   - the patched helper (native polls, payloads, location requests) goes through src/adapters/helper.ts,
//     which holds the same lock
// Request shapes follow scripts/feature-test.ts (verified on this Mac) and the server source
// (BlueBubblesApp/bluebubbles-server, api/http/api/v1). Unverified parts are marked UNCONFIRMED.

import { Hono } from "hono";
import type { Context } from "hono";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AdapterCapabilities, Handle, IncomingEvent, IncomingImage, MessagingAdapter, SendEffect, SentMessage, TapbackType } from "../types.ts";
import type { AdapterDeps } from "./index.ts";
import { config, isEnabled, normalizeHandle } from "../config.ts";
import { getSetting, setSetting } from "../db/index.ts";
import { allowChat, decide, getGoLiveAt, isAllowedChat, sendAllowed } from "./gate.ts";
import { SIGNUP_NOTICE_TEXT, consumeSignupNotice, wasRefusedFirstMessage } from "../signups.ts";
import { FINDMY_BALLOON_ID, createHelper, decodeFindMyPayload, decodeFindMyShare, decodePollVote } from "./helper.ts";

// How long to keep asking Find My for a fix after a share whose bubble had none (ms between tries).
const FINDMY_WAITS_MS = (process.env.TROY_FINDMY_WAITS_MS || "5000,15000,20000,20000").split(",").map(Number).filter((n) => Number.isFinite(n) && n >= 0);
import type { Helper } from "./helper.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const DOWNLOADS = join(ROOT, "tmp-downloads"); // gitignored
const AVATAR = join(ROOT, "public", "assets", "troy-avatar.png"); // made from troy-avatar.svg, 512px
/** Polls, Find My and every other iMessage app bubble. Their text is a placeholder, never something typed. */
const APP_BALLOON_PREFIX = "com.apple.messages.MSMessageExtensionBalloonPlugin";

/** How long to wait before asking again when the server lists no messages for a chat. */
const EMPTY_RETRY_MS = Number(process.env.TROY_EMPTY_RETRY_MS ?? 1500);

const TAPBACKS: TapbackType[] = ["love", "like", "dislike", "laugh", "emphasize", "question"];

// Effect ids are Apple's; only "slam" (impact) was tested on this Mac. The others are UNCONFIRMED here.
const EFFECTS: Record<SendEffect, string> = {
  confetti: "com.apple.messages.effect.CKConfettiEffect",
  fireworks: "com.apple.messages.effect.CKFireworksEffect",
  balloons: "com.apple.messages.effect.CKHappyBirthdayEffect",
  celebration: "com.apple.messages.effect.CKSparklesEffect",
  slam: "com.apple.MobileSMS.expressivesend.impact",
  loud: "com.apple.MobileSMS.expressivesend.loud",
  gentle: "com.apple.MobileSMS.expressivesend.gentle",
};

const IMAGE_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic" };

type Json = Record<string, any>;

/** "any;-;+13105551234" -> "+13105551234". Null for group chats and anything unexpected. */
export function handleFromChatId(chatId: string): Handle | null {
  const parts = typeof chatId === "string" ? chatId.split(";") : [];
  if (parts.length !== 3 || parts[1] !== "-") return null;
  return normalizeHandle(parts[2]);
}

/** Pull lat/lng out of an Apple location pin vCard (a maps URL with ll= or q=lat,lng; the comma is often escaped). */
export function parseLocationVcard(vcf: string): { lat: number; lng: number } | null {
  const m = /(?:[?&](?:ll|q|sll|center)=)(-?\d{1,3}\.\d+)(?:\\?,|%2C)(-?\d{1,3}\.\d+)/i.exec(vcf.replace(/\r?\n /g, ""));
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** associatedMessageType arrives as "love" / "-love" (or 2000..2005 / 3000..3005 from the raw database value). */
function parseTapback(raw: unknown): { type: TapbackType; removed: boolean } | null {
  let s = String(raw ?? "");
  const n = Number(s);
  if (Number.isInteger(n) && n >= 2000 && n <= 3005) {
    const type = TAPBACKS[n % 1000];
    return type ? { type, removed: n >= 3000 } : null;
  }
  const removed = s.startsWith("-");
  if (removed) s = s.slice(1);
  return (TAPBACKS as string[]).includes(s) ? { type: s as TapbackType, removed } : null;
}

/** The contact card: name, optional handle, the mascot photo. Lines are folded at 75 characters as vCard 3.0 asks. */
export function buildContactCard(): string {
  const lines = ["BEGIN:VCARD", "VERSION:3.0", "N:;Troy;;;", "FN:Troy"];
  // Optional: TROY_CONTACT (the number or email students text) so saving the card attaches to this chat.
  for (const raw of (process.env.TROY_CONTACT || process.env.TROY_NUMBER || "").split(",")) {
    const h = normalizeHandle(raw);
    if (h) lines.push(h.includes("@") ? `EMAIL;TYPE=INTERNET:${h}` : `TEL;TYPE=CELL:${h}`);
  }
  // UNCONFIRMED on a phone: how the note renders. It is a NOTE (not ORG) so it can never change the name shown.
  lines.push("NOTE:ai that knows a guy · usc hackathon demo");
  if (existsSync(AVATAR)) lines.push(`PHOTO;ENCODING=b;TYPE=PNG:${readFileSync(AVATAR).toString("base64")}`);
  lines.push("END:VCARD");
  const folded = lines.map((l) => (l.length <= 75 ? l : l.slice(0, 75) + l.slice(75).replace(/.{1,74}/g, "\r\n $&")));
  return folded.join("\r\n") + "\r\n";
}

export function createBluebubblesAdapter(
  deps: AdapterDeps,
  /** Tests pass a helper built around a fake client. Left out, the real one is used when it is configured. */
  opts: { helper?: Helper } = {},
): {
  adapter: MessagingAdapter;
  routes: Hono;
  /** Processes one webhook body. The route calls this without waiting; tests can await it. */
  handleWebhook: (body: unknown) => Promise<void>;
  helper: Helper;
} {
  const { db, onEvent } = deps;
  const helper = opts.helper ?? createHelper({ db });

  // ---------- raw HTTP (private to this file) ----------

  async function api(method: string, path: string, body?: unknown, form?: FormData, timeoutMs = 20_000): Promise<Json> {
    const sep = path.includes("?") ? "&" : "?";
    const res = await fetch(`${config.bluebubblesUrl}/api/v1${path}${sep}password=${encodeURIComponent(config.bluebubblesPassword)}`, {
      method,
      headers: form ? undefined : body ? { "content-type": "application/json" } : undefined,
      body: form ?? (body ? JSON.stringify(body) : undefined),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Errors carry only the status: never the URL (it has the password) and never a response body.
    if (!res.ok) throw new Error(`bluebubbles ${res.status}`);
    return (await res.json()) as Json;
  }

  const enc = encodeURIComponent;

  // ---------- Private API status (lazy, cached; never checked until a real call needs it) ----------

  let papi: boolean | null = null;
  let papiCheckedAt = 0;
  let findMyBroken = false;
  /** The Apple ID this Mac sends iMessages from (server info "detected_imessage"). Native polls need it as the creator. */
  let hostHandle: string | null = null;

  async function privateApiOn(): Promise<boolean> {
    if (papi !== null && Date.now() - papiCheckedAt < 5 * 60_000) return papi;
    try {
      const info = (await api("GET", "/server/info")).data ?? {};
      papi = info.private_api === true && info.helper_connected === true;
      if (typeof info.detected_imessage === "string" && info.detected_imessage) hostHandle = info.detected_imessage;
    } catch {
      papi = false;
    }
    papiCheckedAt = Date.now();
    return papi;
  }

  // ---------- the send lock ----------

  const editsOn = () => ["true", "1", "on", "yes"].includes((process.env.BLUEBUBBLES_EDITS || "").trim().toLowerCase());

  /**
   * The ONLY way this adapter makes a request that acts on a chat.
   * `target` is the chat id, or the member list when creating a group.
   * Refuses (no request at all) unless Troy is enabled and the chat, or every member, is allowed.
   */
  async function guardedSend(
    target: string | Handle[],
    build: (privateApi: boolean) => { method: string; path: string; body?: unknown; form?: FormData } | null,
  ): Promise<Json | null> {
    const allowed = () =>
      Array.isArray(target)
        ? isEnabled(db) && target.length > 0 && target.every((h) => isAllowedChat(db, chatIdForHandle(h), h))
        : sendAllowed(db, target, handleFromChatId(target));
    if (!allowed()) {
      console.log("send refused");
      return null;
    }
    try {
      const req = build(await privateApiOn());
      if (!req) return null; // not possible without the Private API; the caller falls back
      // The status lookup above can take seconds. The kill switch or allow-list may have changed meanwhile,
      // so the lock is checked again as the very last thing before the request goes out.
      if (!allowed()) {
        console.log("send refused");
        return null;
      }
      return await api(req.method, req.path, req.body, req.form);
    } catch {
      console.log("send failed");
      return null;
    }
  }

  function chatIdForHandle(handle: Handle): string {
    return `any;-;${handle}`; // macOS 27 uses the "any" prefix for 1:1 chats
  }

  // ---------- outgoing ----------

  async function sendText(chatId: string, text: string, effect?: SendEffect): Promise<SentMessage | null> {
    const r = await guardedSend(chatId, (privateApi) => ({
      method: "POST",
      path: "/message/text",
      body: {
        chatGuid: chatId,
        tempGuid: randomUUID(),
        message: text,
        // UNCONFIRMED: the apple-script fallback was never tried with "any;-;" chat guids.
        method: privateApi ? "private-api" : "apple-script",
        ...(privateApi && effect ? { effectId: EFFECTS[effect] } : {}),
      },
    }));
    return r ? { messageId: typeof r.data?.guid === "string" ? r.data.guid : null } : null;
  }

  async function sendFile(chatId: string, filePath: string, mime: string): Promise<SentMessage | null> {
    const r = await guardedSend(chatId, (privateApi) => {
      const name = basename(filePath);
      const form = new FormData();
      form.set("chatGuid", chatId);
      form.set("tempGuid", randomUUID());
      form.set("name", name);
      form.set("method", privateApi ? "private-api" : "apple-script");
      form.set("attachment", new Blob([readFileSync(filePath)], { type: mime }), name);
      return { method: "POST", path: "/message/attachment", form };
    });
    return r ? { messageId: typeof r.data?.guid === "string" ? r.data.guid : null } : null;
  }

  function contactCardPath(): string {
    mkdirSync(DOWNLOADS, { recursive: true });
    const file = join(DOWNLOADS, "Troy.vcf");
    writeFileSync(file, buildContactCard());
    return file;
  }

  // ---------- native polls (through the helper) ----------

  // A vote names the option by identifier, so each poll's identifiers are kept: in memory, and in the
  // settings table (key "poll:<guid>") so a vote can still be mapped after a restart. No handle or chat id is stored.
  const polls = new Map<string, string[]>();

  function rememberPoll(guid: string, optionIdentifiers: string[]): void {
    polls.set(guid, optionIdentifiers);
    if (polls.size > 500) polls.delete(polls.keys().next().value as string);
    setSetting(db, `poll:${guid}`, JSON.stringify(optionIdentifiers));
  }

  function pollOptions(guid: string): string[] | null {
    const cached = polls.get(guid);
    if (cached) return cached;
    try {
      const saved: unknown = JSON.parse(getSetting(db, `poll:${guid}`) ?? "null");
      if (!Array.isArray(saved) || saved.some((x) => typeof x !== "string")) return null;
      polls.set(guid, saved as string[]);
      return saved as string[];
    } catch {
      return null;
    }
  }

  /** A balloon's payload. The helper can be a moment behind the webhook, so it is asked twice. */
  async function payloadFor(chatId: string, messageGuid: string): Promise<string | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!helper.isConnected()) return null;
      const p = await helper.getPayload(chatId, messageGuid);
      if (p) return p;
      if (attempt === 0) await new Promise((r) => setTimeout(r, EMPTY_RETRY_MS));
    }
    return null;
  }

  // Find My refresh reopens the Find My app on the Mac, so do it at most once a minute.
  let lastFindMyRefresh = 0;

  /** Returns the one entry for `handle` and nothing else. Other people's entries are never kept. */
  function pickFriend(list: unknown, handle: Handle): { lat: number; lng: number; at: number } | null {
    if (!Array.isArray(list)) return null;
    const mine = list.find((e) => normalizeHandle(e?.handle) === handle);
    const c = mine?.coordinates;
    if (!Array.isArray(c) || typeof c[0] !== "number" || typeof c[1] !== "number") return null;
    if (c[0] === 0 && c[1] === 0) return null; // the server uses [0, 0] for "no location yet"
    // UNCONFIRMED: last_updated is assumed to be unix ms (seconds are converted just in case).
    const t = Number(mine.last_updated) || Date.now();
    return { lat: c[0], lng: c[1], at: t < 1e12 ? t * 1000 : t };
  }

  const adapter: MessagingAdapter & { helperConnected(): boolean } = {
    provider: "bluebubbles",

    /** Not part of MessagingAdapter: the server asks this before it runs the background location refresh. */
    helperConnected: () => helper.isConnected(),

    // Before the first real call the Private API status is unknown and reported as on (it is on per
    // docs/bluebubbles-status.md). Each method still checks for real and falls back when it's off.
    capabilities(): AdapterCapabilities {
      const on = papi !== false;
      return {
        tapbacks: on,
        typing: on,
        readReceipts: on,
        edits: on && editsOn(),
        effects: on,
        polls: on && helper.isConnected(),
        groupChats: on,
        contactCard: true,
        liveLocation: on && (!findMyBroken || helper.isConnected()),
      };
    },

    sendMessage(chatId, text, opts) {
      return sendText(chatId, text, opts?.effect);
    },

    async sendImage(chatId, imagePath, caption) {
      const ext = imagePath.toLowerCase().split(".").pop() ?? "";
      const mime = Object.entries(IMAGE_EXT).find(([, e]) => e === ext)?.[0] ?? (ext === "jpeg" ? "image/jpeg" : "application/octet-stream");
      const sent = await sendFile(chatId, imagePath, mime);
      if (sent && caption) await sendText(chatId, caption);
      return sent;
    },

    async sendContactCard(chatId) {
      // The lock is checked again inside sendFile; this early check keeps a refused call from writing a file.
      if (!sendAllowed(db, chatId, handleFromChatId(chatId))) {
        console.log("send refused");
        return null;
      }
      return sendFile(chatId, contactCardPath(), "text/vcard");
    },

    async markRead(chatId) {
      await guardedSend(chatId, (privateApi) => (privateApi ? { method: "POST", path: `/chat/${enc(chatId)}/read` } : null));
    },

    async startTyping(chatId) {
      await guardedSend(chatId, (privateApi) => (privateApi ? { method: "POST", path: `/chat/${enc(chatId)}/typing` } : null));
    },

    async stopTyping(chatId) {
      await guardedSend(chatId, (privateApi) => (privateApi ? { method: "DELETE", path: `/chat/${enc(chatId)}/typing` } : null));
    },

    async react(chatId, messageId, type) {
      const r = await guardedSend(chatId, (privateApi) =>
        privateApi ? { method: "POST", path: "/message/react", body: { chatGuid: chatId, selectedMessageGuid: messageId, reaction: type, partIndex: 0 } } : null,
      );
      return r !== null;
    },

    // Edits crashed Messages with the stock 1.9.12 helper; the patched helper (bluebubbles/README.md) fixes it.
    // Off unless BLUEBUBBLES_EDITS is on, so a machine with the old helper can never reach the endpoint.
    // Returns false when skipped; the caller sends a new text instead.
    async editMessage(chatId, messageId, text) {
      if (!editsOn()) {
        if (!sendAllowed(db, chatId, handleFromChatId(chatId))) console.log("send refused");
        return false;
      }
      const r = await guardedSend(chatId, (privateApi) =>
        privateApi
          ? {
              method: "POST",
              path: `/message/${enc(messageId)}/edit`,
              body: { editedMessage: text, backwardsCompatibilityMessage: `Edited to "${text}"`, partIndex: 0 },
            }
          : null,
      );
      return r !== null;
    },

    // Native poll when the patched helper is connected (1:1 chats, 2 to 12 options): the question as a normal
    // text first, because a poll has no title of its own, then the poll. Otherwise "tap to pick": one bubble per
    // option that the student tapbacks. Without the Private API tapbacks can't be read, so it is a numbered list.
    async sendPoll(chatId, question, options) {
      const none = options.map(() => null);
      if (!sendAllowed(db, chatId, handleFromChatId(chatId))) {
        console.log("send refused");
        return { optionMessageIds: none, mode: "tap" };
      }
      if (!(await privateApiOn())) {
        // No instruction line: every caller adds exactly one hint of its own (never two in one message).
        await sendText(chatId, [question, ...options.map((o, i) => `${i + 1}. ${o}`)].join("\n"));
        return { optionMessageIds: none, mode: "numbered" };
      }
      let questionSent = false;
      if (helper.isConnected() && hostHandle && handleFromChatId(chatId) && options.length >= 2 && options.length <= 12) {
        questionSent = (await sendText(chatId, question)) !== null;
        const poll = questionSent ? await helper.sendPoll(chatId, options, hostHandle) : null;
        if (poll) {
          rememberPoll(poll.guid, poll.optionIdentifiers);
          return { optionMessageIds: options.map(() => poll.guid), mode: "native" };
        }
      }
      // The question may already be out (the poll itself failed): don't say it twice. No instruction line here:
      // the caller adds its one hint ("heart the one u want"), never "tap ❤️ on ur pick" (John, second live test (5)).
      if (!questionSent) await sendText(chatId, question);
      const optionMessageIds: (string | null)[] = [];
      for (const o of options) optionMessageIds.push((await sendText(chatId, o))?.messageId ?? null);
      return { optionMessageIds, mode: "tap" };
    },

    // Every member must already be an allowed handle. UNCONFIRMED: group creation was never tested on this Mac.
    async createGroupChat(members, firstMessage) {
      const handles = [...new Set(members.map(normalizeHandle))];
      if (handles.length < 2 || handles.some((h) => h === null)) {
        console.log("send refused");
        return null;
      }
      const startedAt = Date.now();
      const r = await guardedSend(handles as Handle[], (privateApi) =>
        privateApi
          ? { method: "POST", path: "/chat/new", body: { addresses: handles, message: firstMessage, method: "private-api", service: "iMessage", tempGuid: randomUUID() } }
          : null,
      );
      const guid = r?.data?.guid;
      if (typeof guid !== "string" || !guid.includes(";+;")) return null;
      // iMessage reuses an existing thread with the same people. A group only counts as Troy's if it is
      // brand new: the right members, and nothing in it from before this call. Otherwise it stays locked.
      const participants: unknown = r?.data?.participants;
      if (Array.isArray(participants)) {
        const got = participants.map((m) => normalizeHandle(m?.address)).sort();
        const want = [...(handles as Handle[])].sort();
        if (got.length !== want.length || got.some((h, i) => h !== want[i])) {
          console.log("send refused");
          return null;
        }
      }
      let isNew = false;
      try {
        const earliest = await earliestMessage(guid);
        isNew = earliest !== null && earliest.at >= startedAt - 2000;
      } catch {
        isNew = false;
      }
      if (!isNew || !isEnabled(db)) {
        console.log("send refused");
        return null;
      }
      allowChat(db, { handle: null, chatId: guid, reason: "troy_group" });
      return guid;
    },

    // GET /api/v1/icloud/findmy/friends returns the server's cache of everyone sharing with John:
    //   { data: [{ handle, coordinates: [lat, lng], last_updated, status, ... }] }  (server source: FindMyLocationItem)
    // Only the requested handle's entry is read, and only if that handle is allowed.
    // UNCONFIRMED on macOS 27: whether the cache fills at all. On Sonoma and later the server relies on the
    // helper pushing "new-findmy-location" updates and on opening the Find My app (the refresh call below).
    // Second source: the helper's "location-get" (bluebubbles/README.md, "Location"), which asks Find My about
    // the one person in the chat. It is tried when BlueBubbles has nothing fresh, before the slow refresh.
    async getLiveLocation(handle) {
      const h = normalizeHandle(handle);
      const allowed = () => sendAllowed(db, chatIdForHandle(h as Handle), h);
      if (!h || !allowed()) return null;
      if (!(await privateApiOn())) return null;
      if (!allowed()) return null; // the kill switch may have flipped during the status lookup
      const fresh = (f: { at: number } | null) => f !== null && Date.now() - f.at < 5 * 60_000;
      let found: { lat: number; lng: number; at: number } | null = null;
      try {
        found = pickFriend((await api("GET", "/icloud/findmy/friends")).data, h);
        findMyBroken = false;
      } catch {
        findMyBroken = true;
      }
      if (!fresh(found) && helper.isConnected()) {
        if (!allowed()) return null;
        const viaHelper = await helper.getLocation(chatIdForHandle(h));
        if (viaHelper && (!found || viaHelper.at > found.at)) found = viaHelper;
      }
      if (!fresh(found) && !findMyBroken && Date.now() - lastFindMyRefresh > 60_000) {
        try {
          lastFindMyRefresh = Date.now();
          // Returns straight away with the current cache and refreshes in the background.
          // TROY_FINDMY_REFRESH=off: use the cached fixes only. A refresh opens the Find My app on the Mac.
          if (process.env.TROY_FINDMY_REFRESH === "off") throw new Error("refresh off");
          await api("POST", "/icloud/findmy/friends/refresh");
          for (let i = 0; i < 2; i++) {
            await new Promise((r) => setTimeout(r, 4000));
            if (!allowed()) return null;
            const again = pickFriend((await api("GET", "/icloud/findmy/friends")).data, h);
            if (again && (!found || again.at > found.at)) {
              found = again;
              break;
            }
          }
        } catch {
          findMyBroken = true;
        }
      }
      return allowed() ? found : null;
    },

    // A Find My location request through the helper, with no chat bubble (the bubble has no Share button).
    // The student gets it in the Find My app under People. True when it was delivered or one is already pending
    // ("error 7" counts, see locationRequestDelivered). False when the helper isn't there or it could not be
    // sent; the caller then explains how to share by hand (+ > Location > Share). 1:1 chats only.
    async requestLocation(chatId) {
      if (!sendAllowed(db, chatId, handleFromChatId(chatId))) {
        console.log("send refused");
        return false;
      }
      if (!helper.isConnected()) return false;
      return helper.requestLocation(chatId);
    },

    // The one request that does not go through guardedSend: the fixed line for a brand-new chat turned away by
    // the sign-up switch or cap. Its lock is the gate's one-time grant for exactly this chat and kind, consumed
    // as the very last thing before the request (it checks the kill switch too). Only ever one of two fixed
    // strings, 1:1 chats only, and nothing else is touched: no read receipt, no typing, no helper, nothing saved.
    async sendSignupNotice(chatId, kind) {
      const text = Object.hasOwn(SIGNUP_NOTICE_TEXT, kind) ? SIGNUP_NOTICE_TEXT[kind] : null;
      if (!text || !handleFromChatId(chatId) || !isEnabled(db)) {
        console.log("send refused");
        return false;
      }
      try {
        const privateApi = await privateApiOn();
        if (!consumeSignupNotice(db, chatId, handleFromChatId(chatId), kind)) {
          console.log("send refused");
          return false;
        }
        await api("POST", "/message/text", { chatGuid: chatId, tempGuid: randomUUID(), message: text, method: privateApi ? "private-api" : "apple-script" });
        return true;
      } catch {
        console.log("send failed");
        return false;
      }
    },

    // The helper keeps its own list of chats it may touch. Keep it in step with Troy's.
    async onAllowed(chatId) {
      await helper.allowChat(chatId).catch(() => false);
    },

    async onDisallowed(chatId) {
      await helper.removeChat(chatId).catch(() => false);
    },

    chatIdForHandle,
  };

  // ---------- incoming ----------

  /**
   * The id and date of a chat's earliest message, and nothing else. The text is never read, kept or logged.
   * Null when the server lists no messages for the chat (tried twice: a new message can take a moment to show up).
   * UNCONFIRMED live: that sort=ASC returns the true earliest message.
   */
  async function earliestMessage(chatId: string): Promise<{ guid: string; at: number } | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await api("GET", `/chat/${enc(chatId)}/message?limit=1&sort=ASC`);
      if (!Array.isArray(r.data)) throw new Error("bad history response");
      if (r.data.length > 0) {
        const guid: unknown = r.data[0]?.guid;
        const at: unknown = r.data[0]?.dateCreated;
        if (typeof guid !== "string" || !guid) throw new Error("no guid");
        if (typeof at !== "number" || !Number.isFinite(at)) throw new Error("no date");
        return { guid, at };
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, EMPTY_RETRY_MS));
    }
    return null;
  }

  /**
   * Rules 2 and 4: "hey troy" only opts a chat in when it is the chat's very first message, sent after go-live.
   * hasHistory is true (so deny) unless the chat's earliest message IS this message, with one exception: the
   * earliest message is the "hey troy" this same person was turned away on by the sign-up switch or cap (matched
   * by the salted hash of its id, kept when the line was sent), so "try again in a bit" can work. Still only the
   * id and date are read, and a chat with anything from before go-live is always denied.
   * An empty list is a failed lookup, not a new chat: the message that triggered it must be in there.
   * isFirst says the earliest message is this very message.
   */
  async function historyCheck(chatId: string, messageGuid: string): Promise<{ hasHistory: boolean; isFirst: boolean }> {
    const goLive = getGoLiveAt(db);
    const earliest = await earliestMessage(chatId);
    if (!earliest) throw new Error("empty history");
    if (earliest.at < goLive) return { hasHistory: true, isFirst: false };
    if (earliest.guid === messageGuid) return { hasHistory: false, isFirst: true };
    const who = handleFromChatId(chatId);
    return { hasHistory: !(who !== null && wasRefusedFirstMessage(db, who, earliest.guid)), isFirst: false };
  }

  async function download(guid: string): Promise<{ buf: Buffer; type: string } | null> {
    // An attachment can still be transferring when the webhook fires, so try twice.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(`${config.bluebubblesUrl}/api/v1/attachment/${enc(guid)}/download?password=${encodeURIComponent(config.bluebubblesPassword)}`, {
          signal: AbortSignal.timeout(30_000),
        });
        if (res.ok) return { buf: Buffer.from(await res.arrayBuffer()), type: (res.headers.get("content-type") ?? "").split(";")[0].trim() };
      } catch {
        /* retry */
      }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
    }
    return null;
  }

  // Message guids already handled (BlueBubbles can deliver the same event twice). Only allowed messages get here.
  const seen = new Set<string>();

  async function handleWebhook(body: unknown): Promise<void> {
    const ignored = () => console.log("ignored event");
    try {
      const evt = body as Json | null;
      if (!evt || typeof evt !== "object" || typeof evt.type !== "string") return ignored();
      // Not needed: delivery and read updates, and other people's typing bubbles.
      if (evt.type === "updated-message" || evt.type === "typing-indicator") return;
      const data: Json | null = evt.data;
      if (evt.type !== "new-message" || !data || typeof data !== "object") return ignored();
      const guid: unknown = data.guid;
      const chats: unknown = data.chats;
      // Exactly one chat. A message that claims several chats is dropped whole, so no chat can be
      // opted in as a side effect of an event that ends up ignored.
      if (typeof guid !== "string" || !guid || !Array.isArray(chats) || chats.length !== 1) return ignored();

      // ---- the gate: before any download, save or conversion ----
      const handle = normalizeHandle(data.handle?.address);
      const text = typeof data.text === "string" ? data.text : "";
      for (const chat of chats) {
        const chatId: string | null = typeof chat?.guid === "string" && chat.guid.split(";").length === 3 ? chat.guid : null;
        const isGroup = chatId ? chatId.split(";")[1] !== "-" : false;
        // In a 1:1 chat the sender has to be the person the chat is with.
        const consistent = chatId !== null && (isGroup || (handle !== null && handleFromChatId(chatId) === handle));
        let isFirst = false;
        const decision = await decide(db, {
          isFromMe: data.isFromMe !== false,
          handle,
          chatId: consistent ? chatId : null,
          isGroup,
          text,
          hasHistoryBeforeGoLive: async () => {
            const h = await historyCheck(chatId as string, guid);
            isFirst = h.isFirst;
            return h.hasHistory;
          },
          firstMessageId: () => (isFirst ? guid : null),
        });
        if (!decision.allow) {
          // Sign-ups closed or full, first time for this brand-new chat: the one fixed line, then dropped as usual.
          if (decision.notice && chatId) await adapter.sendSignupNotice?.(chatId, decision.notice);
          return ignored();
        }
      }
      // ---- allowed from here on ----

      const chatId = chats[0].guid as string;
      if (seen.has(guid)) return;
      seen.add(guid);
      if (seen.size > 5000) seen.delete(seen.values().next().value as string);
      if (db.prepare("SELECT 1 FROM messages WHERE providerMessageId = ? AND direction = 'in' LIMIT 1").get(guid)) return;

      const event: IncomingEvent = {
        provider: "bluebubbles",
        userHandle: handle as Handle,
        chatId,
        isGroup: chatId.split(";")[1] !== "-",
        messageId: guid,
        text: text.replace(/\uFFFC/g, "").trim(), // attachments leave an object-replacement character in the text
        images: [],
        receivedAt: typeof data.dateCreated === "number" ? data.dateCreated : Date.now(),
      };

      const balloon = typeof data.balloonBundleId === "string" ? data.balloonBundleId : "";

      // Anything attached to another message is a reaction of some kind, never typed text.
      if (data.associatedMessageGuid && String(data.associatedMessageType) === "4000") {
        // A vote on a native poll: associatedMessageGuid is the poll's guid (no "p:" prefix seen, stripped anyway).
        const pollGuid = String(data.associatedMessageGuid).replace(/^(p:\d+\/|bp:)/, "");
        const ids = pollOptions(pollGuid);
        if (!ids) return; // not a poll Troy sent: nothing is fetched
        const payload = await payloadFor(chatId, guid);
        const optionIndex = payload ? ids.indexOf(decodePollVote(payload, handle) ?? "") : -1;
        if (optionIndex < 0) return;
        event.pollVote = { pollMessageId: pollGuid, optionIndex };
        event.text = "";
      } else if (data.associatedMessageGuid) {
        const tap = parseTapback(data.associatedMessageType);
        if (!tap) return; // stickers, emoji tapbacks and anything without a known type aren't used
        // "p:0/<guid>" or "bp:<guid>" -> "<guid>"
        const target = String(data.associatedMessageGuid).replace(/^(p:\d+\/|bp:)/, "");
        event.reaction = { targetMessageId: target, type: tap.type, removed: tap.removed };
        event.text = ""; // the text is only Apple's summary ('Loved "..."')
      } else if (balloon === FINDMY_BALLOON_ID) {
        // A location share (iOS: + > Location, or the answer to a request). The fix is inside the bubble's payload.
        const payload = await payloadFor(chatId, guid);
        let location = payload ? decodeFindMyShare(payload) : null;
        // A bubble that is someone asking for John's location is not a share: drop it as before.
        const kind = payload ? (decodeFindMyPayload(payload) as { kind?: Record<string, unknown> } | null)?.kind : undefined;
        if (!location && kind && !("share" in kind)) return;
        if (!location) {
          // Never go silent on a share. The bubble often carries no fix yet (Find My takes up to about a
          // minute after a share starts), so say so once and keep asking Find My for the live fix.
          console.log(`findmy share: ${!helper.isConnected() ? "helper not connected" : payload ? "no fix in the bubble yet" : "no payload"}`);
          await sendText(chatId, "got ur share. give me a sec to read it");
          for (const wait of FINDMY_WAITS_MS) {
            await new Promise((r) => setTimeout(r, wait));
            const live = await adapter.getLiveLocation(handle as Handle).catch(() => null);
            if (live) {
              location = { lat: live.lat, lng: live.lng };
              break;
            }
          }
        }
        if (location) {
          event.location = location;
          event.text = ""; // "Started Sharing Location" / the placeholder character is not something they typed
        } else {
          console.log("findmy share: no fix after waiting");
          // Hand it to the conversation honestly instead of dropping it: Troy can ask where they are.
          event.text = "i shared my location with u but i don't think it came through";
        }
      } else if (balloon.startsWith(APP_BALLOON_PREFIX)) {
        return; // a poll the student made, or any other app bubble: not text
      } else {
        const attachments: Json[] = Array.isArray(data.attachments) ? data.attachments.slice(0, 6) : [];
        for (const a of attachments) {
          if (typeof a?.guid !== "string") continue;
          const name = String(a.transferName ?? "").toLowerCase();
          const mime = String(a.mimeType ?? "").toLowerCase();
          const isPin = name.endsWith(".loc.vcf");
          if (!isPin && !mime.startsWith("image/")) continue;
          const file = await download(a.guid);
          if (!file) continue;
          if (isPin) {
            // UNCONFIRMED: that location pins arrive through the webhook as a .loc.vcf attachment on macOS 27.
            event.location = parseLocationVcard(file.buf.toString("utf8")) ?? event.location;
            continue;
          }
          // HEIC photos come back already converted to JPEG, so trust the response type first.
          const type = file.type.startsWith("image/") ? file.type : mime;
          mkdirSync(DOWNLOADS, { recursive: true });
          const path = join(DOWNLOADS, `${randomUUID()}.${IMAGE_EXT[type] ?? "jpg"}`);
          writeFileSync(path, file.buf);
          const image: IncomingImage = { path, mime: type };
          event.images.push(image);
        }
        if (!event.text && event.images.length === 0 && !event.location) return;
      }

      await onEvent(event);
    } catch {
      // No details: an error here could carry message content.
      console.log("event failed");
    }
  }

  /** Constant-time compare so the secret can't be guessed a character at a time. */
  function secretMatches(given: string | undefined): boolean {
    const want = Buffer.from(config.webhookSecret);
    const got = Buffer.from(given ?? "");
    return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
  }

  /**
   * BlueBubbles posts JSON from the same Mac. A web page open in a browser can also reach loopback, so:
   * JSON content type only (a page can't send that cross-site without a preflight, which gets no CORS answer),
   * nothing that carries a browser Origin, and the shared secret in the path when one is configured.
   */
  async function receive(c: Context, secret: string | undefined): Promise<Response> {
    const type = String(c.req.header("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const fromBrowser = c.req.header("origin") !== undefined || c.req.header("sec-fetch-site") !== undefined;
    const secretOk = config.webhookSecret ? secretMatches(secret) : secret === undefined;
    if (type !== "application/json" || fromBrowser || !secretOk) {
      console.log("ignored event");
      return c.json({ ok: false }, 403);
    }
    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      /* handled as an ignored event */
    }
    void handleWebhook(body); // answer 200 right away; the work continues after the response
    return c.json({ ok: true });
  }

  const routes = new Hono();
  routes.post("/webhooks/bluebubbles", (c) => receive(c, undefined));
  routes.post("/webhooks/bluebubbles/:secret", (c) => receive(c, c.req.param("secret")));

  // Go-live is fixed when Troy first starts, not when the first "hey troy" arrives
  // (otherwise that first message would itself count as older than go-live).
  getGoLiveAt(db);

  // Start listening for the patched helper (a no-op without TROY_HELPER_TOKEN). Each time it connects, every
  // allowed 1:1 chat is registered with it, so its own allowlist matches Troy's.
  helper.start();

  return { adapter, routes, handleWebhook, helper };
}
