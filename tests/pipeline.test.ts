import { test } from "node:test";
import assert from "node:assert/strict";
import type { AdapterCapabilities, Bubble, FlowHandler, IncomingEvent, Intent, MessagingAdapter, TapbackType } from "../src/types.ts";
import { openDb, getUserByHandle, getOrCreateUser, updateUser, setSetting, setFlowState } from "../src/db/index.ts";
import { chunkBubble, createPipeline, JUDGE_PACE, TIMING, typingMs } from "../src/pipeline.ts";
import { noteTourFinished, plainTone } from "../src/judge.ts";
import { toPlain } from "../src/voice.ts";
import { markMove } from "../src/firstten.ts";
import type { LocationStore, SafetyReader } from "../src/pipeline.ts";
import { COMMAND_POOLS } from "../src/commands.ts";
import { FALLBACK_POOLS } from "../src/flows/smalltalk.ts";
import { getFlowState } from "../src/db/index.ts";
import * as brain from "../src/brain.ts";
import * as topics from "../src/topics.ts";
import { getFlow, registerFlow } from "../src/flows/index.ts";
import { TEMPLATES } from "../src/commands.ts";
import { REFERENCE_LINES } from "../src/onboarding.ts";

const HANDLE = "+12135550111";
const CHAT = "chat-p";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Call = { method: string; chatId: string; text?: string; id?: string | null; ms?: number };

function fakeAdapter(caps: Partial<AdapterCapabilities> = {}, calls: Call[] = []) {
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
    async requestLocation(chatId) {
      calls.push({ method: "requestLocation", chatId });
      return false;
    },
    async onAllowed(chatId) {
      calls.push({ method: "onAllowed", chatId });
    },
    async onDisallowed(chatId) {
      calls.push({ method: "onDisallowed", chatId });
    },
    chatIdForHandle: (h) => `chat-${h}`,
  };
  const texts = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.text!);
  return { adapter, calls, texts };
}

type Detect = (input: { text: string }) => Intent;

