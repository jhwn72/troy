// BlueBubbles adapter (Server 1.9.12, Private API). The server sees every iMessage on John's Apple ID,
// so this file is where the privacy rules are enforced:
//   - incoming: decide() runs before anything is downloaded, saved, built or logged
//   - outgoing: every request goes through guardedSend(), which holds the send lock
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
import { allowChat, decide, getGoLiveAt, isAllowedChat, sendAllowed } from "./gate.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const DOWNLOADS = join(ROOT, "tmp-downloads"); // gitignored

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

export function createBluebubblesAdapter(deps: AdapterDeps): {
  adapter: MessagingAdapter;
  routes: Hono;
  /** Processes one webhook body. The route calls this without waiting; tests can await it. */
  handleWebhook: (body: unknown) => Promise<void>;
} {
  const { db, onEvent } = deps;

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

  async function privateApiOn(): Promise<boolean> {
    if (papi !== null && Date.now() - papiCheckedAt < 5 * 60_000) return papi;
    try {
      const info = (await api("GET", "/server/info")).data ?? {};
      papi = info.private_api === true && info.helper_connected === true;
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
    const lines = ["BEGIN:VCARD", "VERSION:3.0", "N:;Troy;;;", "FN:Troy"];
    // Optional: TROY_CONTACT (the number or email students text) so saving the card attaches to this chat.
    for (const raw of (process.env.TROY_CONTACT || "").split(",")) {
      const h = normalizeHandle(raw);
      if (h) lines.push(h.includes("@") ? `EMAIL;TYPE=INTERNET:${h}` : `TEL;TYPE=CELL:${h}`);
    }
    const photo = join(ROOT, "public", "troy-avatar.jpg");
    if (existsSync(photo)) lines.push(`PHOTO;ENCODING=b;TYPE=JPEG:${readFileSync(photo).toString("base64")}`);
    lines.push("END:VCARD");
    const file = join(DOWNLOADS, "Troy.vcf");
    writeFileSync(file, lines.join("\r\n") + "\r\n");
    return file;
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

  const adapter: MessagingAdapter = {
    provider: "bluebubbles",

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
        polls: false,
        groupChats: on,
        contactCard: true,
        liveLocation: on && !findMyBroken,
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

    // Native polls don't work through BlueBubbles. "Tap to pick": the question, then one bubble per option
    // that the student tapbacks. Without the Private API tapbacks can't be read, so it becomes a numbered list.
    async sendPoll(chatId, question, options) {
      const none = options.map(() => null);
      if (!sendAllowed(db, chatId, handleFromChatId(chatId))) {
        console.log("send refused");
        return { optionMessageIds: none, mode: "tap" };
      }
      if (!(await privateApiOn())) {
        await sendText(chatId, [question, ...options.map((o, i) => `${i + 1}. ${o}`), "reply with the number"].join("\n"));
        return { optionMessageIds: none, mode: "numbered" };
      }
      await sendText(chatId, `${question}\ntap ❤️ on ur pick`);
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
    async getLiveLocation(handle) {
      const h = normalizeHandle(handle);
      const allowed = () => sendAllowed(db, chatIdForHandle(h as Handle), h);
      if (!h || !allowed()) return null;
      if (!(await privateApiOn())) return null;
      if (!allowed()) return null; // the kill switch may have flipped during the status lookup
      try {
        let found = pickFriend((await api("GET", "/icloud/findmy/friends")).data, h);
        const fresh = found && Date.now() - found.at < 5 * 60_000;
        if (!fresh && Date.now() - lastFindMyRefresh > 60_000) {
          lastFindMyRefresh = Date.now();
          // Returns straight away with the current cache and refreshes in the background.
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
        }
        findMyBroken = false;
        return found;
      } catch {
        findMyBroken = true;
        return null;
      }
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
   * Returns true ("has history", so deny) unless the chat's earliest message IS this message.
   * An empty list is a failed lookup, not a new chat: the message that triggered it must be in there.
   */
  async function hasHistoryBeforeGoLive(chatId: string, messageGuid: string): Promise<boolean> {
    const goLive = getGoLiveAt(db);
    const earliest = await earliestMessage(chatId);
    if (!earliest) throw new Error("empty history");
    if (earliest.at < goLive) return true;
    return earliest.guid !== messageGuid;
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
        const decision = await decide(db, {
          isFromMe: data.isFromMe !== false,
          handle,
          chatId: consistent ? chatId : null,
          isGroup,
          text,
          hasHistoryBeforeGoLive: () => hasHistoryBeforeGoLive(chatId as string, guid),
        });
        if (!decision.allow) return ignored();
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

      // Anything attached to another message is a reaction of some kind, never typed text.
      if (data.associatedMessageGuid) {
        const tap = parseTapback(data.associatedMessageType);
        if (!tap) return; // stickers, emoji tapbacks and anything without a known type aren't used
        // "p:0/<guid>" or "bp:<guid>" -> "<guid>"
        const target = String(data.associatedMessageGuid).replace(/^(p:\d+\/|bp:)/, "");
        event.reaction = { targetMessageId: target, type: tap.type, removed: tap.removed };
        event.text = ""; // the text is only Apple's summary ('Loved "..."')
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

  return { adapter, routes, handleWebhook };
}
