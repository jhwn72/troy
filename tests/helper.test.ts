import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

// People on the manual list count only once they have said "hey troy" themselves. Most tests here are about
// what happens after that, so start with them activated.
function activated<T extends { prepare(sql: string): { run(...a: unknown[]): unknown } }>(db: T): T {
  for (const raw of (process.env.ALLOWED_HANDLES || "").split(",")) {
    const h = raw.trim().toLowerCase();
    const handle = h.includes("@") ? h : "+" + h.replace(/\D/g, "").replace(/^(\d{10})$/, "1$1");
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')").run(`manual_on:${handle}`);
  }
  return db;
}


// config reads the environment when it's first imported, so set it before importing anything.
process.env.ALLOWED_HANDLES = "+13105550001";
process.env.TROY_ENABLED = "true";
process.env.MESSAGING_PROVIDER = "webchat"; // the real HelperClient must never start in tests
delete process.env.TROY_HELPER_TOKEN;

const { openDb, setSetting } = await import("../src/db/index.ts");
const { allowChat } = await import("../src/adapters/gate.ts");
const { createHelper, decodeFindMyShare, decodePollVote, decodePollPayload, decodeFindMyPayload, locationRequestDelivered } = await import("../src/adapters/helper.ts");
type HelperClientLike = import("../src/adapters/helper.ts").HelperClientLike;

const ENV_CHAT = "any;-;+13105550001";
const OPTED = "+12135550111";
const OPTED_CHAT = `any;-;${OPTED}`;
const STRANGER_CHAT = "any;-;+12135550199";
const GROUP_CHAT = "any;+;chat123";

type Call = { cmd: string; chatGuid: string; args?: Record<string, unknown> };

/** Stands in for HelperClient. No sockets. Keeps its own allowlist the way the real one does. */
function fakeClient(over: { connected?: boolean; answer?: (c: Call) => any } = {}) {
  const calls: Call[] = [];
  const allow = new Set<string>();
  const state = { connected: over.connected ?? true, started: 0, answer: over.answer ?? (() => ({ ok: true })) };
  const client: HelperClientLike = {
    get connected() {
      return state.connected;
    },
    start() {
      state.started++;
    },
    stop() {},
    async allowChat(chatGuid) {
      calls.push({ cmd: "allow-chat", chatGuid });
      const r = state.answer({ cmd: "allow-chat", chatGuid });
      if (r.ok) allow.add(chatGuid);
      return r;
    },
    async removeChat(chatGuid) {
      calls.push({ cmd: "remove-chat", chatGuid });
      allow.delete(chatGuid);
      return { ok: true };
    },
    async request(cmd, chatGuid, args) {
      if (!allow.has(chatGuid)) throw new Error("BLOCKED: chat not in allowlist");
      calls.push({ cmd, chatGuid, args });
      return state.answer({ cmd, chatGuid, args });
    },
  };
  return { client, calls, state };
}

function votePayload(optionIdentifier: string, participantHandle = OPTED): string {
  const json = JSON.stringify({ version: 1, item: { votes: [{ voteOptionIdentifier: optionIdentifier, participantHandle }] } });
  return Buffer.from(`bplist00...NSKeyedArchiver...data:,${Buffer.from(json).toString("base64")}?src=p&c=2\u0000...`, "latin1").toString("base64");
}

function findMyPayload(body: Record<string, unknown>): string {
  const zipped = encodeURIComponent(deflateRawSync(Buffer.from(JSON.stringify(body))).toString("base64"));
  return Buffer.from(`bplist00...?FindMyMessagePayloadVersionKey=v0&FindMyMessagePayloadZippedDataKey=${zipped}\u0000...`, "latin1").toString("base64");
}

let logs: string[] = [];
const realLog = console.log;
beforeEach(() => {
  logs = [];
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
});
afterEach(() => {
  console.log = realLog;
});