function setup(
  opts: { caps?: Partial<AdapterCapabilities>; intent?: Intent; verified?: boolean; judge?: boolean; pause?: (ms: number) => Promise<void>; random?: () => number; detect?: Detect; readSafety?: SafetyReader | null } = {},
) {
  const db = openDb(":memory:");
  const fake = fakeAdapter(opts.caps);
  const intent: Intent = opts.intent ?? { flow: "smalltalk", action: "chat", details: {}, source: "fallback" };
  // Stands in for src/location.ts: records what the pipeline saves and forgets.
  const saved = new Map<number, { lat: number; lng: number; source: string }>();
  const forgot: number[] = [];
  const location: LocationStore = {
    saveUserLocation: (_db, userId, loc, source) => void saved.set(userId, { ...loc, source }),
    forgetUserLocation: (_db, userId) => {
      saved.delete(userId);
      forgot.push(userId);
    },
  };
  // Every wait is instant and recorded in the same list as the adapter calls, so order can be asserted.
  const pause = opts.pause ?? (async (ms: number) => void fake.calls.push({ method: "wait", chatId: CHAT, ms }));
  const pipeline = createPipeline({ db, getAdapter: () => fake.adapter, pause, random: opts.random, location, ackAfterMs: 30, detectIntent: async (i) => (opts.detect ? opts.detect(i) : intent), readSafety: opts.readSafety });
  // `verified` is a student. `judge` took the hackathon skip, which changes pacing and adds judge mode.
  if (opts.verified || opts.judge) {
    const u = getOrCreateUser(db, HANDLE, CHAT);
    updateUser(db, u.id, { verifiedAt: Date.now(), verifiedVia: opts.judge ? "judge_skip" : "usc_email" });
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
  /** A tapback on the bubble of Troy's with exactly this text (the latest one). */
  const tap = async (onText: string, type: TapbackType) => {
    const target = [...fake.calls].reverse().find((c) => c.method === "sendMessage" && c.text === onText);
    assert.ok(target?.id, `no bubble "${onText}"`);
    const before = fake.texts().length;
    await pipeline.handleEvent(event({ reaction: { targetMessageId: target.id!, type, removed: false } }));
    return fake.texts().slice(before);
  };
  return { db, fake, pipeline, event, text, tap, user, saved, forgot };
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
  // Pauses: read beat, typing for bubble 1, gap, then typing for bubble 2, which blocks until the test lets go.
  const t = setup({ pause: async () => void (pauses++ === 3 && (await held)) });
  const first = t.pipeline.handleEvent(t.event({ text: "hey troy" }));
  await sleep(20);
  // The opener is one of the welcome's versions (it rotates per person).
  const opener = t.fake.texts()[0]!;
  assert.ok(REFERENCE_LINES.welcome.some((v) => v[0] === opener), opener);
  assert.equal(t.fake.texts().length, 1);
  const stop = t.pipeline.handleEvent(t.event({ text: "STOP" }));
  // Applied the moment it arrives, before its turn in the queue.
  assert.equal(t.user().stopped, true);
  release();
  await Promise.all([first, stop]);
  assert.deepEqual(t.fake.texts(), [opener, ...TEMPLATES.stop]);
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

test("separate sends in one turn are paced: a gap, then typing, before each one after the first", async () => {
  const t = setup();
  await t.text("hey troy");
  const order = t.fake.calls.map((c) => c.method);
  // welcome (4) + save my contact + contact card + the student-or-judge poll + its one tap hint (this fake's polls
  // are tap mode, and the provider adds no instruction of its own): 8 items.
  // One read beat, one typing wait per item, one gap between items. (Onboarding's own beat after the card is 0 under test.)
  assert.equal(order.filter((m) => m === "wait").length, 1 + 8 + 7);
  const card = order.indexOf("sendContactCard");
  assert.deepEqual(order.slice(card - 4, card + 1), ["sendMessage", "wait", "startTyping", "wait", "sendContactCard"]);
  assert.equal(t.fake.texts()[4], "save my contact if u haven't so u know it's me");
  const poll = order.indexOf("sendPoll");
  assert.deepEqual(order.slice(poll - 3, poll), ["wait", "startTyping", "wait"]);
  assert.equal(order.filter((m) => m === "onAllowed").length, 1);
});

test("no key: a greeting gets a greeting", async () => {
  const t = setup({ verified: true });
  const hi = await t.text("hi");
  assert.ok(hi.length >= 1 && !hi.join(" ").includes("not sure i got that"));
});

// ---------- texting feel (John, Nov 14 evening) ----------

test("read, then a beat, then typing, then the bubble; a gap before typing the next one", async () => {
  const t = setup({ verified: true });
  await t.text("help");
  const order = t.fake.calls.map((c) => c.method);
  assert.deepEqual(order, ["markRead", "wait", "startTyping", "wait", "sendMessage", "wait", "startTyping", "wait", "sendMessage", "wait", "startTyping", "wait", "sendMessage"]);
  const waits = t.fake.calls.filter((c) => c.method === "wait").map((c) => c.ms!);
  const within = (ms: number, [lo, hi]: readonly number[]) => ms >= lo && ms <= hi;
  // "Read" gets 0.8 to 1.4 seconds before any typing.
  assert.ok(within(waits[0], TIMING.readBeat), `read beat ${waits[0]}`);
  // TEMPLATES.help: a short bubble, then two long ones.
  assert.ok(TEMPLATES.help[0].length <= 80 && TEMPLATES.help[1].length > 80 && TEMPLATES.help[2].length > 80);
  assert.ok(within(waits[1], TIMING.typingShort), `short typing ${waits[1]}`);
  assert.ok(within(waits[2], TIMING.gap), `gap ${waits[2]}`);
  assert.ok(within(waits[3], TIMING.typingLong), `long typing ${waits[3]}`);
  assert.ok(within(waits[4], TIMING.gap));
  assert.ok(within(waits[5], TIMING.typingLong));
  assert.ok(waits.every((ms) => ms <= 4000));
});

test("a flow reply also waits for the read beat before typing", async () => {
  const t = setup({ verified: true, intent: { flow: "repair", action: "report", details: {}, source: "ai" } });
  await t.text("the light in taper is broken");
  const order = t.fake.calls.map((c) => c.method);
  assert.deepEqual(order.slice(0, 3), ["markRead", "wait", "startTyping"]);
  const send = order.indexOf("sendMessage");
  assert.deepEqual(order.slice(send - 2, send), ["startTyping", "wait"]);
  assert.equal(order.filter((m) => m === "sendMessage").length, 1);
});

test("typing time: 1 to 2 seconds up to 80 characters, 3 to 4 above, never more than 4", () => {
  assert.equal(typingMs("ok", 0), 1000);
  assert.equal(typingMs("ok", 1), 2000);
  assert.equal(typingMs("x".repeat(80), 1), 2000);
  assert.equal(typingMs("x".repeat(81), 0), 3000);
  assert.equal(typingMs("x".repeat(500), 1), 4000);
  assert.equal(typingMs("x".repeat(500), 7), 4000);
  // The whole welcome, card included, at the slowest: under half a minute; on average about 15 seconds.
  const worst = TIMING.readBeat[1] + TEMPLATES.welcome.concat(TEMPLATES.saveContact).reduce((n, b) => n + typingMs(b, 1) + TIMING.gap[1], 0) + TIMING.attachment[1];
  assert.ok(worst < 25_000, String(worst));
});

test("an emergency reply's first bubble goes out at once, with no read beat or typing before it", async () => {
  const t = setup({ verified: true });
  await t.text("there's a fire in my dorm");
  const order = t.fake.calls.map((c) => c.method);
  const first = order.indexOf("sendMessage");
  assert.ok(!order.slice(0, first).includes("startTyping"));
  assert.deepEqual(t.fake.texts(), TEMPLATES.emergency);
});

// ---------- chunking ----------

const USG_FUNDING =
  "apps are due wednesdays by 11:59pm, six academic weeks before the event (or nine before the first payment is due, whichever comes first), and an rso can get up to 4 events funded a semester as long as it stays under $8,000 from usg a year.";
const DEMO_NOTE = "demo note: it's logged on troy's staff dashboard for fms. the link into their real work order system is mocked, so nothing was filed there";

test("chunking: bubbles that fit are left alone (real lines from the flow transcripts)", () => {
  for (const b of [DEMO_NOTE, "ur pickup code is M4WKYM", TEMPLATES.welcome[2], ...TEMPLATES.help]) assert.deepEqual(chunkBubble(b), [b]);
});

test("chunking: one long sentence splits at a clause boundary, not into fragments", () => {
  assert.ok(USG_FUNDING.length > 160);
  assert.deepEqual(chunkBubble(USG_FUNDING), [
    "apps are due wednesdays by 11:59pm, six academic weeks before the event (or nine before the first payment is due, whichever comes first)",
    "and an rso can get up to 4 events funded a semester as long as it stays under $8,000 from usg a year.",
  ]);
});

test("chunking: several sentences split at sentence ends, and nothing is reworded", () => {
  const long =
    "recognized student orgs and usc undergrads can apply for usg funding on engagesc. the senate was looking at changing the deadline rules in oct 2026, so double check the page before u plan around them. u can find the form at https://usg.usc.edu/branches/funding/?from=troy&x=1 or email usgfunding@usc.edu.";
  const parts = chunkBubble(long);
  assert.deepEqual(parts, [
    "recognized student orgs and usc undergrads can apply for usg funding on engagesc.",
    "the senate was looking at changing the deadline rules in oct 2026, so double check the page before u plan around them.",
    "u can find the form at https://usg.usc.edu/branches/funding/?from=troy&x=1 or email usgfunding@usc.edu.",
  ]);
  assert.equal(parts.join(" "), long);
  assert.ok(parts.every((p) => p.length <= 160));
});

test("chunking: never inside a link, an email, a phone number or a pickup code, and never mid-word", () => {
  const filler = "the front desk at the dps office on mcclintock holds found items for thirty days and they are open every day";
  const cases: [string, string][] = [
    [`${filler} so when u get there tell them it's for pickup code M4WKYM and bring ur usc id with u`, "pickup code M4WKYM"],
    [`${filler} and if nobody is there just call the non-emergency line at 213 740 6000 and ask for lost and found`, "213 740 6000"],
    [`${filler} and if u need a person the number on their page is +1 (213) 740-6000 which is the non-emergency line`, "+1 (213) 740-6000"],
    [`${filler} or fill out the form here https://dps.usc.edu/services/lost-and-found/report?item=wallet&where=leavey%20library&when=today so they have it on file`, "https://dps.usc.edu/services/lost-and-found/report?item=wallet&where=leavey%20library&when=today"],
    [`${filler} or just send a quick note to lostandfound.universitypark@usc.edu with what it looks like and where u left it`, "lostandfound.universitypark@usc.edu"],
  ];
  for (const [text, whole] of cases) {
    for (let max = 60; max <= 170; max += 7) {
      const parts = chunkBubble(text, max);
      assert.equal(parts.join(" "), text, `nothing lost at ${max}`);
      assert.ok(parts.some((p) => p.includes(whole)), `${whole} kept whole at ${max}: ${JSON.stringify(parts)}`);
      const words = new Set(text.split(" "));
      assert.ok(parts.every((p) => p.split(" ").every((w) => words.has(w))), `no word cut at ${max}`);
    }
  }
  // A link longer than a bubble stays in one piece.
  const url = "https://example.usc.edu/" + "a".repeat(200);
  assert.ok(chunkBubble(`here u go ${url} hope that helps`).some((p) => p.includes(url)));
});

test("chunking: a short option list is one bubble per item; longer lines stay together as far as they fit", () => {
  const options = Array.from({ length: 9 }, (_, i) => `${i + 1}. option number ${i + 1} at leavey`).join("\n");
  assert.ok(options.length > 160);
  assert.equal(chunkBubble(options).length, 9);
  const para = [USG_FUNDING.slice(0, 137), "second line that is fairly long too, long enough that it is not an option in a list at all", "third"].join("\n");
  const parts = chunkBubble(para);
  assert.equal(parts.length, 2);
  assert.ok(parts[1].includes("\n"));
});

test("a long reply from a flow goes out as several bubbles, and say() still returns one id per bubble", async () => {
  let ids: (string | null)[] = [];
  registerFlow({
    name: "notes",
    async handle(ctx) {
      ids = await ctx.say("short one", USG_FUNDING);
    },
  });
  const t = setup({ verified: true, intent: { flow: "notes", action: "x", details: {}, source: "ai" } });
  const reply = await t.text("how does funding work");
  assert.deepEqual(reply, ["short one", ...chunkBubble(USG_FUNDING)]);
  assert.equal(reply.length, 3);
  // One id per bubble passed in; a split bubble reports its last piece.
  assert.deepEqual(ids, ["out-1", "out-3"]);
  const out = t.db.prepare("SELECT text FROM messages WHERE direction = 'out' ORDER BY id").all() as { text: string }[];
  assert.equal(out.length, 3);
});

// ---------- location is kept ----------

test("a bare location share is saved and gets one fixed line, with no intent call", async () => {
  let asked = 0;
  const t = setup({ verified: true });
  const db = t.db;
  const pipeline = createPipeline({
    db,
    getAdapter: () => t.fake.adapter,
    pause: async () => {},
    location: { saveUserLocation: (_d, id, loc, source) => void t.saved.set(id, { ...loc, source }), forgetUserLocation: () => {} },
    detectIntent: async () => {
      asked++;
      return { flow: "smalltalk", action: "chat", details: {}, source: "fallback" };
    },
  });
  await pipeline.handleEvent(t.event({ text: "", location: { lat: 34.0205, lng: -118.2856 } }));
  assert.deepEqual(t.fake.texts(), ["got it, thx"]);
  assert.deepEqual(t.saved.get(t.user().id), { lat: 34.0205, lng: -118.2856, source: "find_my" });
  assert.equal(asked, 0);
  // A newer share replaces it.
  await pipeline.handleEvent(t.event({ text: "", location: { lat: 34.0224, lng: -118.2851 } }));
  assert.equal(t.saved.get(t.user().id)!.lat, 34.0224);
});

test("a location that comes with words is saved and the words are handled as usual", async () => {
  const t = setup({ verified: true, intent: { flow: "repair", action: "report", details: {}, source: "ai" } });
  const before = t.fake.texts().length;
  await t.pipeline.handleEvent(t.event({ text: "the light here is broken", location: { lat: 34.02, lng: -118.28 } }));
  assert.deepEqual(t.fake.texts().slice(before), ["repair reply"]);
  assert.equal(t.saved.get(t.user().id)!.source, "find_my");
});

test("forget my location erases the saved fix and nothing else", async () => {
  const t = setup({ verified: true });
  await t.pipeline.handleEvent(t.event({ text: "", location: { lat: 34.02, lng: -118.28 } }));
  assert.ok(t.saved.has(t.user().id));
  assert.deepEqual(await t.text("Forget my location"), TEMPLATES.forgetLocation);
  assert.equal(t.saved.has(t.user().id), false);
  assert.ok(t.user().verifiedAt);
  assert.equal(t.user().stopped, false);
});

test("STOP and delete my data forget the location and tell the provider the chat is out", async () => {
  const a = setup({ verified: true });
  await a.pipeline.handleEvent(a.event({ text: "", location: { lat: 34.02, lng: -118.28 } }));
  await a.text("STOP");
  assert.equal(a.saved.size, 0);
  assert.deepEqual(a.forgot, [a.user().id]);
  const order = a.fake.calls.map((c) => c.method);
  // After the confirmation, so the provider still lets that one text out.
  assert.ok(order.lastIndexOf("onDisallowed") > order.lastIndexOf("sendMessage"));
  // A share from a stopped user is not saved.
  await a.pipeline.handleEvent(a.event({ text: "", location: { lat: 34.02, lng: -118.28 } }));
  assert.equal(a.saved.size, 0);

  const b = setup({ verified: true });
  await b.pipeline.handleEvent(b.event({ text: "", location: { lat: 34.02, lng: -118.28 } }));
  assert.deepEqual(await b.text("delete my data"), TEMPLATES.deleteData);
  assert.equal(b.saved.size, 0);
  assert.equal(b.fake.calls.filter((c) => c.method === "onDisallowed").length, 1);
  assert.equal((b.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 0);
});

test("STOP and delete my data give the sign-up seat back", async () => {
  const { signupCount } = await import("../src/signups.ts");
  const { decide } = await import("../src/adapters/gate.ts");
  const seat = (db: ReturnType<typeof openDb>) => db.prepare("INSERT INTO allow_list (handle, chatId, reason, addedAt) VALUES (?, ?, 'opt_in_phrase', ?)").run(HANDLE, CHAT, Date.now());
  const a = setup({ verified: true });
  seat(a.db);
  assert.equal(signupCount(a.db), 1);
  await a.text("STOP");
  assert.equal(signupCount(a.db), 0);
  await a.text("hey troy");
  assert.equal(signupCount(a.db), 1);

  const b = setup({ verified: true });
  seat(b.db);
  assert.deepEqual(await b.text("delete my data"), TEMPLATES.deleteData);
  assert.equal(signupCount(b.db), 0);
  // Their next text passes the gate (the allow-list row stays) and the seat is theirs again.
  const d = await decide(b.db, { isFromMe: false, handle: HANDLE, chatId: CHAT, isGroup: false, text: "hey troy", hasHistoryBeforeGoLive: async () => true });
  assert.deepEqual(d, { allow: true, newlyOptedIn: false });
  assert.equal(signupCount(b.db), 1);
});

test("after STOP, START or any text that opens with hey troy brings Troy back", async () => {
  const t = setup({ verified: true });
  await t.text("stop");
  assert.deepEqual(await t.text("hey whats up"), []);
  assert.deepEqual(await t.text("hey troy"), TEMPLATES.start);
  assert.equal(t.user().stopped, false);
  assert.equal(t.fake.calls.filter((c) => c.method === "onAllowed").length, 1);
  await t.text("stop");
  assert.deepEqual(await t.text("Hey Troy, u there?"), TEMPLATES.start);
  assert.match(TEMPLATES.stop.join(" "), /"START" or "hey troy"/);
});

test("typing is turned off after a poll, so the judge poll at the end of the welcome doesn't leave it on", async () => {
  const s = setup();
  // The shared fake doesn't record stopTyping (other tests assert the exact call order), so record it here.
  const seen: string[] = [];
  const { startTyping, sendPoll } = s.fake.adapter;
  s.fake.adapter.startTyping = async (chatId) => (seen.push("on"), startTyping(chatId));
  s.fake.adapter.stopTyping = async () => void seen.push("off");
  s.fake.adapter.sendPoll = async (chatId, question, options) => (seen.push("poll"), sendPoll(chatId, question, options));
  await s.text("hey troy");
  const at = seen.lastIndexOf("poll");
  assert.deepEqual(seen.slice(at - 1, at + 2), ["on", "poll", "off"]);
});

// ---------- commands by meaning ----------

const chat: Intent = { flow: "smalltalk", action: "chat", details: {}, source: "ai" };
const meant = (name: NonNullable<Intent["command"]>["name"], certainty: "clear" | "unsure" = "clear", topic?: string): Detect => (i) =>
  /^(?:yes|no)$/i.test(i.text.trim()) ? chat : { ...chat, command: topic ? { name, certainty, topic } : { name, certainty } };
const everyChat = Object.values(FALLBACK_POOLS).flat().flatMap((l) => l.split("|").map((b) => b.trim()));
const isChat = (bubbles: string[]) => bubbles.length > 0 && bubbles.every((b) => everyChat.includes(b));
const inPool = (bubbles: string[], pool: readonly string[], values: Record<string, string> = {}) => {
  const lines = pool.map((l) => Object.entries(values).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, v), l));
  return lines.some((l) => l.split("|").map((b) => b.trim()).join("\n") === bubbles.join("\n"));
};

test("by meaning: a clear wish to be left alone is honored at once with the fixed STOP confirmation", async () => {
  const t = setup({ verified: true, detect: meant("stop") });
  assert.deepEqual(await t.text("pls just leave me alone"), TEMPLATES.stop);
  assert.equal(t.user().stopped, true);
  assert.deepEqual(await t.text("u there"), []);
});

test("by meaning: playful uses do nothing, even when the read comes back as a maybe", async () => {
  for (const text of ["stop lol", "omg stop 😂", "stop ur so funny lmao"]) {
    const t = setup({ verified: true, detect: meant("stop", "unsure") });
    const reply = await t.text(text);
    assert.equal(t.user().stopped, false, text);
    assert.ok(isChat(reply), `a normal reply to "${text}": ${reply.join(" / ")}`);
    assert.ok(!reply.some((b) => COMMAND_POOLS.askStop.includes(b as never)), "no question either");
  }
});

test("by meaning: when he can't tell, he asks one short question, and a yes (typed or a thumbs up on it) does it", async () => {
  const t = setup({ verified: true, detect: meant("stop", "unsure") });
  const asked = await t.text("ok i think i'm done with this");
  assert.equal(asked.length, 1);
  assert.ok((COMMAND_POOLS.askStop as readonly string[]).includes(asked[0]), asked[0]);
  assert.equal(t.user().stopped, false, "nothing happens before the answer");
  assert.deepEqual(await t.text("yes"), TEMPLATES.stop);
  assert.equal(t.user().stopped, true);

  const b = setup({ verified: true, detect: meant("pause", "unsure") });
  const q = await b.text("maybe quiet down a bit");
  assert.ok((COMMAND_POOLS.askPause as readonly string[]).includes(q[0]), q[0]);
  // A thumbs up on another bubble is only an acknowledgement.
  assert.equal(b.user().paused, false);
  assert.ok(inPool(await b.tap(q[0], "like"), COMMAND_POOLS.pause));
  assert.equal(b.user().paused, true);

  const c = setup({ verified: true, detect: meant("pause", "unsure") });
  await c.text("maybe quiet down a bit");
  assert.ok(inPool(await c.text("no"), COMMAND_POOLS.kept));
  assert.equal(c.user().paused, false);
});

test("by meaning: deleting always asks once first and needs a typed yes, never a tapback", async () => {
  const t = setup({ verified: true, detect: meant("delete_data") });
  await t.text("help");
  const question = await t.text("erase everything u have on me");
  assert.ok(inPool(question, COMMAND_POOLS.askDelete), question.join(" / "));
  assert.ok(t.user().verifiedAt, "nothing deleted yet");
  assert.ok((t.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n > 0);

  // A heart and a thumbs up on the question do nothing at all.
  assert.deepEqual(await t.tap(question[0]!, "love"), []);
  assert.deepEqual(await t.tap(question[0]!, "like"), []);
  assert.ok(t.user().verifiedAt, "a tapback never deletes");

  assert.deepEqual(await t.text("yes"), TEMPLATES.deleteData);
  assert.equal(t.user().verifiedAt, null);
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 0);
});

test("by meaning: a no to the delete question keeps everything, and anything else lets the question lapse", async () => {
  const t = setup({ verified: true, detect: meant("delete_data") });
  await t.text("delete my account");
  assert.ok(inPool(await t.text("no"), COMMAND_POOLS.keptData));
  assert.ok(t.user().verifiedAt);
  // The question is closed: a later yes deletes nothing.
  await t.text("yes");
  assert.ok(t.user().verifiedAt);

  const b = setup({ verified: true, detect: (i) => (/delete/.test(i.text) ? { ...chat, command: { name: "delete_data", certainty: "clear" } } : chat) });
  await b.text("delete my account");
  await b.text("wait what does that remove");
  await b.text("yes");
  assert.ok(b.user().verifiedAt, "a yes after something else is not a yes to deleting");
});

test("by meaning: pause, resume and forget my location act and confirm in varied words", async () => {
  const p = setup({ verified: true, detect: meant("pause") });
  assert.ok(inPool(await p.text("can u chill with the alerts for a while"), COMMAND_POOLS.pause));
  assert.equal(p.user().paused, true);

  const r = setup({ verified: true, detect: meant("resume") });
  updateUser(r.db, r.user().id, { paused: 1 });
  assert.ok(inPool(await r.text("ok u can send alerts again"), COMMAND_POOLS.resume));
  assert.equal(r.user().paused, false);

  const f = setup({ verified: true, detect: meant("forget_location") });
  const first = await f.text("pls get rid of where i am");
  assert.ok(inPool(first, COMMAND_POOLS.forgetLocation));
  assert.deepEqual(f.forgot, [f.user().id]);
  // Not the same wording twice in a row.
  const second = await f.text("pls get rid of where i am");
  assert.ok(inPool(second, COMMAND_POOLS.forgetLocation));
  assert.notDeepEqual(second, first);
});

test("by meaning: 'stop the food texts' turns off that topic only, and says what will happen in plain words", async () => {
  const t = setup({ verified: true, detect: meant("unsubscribe_topic", "clear", "food") });
  const food = topics.findTopic(t.db, "food")!;
  const pickup = topics.findTopic(t.db, "pickup games")!;
  topics.subscribe(t.db, t.user().id, food.id);
  topics.subscribe(t.db, t.user().id, pickup.id);
  const reply = await t.text("stop the food texts");
  assert.ok(inPool(reply, COMMAND_POOLS.unsubscribed, { what: food.plain }), reply.join(" / "));
  assert.ok(!reply.join(" ").includes(food.label), "never the poll label");
  assert.equal(t.user().stopped, false);
  assert.equal(topics.isSubscribed(t.db, t.user().id, food), false);
  assert.equal(topics.isSubscribed(t.db, t.user().id, pickup), true, "the other topic is untouched");

  // Not following it: nothing changes, and he says so.
  assert.ok(inPool(await t.text("stop the food texts"), COMMAND_POOLS.notSubscribed));

  // No topic he can find: one short question.
  const u = setup({ verified: true, detect: meant("unsubscribe_topic", "unsure") });
  assert.ok(inPool(await u.text("stop those texts"), COMMAND_POOLS.whichTopic));
});

test("by meaning: asking how to stop is a question for the chat brain, not the canned help list", async () => {
  const t = setup({ verified: true, detect: meant("help") });
  const reply = await t.text("how do i make u stop if i need to");
  assert.notDeepEqual(reply, TEMPLATES.help);
  assert.ok(reply.length > 0);
  // The exact word still gets the fixed list at once.
  assert.deepEqual(await t.text("help"), TEMPLATES.help);
});

// ---------- jokes versus real distress ----------

function reader(read: "none" | "joke" | "concern" | "crisis") {
  const seen: { text: string; history: { from: string; text: string }[] }[] = [];
  const fn: SafetyReader = async (input) => {
    seen.push(input);
    return read;
  };
  return { fn, seen };
}
const hasHotline = (bubbles: string[]) => bubbles.some((b) => /\b988\b|\b911\b/.test(b));
const EMOJI_RE = /\p{Extended_Pictographic}/u;

test("obvious slang never reaches the model's safety read and never gets the hotline", async () => {
  for (const text of ["that exam killed me lol", "i'm dead 😂", "this class is killing me"]) {
    const r = reader("crisis");
    const t = setup({ verified: true, readSafety: r.fn });
    const reply = await t.text(text);
    assert.equal(r.seen.length, 0, text);
    assert.ok(reply.length > 0 && !hasHotline(reply), `${text}: ${reply.join(" / ")}`);
  }
});

test("safety read 'joke' and 'none': a normal reply, with the conversation passed to the read", async () => {
  for (const read of ["joke", "none"] as const) {
    const r = reader(read);
    const t = setup({ verified: true, readSafety: r.fn });
    await t.text("this pset is so long");
    const reply = await t.text("kms lol");
    assert.equal(r.seen.length, 1);
    assert.equal(r.seen[0].text, "kms lol");
    assert.ok(r.seen[0].history.some((h) => h.from === "student" && h.text === "this pset is so long"), "the last few texts go with it");
    assert.ok(!r.seen[0].history.some((h) => h.text === "kms lol"), "not the message itself");
    assert.ok(reply.length > 0 && !hasHotline(reply), reply.join(" / "));
    assert.equal(brain.isHeavy(t.db, t.user().id), false);
  }
});

test("safety read 'concern': he checks in like a person, one direct kind question, no hotline wall and no emoji", async () => {
  const r = reader("concern");
  const t = setup({ verified: true, readSafety: r.fn });
  const reply = await t.text("i can't do this anymore");
  assert.equal(reply.length, 1, reply.join(" / "));
  assert.match(reply[0], /\?$/);
  assert.match(reply[0], /hurting urself|are u ok/);
  assert.ok(!hasHotline(reply) && !EMOJI_RE.test(reply[0]));
  assert.equal(brain.isHeavy(t.db, t.user().id), true, "the conversation is heavy for the next hour");
  assert.equal(t.user().stopped, false);
});

test("after the check-in: a yes gets the fixed crisis line, and so does a dodge", async () => {
  const yes = setup({ verified: true, readSafety: reader("concern").fn });
  await yes.text("i can't do this anymore");
  assert.deepEqual(await yes.text("yeah"), TEMPLATES.crisis);

  const dodge = setup({ verified: true, readSafety: reader("concern").fn });
  await dodge.text("whats the point of anything");
  assert.deepEqual(await dodge.text("idk whatever"), TEMPLATES.crisis);

  // With no model to read the dodge, it still gets the fixed line.
  let n = 0;
  const once: SafetyReader = async () => (n++ === 0 ? "concern" : Promise.reject(new Error("down")));
  const down = setup({ verified: true, readSafety: once });
  await down.text("whats the point of anything");
  assert.deepEqual(await down.text("doesn't matter"), TEMPLATES.crisis);
});

test("after the check-in: a clear 'no, i'm fine' goes back to normal chat, and replies stay gentle", async () => {
  const t = setup({ verified: true, readSafety: reader("concern").fn });
  await t.text("i can't do this anymore");
  const reply = await t.text("no");
  assert.ok(reply.length > 0, "he still answers");
  assert.notDeepEqual(reply, TEMPLATES.crisis);
  assert.equal(brain.isHeavy(t.db, t.user().id), true);
  // The check-in is closed: a later yes is just a yes.
  assert.notDeepEqual(await t.text("yeah"), TEMPLATES.crisis);
});

test("safety read 'crisis': the fixed crisis line", async () => {
  const t = setup({ verified: true, readSafety: reader("crisis").fn });
  assert.deepEqual(await t.text("kms"), TEMPLATES.crisis);
  assert.equal(brain.isHeavy(t.db, t.user().id), true);
});

test("fail safe: with no model, an ambiguous message with self-harm words gets the fixed line, and a merely heavy one does not", async () => {
  const t = setup({ verified: true, readSafety: null });
  assert.deepEqual(await t.text("kms"), TEMPLATES.crisis);
  assert.deepEqual(await t.text("gonna kill myself if i fail this lol"), TEMPLATES.crisis);
  const heavy = await t.text("i can't do this anymore");
  assert.ok(heavy.length > 0);
  assert.notDeepEqual(heavy, TEMPLATES.crisis, "no fixed line on a heavy text with no self-harm words");
  // A read that throws is the same as no model.
  const broken = setup({ verified: true, readSafety: async () => Promise.reject(new Error("down")) });
  assert.deepEqual(await broken.text("kms"), TEMPLATES.crisis);
  // No reader passed at all and no key: the default is the same fail safe.
  const plain = setup({ verified: true });
  assert.deepEqual(await plain.text("kms"), TEMPLATES.crisis);
});

test("a stopped user's ambiguous text is never sent to the model: self-harm words get the fixed line, slang gets nothing", async () => {
  const r = reader("joke");
  const t = setup({ verified: true, readSafety: r.fn });
  await t.text("STOP");
  assert.deepEqual(await t.text("kms"), TEMPLATES.crisis);
  assert.deepEqual(await t.text("that exam killed me lol"), []);
  assert.equal(r.seen.length, 0);
});

// ---------- open questions, pacing, mid-flow chat ----------

const taps: { yesNo: unknown; onOpenQuestion: unknown }[] = [];
const quiet: FlowHandler = {
  name: "topics",
  async handle(ctx) {
    if (ctx.event.reaction) {
      taps.push({ yesNo: ctx.intent.details.yesNo, onOpenQuestion: ctx.intent.details.onOpenQuestion });
      return;
    }
    if (ctx.event.text === "open") {
      await ctx.say("first bubble", "is that ok?");
      ctx.setState({ flow: "topics", step: "confirm", data: {} });
    } else if (ctx.event.text === "open again") {
      await ctx.say("ok one more", "and this one?");
      ctx.setState({ flow: "topics", step: "second", data: {} });
    } else if (ctx.event.text === "paced") {
      await ctx.say({ text: "one", pauseAfterMs: 2000 } as Bubble, "two", { text: "three", pauseAfterMs: 5000 } as Bubble);
    }
    // Anything else at an open step: this flow stays silent.
  },
};
registerFlow(quiet);
const usgIntent: Detect = (i) => (/^(?:open|paced)/.test(i.text) ? { flow: "topics", action: "concern", details: {}, source: "ai" } : { flow: "topics", action: "answer", details: {}, source: "fallback" });

test("a thumbs up on the open question reaches the flow as a yes, a thumbs down as a no, any other bubble as nothing", async () => {
  taps.length = 0;
  const t = setup({ verified: true, detect: usgIntent });
  await t.text("open");
  await t.tap("is that ok?", "like");
  await t.tap("is that ok?", "love");
  await t.tap("is that ok?", "dislike");
  await t.tap("is that ok?", "laugh");
  await t.tap("first bubble", "like");
  assert.deepEqual(taps, [
    { yesNo: "yes", onOpenQuestion: true },
    { yesNo: "yes", onOpenQuestion: true },
    { yesNo: "no", onOpenQuestion: true },
    { yesNo: undefined, onOpenQuestion: true },
    { yesNo: undefined, onOpenQuestion: false },
  ]);

  // The step moved on: the old question no longer takes a tapback, the new one does.
  taps.length = 0;
  await t.text("open again");
  await t.tap("is that ok?", "like");
  await t.tap("and this one?", "like");
  assert.deepEqual(taps, [
    { yesNo: undefined, onOpenQuestion: false },
    { yesNo: "yes", onOpenQuestion: true },
  ]);

  // Answered (no step open): a late thumbs up means nothing. With no step open the tap goes to the food flow.
  setFlowState(t.db, t.user().id, null);
  taps.length = 0;
  await t.tap("and this one?", "like");
  assert.deepEqual(taps, []);
});

test("say() takes a longer beat after a bubble when asked (pauseAfterMs), but never after the last one", async () => {
  const t = setup({ verified: true, detect: usgIntent });
  assert.deepEqual(await t.text("paced"), ["one", "two", "three"]);
  const order = t.fake.calls.filter((c) => c.method === "sendMessage" || c.method === "wait").map((c) => (c.method === "wait" ? c.ms : c.text));
  const one = order.indexOf("one");
  assert.equal(order[one + 1], 2000, "the asked-for beat comes right after the bubble");
  assert.ok(!order.includes(5000), "nothing waits after the last bubble");
});

test("a question asked in the middle of a step reaches the chat brain when the open flow stays silent, and the step stays open", async () => {
  const t = setup({ verified: true, detect: usgIntent });
  await t.text("open");
  const reply = await t.text("wait what can u do");
  assert.ok(reply.length > 0, "nobody is left on read");
  const whatHeDoes = FALLBACK_POOLS.what_he_does.map((l) => l.split("|").map((b) => b.trim()).join("\n"));
  assert.ok(whatHeDoes.includes(reply.join("\n")), reply.join(" / "));
  assert.deepEqual({ flow: getFlowState(t.db, t.user().id)?.flow, step: getFlowState(t.db, t.user().id)?.step }, { flow: "topics", step: "confirm" });
});

test("a vote on a poll that isn't open anywhere doesn't break anything", async () => {
  const t = setup({ verified: true });
  await t.pipeline.handleEvent(t.event({ pollVote: { pollMessageId: "no-such-poll", optionIndex: 0 } }));
  assert.ok((await t.text("hi")).length > 0);
});

test("the pipeline can be built before the adapter exists (the server's boot order)", () => {
  const db = openDb(":memory:");
  assert.doesNotThrow(() =>
    createPipeline({
      db,
      getAdapter: () => {
        throw new Error("adapter not ready");
      },
    }),
  );
});

// ---------- commands by meaning: what code reads by itself (John hit "Delete me pls" on his phone) ----------

test('"Delete me pls" gets the one-step confirmation, never the words to type, and a typed yes deletes', async () => {
  // The model reads nothing here: it says plain chat for every message.
  for (const ask of ["Delete me pls", "delete my account", "erase me", "can u delete everything u have on me"]) {
    const t = setup({ verified: true, detect: () => chat });
    await t.text("hi");
    const question = await t.text(ask);
    assert.ok(inPool(question, COMMAND_POOLS.askDelete), `${ask}: ${question.join(" / ")}`);
    assert.match(question.join(" "), /reply "yes"/);
    assert.ok(!/delete my data/.test(question.join(" ")), "he never answers with the command to type");
    assert.ok(t.user().verifiedAt, "nothing deleted before the yes");
    assert.deepEqual(await t.text("yes"), TEMPLATES.deleteData);
    assert.equal(t.user().verifiedAt, null);
    assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 0);
  }
});

