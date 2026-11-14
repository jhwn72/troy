// Relay mode: the helpers on their own, then through the real pipeline with two fake users.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingEvent, IncomingImage, MessagingAdapter } from "../src/types.ts";
import { openDb, getOrCreateUser, updateUser } from "../src/db/index.ts";
import { createPipeline } from "../src/pipeline.ts";
import { TEMPLATES } from "../src/commands.ts";
import { RELAY_COPY, RELAY_TTL_MS, activeRelayFor, endRelay, endRelayByContext, onRelayEnd, startRelay } from "../src/relay.ts";

function world(opts: { tapbacks?: boolean } = {}) {
  const db = openDb(":memory:");
  const sent: { chatId: string; text: string }[] = [];
  const images: { chatId: string; path: string; caption?: string }[] = [];
  const reacts: { chatId: string; id: string; type: string }[] = [];
  let intents = 0;
  let n = 0;
  const adapter: MessagingAdapter = {
    provider: "webchat",
    capabilities: () => ({ tapbacks: opts.tapbacks ?? true, typing: true, readReceipts: true, edits: false, effects: true, polls: false, groupChats: false, contactCard: true, liveLocation: false }),
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
      return { messageId: `out-${++n}` };
    },
    async sendImage(chatId, path, caption) {
      images.push({ chatId, path, caption });
      return { messageId: `out-${++n}` };
    },
    async sendContactCard() {
      return null;
    },
    async markRead() {},
    async startTyping() {},
    async stopTyping() {},
    async react(chatId, id, type) {
      reacts.push({ chatId, id, type });
      return true;
    },
    async editMessage() {
      return false;
    },
    async sendPoll(_c, _q, options) {
      return { optionMessageIds: options.map(() => null), mode: "numbered" };
    },
    async createGroupChat() {
      return null;
    },
    async getLiveLocation() {
      return null;
    },
    requestLocation: async () => false,
    chatIdForHandle: (h) => `chat-${h}`,
  };
  const pipeline = createPipeline({
    db,
    getAdapter: () => adapter,
    pause: async () => {},
    ackAfterMs: 60_000,
    detectIntent: async () => {
      intents++;
      return { flow: "smalltalk", action: "chat", details: {}, source: "fallback" };
    },
  });
  let m = 0;
  function person(handle: string) {
    const chatId = `chat-${handle}`;
    const u = getOrCreateUser(db, handle, chatId);
    updateUser(db, u.id, { verifiedAt: Date.now(), verifiedVia: "judge_skip" });
    const texts = () => sent.filter((s) => s.chatId === chatId).map((s) => s.text);
    const say = async (text: string, imgs: IncomingImage[] = []) => {
      const before = texts().length;
      const event: IncomingEvent = { provider: "webchat", userHandle: handle, chatId, isGroup: false, messageId: `in-${++m}`, text, images: imgs, receivedAt: Date.now() };
      await pipeline.handleEvent(event);
      return texts().slice(before);
    };
    return { id: u.id, handle, chatId, say, texts };
  }
  const a = person("+12135550201");
  const b = person("+12135550202");
  return { db, a, b, person, sent, images, reacts, intents: () => intents };
}

test("startRelay, activeRelayFor and endRelay", () => {
  const w = world();
  assert.equal(activeRelayFor(w.db, w.a.id), null);
  const id = startRelay(w.db, w.a.id, w.b.id, "lost_found:7");
  assert.deepEqual(activeRelayFor(w.db, w.a.id), { id, otherUserId: w.b.id, context: "lost_found:7" });
  assert.deepEqual(activeRelayFor(w.db, w.b.id), { id, otherUserId: w.a.id, context: "lost_found:7" });
  endRelay(w.db, id);
  assert.equal(activeRelayFor(w.db, w.a.id), null);
  assert.equal(activeRelayFor(w.db, w.b.id), null);

  startRelay(w.db, w.a.id, w.b.id, "rides:3");
  endRelayByContext(w.db, "rides:3");
  assert.equal(activeRelayFor(w.db, w.a.id), null);
});

test("a person is in one relay at a time: a new one closes the old one", () => {
  const w = world();
  const c = w.person("+12135550203");
  startRelay(w.db, w.a.id, w.b.id, "one");
  const second = startRelay(w.db, w.a.id, c.id, "two");
  assert.equal(activeRelayFor(w.db, w.a.id)?.id, second);
  assert.equal(activeRelayFor(w.db, w.b.id), null);
  assert.equal(activeRelayFor(w.db, c.id)?.otherUserId, w.a.id);
});

test("relays expire after 24 hours", () => {
  const w = world();
  const id = startRelay(w.db, w.a.id, w.b.id, "x");
  const start = (w.db.prepare("SELECT createdAt FROM relays WHERE id = ?").get(id) as { createdAt: number }).createdAt;
  assert.ok(activeRelayFor(w.db, w.a.id, start + RELAY_TTL_MS - 1000));
  assert.equal(activeRelayFor(w.db, w.a.id, start + RELAY_TTL_MS + 1), null);
  // Expiry is recorded, so it stays closed.
  assert.equal((w.db.prepare("SELECT status FROM relays WHERE id = ?").get(id) as { status: string }).status, "ended");
  assert.equal(activeRelayFor(w.db, w.b.id), null);
});

