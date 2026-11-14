import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { IncomingEvent } from "../src/types.ts";

// config reads the environment when it's first imported, so set it before importing anything.
process.env.ALLOWED_HANDLES = "+13105550001,judge@example.com";
process.env.TROY_ENABLED = "true";
process.env.BLUEBUBBLES_URL = "http://bb.test:1234";
process.env.BLUEBUBBLES_PASSWORD = "test-password";
process.env.TROY_EMPTY_RETRY_MS = "5";

const { openDb, setSetting } = await import("../src/db/index.ts");
const { createBluebubblesAdapter, parseLocationVcard, handleFromChatId } = await import("../src/adapters/bluebubbles.ts");
const { allowChat, isAllowedChat } = await import("../src/adapters/gate.ts");
const { config } = await import("../src/config.ts");
const { getSetting } = await import("../src/db/index.ts");

const ALLOWED = "+13105550001";
const ALLOWED_CHAT = `any;-;${ALLOWED}`;
const STRANGER = "+12135550199";
const STRANGER_CHAT = `any;-;${STRANGER}`;
const SECRET = "private dinner plans";

// ---------- stubs ----------

type Call = { method: string; path: string; body: any };
let calls: Call[] = [];
let logs: string[] = [];
let respond: (c: Call) => unknown = () => ({});
let privateApi = true;
const realFetch = globalThis.fetch;
const realLog = console.log;
const realError = console.error;
const realWarn = console.warn;

function json(data: unknown): Response {
  return new Response(JSON.stringify({ status: 200, data }), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  logs = [];
  privateApi = true;
  respond = () => ({});
  const capture = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  console.log = capture;
  console.error = capture;
  console.warn = capture;
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const u = new URL(String(url));
    let body: any = null;
    if (typeof init.body === "string") body = JSON.parse(init.body);
    else if (init.body instanceof FormData) body = Object.fromEntries(init.body.entries());
    const call = { method: init.method ?? "GET", path: u.pathname.replace("/api/v1", "") + u.search.replace(/[?&]password=[^&]*/, ""), body };
    calls.push(call);
    if (call.path.startsWith("/server/info")) return json({ private_api: privateApi, helper_connected: privateApi });
    const r = respond(call);
    return r instanceof Response ? r : json(r);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.error = realError;
  console.warn = realWarn;
});

function setup() {
  const db = openDb(":memory:");
  const events: IncomingEvent[] = [];
  const bb = createBluebubblesAdapter({ db, onEvent: async (e) => void events.push(e) });
  return { db, events, ...bb };
}

let n = 0;
function msg(over: Record<string, unknown> = {}, handle = ALLOWED): { type: string; data: Record<string, unknown> } {
  return {
    type: "new-message",
    data: {
      guid: `MSG-${++n}`,
      text: "hello troy",
      isFromMe: false,
      dateCreated: 1_800_000_000_000,
      handle: { address: handle },
      chats: [{ guid: `any;-;${handle}` }],
      attachments: [],
      associatedMessageGuid: null,
      associatedMessageType: null,
      ...over,
    },
  };
}

const sends = () => calls.filter((c) => !c.path.startsWith("/server/info"));

// ---------- incoming ----------

test("a denied event makes zero fetch calls and logs only 'ignored event'", async () => {
  const { handleWebhook, events, db } = setup();
  await handleWebhook(msg({ text: SECRET, attachments: [{ guid: "ATT-1", mimeType: "image/jpeg", transferName: "IMG.jpeg" }] }, STRANGER));
  assert.equal(calls.length, 0);
  assert.deepEqual(logs, ["ignored event"]);
  assert.equal(events.length, 0);
  assert.equal(db.prepare("SELECT count(*) AS c FROM allow_list").get()!.c, 0);
  assert.equal(db.prepare("SELECT count(*) AS c FROM messages").get()!.c, 0);
});

