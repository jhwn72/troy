import { test } from "node:test";
import assert from "node:assert/strict";
import type { AdapterCapabilities, FlowHandler, IncomingEvent, Intent, MessagingAdapter } from "../src/types.ts";
import { openDb, getUserByHandle, getOrCreateUser, updateUser, setSetting, setFlowState } from "../src/db/index.ts";
import { createPipeline } from "../src/pipeline.ts";
import { registerFlow } from "../src/flows/index.ts";
import { TEMPLATES } from "../src/commands.ts";

const HANDLE = "+12135550111";
const CHAT = "chat-p";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Call = { method: string; chatId: string; text?: string; id?: string | null };

function fakeAdapter(caps: Partial<AdapterCapabilities> = {}) {
  const calls: Call[] = [];
  let n = 0;
  const adapter: MessagingAdapter = {
    provider: "webchat",
    capabilities: () => ({ tapbacks: true, typing: true, readReceipts: true, edits: false, effects: true, polls: false, groupChats: false, contactCard: true, liveLocation: false, ...caps }),
    async sendMessage(chatId, text) {
      const id = `out-${++n}`;
      calls.push({ method: "sendMessage", chatId, text, id });
      return { messageId: id };
    },
    async sendImage() {
      return null;
    },
    async sendContactCard(chatId) {
      calls.push({ method: "sendContactCard", chatId });
      return { messageId: `out-${++n}` };
    },
    async markRead(chatId) {
      calls.push({ method: "markRead", chatId });
    },
    async startTyping(chatId) {
      calls.push({ method: "startTyping", chatId });
    },
    async stopTyping() {},
    async react(chatId, messageId, type) {
      calls.push({ method: "react", chatId, id: messageId, text: type });
      return true;
    },
    async editMessage() {
      return false;
    },
    async sendPoll(chatId, question, options) {
      calls.push({ method: "sendPoll", chatId, text: question });
      return { optionMessageIds: options.map((_, i) => `opt-${i}`), mode: "tap" };
    },
    async createGroupChat() {
      return null;
    },
    async getLiveLocation() {
      return null;
    },
    chatIdForHandle: (h) => `chat-${h}`,
  };
  const texts = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.text!);
  return { adapter, calls, texts };
}

function setup(opts: { caps?: Partial<AdapterCapabilities>; intent?: Intent; verified?: boolean; pause?: (ms: number) => Promise<void> } = {}) {
  const db = openDb(":memory:");
  const fake = fakeAdapter(opts.caps);
  const intent: Intent = opts.intent ?? { flow: "smalltalk", action: "chat", details: {}, source: "fallback" };
  const pipeline = createPipeline({ db, getAdapter: () => fake.adapter, pause: opts.pause ?? (async () => {}), ackAfterMs: 30, detectIntent: async () => intent });
  if (opts.verified) {
    const u = getOrCreateUser(db, HANDLE, CHAT);
    updateUser(db, u.id, { verifiedAt: Date.now(), verifiedVia: "judge_skip" });
  }
  let m = 0;
  const event = (over: Partial<IncomingEvent>): IncomingEvent => ({
    provider: "webchat",
    userHandle: HANDLE,
    chatId: CHAT,
    isGroup: false,
    messageId: `in-${++m}`,
    text: "",
    images: [],
    receivedAt: Date.now(),
    ...over,
  });
  const text = async (t: string) => {
    const before = fake.texts().length;
    await pipeline.handleEvent(event({ text: t }));
    return fake.texts().slice(before);
  };
  const user = () => getUserByHandle(db, HANDLE)!;
  return { db, fake, pipeline, event, text, user };
}

// Test flows live under names no real flow uses in this file's process.
let slowMs = 0;
const seen: { flow: string; action: string; text: string; reaction: boolean }[] = [];
const recorder = (name: FlowHandler["name"]): FlowHandler => ({
  name,
  async handle(ctx) {
    seen.push({ flow: name, action: ctx.intent.action, text: ctx.event.text, reaction: !!ctx.event.reaction });
    if (ctx.event.reaction) return;
    if (slowMs) await sleep(slowMs);
    await ctx.say(`${name} reply`);
  },
});
registerFlow(recorder("repair"));
registerFlow(recorder("food"));

test("STOP, then a normal text gets nothing, then START", async () => {
  const t = setup({ verified: true });
  assert.deepEqual(await t.text("STOP"), TEMPLATES.stop);
  assert.equal(t.user().stopped, true);
  assert.deepEqual(await t.text("hey whats up"), []);
  assert.deepEqual(await t.text("help"), []);
  assert.deepEqual(await t.text("START"), TEMPLATES.start);
  assert.equal(t.user().stopped, false);
  assert.ok((await t.text("hey whats up")).length > 0);
});

test("emergency text from an unverified user still gets the emergency reply", async () => {
  const t = setup();
  const reply = await t.text("there's a fire in my dorm");
  assert.deepEqual(reply, TEMPLATES.emergency);
  assert.equal(t.fake.calls.filter((c) => c.method === "sendContactCard").length, 0);
});

