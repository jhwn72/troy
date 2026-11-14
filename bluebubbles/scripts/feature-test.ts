// BlueBubbles feature test for Troy. Tests ONLY the 1:1 chat with the first number in ALLOWED_HANDLES.
// Run: node --env-file=.env scripts/feature-test.ts
// Every write goes through guarded helpers that refuse any chat other than the test chat.
// Results are written to docs/bluebubbles-status.md.

import { createInterface } from "node:readline/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { getAllowedLocations } from "./location.ts";
import { HelperClient, decodePollPayload, decodeFindMyPayload, FINDMY_BALLOON_ID } from "./helper-client.ts";

const BASE = (process.env.BLUEBUBBLES_URL ?? "http://localhost:1234").replace(/\/$/, "");
const PW = process.env.BLUEBUBBLES_PASSWORD ?? "";
const HANDLE = (process.env.ALLOWED_HANDLES ?? "").split(",")[0]?.trim();
if (!PW || !HANDLE) {
  console.error("Need BLUEBUBBLES_PASSWORD and ALLOWED_HANDLES in .env");
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q: string) => (await rl.question(`${q} `)).trim();
const yes = async (q: string) => /^y/i.test(await ask(`${q} [y/n]`));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api(method: string, path: string, body?: unknown, form?: FormData): Promise<any> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${BASE}/api/v1${path}${sep}password=${encodeURIComponent(PW)}`, {
    method,
    headers: form ? undefined : body ? { "content-type": "application/json" } : undefined,
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${json?.message ?? ""} ${json?.error?.message ?? ""}`.trim());
  return json;
}

// ---- Guard: the only chat this script may touch ----
let TEST_CHAT = "";
function guard(chatGuid: string) {
  if (!TEST_CHAT || chatGuid !== TEST_CHAT) throw new Error(`BLOCKED: refusing to act on a chat other than the test chat`);
}
const enc = (g: string) => encodeURIComponent(g);
const testMessageGuids = new Set<string>(); // only messages read from or sent to the test chat

async function findTestChat(): Promise<string | null> {
  for (const prefix of ["any", "iMessage", "SMS"]) {
    const guid = `${prefix};-;${HANDLE}`;
    try {
      const r = await api("GET", `/chat/${enc(guid)}`);
      if (r?.data?.guid) return r.data.guid;
    } catch { /* not found, try next */ }
  }
  return null;
}

async function recentMessages(limit = 15): Promise<any[]> {
  guard(TEST_CHAT);
  const r = await api("GET", `/chat/${enc(TEST_CHAT)}/message?limit=${limit}&sort=DESC&with=attachment`);
  const msgs: any[] = r?.data ?? [];
  msgs.forEach((m) => m?.guid && testMessageGuids.add(m.guid));
  return msgs;
}

async function waitFor(pred: (m: any) => boolean, since: number, timeoutMs = 180_000): Promise<any | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const m = (await recentMessages()).find((m) => !m.isFromMe && (m.dateCreated ?? 0) >= since && pred(m));
    if (m) return m;
    await sleep(2000);
  }
  return null;
}

async function sendText(message: string, extra: Record<string, unknown> = {}): Promise<any> {
  guard(TEST_CHAT);
  const r = await api("POST", "/message/text", { chatGuid: TEST_CHAT, tempGuid: randomUUID(), message, method: "private-api", ...extra });
  if (r?.data?.guid) testMessageGuids.add(r.data.guid);
  return r?.data;
}

function guardMessage(guid: string) {
  if (!testMessageGuids.has(guid)) throw new Error("BLOCKED: message is not from the test chat");
}

// ---- Results ----
type Result = { status: string; notes: string };
const results: Record<string, Result> = {};
async function step(name: string, fn: () => Promise<string | void>) {
  console.log(`\n=== ${name} ===`);
  try {
    const notes = (await fn()) ?? "";
    if (!results[name]) results[name] = { status: "Works", notes };
  } catch (e: any) {
    results[name] = { status: "Fails", notes: String(e?.message ?? e).slice(0, 160) };
  }
  console.log(`${name}: ${results[name].status}${results[name].notes ? ` (${results[name].notes})` : ""}`);
}
const fail = (name: string, notes: string) => { results[name] = { status: "Fails", notes }; };
const skip = (name: string, notes: string) => { results[name] = { status: "Not tested", notes }; };

