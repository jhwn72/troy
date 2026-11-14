import { test } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { AdapterCapabilities, IncomingEvent, MessagingAdapter } from "../src/types.ts";
import { openDb, getUserByHandle, getFlowState } from "../src/db/index.ts";
import { createPipeline } from "../src/pipeline.ts";
import { guessName } from "../src/onboarding.ts";
import { TEMPLATES } from "../src/commands.ts";

const HANDLE = "+12135550100";
const CHAT = "chat-1";

type Call = { method: string; chatId: string; text?: string; id?: string | null };

type Fake = { caps?: Partial<AdapterCapabilities>; pollMode?: "native" | "tap" | "numbered"; canRequestLocation?: boolean };

function fakeAdapter({ caps = {}, pollMode = "tap", canRequestLocation = false }: Fake = {}) {
  const calls: Call[] = [];
  let n = 0;
  let polls = 0;
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
      const p = ++polls;
      calls.push({ method: "sendPoll", chatId, text: `${question}: ${options.join(" / ")}`, id: `poll-${p}` });
      // Native: one poll message, every option id is the poll's id. Tap: one bubble per option. Numbered: no ids.
      if (pollMode === "native") return { optionMessageIds: options.map(() => `poll-${p}`), mode: "native" };
      if (pollMode === "numbered") return { optionMessageIds: options.map(() => null), mode: "numbered" };
      // The first poll is the student / judge one (j-0, j-1); the subscriptions poll keeps opt-0..3.
      const judgePoll = options.includes("hackathon judge");
      return { optionMessageIds: options.map((_, i) => (judgePoll ? `j-${i}` : `opt-${i}`)), mode: "tap" };
    },
    async createGroupChat() {
      return null;
    },
    async getLiveLocation() {
      return null;
    },
    async requestLocation(chatId) {
      calls.push({ method: "requestLocation", chatId });
      return canRequestLocation;
    },
    async onAllowed(chatId) {
      calls.push({ method: "onAllowed", chatId });
    },
    chatIdForHandle: (h) => `chat-${h}`,
  };
  const texts = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.text!);
  return { adapter, calls, texts };
}

function setup(opts: Fake = {}) {
  const db = openDb(":memory:");
  const fake = fakeAdapter(opts);
  // Stands in for src/location.ts.
  const saved = new Map<number, { lat: number; lng: number; source: string }>();
  const location = {
    saveUserLocation: (_d: DatabaseSync, id: number, loc: { lat: number; lng: number }, source: string) => void saved.set(id, { ...loc, source }),
    forgetUserLocation: (_d: DatabaseSync, id: number) => void saved.delete(id),
  };
  const pipeline = createPipeline({ db, getAdapter: () => fake.adapter, pause: async () => {}, ackAfterMs: 50, location });
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
  /** Send a non-text event (a vote, a tapback, a location share) and return Troy's reply bubbles. */
  const send = async (over: Partial<IncomingEvent>) => {
    const before = fake.texts().length;
    await pipeline.handleEvent(event(over));
    return fake.texts().slice(before);
  };
  const user = () => getUserByHandle(db, HANDLE)!;
  return { db, fake, pipeline, event, text, send, user, saved };
}

function codeFor(db: DatabaseSync): string {
  return (db.prepare("SELECT code FROM verification_codes ORDER BY id DESC LIMIT 1").get() as { code: string }).code;
}