function setup(over: Parameters<typeof fakeClient>[0] = {}) {
  const db = activated(openDb(":memory:"));
  allowChat(db, { handle: OPTED, chatId: OPTED_CHAT, reason: "opt_in_phrase" });
  const fake = fakeClient(over);
  const helper = createHelper({ db, client: fake.client });
  return { db, helper, ...fake };
}

test("no token: nothing is available, nothing throws, and no client is made", async () => {
  const db = activated(openDb(":memory:"));
  const helper = createHelper({ db });
  helper.start();
  assert.equal(helper.available, false);
  assert.equal(helper.isConnected(), false);
  assert.equal(await helper.allowChat(ENV_CHAT), false);
  assert.equal(await helper.removeChat(ENV_CHAT), false);
  assert.equal(await helper.sendPoll(ENV_CHAT, ["a", "b"], "troy@example.com"), null);
  assert.equal(await helper.getPayload(ENV_CHAT, "M"), null);
  assert.equal(await helper.requestLocation(ENV_CHAT), false);
  assert.equal(await helper.getLocation(ENV_CHAT), null);
  assert.equal(await helper.registerAllowedChats(), 0);
});

test("startup registration: every allowed 1:1 chat, groups and stopped users left out, missing chats ignored", async () => {
  const { db, helper, calls, state } = setup({
    answer: (c) => (c.chatGuid === "any;-;+12135550122" ? { ok: false, error: "chat does not exist in Messages yet" } : { ok: true, changed: true, count: 1 }),
  });
  allowChat(db, { handle: "+12135550122", chatId: null, reason: "manual" }); // never texted yet
  allowChat(db, { handle: null, chatId: GROUP_CHAT, reason: "troy_group" });
  allowChat(db, { handle: "+12135550133", chatId: "any;-;+12135550133", reason: "opt_in_phrase" });
  allowChat(db, { handle: "+12135550144", chatId: "webchat;-;+12135550144", reason: "opt_in_phrase" });
  db.prepare("INSERT INTO users (handle, chatId, stopped, createdAt) VALUES (?, ?, 1, ?)").run("+12135550133", "any;-;+12135550133", Date.now());

  state.connected = false;
  helper.start(); // listening; the helper has not connected yet
  assert.equal(state.started, 1);
  assert.equal(calls.length, 0);
  state.connected = true; // the real client calls registerAllowedChats from its hello callback
  const count = await helper.registerAllowedChats();
  assert.equal(count, 2);
  assert.deepEqual(calls.map((c) => `${c.cmd} ${c.chatGuid}`).sort(), [`allow-chat ${ENV_CHAT}`, `allow-chat ${OPTED_CHAT}`, "allow-chat any;-;+12135550122"].sort());
  // a second pass only retries the one that failed
  calls.length = 0;
  await helper.registerAllowedChats();
  assert.deepEqual(calls.map((c) => c.chatGuid), ["any;-;+12135550122"]);
});

test("the send lock: a chat that isn't allowed gets zero helper calls from every method", async () => {
  const { helper, calls } = setup();
  for (const chat of [STRANGER_CHAT, GROUP_CHAT, ""]) {
    assert.equal(await helper.allowChat(chat), false);
    assert.equal(await helper.sendPoll(chat, ["a", "b"], "troy@example.com"), null);
    assert.equal(await helper.getPayload(chat, "M-1"), null);
    assert.equal(await helper.requestLocation(chat), false);
    assert.equal(await helper.getLocation(chat), null);
  }
  assert.equal(calls.length, 0);
  assert.ok(logs.length >= 15);
  assert.ok(logs.every((l) => l === "send refused"));
});