test("John's own messages are dropped, even in an allowed chat", async () => {
  const { handleWebhook, events } = setup();
  await handleWebhook(msg({ isFromMe: true, text: "hey troy" }));
  await handleWebhook(msg({ isFromMe: undefined }));
  assert.equal(calls.length, 0);
  assert.deepEqual(logs, ["ignored event", "ignored event"]);
  assert.equal(events.length, 0);
});

test("unparseable and unknown events log only 'ignored event'", async () => {
  const { routes, handleWebhook, events } = setup();
  const res = await routes.request("/webhooks/bluebubbles", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
  assert.equal(res.status, 200);
  await handleWebhook(null);
  await handleWebhook("text");
  await handleWebhook({ type: "new-message" });
  await handleWebhook({ type: "new-message", data: { guid: "X", text: SECRET, isFromMe: false, handle: { address: STRANGER } } });
  await handleWebhook({ type: "chat-read-status-changed", data: { chatGuid: STRANGER_CHAT } });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 0);
  assert.equal(events.length, 0);
  assert.ok(logs.length >= 5);
  assert.ok(logs.every((l) => l === "ignored event"));
});

test("typing indicators and message updates are ignored without any call", async () => {
  const { handleWebhook, events } = setup();
  await handleWebhook({ type: "typing-indicator", data: { guid: ALLOWED_CHAT, display: true } });
  await handleWebhook({ ...msg(), type: "updated-message" });
  assert.equal(calls.length, 0);
  assert.equal(events.length, 0);
});

test("a stranger saying hey troy with history before go-live: one date lookup, denied, nothing leaked", async () => {
  const { handleWebhook, events, db } = setup();
  setSetting(db, "go_live_at", "1700000000000");
  respond = () => [{ guid: "OLD", text: SECRET, dateCreated: 1_600_000_000_000 }];
  await handleWebhook(msg({ text: "hey troy" }, STRANGER));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].path, `/chat/${encodeURIComponent(STRANGER_CHAT)}/message?limit=1&sort=ASC`);
  assert.deepEqual(logs, ["ignored event"]);
  assert.equal(events.length, 0);
  assert.equal(isAllowedChat(db, STRANGER_CHAT, STRANGER), false);
});

test("a failed history lookup denies", async () => {
  const { handleWebhook, events } = setup();
  respond = () => new Response("nope", { status: 500 });
  await handleWebhook(msg({ text: "hey troy" }, STRANGER));
  respond = () => [{ guid: "OLD" }]; // no date
  await handleWebhook(msg({ text: "hey troy" }, STRANGER));
  assert.deepEqual(logs, ["ignored event", "ignored event"]);
  assert.equal(events.length, 0);
});

test("a brand-new chat saying hey troy opts in and reaches onEvent", async () => {
  const { handleWebhook, events, db } = setup();
  setSetting(db, "go_live_at", "1700000000000");
  const first = msg({ text: "Hey Troy!" }, STRANGER);
  respond = () => [{ guid: first.data.guid, dateCreated: 1_800_000_000_000 }];
  await handleWebhook(first);
  assert.equal(events.length, 1);
  assert.equal(events[0].userHandle, STRANGER);
  assert.equal(events[0].text, "Hey Troy!");
  assert.equal(isAllowedChat(db, STRANGER_CHAT, STRANGER), true);
  assert.deepEqual(logs, []);
  // the next message needs no lookup
  calls = [];
  await handleWebhook(msg({ text: "i lost my keys" }, STRANGER));
  assert.equal(calls.length, 0);
  assert.equal(events.length, 2);
});

test("an allowed text event reaches onEvent with the right shape", async () => {
  const { handleWebhook, events } = setup();
  const m = msg({ text: "found a wallet at leavey" });
  await handleWebhook(m);
  assert.deepEqual(events, [
    {
      provider: "bluebubbles",
      userHandle: ALLOWED,
      chatId: ALLOWED_CHAT,
      isGroup: false,
      messageId: m.data.guid,
      text: "found a wallet at leavey",
      images: [],
      receivedAt: 1_800_000_000_000,
    },
  ]);
  assert.equal(calls.length, 0);
  assert.deepEqual(logs, []);
});