test("every message is saved and marked read; replies are saved with provider ids", async () => {
  const t = setup({ verified: true });
  await t.text("help");
  const rows = t.db.prepare("SELECT direction, providerMessageId, text FROM messages ORDER BY id").all() as { direction: string; providerMessageId: string; text: string }[];
  assert.deepEqual({ ...rows[0] }, { direction: "in", providerMessageId: "in-1", text: "help" });
  assert.equal(rows.filter((r) => r.direction === "out").length, TEMPLATES.help.length);
  assert.ok(rows.filter((r) => r.direction === "out").every((r) => r.providerMessageId.startsWith("out-")));
  assert.equal(t.fake.calls.filter((c) => c.method === "markRead").length, 1);
});

test("pause, resume, settings, human", async () => {
  const t = setup({ verified: true });
  assert.deepEqual(await t.text("pause"), TEMPLATES.pause);
  assert.equal(t.user().paused, true);
  assert.match((await t.text("settings"))[0], /paused/);
  assert.deepEqual(await t.text("resume"), TEMPLATES.resume);
  assert.equal(t.user().paused, false);
  assert.deepEqual(await t.text("human"), TEMPLATES.human);
});

test("delete my data wipes messages and the profile", async () => {
  const t = setup({ verified: true });
  await t.text("help");
  assert.deepEqual(await t.text("delete my data"), TEMPLATES.deleteData);
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 0);
  assert.equal(t.user().verifiedAt, null);
});

test("a fast handler gets no acknowledgement", async () => {
  slowMs = 0;
  const t = setup({ verified: true, intent: { flow: "repair", action: "report", details: {}, source: "ai" } });
  assert.deepEqual(await t.text("the light in taper is broken"), ["repair reply"]);
  await sleep(60);
  assert.equal(t.fake.calls.filter((c) => c.method === "react").length, 0);
  assert.equal(t.fake.texts().length, 1);
});

test("a slow handler gets exactly one acknowledgement: a like tapback", async () => {
  slowMs = 120;
  const t = setup({ verified: true, intent: { flow: "repair", action: "report", details: {}, source: "ai" } });
  assert.deepEqual(await t.text("the light in taper is broken"), ["repair reply"]);
  await sleep(60);
  const reacts = t.fake.calls.filter((c) => c.method === "react");
  assert.equal(reacts.length, 1);
  assert.equal(reacts[0].text, "like");
  assert.equal(reacts[0].id, "in-1");
  slowMs = 0;
});

test("without tapbacks a slow handler gets exactly one short line", async () => {
  slowMs = 120;
  const t = setup({ verified: true, caps: { tapbacks: false }, intent: { flow: "repair", action: "report", details: {}, source: "ai" } });
  const reply = await t.text("the light in taper is broken");
  await sleep(60);
  assert.equal(reply.length, 2);
  assert.ok(TEMPLATES.acks.includes(reply[0]));
  assert.equal(reply[1], "repair reply");
  assert.equal(t.fake.calls.filter((c) => c.method === "react").length, 0);
  slowMs = 0;
});

test("an intent for a flow that isn't registered falls back to smalltalk", async () => {
  const t = setup({ verified: true, intent: { flow: "rides", action: "find", details: {}, source: "ai" } });
  const reply = await t.text("find me a ride to lax");
  assert.ok(reply.length >= 1 && reply.length <= 2);
});

test("the open flow keeps the conversation unless the model clearly starts another", async () => {
  seen.length = 0;
  const keep = setup({ verified: true, intent: { flow: "food", action: "post", details: {}, source: "fallback" } });
  setFlowState(keep.db, keep.user().id, { flow: "repair", step: "where", data: {} });
  assert.deepEqual(await keep.text("by the food court"), ["repair reply"]);

  const sw = setup({ verified: true, intent: { flow: "food", action: "post", details: {}, source: "ai" } });
  setFlowState(sw.db, sw.user().id, { flow: "repair", step: "where", data: {} });
  assert.deepEqual(await sw.text("3 free pizzas at leavey"), ["food reply"]);
});

test("two fast texts from one user are handled in order, not interleaved", async () => {
  slowMs = 40;
  seen.length = 0;
  const t = setup({ verified: true, intent: { flow: "repair", action: "report", details: {}, source: "ai" } });
  await Promise.all([t.pipeline.handleEvent(t.event({ text: "first" })), t.pipeline.handleEvent(t.event({ text: "second" }))]);
  assert.deepEqual(seen.map((s) => s.text), ["first", "second"]);
  const order = t.fake.calls.filter((c) => c.method === "sendMessage" || c.method === "markRead").map((c) => c.method);
  assert.deepEqual(order, ["markRead", "sendMessage", "markRead", "sendMessage"]);
  slowMs = 0;
});