test('"delete this class from my life lol" deletes nothing and asks nothing', async () => {
  const t = setup({ verified: true, detect: () => chat });
  for (const line of ["delete this class from my life lol", "delete me lol", "i can't stop laughing", "erase that from my memory pls"]) {
    const reply = await t.text(line);
    assert.ok(!COMMAND_POOLS.askDelete.some((q) => reply.includes(q)), `${line}: ${reply.join(" / ")}`);
    assert.ok(!reply.includes(TEMPLATES.stop[0]), line);
  }
  // Nothing is waiting for a yes either.
  await t.text("yes");
  assert.ok(t.user().verifiedAt);
  assert.equal(t.user().stopped, false);
});

test('asking how to delete or stop gets an offer to do it ("reply \"yes\""), not instructions', async () => {
  const t = setup({ verified: true, detect: () => chat });
  const del = await t.text("how do i delete my data?");
  assert.ok(inPool(del, COMMAND_POOLS.askDelete), del.join(" / "));
  assert.ok(inPool(await t.text("no"), COMMAND_POOLS.keptData));
  assert.ok(t.user().verifiedAt);
  const stop = await t.text("how do i unsubscribe");
  assert.ok(inPool(stop, COMMAND_POOLS.askStop), stop.join(" / "));
  assert.deepEqual(await t.text("yes"), TEMPLATES.stop);
  assert.equal(t.user().stopped, true);
});