test("the send lock: kill switch off stops every method, even for an allowed chat", async () => {
  const { db, helper, calls } = setup();
  setSetting(db, "troy_enabled", "false");
  assert.equal(await helper.allowChat(OPTED_CHAT), false);
  assert.equal(await helper.sendPoll(OPTED_CHAT, ["a", "b"], "troy@example.com"), null);
  assert.equal(await helper.getPayload(OPTED_CHAT, "M-1"), null);
  assert.equal(await helper.requestLocation(OPTED_CHAT), false);
  assert.equal(await helper.getLocation(OPTED_CHAT), null);
  assert.equal(await helper.registerAllowedChats(), 0);
  assert.equal(calls.length, 0);
});

test("the kill switch flipping while the helper answers stops the request that would follow", async () => {
  const { db, helper, calls } = setup({
    answer: (c) => {
      if (c.cmd === "allow-chat") setSetting(db, "troy_enabled", "false");
      return { ok: true };
    },
  });
  assert.equal(await helper.requestLocation(OPTED_CHAT), false);
  assert.deepEqual(calls.map((c) => c.cmd), ["allow-chat", "remove-chat"]);
});

test("an allowed chat is registered on first use, then the commands go out in the documented shapes", async () => {
  const { helper, calls } = setup({
    answer: (c) => {
      if (c.cmd === "send-poll") return { ok: true, guid: "POLL-1", optionIdentifiers: ["ID-A", "ID-B"] };
      if (c.cmd === "get-payload") return { ok: true, payloadBase64: "AAAA" };
      if (c.cmd === "location-request") return { ok: true, requested: "x", invite: "ok" };
      if (c.cmd === "location-get") return { ok: true, handle: "x", sharingWithMe: true, location: { latitude: 34.02, longitude: -118.28, timestamp: 1_794_688_935 } };
      return { ok: true };
    },
  });
  assert.deepEqual(await helper.sendPoll(OPTED_CHAT, ["usc student", "hackathon judge"], "troy@example.com"), { guid: "POLL-1", optionIdentifiers: ["ID-A", "ID-B"] });
  assert.equal(await helper.getPayload(OPTED_CHAT, "MSG-7"), "AAAA");
  assert.equal(await helper.requestLocation(OPTED_CHAT), true);
  assert.deepEqual(await helper.getLocation(OPTED_CHAT), { lat: 34.02, lng: -118.28, at: 1_794_688_935_000 });
  assert.deepEqual(calls, [
    { cmd: "allow-chat", chatGuid: OPTED_CHAT },
    { cmd: "send-poll", chatGuid: OPTED_CHAT, args: { options: ["usc student", "hackathon judge"], creatorHandle: "troy@example.com" } },
    { cmd: "get-payload", chatGuid: OPTED_CHAT, args: { messageGuid: "MSG-7" } },
    { cmd: "location-request", chatGuid: OPTED_CHAT, args: { bubble: false } }, // never the chat bubble: it has no Share button
    { cmd: "location-get", chatGuid: OPTED_CHAT, args: {} },
  ]);
  assert.deepEqual(logs, []);
});

test("helper not connected: every method is 'not available' at once, with no call", async () => {
  const { helper, calls } = setup({ connected: false });
  const t = Date.now();
  assert.equal(helper.available, true);
  assert.equal(helper.isConnected(), false);
  assert.equal(await helper.allowChat(OPTED_CHAT), false);
  assert.equal(await helper.sendPoll(OPTED_CHAT, ["a", "b"], "troy@example.com"), null);
  assert.equal(await helper.getPayload(OPTED_CHAT, "M"), null);
  assert.equal(await helper.requestLocation(OPTED_CHAT), false);
  assert.equal(await helper.getLocation(OPTED_CHAT), null);
  assert.equal(calls.length, 0);
  assert.ok(Date.now() - t < 500);
});