test("happy path: welcome, usc email, code, subscriptions, spots, all set", async () => {
  const t = setup();

  const welcome = await t.text("hey troy i lost my airpods");
  // John's words, exactly.
  assert.deepEqual(welcome.slice(0, 5), [
    "hey i'm troy",
    "i'm an ai, but i know a guy for everything",
    "send me a photo of anything on campus and i'll get it to the right person. or just text me like 'lost my airpods at leavey'",
    "reply STOP anytime and i'll leave u alone until u want to talk again",
    "save my contact if u haven't so u know it's me",
  ]);
  assert.match(welcome[5], /usc email/);
  // The judge skip is a poll now, with an honor-system line above it. No "reply JUDGE".
  assert.equal(welcome[6], "hackathon judges can skip this. not a judge? pls don't tap it, i'm trusting u");
  assert.equal(welcome.length, 7);
  assert.ok(!welcome.join(" ").includes("JUDGE"));
  const methods = t.fake.calls.map((c) => c.method);
  // "save my contact" is the bubble right before the card; the poll comes last.
  const card = methods.indexOf("sendContactCard");
  assert.equal(t.fake.calls[card - 1].text, "save my contact if u haven't so u know it's me");
  assert.equal(methods.filter((m) => m === "sendContactCard").length, 1);
  assert.equal(methods[methods.length - 1], "sendPoll");
  assert.equal(t.fake.calls[methods.length - 1].text, "which one are u?: usc student / hackathon judge");
  assert.equal(methods.filter((m) => m === "onAllowed").length, 1);
  const st = getFlowState(t.db, t.user().id)!;
  assert.deepEqual(st.data.judge, { pollId: null, optionIds: ["j-0", "j-1"], mode: "tap" });
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
  // Says plainly that the last location is kept and how to erase it, then how to share (no request could be sent).
  assert.match(subs.join(" "), /i keep the last location u share so alerts and walking times are accurate/);
  assert.match(subs.join(" "), /forget my location/);
  assert.ok(subs.includes("tap the + in this chat, then Location, then Share"));
  assert.ok(subs.includes("or just tell me ur usual spots, or reply skip"));
  assert.equal(t.fake.calls.filter((c) => c.method === "requestLocation").length, 1);

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
  assert.equal(reply[0], "ur in as a judge. this skip is demo only, the real campus version wouldn't have it");
  assert.equal(t.user().verifiedVia, "judge_skip");
  assert.ok(t.user().verifiedAt);
  assert.equal(t.user().uscEmail, null);
  assert.equal(getFlowState(t.db, t.user().id)?.step, "subscriptions");
});

// ---------- the student / judge poll: three ways to answer ----------