// ---------- judge mode: pacing, tone, the wrap-up ----------

test("judge pacing: typing, gaps and longer beats are 45 percent of a student's, and the read beat is not shortened", async () => {
  const waitsFor = async (judge: boolean) => {
    const t = setup({ verified: !judge, judge, random: () => 0.5 });
    await t.text("help");
    return t.fake.calls.filter((c) => c.method === "wait").map((c) => c.ms!);
  };
  const student = await waitsFor(false);
  const judge = await waitsFor(true);
  assert.equal(JUDGE_PACE, 0.45);
  assert.equal(student.length, 6);
  assert.equal(judge.length, student.length, "same bubbles, same order");
  assert.equal(judge[0], student[0], "read shows for its full beat first");
  for (let i = 1; i < student.length; i++) assert.equal(judge[i], Math.round(student[i]! * JUDGE_PACE), `wait ${i}`);

  // A beat a flow asked for (pauseAfterMs) is scaled the same way.
  const beatOf = async (isJudge: boolean) => {
    const t = setup({ verified: !isJudge, judge: isJudge, detect: usgIntent, random: () => 0.5 });
    await t.text("paced");
    const order = t.fake.calls.filter((c) => c.method === "sendMessage" || c.method === "wait").map((c) => (c.method === "wait" ? c.ms : c.text));
    return order[order.indexOf("one") + 1];
  };
  assert.equal(await beatOf(false), 2000);
  assert.equal(await beatOf(true), 900);
});

