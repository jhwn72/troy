// Troy control server: the patched BlueBubbles helper (inside Messages) connects here.
// Usage:
//   node --env-file=.env scripts/troy-control.ts get-payload <messageGuid>
//   node --env-file=.env scripts/troy-control.ts send-balloon <balloonBundleID> <payloadBase64> [text]
//   node --env-file=.env scripts/troy-control.ts location-request | location-get | location-friends   (test chat's handle only)
//   node --env-file=.env scripts/troy-control.ts send-poll "Option 1" "Option 2" [...more]   (creator = this Mac's iMessage address)
// Only the chat for the first ALLOWED_HANDLES entry is ever used (the helper also enforces its own allowlist).

import { createServer, type Socket } from "node:net";
import { pathToFileURL } from "node:url";

const TOKEN = process.env.TROY_HELPER_TOKEN ?? "";
const HANDLE = (process.env.ALLOWED_HANDLES ?? "").split(",")[0]?.trim();
if (!TOKEN || !HANDLE) {
  console.error("Need TROY_HELPER_TOKEN and ALLOWED_HANDLES in .env");
  process.exit(1);
}
const CHAT = process.env.TROY_TEST_CHAT ?? `any;-;${HANDLE}`;

export async function helperRequest(cmd: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const timer = setTimeout(() => { server.close(); reject(new Error("timed out waiting for helper (it reconnects every 5s)")); }, timeoutMs);
    server.on("connection", (sock: Socket) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.hello) {
            if (!msg.config) console.error("warning: helper says its config file is missing");
            sock.write(JSON.stringify({ id: 1, token: TOKEN, cmd, chatGuid: CHAT, ...args }) + "\n");
          } else if (msg.id === 1) {
            clearTimeout(timer); sock.end(); server.close(); resolve(msg);
          }
        }
      });
    });
    server.on("error", (e) => { clearTimeout(timer); reject(e); });
    server.listen(45699, "127.0.0.1");
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, a, b, c] = process.argv.slice(2);
  let creatorHandle = "";
  if (cmd === "send-poll" || cmd === "location-request") {
    const base = (process.env.BLUEBUBBLES_URL ?? "http://localhost:1234").replace(/\/$/, "");
    const info: any = await (await fetch(`${base}/api/v1/server/info?password=${encodeURIComponent(process.env.BLUEBUBBLES_PASSWORD ?? "")}`)).json();
    creatorHandle = info?.data?.detected_imessage ?? "";
    if (!creatorHandle) { console.error("could not read this Mac's iMessage address from server info"); process.exit(1); }
  }
  const args =
    cmd === "get-payload" ? { messageGuid: a } :
    cmd === "send-balloon" ? { balloonBundleID: a, payloadBase64: b, ...(c ? { text: c } : {}) } :
    cmd === "send-poll" ? { options: process.argv.slice(3), creatorHandle } :
    cmd === "location-request" ? { fromHandle: creatorHandle, ...(a === "--no-bubble" ? { bubble: false } : {}), ...(a === "--bubble-only" ? { invite: false, bubbleId: b } : {}) } :
    cmd === "location-get" ? (a ? { priority: Number(a) } : {}) :
    cmd === "location-friends" ? {} :
    cmd === "allow-chat" || cmd === "remove-chat" ? { chatGuid: a } :
    null;
  if (!args) { console.error("usage: get-payload <messageGuid> | send-balloon <bundleID> <payloadBase64> [text] | send-poll <opt1> <opt2> [...] | location-request | location-get | location-friends | allow-chat <chatGuid> | remove-chat <chatGuid>"); process.exit(1); }
  helperRequest(cmd, args).then((r) => console.log(JSON.stringify(r, null, 2)), (e) => { console.error(e.message); process.exit(1); });
}
