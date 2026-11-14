import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, setSetting } from "../src/db/index.ts";
import { createWebchatAdapter } from "../src/adapters/webchat.ts";
import type { IncomingEvent } from "../src/types.ts";

const A = "+12135550101";
const B = "+12135550102";
const chat = (h: string) => `webchat;-;${h}`;

function setup() {
  const db = openDb(":memory:");
  const events: IncomingEvent[] = [];
  const { adapter, routes } = createWebchatAdapter({ db, onEvent: async (e) => void events.push(e) });
  const post = async (path: string, body: unknown) => {
    const res = await routes.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json()) as Record<string, unknown>;
  };
  return { db, events, adapter, routes, post };
}

test("first message 'hey troy' passes, and so do later messages", async () => {
  const { events, adapter, post } = setup();
  const first = await post("/webchat/send", { handle: "(213) 555-0101", text: "Hey Troy!" });
  assert.equal(first.accepted, true);
  const second = await post("/webchat/send", { handle: A, text: "i lost my keys" });
  assert.equal(second.accepted, true);
  assert.deepEqual(events.map((e) => e.text), ["Hey Troy!", "i lost my keys"]);
  assert.equal(events[0].userHandle, A);
  assert.equal(events[0].chatId, chat(A));
  assert.equal(events[0].isGroup, false);
  assert.equal(events[0].provider, "webchat");

  const sent = await adapter.sendMessage(chat(A), "hi, i'm troy", { effect: "confetti" });
  assert.ok(sent?.messageId);
  const kinds = adapter.transcript(chat(A)).map((e) => `${e.from === "troy" ? "troy" : "student"}:${e.kind}`);
  assert.deepEqual(kinds, ["student:message", "student:message", "troy:message"]);
});

test("first message 'hello' is dropped and nothing is kept", async () => {
  const { events, adapter, post } = setup();
  const res = await post("/webchat/send", { handle: A, text: "hello" });
  assert.equal(res.accepted, false);
  assert.equal(events.length, 0);
  assert.equal(adapter.transcript(chat(A)).length, 0);
});

test("a phone flagged as having old history cannot opt in with 'hey troy'", async () => {
  const { events, post } = setup();
  await post("/webchat/history", { handle: A, hasOldHistory: true });
  const res = await post("/webchat/send", { handle: A, text: "hey troy" });
  assert.equal(res.accepted, false);
  assert.equal(events.length, 0);
});

test("sends to a chat that is not allowed are refused and leave no transcript entry", async () => {
  const { adapter, post } = setup();
  await post("/webchat/send", { handle: A, text: "hey troy" });
  const id = chat(B);
  assert.equal(await adapter.sendMessage(id, "hi"), null);
  assert.equal(await adapter.sendImage(id, "/nope.jpg"), null);
  assert.equal(await adapter.sendContactCard(id), null);
  assert.equal(await adapter.react(id, "x", "love"), false);
  assert.equal(await adapter.editMessage(id, "x", "y"), false);
  await adapter.markRead(id);
  await adapter.startTyping(id);
  await adapter.stopTyping(id);
  const poll = await adapter.sendPoll(id, "which one?", ["a", "b"]);
  assert.deepEqual(poll.optionMessageIds, [null, null]);
  assert.equal(await adapter.createGroupChat([A, B], "hi both"), null);
  assert.equal(adapter.transcript(id).length, 0);
});

test("kill switch off refuses everything, in and out", async () => {
  const { db, events, adapter, post } = setup();
  await post("/webchat/send", { handle: A, text: "hey troy" });
  await post("/webchat/location", { handle: A, lat: 34.02, lng: -118.28 });
  const before = adapter.transcript(chat(A)).length;
  setSetting(db, "troy_enabled", "false");

  assert.equal((await post("/webchat/send", { handle: A, text: "still there?" })).accepted, false);
  assert.equal((await post("/webchat/send", { handle: B, text: "hey troy" })).accepted, false);
  assert.equal(events.length, 1);
  assert.equal(await adapter.sendMessage(chat(A), "hi"), null);
  await adapter.startTyping(chat(A));
  await adapter.markRead(chat(A));
  assert.equal(await adapter.getLiveLocation(A), null);
  assert.equal(adapter.transcript(chat(A)).length, before);

  setSetting(db, "troy_enabled", "true");
  assert.ok(await adapter.sendMessage(chat(A), "back"));
});