test("a duplicate guid is delivered once", async () => {
  const { handleWebhook, events, db } = setup();
  const m = msg();
  await Promise.all([handleWebhook(m), handleWebhook(m)]);
  await handleWebhook(m);
  assert.equal(events.length, 1);
  // also when the pipeline already saved it (for example after a restart)
  db.prepare("INSERT INTO messages (chatId, direction, providerMessageId, text, createdAt) VALUES (?, 'in', ?, 'x', 1)").run(ALLOWED_CHAT, "SAVED-1");
  await handleWebhook(msg({ guid: "SAVED-1" }));
  assert.equal(events.length, 1);
});

test("an event must name exactly one chat, and a 1:1 sender must match the chat", async () => {
  const { handleWebhook, events } = setup();
  await handleWebhook(msg({ chats: [{ guid: ALLOWED_CHAT }, { guid: STRANGER_CHAT }] }));
  await handleWebhook(msg({ chats: [{ guid: ALLOWED_CHAT }] }, STRANGER));
  await handleWebhook(msg({ chats: [{ guid: "any;+;chat777" }] }));
  await handleWebhook(msg({ chats: [] }));
  assert.equal(events.length, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(logs, ["ignored event", "ignored event", "ignored event", "ignored event"]);
});

test("kill switch off: allowed chats are ignored too", async () => {
  const { handleWebhook, events, db } = setup();
  setSetting(db, "troy_enabled", "false");
  await handleWebhook(msg());
  assert.equal(events.length, 0);
  assert.deepEqual(logs, ["ignored event"]);
});

test("tapbacks, including removals", async () => {
  const { handleWebhook, events } = setup();
  await handleWebhook(msg({ text: "Loved “pizza”", associatedMessageGuid: "p:0/TARGET-1", associatedMessageType: "love" }));
  await handleWebhook(msg({ associatedMessageGuid: "bp:TARGET-2", associatedMessageType: "-like" }));
  await handleWebhook(msg({ associatedMessageGuid: "p:1/TARGET-3", associatedMessageType: 2005 }));
  await handleWebhook(msg({ associatedMessageGuid: "p:0/TARGET-4", associatedMessageType: "sticker" }));
  assert.deepEqual(
    events.map((e) => [e.reaction, e.text]),
    [
      [{ targetMessageId: "TARGET-1", type: "love", removed: false }, ""],
      [{ targetMessageId: "TARGET-2", type: "like", removed: true }, ""],
      [{ targetMessageId: "TARGET-3", type: "question", removed: false }, ""],
    ],
  );
});

test("an image and a location pin on an allowed event are downloaded and parsed", async () => {
  const { handleWebhook, events } = setup();
  const vcf = "BEGIN:VCARD\r\nVERSION:3.0\r\nN:;Current Location;;;\r\nitem1.URL;type=pref:https://maps.apple.com/?ll=34.021986\\,-118.285117&q=34.021986\\,-118.285117\r\nEND:VCARD\r\n";
  respond = (c) =>
    c.path.includes("ATT-IMG")
      ? new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/jpeg" } })
      : new Response(vcf, { status: 200, headers: { "content-type": "text/vcard" } });
  await handleWebhook(
    msg({
      text: "￼",
      attachments: [
        { guid: "ATT-IMG", mimeType: "image/heic", transferName: "../../evil.HEIC" },
        { guid: "ATT-LOC", mimeType: "text/x-vlocation", transferName: "CL.loc.vcf" },
        { guid: "ATT-PDF", mimeType: "application/pdf", transferName: "a.pdf" },
      ],
    }),
  );
  assert.equal(calls.length, 2);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.text, "");
  assert.deepEqual(e.location, { lat: 34.021986, lng: -118.285117 });
  assert.equal(e.images.length, 1);
  assert.equal(e.images[0].mime, "image/jpeg");
  assert.match(e.images[0].path, /\/tmp-downloads\/[0-9a-f-]{36}\.jpg$/);
  assert.deepEqual([...readFileSync(e.images[0].path)], [1, 2, 3]);
  rmSync(e.images[0].path);
});

