import { test } from "node:test";
import assert from "node:assert/strict";
import type { AdapterCapabilities, FlowHandler, IncomingEvent, Intent, MessagingAdapter } from "../src/types.ts";
import { openDb, getUserByHandle, getOrCreateUser, updateUser, setSetting, setFlowState } from "../src/db/index.ts";
import { chunkBubble, createPipeline, TIMING, typingMs } from "../src/pipeline.ts";
import type { LocationStore } from "../src/pipeline.ts";
import { registerFlow } from "../src/flows/index.ts";
import { TEMPLATES } from "../src/commands.ts";

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

function setup(opts: { caps?: Partial<AdapterCapabilities>; intent?: Intent; verified?: boolean; pause?: (ms: number) => Promise<void>; random?: () => number } = {}) {
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
  const pipeline = createPipeline({ db, getAdapter: () => fake.adapter, pause, random: opts.random, location, ackAfterMs: 30, detectIntent: async () => intent });
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
  return { db, fake, pipeline, event, text, user, saved, forgot };
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

test("separate sends in one turn are paced: a gap, then typing, before each one after the first", async () => {
  const t = setup();
  await t.text("hey troy");
  const order = t.fake.calls.map((c) => c.method);
  // welcome (4) + save my contact + contact card + email ask + judge line + poll: 9 items.
  // One read beat, one typing wait per item, one gap between items.
  assert.equal(order.filter((m) => m === "wait").length, 1 + 9 + 8);
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

test("after STOP, START or any text that opens with hey troy brings Troy back", async () => {
  const t = setup({ verified: true });
  await t.text("stop");
  assert.deepEqual(await t.text("hey whats up"), []);
  assert.deepEqual(await t.text("hey troy"), TEMPLATES.start);
  assert.equal(t.user().stopped, false);
  assert.equal(t.fake.calls.filter((c) => c.method === "onAllowed").length, 1);
  await t.text("stop");
  assert.deepEqual(await t.text("Hey Troy, u there?"), TEMPLATES.start);
  assert.match(TEMPLATES.stop.join(" "), /START or hey troy/);
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
  assert.deepEqual(seen.slice(-3), ["on", "poll", "off"]);
});