test('plain tone: "drop the slang" from a judge turns every bubble into standard english, safety lines stay word for word, "slang back on" reverses it', async () => {
  const t = setup({ judge: true, detect: () => chat });
  const on = await t.text("drop the slang");
  assert.equal(on.length, 1);
  assert.match(on[0]!, /"slang back on"/);
  assert.ok(!/\b(?:u|ur)\b/.test(on[0]!.replace(/"[^"]*"/g, "")), on[0]);
  assert.match(on[0]!, /^[A-Z]/);
  assert.equal(plainTone(t.db, t.user().id), true);

  // A fixed line and a variant pool, both through the same conversion.
  assert.deepEqual(await t.text("help"), TEMPLATES.help.map(toPlain));
  const paused = await t.text("pause");
  assert.deepEqual(paused, TEMPLATES.pause.map(toPlain));
  assert.match(paused[0]!, /^Paused\. No alerts until you text "resume"\. I'll still answer when you text me\.$/);
  // The safety list is never reworded.
  assert.deepEqual(await t.text("there's a fire in my building"), TEMPLATES.emergency);

  const off = await t.text("slang back on");
  assert.match(off.join(" "), /"drop the slang"/);
  assert.equal(plainTone(t.db, t.user().id), false);
  assert.deepEqual(await t.text("help"), TEMPLATES.help);
  // STOP stays word for word in either tone.
  await t.text("formal");
  assert.equal(plainTone(t.db, t.user().id), true);
  assert.deepEqual(await t.text("stop"), TEMPLATES.stop);
});

test("plain tone is a judge thing: a student typing the same words changes nothing", async () => {
  const t = setup({ verified: true, detect: () => chat });
  await t.text("drop the slang");
  assert.equal(plainTone(t.db, t.user().id), false);
  assert.deepEqual(await t.text("help"), TEMPLATES.help);
});

const tourish = (name: FlowHandler["name"]): FlowHandler => ({
  name,
  async handle(ctx) {
    if (ctx.state) {
      await ctx.say("example over");
      ctx.setState(null);
      return;
    }
    await ctx.say("example run, describe it");
    ctx.setState({ flow: name, step: "describe", data: {} });
  },
});

test("after the try-it tour a judge gets the wrap-up once, with john's email. a student never does", async () => {
  registerFlow(tourish("tour"));
  const tourIntent: Detect = () => ({ flow: "tour", action: "lost", details: {}, source: "ai" });
  const run = async (judge: boolean) => {
    const t = setup({ verified: !judge, judge, detect: tourIntent });
    assert.deepEqual(await t.text("show me how it works"), ["example run, describe it"]);
    // The real tour marks its move when a variant starts, and notes a run that reached its end.
    markMove(t.db, t.user().id, "tour_lost", { did: true });
    noteTourFinished(t.db, t.user().id);
    return { t, end: await t.text("navy hydro flask with a usc sticker") };
  };
  const student = await run(false);
  assert.deepEqual(student.end, ["example over"]);

  const judge = await run(true);
  assert.equal(judge.end[0], "example over");
  const wrap = judge.end.slice(1).join(" ");
  assert.match(wrap, /short version/);
  assert.match(wrap, /full walkthrough/);
  assert.match(wrap, /johnwang@usc\.edu/);
  assert.match(wrap, /john/);
  // Once per judge: a second run of the example ends without it.
  await judge.t.text("show me how it works");
  assert.deepEqual(await judge.t.text("another description"), ["example over"]);
});

// ---------- review fixes ----------

test("a judge who backs out of the tour gets no wrap-up, and still gets it when a run does reach its end", async () => {
  registerFlow(tourish("tour"));
  const t = setup({ judge: true, detect: () => ({ flow: "tour", action: "lost", details: {}, source: "ai" }) });
  await t.text("show me how it works");
  markMove(t.db, t.user().id, "tour_lost", { did: true });
  // The step closes without the run having finished (they bailed): nothing but the flow's own line.
  assert.deepEqual(await t.text("stop the example"), ["example over"]);
  // Later they go through it and the tour notes the finish: now the wrap-up, once.
  await t.text("show me how it works");
  noteTourFinished(t.db, t.user().id);
  const end = await t.text("navy hydro flask with a usc sticker");
  assert.equal(end[0], "example over");
  assert.match(end.slice(1).join(" "), /johnwang@usc\.edu/);
});

test("the wrap-up never fires when some other flow closes, even for a judge who finished the tour earlier", async () => {
  registerFlow(tourish("rides"));
  const t = setup({ judge: true, detect: () => ({ flow: "rides", action: "find", details: {}, source: "ai" }) });
  noteTourFinished(t.db, t.user().id);
  await t.text("need a ride to lax");
  assert.deepEqual(await t.text("friday"), ["example over"]);
});

test("plain tone: someone else's words are passed along exactly as written, and the rides and usg contact warnings stay word for word", async () => {
  let relayed: (string | Bubble)[] = [];
  registerFlow({
    name: "notes",
    async handle(ctx) {
      relayed = [{ text: "from the finder: yo i found ur keys lol, they're by tommy trojan rn", verbatim: true }, "ok lmk when u have them", "heads up, that shares ur contact info. ok?"];
      await ctx.say(...relayed);
    },
  });
  const t = setup({ judge: true, detect: (i) => (/keys/.test(i.text) ? { flow: "notes", action: "x", details: {}, source: "ai" } : chat) });
  await t.text("drop the slang");
  assert.equal(plainTone(t.db, t.user().id), true);
  const out = await t.text("where are my keys");
  assert.equal(out[0], "from the finder: yo i found ur keys lol, they're by tommy trojan rn", "their words, untouched");
  assert.equal(out[1], "OK let me know when you have them.", "troy's own line is in plain english");
  assert.equal(out[2], "heads up, that shares ur contact info. ok?", "the contact-sharing warning is on the safety list");
});

// ---------- the acknowledgement tapback (John, second live test, Nov 14 8pm) ----------

const slowDetect = (flow: Intent["flow"]) => async () => {
  await sleep(80);
  return { flow, action: "chat", details: {}, source: "fallback" } as Intent;
};

test("a slow reply to a statement gets no tapback at all: no thumbs up on a complaint or on something sad", async () => {
  for (const said of ["the professors suck and are overpaid", "my dog died today", "lol nice"]) {
    const t = setup({ verified: true, detect: slowDetect("smalltalk") as unknown as Detect });
    await t.text(said);
    await sleep(40);
    assert.equal(t.fake.calls.filter((c) => c.method === "react").length, 0, said);
    assert.ok(!t.fake.texts().some((x) => TEMPLATES.acks.includes(x)), `no "one sec" line either: ${said}`);
  }
});

test("a slow reply to a request gets one thumbs up while the answer is coming, and only one tapback per message", async () => {
  const t = setup({ verified: true, detect: slowDetect("smalltalk") as unknown as Detect });
  await t.text("where can i print on campus?");
  await sleep(40);
  const reacts = t.fake.calls.filter((c) => c.method === "react");
  assert.equal(reacts.length, 1);
  assert.equal(reacts[0]!.text, "like");
  assert.equal(reacts[0]!.id, "in-1");
  assert.ok(t.fake.texts().length > 0, "the answer still came");
});

test("one tapback per exchange: a flow's second reaction on the same message is refused", async () => {
  const name = "notes" as FlowHandler["name"];
  const real = getFlow(name);
  const results: boolean[] = [];
  registerFlow({
    name,
    async handle(ctx) {
      results.push(await ctx.adapter.react(ctx.event.chatId, ctx.event.messageId, "love"));
      results.push(await ctx.adapter.react(ctx.event.chatId, ctx.event.messageId, "laugh"));
      await ctx.say("ok");
    },
  });
  try {
    const t = setup({ verified: true, intent: { flow: name, action: "add_note", details: {}, source: "ai" } });
    await t.text("remember i like short texts");
    assert.deepEqual(results, [true, false]);
    assert.equal(t.fake.calls.filter((c) => c.method === "react").length, 1);
  } finally {
    if (real) registerFlow(real);
  }
});