test("parseLocationVcard and handleFromChatId", () => {
  assert.deepEqual(parseLocationVcard("URL:https://maps.apple.com/?q=1.5%2C-2.25"), { lat: 1.5, lng: -2.25 });
  assert.equal(parseLocationVcard("BEGIN:VCARD\nFN:Someone\nEND:VCARD"), null);
  assert.equal(handleFromChatId("any;-;+13105550001"), "+13105550001");
  assert.equal(handleFromChatId("iMessage;-;Judge@Example.com"), "judge@example.com");
  assert.equal(handleFromChatId("any;+;chat123"), null);
  assert.equal(handleFromChatId("nonsense"), null);
});

// ---------- outgoing ----------

test("no outgoing method makes a fetch for a chat that isn't allowed", async () => {
  const { adapter, db } = setup();
  for (const chatId of [STRANGER_CHAT, "any;+;chat777", "", "garbage"]) {
    assert.equal(await adapter.sendMessage(chatId, "hi", { effect: "confetti" }), null);
    assert.equal(await adapter.sendImage(chatId, "/nonexistent.jpg", "cap"), null);
    assert.equal(await adapter.sendContactCard(chatId), null);
    await adapter.markRead(chatId);
    await adapter.startTyping(chatId);
    await adapter.stopTyping(chatId);
    assert.equal(await adapter.react(chatId, "MSG", "love"), false);
    assert.equal(await adapter.editMessage(chatId, "MSG", "new"), false);
    assert.deepEqual(await adapter.sendPoll(chatId, "q?", ["a", "b"]), { optionMessageIds: [null, null], mode: "tap" });
  }
  assert.equal(await adapter.createGroupChat([ALLOWED, STRANGER], "hi"), null);
  assert.equal(await adapter.createGroupChat([ALLOWED], "hi"), null);
  assert.equal(await adapter.createGroupChat([ALLOWED, "not a handle"], "hi"), null);
  assert.equal(await adapter.getLiveLocation(STRANGER), null);
  assert.equal(calls.length, 0);
  assert.ok(logs.length > 0);
  assert.ok(logs.every((l) => l === "send refused"));
  assert.equal(db.prepare("SELECT count(*) AS c FROM allow_list").get()!.c, 0);
});

test("kill switch off: nothing is sent to an allowed chat either", async () => {
  const { adapter, db } = setup();
  setSetting(db, "troy_enabled", "false");
  assert.equal(await adapter.sendMessage(ALLOWED_CHAT, "hi"), null);
  await adapter.markRead(ALLOWED_CHAT);
  await adapter.startTyping(ALLOWED_CHAT);
  assert.equal(await adapter.react(ALLOWED_CHAT, "MSG", "like"), false);
  assert.equal(await adapter.sendContactCard(ALLOWED_CHAT), null);
  assert.equal(await adapter.createGroupChat([ALLOWED, "judge@example.com"], "hi"), null);
  assert.equal(await adapter.getLiveLocation(ALLOWED), null);
  assert.equal(calls.length, 0);
  assert.ok(logs.every((l) => l === "send refused"));
});

test("editMessage never fetches, even for an allowed chat", async () => {
  const { adapter } = setup();
  assert.equal(await adapter.editMessage(ALLOWED_CHAT, "MSG-1", "new text"), false);
  assert.equal(calls.length, 0);
  assert.equal(adapter.capabilities().edits, false);
});