test("judge poll, native vote: option 1 is the judge skip, option 0 just asks for the email again", async () => {
  const t = setup({ pollMode: "native" });
  await t.text("hey troy");
  const st = getFlowState(t.db, t.user().id)!;
  assert.deepEqual(st.data.judge, { pollId: "poll-1", optionIds: ["poll-1", "poll-1"], mode: "native" });

  // A vote on some other poll means nothing.
  assert.deepEqual(await t.send({ pollVote: { pollMessageId: "someone-elses-poll", optionIndex: 1 } }), []);
  assert.equal(t.user().verifiedAt, null);

  assert.deepEqual(await t.send({ pollVote: { pollMessageId: "poll-1", optionIndex: 0 } }), ["bet. what's ur usc email?"]);
  assert.equal(t.user().verifiedAt, null);
  assert.equal(getFlowState(t.db, t.user().id)?.step, "email");

  const reply = await t.send({ pollVote: { pollMessageId: "poll-1", optionIndex: 1 } });
  assert.match(reply[0], /demo only, the real campus version wouldn't have it/);
  assert.equal(t.user().verifiedVia, "judge_skip");
  assert.equal(getFlowState(t.db, t.user().id)?.step, "subscriptions");
});

test("judge poll, tapback on an option bubble", async () => {
  const student = setup();
  await student.text("hey troy");
  assert.deepEqual(await student.send({ reaction: { targetMessageId: "j-0", type: "love", removed: false } }), ["bet. what's ur usc email?"]);
  assert.equal(student.user().verifiedAt, null);

  const judge = setup();
  await judge.text("hey troy");
  // A thumbs down, or taking a tapback off, is not a choice. Neither is a tapback on another bubble.
  assert.deepEqual(await judge.send({ reaction: { targetMessageId: "j-1", type: "dislike", removed: false } }), []);
  assert.deepEqual(await judge.send({ reaction: { targetMessageId: "j-1", type: "like", removed: true } }), []);
  assert.deepEqual(await judge.send({ reaction: { targetMessageId: "out-1", type: "like", removed: false } }), []);
  assert.equal(judge.user().verifiedAt, null);
  const reply = await judge.send({ reaction: { targetMessageId: "j-1", type: "like", removed: false } });
  assert.match(reply[0], /ur in as a judge/);
  assert.equal(judge.user().verifiedVia, "judge_skip");
});

test("judge poll, typed: judge, student, 1, 2, or just the usc email", async () => {
  for (const said of ["judge", "JUDGE", "hackathon judge", "i'm a judge", "2"]) {
    const t = setup({ pollMode: "numbered" });
    await t.text("hey troy");
    await t.text(said);
    assert.equal(t.user().verifiedVia, "judge_skip", said);
  }
  for (const said of ["student", "usc student", "1", "im a student"]) {
    const t = setup();
    await t.text("hey troy");
    assert.deepEqual(await t.text(said), ["bet. what's ur usc email?"], said);
    assert.equal(t.user().verifiedAt, null, said);
    assert.equal(getFlowState(t.db, t.user().id)?.step, "email", said);
  }
  const t = setup();
  await t.text("hey troy");
  const sent = await t.text("ttrojan@usc.edu");
  assert.match(sent[0], /sent a 6 digit code to ttrojan@usc\.edu/);
  assert.equal(getFlowState(t.db, t.user().id)?.step, "code");
  // The poll still works after an email was typed (they tapped the wrong thing first).
  await t.send({ reaction: { targetMessageId: "j-1", type: "love", removed: false } });
  assert.equal(t.user().verifiedVia, "judge_skip");
});

// ---------- subscriptions: three ways to answer ----------

test("subscriptions, native poll that takes one choice: the last vote counts, and typed numbers add more", async () => {
  const t = setup({ pollMode: "native" });
  await t.text("hey troy");
  const hint = await t.text("judge");
  assert.match(hint[hint.length - 1], /pick one in the poll, or text me a few like 1 and 3/);
  const st = getFlowState(t.db, t.user().id)!;
  assert.equal(st.data.pollId, "poll-2");
  assert.equal(st.data.mode, "native");
  // A late vote on the judge poll is not a subscription.
  await t.send({ pollVote: { pollMessageId: "poll-1", optionIndex: 1 } });
  assert.deepEqual(getFlowState(t.db, t.user().id)!.data.picked, []);
  const nudge = await t.send({ pollVote: { pollMessageId: "poll-2", optionIndex: 0 } });
  assert.equal(nudge.length, 1);
  assert.deepEqual(await t.send({ pollVote: { pollMessageId: "poll-2", optionIndex: 2 } }), []);
  assert.deepEqual(getFlowState(t.db, t.user().id)!.data.picked, [2]);
  await t.text("and 4");
  assert.deepEqual(t.user().subscriptions, ["events", "class_help"]);
  assert.equal(getFlowState(t.db, t.user().id)?.step, "location");
});

test("subscriptions, native poll that takes several choices: votes add up", async () => {
  const t = setup({ pollMode: "native", caps: { pollMultiple: true } as Partial<AdapterCapabilities> });
  await t.text("hey troy");
  const hint = await t.text("judge");
  assert.match(hint[hint.length - 1], /pick any u want in the poll, then text done/);
  await t.send({ pollVote: { pollMessageId: "poll-2", optionIndex: 0 } });
  await t.send({ pollVote: { pollMessageId: "poll-2", optionIndex: 3 } });
  await t.text("done");
  assert.deepEqual(t.user().subscriptions, ["free_food", "class_help"]);
});

// ---------- location is kept ----------

test("location step: when the provider can send a request, Troy says so instead of explaining the + menu", async () => {
  const t = setup({ canRequestLocation: true });
  await t.text("hey troy");
  await t.text("judge");
  const ask = await t.text("1");
  assert.match(ask[1], /i keep the last location u share/);
  assert.equal(ask[2], "sent u a location request, tap it to share");
  assert.ok(!ask.join(" ").includes("tap the +"));
});

test("location step: a share is saved as the last known location and ends onboarding", async () => {
  const t = setup();
  await t.text("hey troy");
  await t.text("judge");
  await t.text("skip");
  const done = await t.send({ text: "", location: { lat: 34.0205, lng: -118.2856 } });
  assert.equal(done[0], "got it, thx");
  assert.match(done.join(" "), /ur all set/);
  assert.deepEqual(t.saved.get(t.user().id), { lat: 34.0205, lng: -118.2856, source: "find_my" });
  assert.equal(getFlowState(t.db, t.user().id), null);
});

test("a share at an earlier step is saved, thanked, and the open question stays open", async () => {
  const t = setup();
  await t.text("hey troy");
  assert.deepEqual(await t.send({ text: "", location: { lat: 34.02, lng: -118.28 } }), ["got it, thx"]);
  assert.ok(t.saved.has(t.user().id));
  assert.equal(getFlowState(t.db, t.user().id)?.step, "email");
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
  assert.match(why.join(" "), /i only keep the last one u share, and forget my location erases it/);
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
  assert.deepEqual(reply.slice(0, 5), [...TEMPLATES.welcome, TEMPLATES.saveContact]);
  assert.match(reply.join(" "), /ur in as a judge/);
  assert.ok(!reply.join(" ").includes("usc email\n"));
  assert.equal(t.user().verifiedVia, "judge_skip");
  assert.equal(getFlowState(t.db, t.user().id)?.step, "subscriptions");
});