// Tiny 1x1 PNG for the send-image test
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function main() {
  const info = (await api("GET", "/server/info")).data;
  console.log(`Server ${info.server_version}, private API ${info.private_api}, helper ${info.helper_connected}`);

  TEST_CHAT = (await findTestChat()) ?? "";
  if (!TEST_CHAT) {
    console.log(`No chat with the test number yet. Text "hey troy test" from the second phone, then press Enter.`);
    await ask("");
    TEST_CHAT = (await findTestChat()) ?? "";
    if (!TEST_CHAT) throw new Error("Still no chat with the test number. Check ALLOWED_HANDLES matches the phone's iMessage address.");
  }
  console.log(`Test chat: ${TEST_CHAT}`);

  let incoming: any = null;
  await step("Receive text", async () => {
    const since = Date.now() - 10 * 60_000;
    const already = (await recentMessages()).find((m) => !m.isFromMe && (m.dateCreated ?? 0) >= since && /hey troy test/i.test(m.text ?? ""));
    if (already) { incoming = already; return "found recent 'hey troy test'"; }
    console.log(`Text "hey troy test" from the second phone now (waiting up to 3 min)...`);
    incoming = await waitFor((m) => /hey troy test/i.test(m.text ?? ""), Date.now() - 5000);
    if (!incoming) throw new Error("timed out");
    return "webhook listener should also show it";
  });

  await step("Receive photo", async () => {
    console.log("Send a photo from the second phone now (waiting up to 3 min)...");
    const m = await waitFor((m) => (m.attachments ?? []).length > 0, Date.now() - 5000);
    if (!m) throw new Error("timed out");
    const a = m.attachments[0];
    const r = await fetch(`${BASE}/api/v1/attachment/${enc(a.guid)}/download?password=${encodeURIComponent(PW)}`);
    if (!r.ok) throw new Error(`download ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    mkdirSync("tmp-downloads", { recursive: true });
    const file = `tmp-downloads/${a.transferName ?? a.guid}`;
    writeFileSync(file, buf);
    return `${a.mimeType ?? "?"}, ${buf.length} bytes, saved to ${file}`;
  });

  let sent: any = null;
  await step("Send text", async () => {
    sent = await sendText("Troy test reply ✅");
    if (!(await yes("Did 'Troy test reply ✅' arrive on the second phone?"))) fail("Send text", "not seen on phone");
  });

  await step("Send image", async () => {
    guard(TEST_CHAT);
    const form = new FormData();
    form.set("chatGuid", TEST_CHAT);
    form.set("tempGuid", randomUUID());
    form.set("name", "troy-test.png");
    form.set("method", "private-api");
    form.set("attachment", new Blob([PNG], { type: "image/png" }), "troy-test.png");
    await api("POST", "/message/attachment", undefined, form);
    if (!(await yes("Did a tiny image arrive on the second phone?"))) fail("Send image", "not seen on phone");
  });

  await step("Typing indicators", async () => {
    guard(TEST_CHAT);
    await api("POST", `/chat/${enc(TEST_CHAT)}/typing`);
    console.log("Typing bubble on for 5 seconds...");
    await sleep(5000);
    await api("DELETE", `/chat/${enc(TEST_CHAT)}/typing`);
    if (!(await yes("Did the phone show the typing bubble?"))) fail("Typing indicators", "not seen on phone");
    return "send works; incoming typing shows in the listener as typing-indicator";
  });

  await step("Tapbacks", async () => {
    if (!incoming) throw new Error("no incoming message to react to");
    guardMessage(incoming.guid);
    guard(TEST_CHAT);
    await api("POST", "/message/react", { chatGuid: TEST_CHAT, selectedMessageGuid: incoming.guid, reaction: "love", partIndex: 0 });
    if (!(await yes("Did a heart appear on 'hey troy test' on the phone?"))) fail("Tapbacks", "not seen on phone");
  });

  await step("Read receipts", async () => {
    guard(TEST_CHAT);
    console.log("Send one more text from the phone, any text, then press Enter.");
    await ask("");
    await api("POST", `/chat/${enc(TEST_CHAT)}/read`);
    if (!(await yes("Does the phone show 'Read' under its last message?"))) fail("Read receipts", "not seen on phone (iMessage only)");
  });

  await step("Edits", async () => {
    if (!sent?.guid) throw new Error("no sent message to edit");
    guardMessage(sent.guid);
    // Needs the patched helper (scripts/build-helper.sh): the stock 1.9.12 helper crashes Messages on macOS 27.
    await api("POST", `/message/${enc(sent.guid)}/edit`, { editedMessage: "Troy test reply (edited) ✅", backwardsCompatibilityMessage: "Edited to “Troy test reply (edited) ✅”", partIndex: 0 });
    if (!(await yes("Did the reply change to '(edited)' on the phone?"))) fail("Edits", "not seen on phone");
  });

  await step("Effects", async () => {
    await sendText("Troy effect test 💥", { effectId: "com.apple.MobileSMS.expressivesend.impact" });
    if (!(await yes("Did that message arrive with the Slam effect?"))) fail("Effects", "not seen on phone");
  });

  await step("Polls (send)", async () => {
    guard(TEST_CHAT);
    const helper = new HelperClient({ token: process.env.TROY_HELPER_TOKEN ?? "", chatAllowlist: [TEST_CHAT] });
    try {
      const creatorHandle = info.detected_imessage;
      const r = await helper.request("send-poll", TEST_CHAT, { options: ["Pizza", "Tacos", "Sushi"], creatorHandle });
      if (!r.ok) throw new Error(r.error ?? "send-poll failed");
      testMessageGuids.add(r.guid);
      if (!(await yes("Did a Pizza/Tacos/Sushi poll appear on the phone? Vote on one, then answer"))) { fail("Polls (send)", "not seen on phone"); return; }
      const since = Date.now() - 5 * 60_000;
      const vote = await waitFor((m) => String(m.associatedMessageType) === "4000" && m.associatedMessageGuid === r.guid, since, 60_000);
      if (!vote) { results["Poll votes (receive)"] = { status: "Fails", notes: "no vote message found" }; return; }
      const payload = await helper.request("get-payload", TEST_CHAT, { messageGuid: vote.guid });
      const v = decodePollPayload(payload.payloadBase64 ?? "");
      const idx = (r.optionIdentifiers as string[]).indexOf(v?.item?.votes?.[0]?.voteOptionIdentifier);
      results["Poll votes (receive)"] = idx >= 0 ? { status: "Works", notes: `read vote: ${["Pizza", "Tacos", "Sushi"][idx]}` } : { status: "Fails", notes: "vote not decoded" };
    } finally {
      helper.stop();
    }
    return "native poll via patched helper";
  });

  await step("Receive location share", async () => {
    console.log("On the phone: + > Location > share your location in this chat (waiting up to 3 min)...");
    const m = await waitFor((m) => m.balloonBundleId === FINDMY_BALLOON_ID, Date.now() - 5000);
    if (!m) throw new Error("timed out");
    const helper = new HelperClient({ token: process.env.TROY_HELPER_TOKEN ?? "", chatAllowlist: [TEST_CHAT] });
    try {
      const payload = await helper.request("get-payload", TEST_CHAT, { messageGuid: m.guid });
      const loc = decodeFindMyPayload(payload.payloadBase64 ?? "")?.initialLocation;
      if (typeof loc?.latitude !== "number") throw new Error("could not decode location");
      return `coordinates read from the message (accuracy ${Math.round(loc.horizontalAccuracy)} m)`; // never print coordinates
    } finally { helper.stop(); }
  });

  await step("Live location updates (Find My)", async () => {
    console.log("Checking BlueBubbles' Find My friends list for the shared location (needs the share from the previous step). Press Enter.");
    await ask("");
    let found: unknown[] = [];
    for (let i = 0; i < 6 && found.length === 0; i++) {
      found = await getAllowedLocations(i > 0); // first cached, then refresh via the Find My app
      if (!found.length) await sleep(5000);
    }
    if (!found.length) throw new Error("no shared location found for the test handle");
    return "location received (only the test phone's entry is kept)";
  });

  skip("Group chat creation", "needs two other people; skipped to keep tests to one chat. Endpoint: POST /api/v1/chat/new {addresses:[...], message, method:'private-api'}");

  writeResults();
  rl.close();
}

function writeResults() {
  const path = "docs/bluebubbles-status.md";
  let doc = readFileSync(path, "utf8");
  for (const [name, r] of Object.entries(results)) {
    const row = new RegExp(`^\\| ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\|.*$`, "m");
    doc = doc.replace(row, `| ${name} | ${r.status} | ${r.notes.replace(/\|/g, "/")} |`);
  }
  doc = doc.replace(/^Last updated: .*$/m, `Last updated: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC (feature-test.ts)`);
  writeFileSync(path, doc);
  console.log(`\nResults written to ${path}`);
  console.table(results);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  if (Object.keys(results).length) writeResults();
  rl.close();
  process.exit(1);
});