test("sending to an allowed chat uses the known-good request shapes", async () => {
  const { adapter } = setup();
  respond = (c) => (c.method === "POST" && c.path.startsWith("/message/") ? { guid: "SENT-1" } : {});
  assert.deepEqual(await adapter.sendMessage(ALLOWED_CHAT, "yo", { effect: "slam" }), { messageId: "SENT-1" });
  await adapter.markRead(ALLOWED_CHAT);
  await adapter.startTyping(ALLOWED_CHAT);
  await adapter.stopTyping(ALLOWED_CHAT);
  assert.equal(await adapter.react(ALLOWED_CHAT, "MSG-9", "like"), true);
  assert.deepEqual(await adapter.sendContactCard(ALLOWED_CHAT), { messageId: "SENT-1" });

  assert.equal(calls[0].path, "/server/info"); // checked once, lazily
  assert.equal(calls.filter((c) => c.path === "/server/info").length, 1);
  const [text, read, typeOn, typeOff, react, card] = sends();
  const chat = encodeURIComponent(ALLOWED_CHAT);
  assert.equal(text.path, "/message/text");
  assert.equal(text.body.chatGuid, ALLOWED_CHAT);
  assert.equal(text.body.message, "yo");
  assert.equal(text.body.method, "private-api");
  assert.equal(text.body.effectId, "com.apple.MobileSMS.expressivesend.impact");
  assert.ok(text.body.tempGuid);
  assert.deepEqual([read.method, read.path], ["POST", `/chat/${chat}/read`]);
  assert.deepEqual([typeOn.method, typeOn.path], ["POST", `/chat/${chat}/typing`]);
  assert.deepEqual([typeOff.method, typeOff.path], ["DELETE", `/chat/${chat}/typing`]);
  assert.deepEqual(react.body, { chatGuid: ALLOWED_CHAT, selectedMessageGuid: "MSG-9", reaction: "like", partIndex: 0 });
  assert.equal(card.path, "/message/attachment");
  assert.equal(card.body.name, "Troy.vcf");
  assert.equal(card.body.chatGuid, ALLOWED_CHAT);
  const vcf = await (card.body.attachment as File).text();
  assert.match(vcf, /FN:Troy/);
  assert.deepEqual(logs, []);
});

test("sendPoll sends the question, then one bubble per option", async () => {
  const { adapter } = setup();
  let i = 0;
  respond = () => ({ guid: `P-${i++}` });
  const r = await adapter.sendPoll(ALLOWED_CHAT, "what do u want alerts for?", ["free food", "events"]);
  assert.deepEqual(r, { optionMessageIds: ["P-1", "P-2"], mode: "tap" });
  const bodies = sends().map((c) => c.body.message);
  assert.equal(bodies.length, 3);
  assert.ok(bodies[0].startsWith("what do u want alerts for?"));
  assert.deepEqual(bodies.slice(1), ["free food", "events"]);
});

test("Private API off: capabilities drop and methods fall back", async () => {
  const { adapter } = setup();
  privateApi = false;
  respond = () => ({ guid: "S-1" });
  assert.deepEqual(await adapter.sendMessage(ALLOWED_CHAT, "yo", { effect: "confetti" }), { messageId: "S-1" });
  assert.equal(await adapter.react(ALLOWED_CHAT, "MSG", "love"), false);
  await adapter.markRead(ALLOWED_CHAT);
  await adapter.startTyping(ALLOWED_CHAT);
  assert.equal(await adapter.createGroupChat([ALLOWED, "judge@example.com"], "hi"), null);
  assert.equal(await adapter.getLiveLocation(ALLOWED), null);
  const poll = await adapter.sendPoll(ALLOWED_CHAT, "pick one", ["a", "b"]);
  assert.deepEqual(poll, { optionMessageIds: [null, null], mode: "numbered" });

  const s = sends();
  assert.equal(s.length, 2); // the text and the numbered list, nothing else
  assert.equal(s[0].body.method, "apple-script");
  assert.equal(s[0].body.effectId, undefined);
  assert.match(s[1].body.message, /1\. a\n2\. b/);
  const caps = adapter.capabilities();
  assert.deepEqual(
    [caps.tapbacks, caps.typing, caps.effects, caps.groupChats, caps.liveLocation, caps.edits, caps.polls],
    [false, false, false, false, false, false, false],
  );
});