test("an expired relay no longer catches messages in the pipeline", async () => {
  const w = world();
  const id = startRelay(w.db, w.a.id, w.b.id, "x");
  w.db.prepare("UPDATE relays SET createdAt = ? WHERE id = ?").run(Date.now() - RELAY_TTL_MS - 1000, id);
  await w.a.say("u there?");
  assert.equal(w.b.texts().length, 0);
  assert.equal(w.intents(), 1);
});

test("texts are forwarded with a role label, before intent detection, and never with a name or number", async () => {
  const w = world();
  startRelay(w.db, w.a.id, w.b.id, "lost_found:1", { a: "the finder", b: "the owner" });
  assert.deepEqual(await w.a.say("I'm outside Leavey, red jacket"), []);
  assert.deepEqual(w.b.texts(), ["from the finder: I'm outside Leavey, red jacket"]);
  await w.b.say("omw");
  assert.deepEqual(w.a.texts(), ["from the owner: omw"]);
  assert.equal(w.intents(), 0, "relay runs before intent detection");
  // The sender gets a thumbs up on their own message instead of a reply.
  assert.deepEqual(w.reacts.map((r) => [r.chatId, r.type]), [[w.a.chatId, "like"], [w.b.chatId, "like"]]);
  for (const s of w.sent) assert.ok(!s.text.includes("+1213"));
});

test("labels that look like contact info are replaced, and the default is neutral", async () => {
  const w = world({ tapbacks: false });
  startRelay(w.db, w.a.id, w.b.id, "x", { a: "+12135550201", b: "sam@usc.edu" });
  assert.deepEqual(await w.a.say("hi"), [RELAY_COPY.passed]);
  await w.b.say("hey");
  assert.deepEqual(w.b.texts(), ["from the other person: hi", RELAY_COPY.passed]);
  assert.deepEqual(w.a.texts(), [RELAY_COPY.passed, "from the other person: hey"]);
});

test("photos are forwarded too", async () => {
  const w = world();
  startRelay(w.db, w.a.id, w.b.id, "x", { a: "the finder", b: "the owner" });
  const img: IncomingImage = { path: "/tmp/troy-test/spot.jpg", mime: "image/jpeg" };
  await w.a.say("", [img]);
  assert.deepEqual(w.images, [{ chatId: w.b.chatId, path: img.path, caption: "from the finder:" }]);
  await w.a.say("this bench", [img]);
  assert.deepEqual(w.b.texts(), ["from the finder: this bench"]);
  assert.equal(w.images.length, 2);
  assert.equal(w.images[1]!.caption, undefined);
});

test("done closes it for both, and later texts go back to normal handling", async () => {
  const w = world();
  const ended: number[] = [];
  onRelayEnd("relaytest:", async (_ctx, relay) => void ended.push(relay.endedBy));
  startRelay(w.db, w.a.id, w.b.id, "relaytest:9");
  assert.deepEqual(await w.b.say("Done"), [RELAY_COPY.ended]);
  assert.deepEqual(w.a.texts(), [RELAY_COPY.endedOther]);
  assert.equal(activeRelayFor(w.db, w.a.id), null);
  assert.deepEqual(ended, [w.b.id]);

  const before = w.b.texts().length;
  await w.a.say("thanks troy");
  assert.equal(w.b.texts().length, before, "nothing is forwarded once it's closed");
  assert.equal(w.intents(), 1);
});

test("end also closes it, but a sentence with done in it is just a message", async () => {
  const w = world();
  startRelay(w.db, w.a.id, w.b.id, "x");
  await w.a.say("i'm done with class at 3");
  assert.deepEqual(w.b.texts(), ["from the other person: i'm done with class at 3"]);
  assert.ok(activeRelayFor(w.db, w.a.id));
  await w.a.say("end");
  assert.equal(activeRelayFor(w.db, w.a.id), null);
});

test("STOP still works inside a relay and nothing more reaches the stopped person", async () => {
  const w = world();
  startRelay(w.db, w.a.id, w.b.id, "x");
  assert.deepEqual(await w.b.say("STOP"), TEMPLATES.stop);
  assert.equal(w.a.texts().length, 0, "STOP is a command, not a relayed message");
  const before = w.b.texts().length;
  assert.deepEqual(await w.a.say("hello?"), [RELAY_COPY.undelivered]);
  assert.equal(w.b.texts().length, before);
});

test("quiet hours hold: an undelivered message tells the sender", async () => {
  const w = world();
  updateUser(w.db, w.b.id, { quietHours: JSON.stringify({ start: "00:00", end: "23:59" }) });
  startRelay(w.db, w.a.id, w.b.id, "x");
  const img: IncomingImage = { path: "/tmp/troy-test/spot.jpg", mime: "image/jpeg" };
  assert.deepEqual(await w.a.say("u up?", [img]), [RELAY_COPY.undelivered]);
  assert.equal(w.b.texts().length, 0);
  assert.equal(w.images.length, 0);
});
