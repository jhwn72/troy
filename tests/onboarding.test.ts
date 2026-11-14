import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { AdapterCapabilities, IncomingEvent, MessagingAdapter } from "../src/types.ts";
import { openDb, getUserByHandle, getFlowState } from "../src/db/index.ts";
import { createPipeline } from "../src/pipeline.ts";
import { guessName } from "../src/onboarding.ts";

const HANDLE = "+12135550100";
const CHAT = "chat-1";

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
    async startTyping() {},
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

function setup() {
  const db = openDb(":memory:");
  const fake = fakeAdapter();
  const pipeline = createPipeline({ db, getAdapter: () => fake.adapter, pause: async () => {}, ackAfterMs: 50 });
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
  /** Send one text and return only the bubbles Troy sent in reply to it. */
  const text = async (t: string) => {
    const before = fake.texts().length;
    await pipeline.handleEvent(event({ text: t }));
    return fake.texts().slice(before);
  };
  const user = () => getUserByHandle(db, HANDLE)!;
  return { db, fake, pipeline, event, text, user };
}

function codeFor(db: DatabaseSync): string {
  return (db.prepare("SELECT code FROM verification_codes ORDER BY id DESC LIMIT 1").get() as { code: string }).code;
}

test("happy path: welcome, usc email, code, subscriptions, spots, all set", async () => {
  const t = setup();

  const welcome = await t.text("hey troy i lost my airpods");
  assert.deepEqual(welcome.slice(0, 3), ["hey i'm troy", "i'm an ai that connects trojans. lost something, found something, free food nearby? i know a guy", "reply STOP anytime"]);
  assert.match(welcome[3], /usc email/);
  assert.match(welcome[4], /JUDGE/);
  assert.match(welcome[4], /demo only/);
  assert.equal(t.fake.calls.filter((c) => c.method === "sendContactCard").length, 1);
  assert.ok(t.fake.calls.some((c) => c.method === "markRead"));

  const sent = await t.text("Tommy.Trojan@usc.edu");
  assert.match(sent.join(" "), /tommy\.trojan@usc\.edu/);
  assert.match(sent.join(" "), /might be in spam since i'm new 👀/);
  const code = codeFor(t.db);
  assert.match(code, /^\d{6}$/);
  assert.equal(t.user().verifiedAt, null);

  const ok = await t.text(code);
  assert.match(ok[0], /verified/);
  assert.ok(t.fake.calls.some((c) => c.method === "sendPoll"));
  assert.equal(t.user().uscEmail, "tommy.trojan@usc.edu");
  assert.equal(t.user().verifiedVia, "usc_email");
  assert.equal(t.user().name, "Tommy Trojan");
  assert.ok(t.user().verifiedAt);

  const subs = await t.text("1 and 3");
  assert.deepEqual(t.user().subscriptions, ["free_food", "events"]);
  assert.match(subs.join(" "), /tap the \+ in this chat, then Location, then Share/);

  const done = await t.text("leavey, the village");
  assert.deepEqual(t.user().usualSpots, ["leavey", "the village"]);
  assert.match(done.join(" "), /ur all set/);
  assert.equal(getFlowState(t.db, t.user().id), null);

  // A verified user never sees onboarding again.
  const later = await t.text("hey troy");
  assert.ok(!later.join(" ").includes("usc email"));
  assert.ok(!later.includes("hey i'm troy"));
});

test("JUDGE skips verification as a demo guest, any case", async () => {
  const t = setup();
  await t.text("hey troy");
  const reply = await t.text("judge");
  assert.match(reply[0], /guest for the demo/);
  assert.equal(t.user().verifiedVia, "judge_skip");
  assert.ok(t.user().verifiedAt);
  assert.equal(t.user().uscEmail, null);
  assert.equal(getFlowState(t.db, t.user().id)?.step, "subscriptions");
});

test("JUDGE also works at the code step", async () => {
  const t = setup();
  await t.text("hey troy");
  await t.text("ttrojan@usc.edu");
  await t.text("JUDGE");
  assert.equal(t.user().verifiedVia, "judge_skip");
});

test("a non-usc email gets a friendly retry and no code", async () => {
  const t = setup();
  await t.text("hey troy");
  const reply = await t.text("tommy@gmail.com");
  assert.match(reply[0], /@usc\.edu/);
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM verification_codes").get() as { n: number }).n, 0);
  assert.equal(getFlowState(t.db, t.user().id)?.step, "email");
  const junk = await t.text("idk");
  assert.match(junk[0], /email/);
  // Lookalike domains don't pass.
  await t.text("tommy@usc.edu.evil.com");
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM verification_codes").get() as { n: number }).n, 0);
});

test("wrong code: 5 tries, then even the right code is refused until resend", async () => {
  const t = setup();
  await t.text("hey troy");
  await t.text("ttrojan@usc.edu");
  const code = codeFor(t.db);
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 1; i <= 5; i++) {
    const r = await t.text(wrong);
    assert.match(r[0], i < 5 ? /not the code/ : /out of tries/);
  }
  const locked = await t.text(code);
  assert.match(locked[0], /resend/);
  assert.equal(t.user().verifiedAt, null);

  await t.text("resend");
  const fresh = codeFor(t.db);
  await t.text(fresh);
  assert.equal(t.user().verifiedVia, "usc_email");
  assert.equal(t.user().name, null); // "ttrojan" doesn't look like a name
});

