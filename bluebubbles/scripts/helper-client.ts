// Persistent connection to the patched BlueBubbles helper (inside Messages).
// The helper connects OUT to 127.0.0.1:45699 (Messages is sandboxed) and stays connected,
// so requests are instant after the first connection. Start this once in the Troy server.
//
//   import { HelperClient } from "./helper-client.ts";
//   const helper = new HelperClient({ token: process.env.TROY_HELPER_TOKEN!, chatAllowlist: ["any;-;test-phone@example.com"] });
//   helper.start();
//   const res = await helper.request("get-payload", "any;-;test-phone@example.com", { messageGuid });
//
// Only one process can own port 45699. The helper also enforces its own chat allowlist.

import { createServer, type Server, type Socket } from "node:net";
import { execFile } from "node:child_process";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

export class HelperClient {
  private server?: Server;
  private sock?: Socket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private waiters: Array<() => void> = [];
  private opts: { token: string; chatAllowlist: string[]; port: number; host: string };

  constructor(opts: { token: string; chatAllowlist: string[]; port?: number; host?: string }) {
    if (!opts.token || opts.token.length < 16) throw new Error("HelperClient needs TROY_HELPER_TOKEN");
    this.opts = { port: 45699, host: "127.0.0.1", ...opts };
  }

  get connected(): boolean { return !!this.sock && !this.sock.destroyed; }

  start(): void {
    if (this.server) return;
    this.server = createServer((sock) => this.attach(sock));
    this.server.listen(this.opts.port, this.opts.host);
  }

  stop(): void {
    this.sock?.destroy();
    this.server?.close();
    this.server = undefined;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("helper client stopped")); }
    this.pending.clear();
  }

  private attach(sock: Socket) {
    // Newest connection wins (the helper reconnects after Messages restarts).
    this.sock?.destroy();
    this.sock = sock;
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.hello) {
          if (!msg.config) console.error("[helper] connected, but its config file is missing");
          this.waiters.splice(0).forEach((w) => w());
          continue;
        }
        const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
        if (p) { clearTimeout(p.timer); this.pending.delete(msg.id); p.resolve(msg); }
      }
    });
    sock.on("close", () => { if (this.sock === sock) this.sock = undefined; });
    sock.on("error", () => {});
  }

  private waitForConnection(timeoutMs: number): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("helper not connected (is BlueBubbles running with the patched helper?)")), timeoutMs);
      this.waiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  /**
   * Send a Find My location request the reliable way:
   * 1) open the Find My app hidden in the background so the Mac's Find My data is fresh
   *    (a stale cache made requests silently do nothing during testing),
   * 2) send the request without the chat bubble (the bubble can't show a Share button).
   * Then text the user: "I sent you a location request: open Find My → People to accept it."
   * Returns the helper's reply; invite "error … error 7" can still mean the request was delivered.
   */
  async requestLocation(chatGuid: string): Promise<any> {
    await new Promise<void>((resolve) => execFile("/usr/bin/open", ["-g", "-j", "-b", "com.apple.findmy"], () => resolve()));
    await new Promise((r) => setTimeout(r, 3000));
    return this.request("location-request", chatGuid, { bubble: false }, 30_000);
  }

  /** Add an opted-in student's 1:1 chat to BOTH this client's allowlist and the helper's saved allowlist. */
  async allowChat(chatGuid: string): Promise<any> {
    if (!/^[^;]+;-;[^;]+$/.test(chatGuid)) throw new Error("allowChat: 1:1 chat guid required");
    const r = await this.raw("allow-chat", chatGuid, {});
    if (r.ok && !this.opts.chatAllowlist.includes(chatGuid)) this.opts.chatAllowlist.push(chatGuid);
    return r;
  }

  /** Remove a chat (opt-out) from both allowlists. */
  async removeChat(chatGuid: string): Promise<any> {
    this.opts.chatAllowlist = this.opts.chatAllowlist.filter((c) => c !== chatGuid);
    return this.raw("remove-chat", chatGuid, {});
  }

  async request(cmd: "get-payload" | "send-balloon" | "send-poll" | "location-request" | "location-get" | "location-friends", chatGuid: string, args: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
    if (!this.opts.chatAllowlist.includes(chatGuid)) throw new Error("BLOCKED: chat not in allowlist");
    return this.raw(cmd, chatGuid, args, timeoutMs);
  }

  private async raw(cmd: string, chatGuid: string, args: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
    this.start();
    await this.waitForConnection(timeoutMs);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`helper did not answer ${cmd}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock!.write(JSON.stringify({ id, token: this.opts.token, cmd, chatGuid, ...args }) + "\n");
    });
  }
}

// ---- Polls ----
// Poll and vote payloads are NSKeyedArchiver blobs whose URL is "data:,<base64 JSON>?...".
// That URL is stored as plain text inside the archive, so we can pull the JSON out directly.
//   Poll: { version: 1, item: { orderedPollOptions: [{ optionIdentifier, text, creatorHandle, ... }], title, creatorHandle } }
//   Vote: { version: 1, item: { votes: [{ voteOptionIdentifier, participantHandle }] } }
export function decodePollPayload(payloadBase64: string): any | null {
  const text = Buffer.from(payloadBase64, "base64").toString("latin1");
  const m = text.match(/data:,([A-Za-z0-9+/=]+)/);
  if (!m) return null;
  try { return JSON.parse(Buffer.from(m[1], "base64").toString("utf8")); } catch { return null; }
}

export const POLL_BALLOON_ID = "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.messages.Polls";
// Webhook: a poll arrives as new-message with balloonBundleId === POLL_BALLOON_ID and no associatedMessageType.
// A vote arrives as new-message with associatedMessageType "4000" and associatedMessageGuid = the poll's guid.
// The webhook's payloadData is null, so fetch it: helper.request("get-payload", chatGuid, { messageGuid }).

// ---- Location shares (iOS 26 Messages > + > Location) ----
// Arrive as new-message with balloonBundleId === FINDMY_BALLOON_ID (Apple's text: "Started Sharing Location").
// Fetch the payload with get-payload; its URL holds FindMyMessagePayloadZippedDataKey = base64 raw-deflate JSON:
//   { initialLocation: { latitude, longitude, horizontalAccuracy, altitude, speed, course, timestamp, ... },
//     kind: { share: { isFromRequest, duration: { indefinitely: {} } | ... } }, id, timestamp, customEndDate }
// Only the initial location is in the message; later movement updates go through Find My, not Messages.
import { inflateRawSync } from "node:zlib";
export const FINDMY_BALLOON_ID = "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.findmy.FindMyMessagesApp";
export function decodeFindMyPayload(payloadBase64: string): any | null {
  const text = Buffer.from(payloadBase64, "base64").toString("latin1");
  const m = text.match(/FindMyMessagePayloadZippedDataKey=([A-Za-z0-9+/=%_-]+)/);
  if (!m) return null;
  try {
    const b64 = decodeURIComponent(m[1]);
    return JSON.parse(inflateRawSync(Buffer.from(b64, "base64")).toString("utf8"));
  } catch { return null; }
}