test("helper errors and refusals come back as 'not available', never as a throw", async () => {
  const { helper, state } = setup();
  await helper.allowChat(OPTED_CHAT);
  state.answer = () => ({ ok: false, error: "chat not allowed" });
  assert.equal(await helper.sendPoll(OPTED_CHAT, ["a", "b"], "troy@example.com"), null);
  assert.equal(await helper.requestLocation(OPTED_CHAT), false);
  state.answer = () => {
    throw new Error(`helper did not answer for ${OPTED_CHAT}`);
  };
  assert.equal(await helper.getPayload(OPTED_CHAT, "M"), null);
  assert.equal(await helper.getLocation(OPTED_CHAT), null);
  assert.ok(logs.every((l) => !l.includes(OPTED)));
  // bad shapes
  state.answer = () => ({ ok: true, guid: "P", optionIdentifiers: ["only-one"] });
  assert.equal(await helper.sendPoll(OPTED_CHAT, ["a", "b"], "troy@example.com"), null);
  state.answer = () => ({ ok: true, sharingWithMe: false, location: { latitude: 1, longitude: 2, timestamp: 5 } });
  assert.equal(await helper.getLocation(OPTED_CHAT), null);
  state.answer = () => ({ ok: true, sharingWithMe: true, location: null });
  assert.equal(await helper.getLocation(OPTED_CHAT), null);
  // one option, or no creator: no call at all
  assert.equal(await helper.sendPoll(OPTED_CHAT, ["a"], "troy@example.com"), null);
  assert.equal(await helper.sendPoll(OPTED_CHAT, ["a", "b"], ""), null);
});

test("removeChat takes the chat away and only an explicit allowChat brings it back", async () => {
  const { helper, calls } = setup({ answer: (c) => (c.cmd === "get-payload" ? { ok: true, payloadBase64: "AAAA" } : { ok: true }) });
  assert.equal(await helper.getPayload(OPTED_CHAT, "M"), "AAAA");
  assert.equal(await helper.removeChat(OPTED_CHAT), true);
  calls.length = 0;
  // still on Troy's allow list (STOP keeps the row), but the helper is off limits for it now
  assert.equal(await helper.getPayload(OPTED_CHAT, "M"), null);
  assert.equal(await helper.requestLocation(OPTED_CHAT), false);
  await helper.registerAllowedChats();
  assert.ok(calls.every((c) => c.chatGuid !== OPTED_CHAT));
  assert.equal(await helper.allowChat(OPTED_CHAT), true);
  assert.equal(await helper.getPayload(OPTED_CHAT, "M"), "AAAA");
});

test("a removal while the helper is away is sent when it comes back", async () => {
  const { helper, calls, state } = setup({ connected: false });
  assert.equal(await helper.removeChat(OPTED_CHAT), false);
  assert.equal(calls.length, 0);
  state.connected = true;
  await helper.registerAllowedChats();
  assert.deepEqual(calls[0], { cmd: "remove-chat", chatGuid: OPTED_CHAT });
  assert.ok(!calls.some((c) => c.cmd === "allow-chat" && c.chatGuid === OPTED_CHAT));
});

test("decoders: poll votes and Find My shares", () => {
  assert.equal(decodePollVote(votePayload("ID-B")), "ID-B");
  assert.equal(decodePollVote(votePayload("ID-B"), OPTED), "ID-B");
  assert.equal(decodePollVote(Buffer.from("nothing here").toString("base64")), null);
  assert.equal(decodePollVote(""), null);
  assert.deepEqual(decodePollPayload(votePayload("X"))?.item.votes[0].voteOptionIdentifier, "X");

  const share = findMyPayload({
    initialLocation: { latitude: 34.0224, longitude: -118.2851, horizontalAccuracy: 61, altitude: 50, speed: 0, course: -1, timestamp: 784_000_000 },
    kind: { share: { isFromRequest: true, duration: { indefinitely: {} } } },
    id: "A1B2",
  });
  assert.deepEqual(decodeFindMyShare(share), { lat: 34.0224, lng: -118.2851 });
  assert.equal(decodeFindMyPayload(share)?.kind.share.isFromRequest, true);
  // a "Requested Location" bubble has no location in it
  assert.equal(decodeFindMyShare(findMyPayload({ kind: { request: {} }, id: "A1B2" })), null);
  assert.equal(decodeFindMyShare(findMyPayload({ initialLocation: { latitude: 0, longitude: 0 } })), null);
  assert.equal(decodeFindMyShare(findMyPayload({ initialLocation: { latitude: 134, longitude: 2 } })), null);
  assert.equal(decodeFindMyShare("not a payload"), null);
});