test("createGroupChat: all members allowed, and the new chat becomes a troy_group", async () => {
  const { adapter, db, handleWebhook, events } = setup();
  respond = (c) =>
    c.path === "/chat/new"
      ? { guid: "any;+;chat555", participants: [{ address: "judge@example.com" }, { address: ALLOWED }] }
      : c.method === "GET"
        ? [{ guid: "G-0", dateCreated: Date.now() }]
        : { guid: "G-1" };
  assert.equal(await adapter.createGroupChat([ALLOWED, "Judge@Example.com"], "handing u off"), "any;+;chat555");
  const create = sends()[0];
  assert.deepEqual(create.body.addresses, [ALLOWED, "judge@example.com"]);
  assert.equal(create.body.method, "private-api");
  assert.equal(create.body.message, "handing u off");
  assert.deepEqual({ ...db.prepare("SELECT handle, chatId, reason FROM allow_list").get() }, { handle: null, chatId: "any;+;chat555", reason: "troy_group" });
  // Troy can now send there and hear from it
  respond = () => ({ guid: "G-1" });
  assert.deepEqual(await adapter.sendMessage("any;+;chat555", "hi both"), { messageId: "G-1" });
  await handleWebhook(msg({ chats: [{ guid: "any;+;chat555" }], text: "thanks" }, STRANGER));
  assert.equal(events.length, 1);
  assert.equal(events[0].isGroup, true);
  assert.equal(events[0].userHandle, STRANGER);
});

test("getLiveLocation returns only the requested, allowed handle", async () => {
  const { adapter, db } = setup();
  const now = Date.now();
  respond = () => [
    { handle: STRANGER, coordinates: [40.1, -74.2], last_updated: now, status: "live" },
    { handle: "(310) 555-0001", coordinates: [34.02, -118.28], last_updated: now, status: "live" },
    { handle: null, coordinates: [1, 1], last_updated: now, status: "legacy" },
  ];
  assert.deepEqual(await adapter.getLiveLocation(ALLOWED), { lat: 34.02, lng: -118.28, at: now });
  assert.deepEqual(sends().map((c) => `${c.method} ${c.path}`), ["GET /icloud/findmy/friends"]);
  // someone sharing with John who isn't a Troy user: refused before any call
  calls = [];
  assert.equal(await adapter.getLiveLocation(STRANGER), null);
  assert.equal(calls.length, 0);
  // allowed but not sharing
  allowChat(db, { handle: "+12135550123", chatId: null, reason: "manual" });
  respond = (c) => (c.method === "POST" ? [] : [{ handle: STRANGER, coordinates: [40.1, -74.2], last_updated: now, status: "live" }]);
  const t = Date.now();
  const none = await adapter.getLiveLocation("+12135550123");
  assert.equal(none, null);
  assert.ok(Date.now() - t < 15_000);
  assert.ok(logs.every((l) => !l.includes("40.1")));
});

test("the password never shows up in logs", async () => {
  const { adapter, handleWebhook } = setup();
  respond = () => new Response("boom", { status: 500 });
  assert.equal(await adapter.sendMessage(ALLOWED_CHAT, "yo"), null);
  await handleWebhook(msg({ attachments: [{ guid: "A", mimeType: "image/png", transferName: "a.png" }], text: "" }));
  assert.ok(logs.every((l) => !l.includes("test-password")));
  assert.ok(existsSync(new URL("../tmp-downloads", import.meta.url)) || true);
});