test("expired code is refused", async () => {
  const t = setup();
  await t.text("hey troy");
  await t.text("ttrojan@usc.edu");
  const code = codeFor(t.db);
  t.db.prepare("UPDATE verification_codes SET expiresAt = ?").run(Date.now() - 1);
  const r = await t.text(code);
  assert.match(r[0], /expired/);
  assert.equal(t.user().verifiedAt, null);
});

test("subscriptions by tapback on the option bubbles, then done; location skip", async () => {
  const t = setup();
  await t.text("hey troy");
  await t.text("judge");
  await t.pipeline.handleEvent(t.event({ reaction: { targetMessageId: "opt-0", type: "love", removed: false } }));
  await t.pipeline.handleEvent(t.event({ reaction: { targetMessageId: "opt-1", type: "like", removed: false } }));
  await t.pipeline.handleEvent(t.event({ reaction: { targetMessageId: "opt-1", type: "like", removed: true } }));
  await t.pipeline.handleEvent(t.event({ reaction: { targetMessageId: "opt-3", type: "like", removed: false } }));
  // One nudge for the first tap, not one per tap.
  assert.equal(t.fake.texts().filter((x) => /tap any others/.test(x)).length, 1);
  await t.text("done");
  assert.deepEqual(t.user().subscriptions, ["free_food", "class_help"]);
  const end = await t.text("skip");
  assert.match(end.join(" "), /ur all set/);
  assert.deepEqual(t.user().usualSpots, []);
  // Onboarding is over. Whatever is open now belongs to the flow that took the request.
  assert.notEqual(getFlowState(t.db, t.user().id)?.flow, "onboarding");
});

test("subscriptions skip saves none", async () => {
  const t = setup();
  await t.text("hey troy");
  await t.text("judge");
  await t.text("skip");
  assert.deepEqual(t.user().subscriptions, []);
  assert.equal(getFlowState(t.db, t.user().id)?.step, "location");
});

test("guessName only accepts first.last", () => {
  assert.equal(guessName("john.wang@usc.edu"), "John Wang");
  assert.equal(guessName("jwang72@usc.edu"), null);
  assert.equal(guessName("ttrojan@usc.edu"), null);
});

// ---------- review fixes ----------

async function toLocationStep() {
  const t = setup();
  await t.text("hey troy");
  await t.text("judge");
  await t.text("skip");
  assert.equal(getFlowState(t.db, t.user().id)?.step, "location");
  return t;
}

test("location step: a decline in any wording is not saved as a spot", async () => {
  for (const no of ["nah im good", "no im ok", "idk", "not now", "I'm good", "nah"]) {
    const t = await toLocationStep();
    const end = await t.text(no);
    assert.match(end.join(" "), /no worries/, no);
    assert.deepEqual(t.user().usualSpots, [], no);
    assert.equal(getFlowState(t.db, t.user().id), null, no);
  }
});

test("location step: a question gets one explanation and nothing is saved", async () => {
  const t = await toLocationStep();
  const why = await t.text("why do u need that");
  assert.match(why.join(" "), /don't keep it/);
  assert.deepEqual(t.user().usualSpots, []);
  assert.equal(getFlowState(t.db, t.user().id)?.step, "location");
  await t.text("leavey, the village and parkside");
  assert.deepEqual(t.user().usualSpots, ["leavey", "the village", "parkside"]);
  assert.equal(getFlowState(t.db, t.user().id), null);
});

test("location step: a real request ends onboarding and is handled as a request, not stored as a spot", async () => {
  const t = await toLocationStep();
  const reply = await t.text("i lost my wallet at leavey");
  assert.deepEqual(t.user().usualSpots, []);
  // Onboarding is over. Whatever is open now belongs to the flow that took the request.
  assert.notEqual(getFlowState(t.db, t.user().id)?.flow, "onboarding");
  assert.ok(reply.length >= 1);
  assert.ok(!reply.join(" ").includes("saved ur usual spots"));
});

test("JUDGE works straight after STOP then START wiped the onboarding state", async () => {
  const t = setup();
  await t.text("hey troy");
  await t.text("stop");
  await t.text("start");
  const reply = await t.text("JUDGE");
  assert.deepEqual(reply.slice(0, 3), ["hey i'm troy", reply[1], "reply STOP anytime"]);
  assert.match(reply.join(" "), /guest for the demo/);
  assert.ok(!reply.join(" ").includes("usc email\n"));
  assert.equal(t.user().verifiedVia, "judge_skip");
  assert.equal(getFlowState(t.db, t.user().id)?.step, "subscriptions");
});