test("tapbacks, edits, live location and the transcript route", async () => {
  const { events, adapter, routes, post } = setup();
  await post("/webchat/send", { handle: A, text: "hey troy" });
  assert.equal(adapter.capabilities().liveLocation, false);
  await post("/webchat/location", { handle: A, lat: 34.02, lng: -118.28 });
  assert.equal(adapter.capabilities().liveLocation, true);
  assert.equal((await adapter.getLiveLocation(A))?.lat, 34.02);

  const sent = await adapter.sendMessage(chat(A), "frist");
  assert.equal(await adapter.editMessage(chat(A), sent!.messageId!, "first"), true);
  const res = await post("/webchat/react", { handle: A, messageId: sent!.messageId, type: "love" });
  assert.equal(res.accepted, true);
  assert.deepEqual(events.at(-1)?.reaction, { targetMessageId: sent!.messageId, type: "love", removed: false });

  const all = (await (await routes.request(`/webchat/transcript?handle=${encodeURIComponent(A)}&since=0`)).json()) as { cursor: number; entries: { kind: string; text?: string }[] };
  assert.deepEqual(all.entries.map((e) => e.kind), ["message", "message", "edit", "tapback"]);
  assert.equal(all.entries[1].text, "first");
  const later = (await (await routes.request(`/webchat/transcript?handle=${encodeURIComponent(A)}&since=${all.cursor}`)).json()) as { entries: unknown[] };
  assert.equal(later.entries.length, 0);
});

test("a group Troy creates is visible to every member and allowed", async () => {
  const { db, events, adapter, routes, post } = setup();
  await post("/webchat/send", { handle: A, text: "hey troy" });
  await post("/webchat/send", { handle: B, text: "hey troy" });
  const groupId = await adapter.createGroupChat([A, B], "found ur keys, meet here");
  assert.ok(groupId?.startsWith("webchat;+;"));
  assert.ok(db.prepare("SELECT 1 FROM allow_list WHERE chatId = ? AND reason = 'troy_group'").get(groupId!));

  for (const h of [A, B]) {
    const t = (await (await routes.request(`/webchat/transcript?handle=${encodeURIComponent(h)}`)).json()) as { entries: { chatId: string }[] };
    assert.ok(t.entries.some((e) => e.chatId === groupId));
  }
  const res = await post("/webchat/send", { handle: B, chatId: groupId, text: "omw" });
  assert.equal(res.accepted, true);
  assert.equal(events.at(-1)?.isGroup, true);
  // Someone who isn't in the group can't post into it.
  const out = await routes.request("/webchat/send", { method: "POST", body: JSON.stringify({ handle: "+12135550103", chatId: groupId, text: "hi" }) });
  assert.equal(out.status, 400);
});

test("the transcript says whether the phone is verified (the page hides the judge button then)", async () => {
  const { db, routes, post } = setup();
  await post("/webchat/send", { handle: A, text: "hey troy" });
  const get = async () => ((await (await routes.request(`/webchat/transcript?handle=${encodeURIComponent(A)}`)).json()) as { phone: { verified: boolean } }).phone.verified;
  assert.equal(await get(), false);
  db.prepare("INSERT INTO users (handle, chatId, verifiedAt, verifiedVia, createdAt) VALUES (?, ?, ?, 'judge_skip', ?)").run(A, chat(A), Date.now(), Date.now());
  assert.equal(await get(), true);
});