// ---------- review fixes ----------

test("hey troy only opts in when it is the chat's very first message", async () => {
  const { handleWebhook, events, db } = setup();
  setSetting(db, "go_live_at", "1700000000000");
  // An earlier message exists in the chat (after go-live). Only its id and date are looked at.
  respond = () => [{ guid: "EARLIER-PRIVATE-MSG", text: SECRET, dateCreated: 1_750_000_000_000 }];
  await handleWebhook(msg({ text: "hey troy's demo is at 9 right? dont tell him i asked" }, STRANGER));
  assert.equal(events.length, 0);
  assert.equal(isAllowedChat(db, STRANGER_CHAT, STRANGER), false);
  assert.deepEqual(logs, ["ignored event"]);
  assert.ok(!logs.join(" ").includes(SECRET));
});

test("an empty history list is a failed lookup, not a new chat", async () => {
  const { handleWebhook, events, db } = setup();
  setSetting(db, "go_live_at", "1700000000000");
  respond = () => [];
  await handleWebhook(msg({ text: "hey troy's party is at 9 right?" }, STRANGER));
  assert.equal(events.length, 0);
  assert.equal(isAllowedChat(db, STRANGER_CHAT, STRANGER), false);
  assert.equal(calls.length, 2); // asked twice, then gave up
  assert.deepEqual(logs, ["ignored event"]);
});

test("go-live is fixed when the adapter is created, so the first hey troy can opt in", async () => {
  const { handleWebhook, events, db } = setup();
  const goLive = Number(getSetting(db, "go_live_at"));
  assert.ok(goLive > 0 && goLive <= Date.now());
  const first = msg({ text: "hey troy", dateCreated: Date.now() }, STRANGER);
  respond = () => [{ guid: first.data.guid, dateCreated: Date.now() }];
  await handleWebhook(first);
  assert.equal(events.length, 1);
  assert.equal(isAllowedChat(db, STRANGER_CHAT, STRANGER), true);
});

test("an event with two chats opts nobody in and makes no lookup", async () => {
  const { handleWebhook, events, db } = setup();
  await handleWebhook(msg({ text: "hey troy", chats: [{ guid: STRANGER_CHAT }, { guid: "any;+;chat999" }] }, STRANGER));
  assert.equal(events.length, 0);
  assert.equal(calls.length, 0);
  assert.equal(isAllowedChat(db, STRANGER_CHAT, STRANGER), false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM allow_list").get()!.n, 0);
});

test("a 10-digit international number is not treated as a US number", async () => {
  const { handleWebhook, adapter, events, db } = setup();
  assert.equal(handleFromChatId("any;-;+6591234567"), "+6591234567");
  allowChat(db, { handle: "+16591234567", chatId: null, reason: "manual" });
  await handleWebhook(msg({ text: SECRET, chats: [{ guid: "any;-;+6591234567" }] }, "+6591234567"));
  assert.equal(events.length, 0);
  assert.equal(await adapter.sendMessage("any;-;+6591234567", "hi"), null);
  assert.equal(calls.length, 0);
  assert.equal(adapter.chatIdForHandle("+6581112222"), "any;-;+6581112222");
});

test("webhook route: JSON only, nothing from a browser, and the secret when one is set", async () => {
  const { routes, events, db } = setup();
  const forged = JSON.stringify(msg({ text: "hey troy" }, STRANGER));
  const hit = (path: string, headers: Record<string, string>) => routes.request(path, { method: "POST", headers, body: forged });
  const json = { "content-type": "application/json" };
  assert.equal((await hit("/webhooks/bluebubbles", { "content-type": "text/plain" })).status, 403);
  assert.equal((await hit("/webhooks/bluebubbles", { ...json, origin: "https://evil.example" })).status, 403);
  assert.equal((await hit("/webhooks/bluebubbles", { ...json, "sec-fetch-site": "cross-site" })).status, 403);
  config.webhookSecret = "s3cret-token";
  try {
    assert.equal((await hit("/webhooks/bluebubbles", json)).status, 403);
    assert.equal((await hit("/webhooks/bluebubbles/wrong-token!", json)).status, 403);
    assert.equal((await hit("/webhooks/bluebubbles/s3cret-toke", json)).status, 403);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls.length, 0);
    assert.equal(events.length, 0);
    assert.equal(isAllowedChat(db, STRANGER_CHAT, STRANGER), false);
    const ok = await routes.request("/webhooks/bluebubbles/s3cret-token", { method: "POST", headers: json, body: JSON.stringify(msg({ text: "hi" })) });
    assert.equal(ok.status, 200);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(events.length, 1);
  } finally {
    config.webhookSecret = "";
  }
  // With a secret unset, a path that carries one is not accepted either.
  assert.equal((await hit("/webhooks/bluebubbles/anything", json)).status, 403);
  assert.ok(logs.every((l) => l === "ignored event"));
});