// ---------- location requests (live testing, Nov 14) ----------

test("location request: error 7 means delivered or already pending, other errors and no answer do not", async () => {
  const { helper, state, calls } = setup();
  const ask = async (answer: any) => {
    state.answer = (c) => (c.cmd === "location-request" ? answer : { ok: true });
    return helper.requestLocation(OPTED_CHAT);
  };
  assert.equal(await ask({ ok: true, requested: "x", invite: "ok" }), true);
  assert.equal(await ask({ ok: true, requested: "x", invite: "completed with value 0" }), true);
  // delivered, even though the invite field says error
  assert.equal(await ask({ ok: true, requested: "x", invite: "error: The operation couldn’t be completed. (FMLSession.ErrorDomain error 7.)" }), true);
  // a second request while one is pending
  assert.equal(await ask({ ok: true, requested: "x", invite: "error: FMLSession.ErrorDomain error 7" }), true);
  // error 7 in a failed answer still counts
  assert.equal(await ask({ ok: false, error: "FMLSession.ErrorDomain error 7" }), true);
  // real failures
  assert.equal(await ask({ ok: true, requested: "x", invite: "error: FMLSession.ErrorDomain error 70" }), false);
  assert.equal(await ask({ ok: true, requested: "x", invite: "error: FMLSession.ErrorDomain error 3" }), false);
  assert.equal(await ask({ ok: true, requested: "x", invite: "no answer from Find My within 10s" }), false);
  assert.equal(await ask({ ok: false, error: "chat not allowed" }), false);
  assert.equal(await ask({ ok: true }), false);
  assert.equal(await ask(null), false);
  // every one of them asked for no bubble
  const requests = calls.filter((c) => c.cmd === "location-request");
  assert.equal(requests.length, 11);
  assert.ok(requests.every((c) => c.args?.bubble === false));
  assert.equal(locationRequestDelivered("error 7"), false); // only an answer object counts
});

test("location request: Find My is opened first, and the send lock is checked again after that wait", async () => {
  const { db, helper, client, calls } = setup({ answer: (c) => (c.cmd === "location-request" ? { ok: true, invite: "ok" } : { ok: true }) });
  const order: string[] = [];
  let duringRefresh: () => void = () => {};
  client.refreshFindMy = async () => {
    order.push("find my opened");
    duringRefresh();
  };
  const realRequest = client.request.bind(client);
  client.request = async (cmd, chatGuid, args, timeoutMs) => {
    order.push(cmd);
    return realRequest(cmd, chatGuid, args, timeoutMs);
  };
  assert.equal(await helper.requestLocation(OPTED_CHAT), true);
  assert.deepEqual(order, ["find my opened", "location-request"]);

  // a chat that isn't allowed never opens Find My
  order.length = 0;
  assert.equal(await helper.requestLocation(STRANGER_CHAT), false);
  assert.deepEqual(order, []);

  // the kill switch flips while Find My is opening: no request goes out
  duringRefresh = () => setSetting(db, "troy_enabled", "false");
  assert.equal(await helper.requestLocation(OPTED_CHAT), false);
  assert.deepEqual(order, ["find my opened"]);
  assert.equal(calls.filter((c) => c.cmd === "location-request").length, 1);

  // Find My failing to open doesn't stop the request
  setSetting(db, "troy_enabled", "true");
  duringRefresh = () => {
    throw new Error("open failed");
  };
  assert.equal(await helper.requestLocation(OPTED_CHAT), true);
});