test("a tapback on one of Troy's messages goes to the open flow, else food; unknown targets are ignored", async () => {
  const t = setup({ verified: true, intent: { flow: "repair", action: "report", details: {}, source: "ai" } });
  await t.text("light is out"); // Troy's reply is out-1
  seen.length = 0;
  await t.pipeline.handleEvent(t.event({ reaction: { targetMessageId: "out-1", type: "like", removed: false } }));
  assert.deepEqual(seen.map((s) => [s.flow, s.reaction]), [["food", true]]);

  setFlowState(t.db, t.user().id, { flow: "repair", step: "x", data: {} });
  await t.pipeline.handleEvent(t.event({ reaction: { targetMessageId: "out-1", type: "like", removed: false } }));
  assert.equal(seen[1].flow, "repair");

  await t.pipeline.handleEvent(t.event({ reaction: { targetMessageId: "someone-elses-message", type: "like", removed: false } }));
  assert.equal(seen.length, 2);
  // Tapbacks are not saved as messages and get no read receipt of their own.
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in'").get() as { n: number }).n, 1);
});

test("kill switch: nothing is saved or sent", async () => {
  const t = setup({ verified: true });
  setSetting(t.db, "troy_enabled", "false");
  assert.deepEqual(await t.text("help"), []);
  assert.equal(t.fake.calls.length, 0);
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 0);
});

test("a handler that throws doesn't break the next message", async () => {
  registerFlow({
    name: "usg",
    async handle() {
      throw new Error("boom");
    },
  });
  const t = setup({ verified: true, intent: { flow: "usg", action: "ask", details: {}, source: "ai" } });
  const err = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await t.text("who do i talk to"), []);
  } finally {
    console.error = err;
  }
  assert.deepEqual(await t.text("help"), TEMPLATES.help);
});

// ---------- review fixes ----------

test("STOP sent while Troy is mid-reply drops the rest of that reply", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  let pauses = 0;
  // The first pause (before the second welcome bubble) blocks until the test lets go.
  const t = setup({ pause: async () => void (pauses++ === 0 && (await held)) });
  const first = t.pipeline.handleEvent(t.event({ text: "hey troy" }));
  await sleep(20);
  assert.deepEqual(t.fake.texts(), [TEMPLATES.welcome[0]]);
  const stop = t.pipeline.handleEvent(t.event({ text: "STOP" }));
  // Applied the moment it arrives, before its turn in the queue.
  assert.equal(t.user().stopped, true);
  release();
  await Promise.all([first, stop]);
  assert.deepEqual(t.fake.texts(), [TEMPLATES.welcome[0], ...TEMPLATES.stop]);
  assert.equal(t.fake.calls.filter((c) => c.method === "sendContactCard" || c.method === "sendPoll").length, 0);
  assert.equal(t.user().stopped, true);
  // A second STOP gets no second confirmation.
  assert.deepEqual(await t.text("stop"), []);
});

test("a stopped user's texts are not saved, marked read or answered", async () => {
  const t = setup({ verified: true });
  await t.text("STOP");
  const saved = () => (t.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'in'").get() as { n: number }).n;
  const before = { saved: saved(), read: t.fake.calls.filter((c) => c.method === "markRead").length };
  assert.deepEqual(await t.text("what can u do"), []);
  assert.equal(saved(), before.saved);
  assert.equal(t.fake.calls.filter((c) => c.method === "markRead").length, before.read);
});

test("a stopped user who texts an emergency or a crisis still gets the fixed reply", async () => {
  const t = setup({ verified: true });
  await t.text("stop");
  assert.deepEqual(await t.text("there's a fire in my dorm"), TEMPLATES.emergency);
  assert.deepEqual(await t.text("i want to kill myself"), TEMPLATES.crisis);
  assert.equal(t.user().stopped, true);
  assert.deepEqual(await t.text("hey whats up"), []);
});

test("crisis text gets the 988 reply for anyone, verified or not", async () => {
  assert.deepEqual(await setup().text("i want to kill myself"), TEMPLATES.crisis);
  assert.deepEqual(await setup({ verified: true }).text("im suicidal"), TEMPLATES.crisis);
});

test("separate sends in one turn are paced: typing and a pause before each one after the first", async () => {
  let pauses = 0;
  const t = setup({ pause: async () => void pauses++ });
  await t.text("hey troy");
  // welcome (3) + contact card + email ask (2): 6 items, so 5 gaps.
  assert.equal(pauses, 5);
  const order = t.fake.calls.filter((c) => c.method !== "markRead").map((c) => c.method);
  const card = order.indexOf("sendContactCard");
  assert.equal(order[card - 1], "startTyping");
  assert.equal(order[card + 1], "startTyping");
});

test("no key: a greeting gets a greeting, and a bare location pin gets a fixed line", async () => {
  const t = setup({ verified: true });
  const hi = await t.text("hi");
  assert.ok(hi.length >= 1 && !hi.join(" ").includes("not sure i got that"));
  const before = t.fake.texts().length;
  await t.pipeline.handleEvent(t.event({ text: "", location: { lat: 34.02, lng: -118.28 } }));
  assert.deepEqual(t.fake.texts().slice(before), ["got ur location. what do u need?"]);
});