test("a forged hey troy for a number with no real chat cannot opt it in", async () => {
  const { routes, events, db } = setup();
  respond = () => new Response("not found", { status: 404 });
  const res = await routes.request("/webhooks/bluebubbles", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg({ text: "hey troy" }, STRANGER)) });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(events.length, 0);
  assert.equal(isAllowedChat(db, STRANGER_CHAT, STRANGER), false);
  assert.ok(calls.every((c) => c.method === "GET"));
});

test("kill switch flipped during the Private API status lookup stops the send", async () => {
  const { adapter, db } = setup();
  const stub = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes("/server/info")) setSetting(db, "troy_enabled", "false");
    return stub(url, init);
  }) as typeof fetch;
  assert.equal(await adapter.sendMessage(ALLOWED_CHAT, "hi"), null);
  assert.deepEqual(sends(), []);
  assert.deepEqual(logs, ["send refused"]);
});

test("createGroupChat does not adopt a group that already existed", async () => {
  const { adapter, db } = setup();
  const old = "iMessage;+;chat-EXISTING-FAMILY-THREAD";
  respond = (c) => (c.path === "/chat/new" ? { guid: old } : [{ guid: "OLD-1", text: SECRET, dateCreated: Date.now() - 86_400_000 }]);
  assert.equal(await adapter.createGroupChat([ALLOWED, "judge@example.com"], "handing u off"), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM allow_list").get()!.n, 0);
  assert.equal(isAllowedChat(db, old, null), false);
  assert.deepEqual(logs, ["send refused"]);
  // wrong members, or a lookup that fails or comes back empty: also not adopted
  respond = (c) => (c.path === "/chat/new" ? { guid: "any;+;chat1", participants: [{ address: ALLOWED }, { address: STRANGER }] } : [{ guid: "N", dateCreated: Date.now() }]);
  assert.equal(await adapter.createGroupChat([ALLOWED, "judge@example.com"], "x"), null);
  respond = (c) => (c.path === "/chat/new" ? { guid: "any;+;chat2" } : []);
  assert.equal(await adapter.createGroupChat([ALLOWED, "judge@example.com"], "x"), null);
  respond = (c) => (c.path === "/chat/new" ? { guid: "any;+;chat3" } : new Response("x", { status: 500 }));
  assert.equal(await adapter.createGroupChat([ALLOWED, "judge@example.com"], "x"), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM allow_list").get()!.n, 0);
});

test("anything attached to another message is never passed on as typed text", async () => {
  const { handleWebhook, events } = setup();
  await handleWebhook(msg({ associatedMessageGuid: "p:0/ZZZ", associatedMessageType: null, text: 'Reacted 🎉 to "see u at 9"' }));
  await handleWebhook(msg({ associatedMessageGuid: "p:0/ZZZ", associatedMessageType: "sticker", text: "x" }));
  assert.equal(events.length, 0);
});
