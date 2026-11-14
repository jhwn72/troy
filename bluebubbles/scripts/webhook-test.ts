// BlueBubbles webhook test listener for Troy.
// Run: node --env-file=.env scripts/webhook-test.ts
// Listens on POST http://localhost:3000/webhooks/bluebubbles.
// Logs details ONLY for chats with handles in ALLOWED_HANDLES. Everything else logs "ignored event".
// This script never replies, sends, reacts or marks anything read.

import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";

// Optional: CAPTURE_DIR=tmp-captures saves the full raw JSON of ALLOWED-chat events only.
const CAPTURE_DIR = process.env.CAPTURE_DIR ?? "";
if (CAPTURE_DIR) mkdirSync(CAPTURE_DIR, { recursive: true });
let captureCount = 0;

const PORT = 3000;
const PATH = "/webhooks/bluebubbles";

// Normalize a handle: phone numbers to their last 10 digits, emails lowercased.
function norm(h: string): string {
  const s = h.trim().toLowerCase();
  if (s.includes("@")) return s;
  const digits = s.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

const allowed = new Set(
  (process.env.ALLOWED_HANDLES ?? "")
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean)
    .map(norm),
);

if (allowed.size === 0) {
  console.error("ALLOWED_HANDLES is empty in .env; every event will be ignored.");
}

// Only 1:1 chats count. A 1:1 chat guid looks like "iMessage;-;+15551234567" (group chats use ";+;").
function allowedChatGuid(guid: unknown): string | null {
  if (typeof guid !== "string") return null;
  const parts = guid.split(";");
  if (parts.length !== 3 || parts[1] !== "-") return null;
  return allowed.has(norm(parts[2])) ? guid : null;
}

type Hit = { type: string; handle: string; chatGuid: string; text: string | null; attachments: number };

function inspect(event: any): Hit | null {
  const type = typeof event?.type === "string" ? event.type : "unknown";
  const data = event?.data ?? {};

  if (type === "typing-indicator") {
    const chatGuid = allowedChatGuid(data.guid);
    if (!chatGuid) return null;
    return { type: `${type} (${data.display ? "started" : "stopped"})`, handle: chatGuid.split(";")[2], chatGuid, text: null, attachments: 0 };
  }

  if (type === "new-message" || type === "updated-message") {
    const chats: any[] = Array.isArray(data.chats) ? data.chats : [];
    // Every chat on the message must be an allowed 1:1 chat. Group chats are ignored.
    if (chats.length === 0) return null;
    const guids = chats.map((c) => allowedChatGuid(c?.guid));
    if (guids.some((g) => g === null)) return null;
    const chatGuid = guids[0] as string;
    return {
      type: data.isFromMe ? `${type} (from me)` : type,
      handle: chatGuid.split(";")[2],
      chatGuid,
      text: typeof data.text === "string" ? data.text : null,
      attachments: Array.isArray(data.attachments) ? data.attachments.length : 0,
    };
  }

  return null;
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url?.split("?")[0] !== PATH) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 5_000_000) req.destroy();
  });
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    let event: unknown;
    try {
      event = JSON.parse(body);
    } catch {
      console.log("ignored event");
      return;
    }
    const hit = inspect(event);
    if (!hit) {
      console.log("ignored event");
      return;
    }
    if (CAPTURE_DIR) {
      const file = `${CAPTURE_DIR}/${String(++captureCount).padStart(3, "0")}-${hit.type.split(" ")[0]}.json`;
      writeFileSync(file, JSON.stringify(event, null, 2));
    }
    const d: any = (event as any)?.data ?? {};
    const assoc = d.associatedMessageType != null ? ` assocType=${JSON.stringify(d.associatedMessageType)} assocGuid=${d.associatedMessageGuid} isFromMe=${d.isFromMe}` : "";
    const extra = (hit.attachments ? ` attachments=${hit.attachments}` : "") + assoc;
    console.log(`[${new Date().toISOString()}] ${hit.type} handle=${hit.handle} chat=${hit.chatGuid} text=${JSON.stringify(hit.text)}${extra}`);
  });
});

// Listen on both loopback addresses: BlueBubbles resolves "localhost" to IPv6 ::1.
// A second server shares the same handler for IPv4 127.0.0.1. Nothing is exposed to the network.
const server4 = createServer((req, res) => server.emit("request", req, res));
server.listen(PORT, "::1", () => {
  server4.listen(PORT, "127.0.0.1", () => {
    console.log(`Listening on http://localhost:${PORT}${PATH} (::1 and 127.0.0.1, allowed handles: ${allowed.size})`);
  });
});
