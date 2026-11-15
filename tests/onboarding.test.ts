import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { AdapterCapabilities, FlowContext, IncomingEvent, MessagingAdapter } from "../src/types.ts";
import { openDb, getUserByHandle, getFlowState, setFlowState } from "../src/db/index.ts";
import { createPipeline } from "../src/pipeline.ts";
import {
  JUDGE_LINE,
  LOCATION_ASK,
  QUICK_CHECK,
  REFERENCE_LINES,
  STUDENT_LINE,
  guessName,
  handleAlertPollVote,
  readEmail,
  setOnboardingDeps,
  settleAlertVotes,
} from "../src/onboarding.ts";
import type { Brief, OnboardingDeps, StepSpec } from "../src/onboarding.ts";
import type { EmailSendResult } from "../src/email.ts";
import { BUILT_IN_TOPICS, listTopics, openTopicRequests, topicsFor } from "../src/topics.ts";
import { TEMPLATES } from "../src/commands.ts";
import { plainTone } from "../src/judge.ts";

const HANDLE = "+12135550100";
const CHAT = "chat-1";
/** Any file that exists stands in for the how-to GIF. */
const GIF = import.meta.filename;

type Call = { method: string; chatId: string; text?: string; id?: string | null };
type Fake = { caps?: Partial<AdapterCapabilities>; pollMode?: "native" | "tap" | "numbered"; canRequestLocation?: boolean; canSendImage?: boolean };

function fakeAdapter({ caps = {}, pollMode = "tap", canRequestLocation = false, canSendImage = true }: Fake = {}) {
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
    async sendImage(chatId, path) {
      calls.push({ method: "sendImage", chatId, text: path });
      return canSendImage ? { messageId: `out-${++n}` } : null;
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
      // The student / judge poll is j-0, j-1; the alerts poll is opt-0..5.
      const who = options.includes("hackathon judge");
      return { optionMessageIds: options.map((_, i) => (who ? `j-${i}` : `opt-${i}`)), mode: "tap" };
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
  const polled = () => calls.filter((c) => c.method === "sendPoll").map((c) => c.text!);
  return { adapter, calls, texts, polled };
}

/** What the injected chat brain was asked, and what it will answer. */
type Brain = {
  asked: { text: string; step: StepSpec }[];
  said: Brief[];
  finished: number;
  pauses: number[];
  email: { result: EmailSendResult; sent: { to: string; code: string }[] };
  verdicts: Record<string, "ok" | "unsure" | "no">;
};

let brain: Brain;

beforeEach(() => {
  brain = { asked: [], said: [], finished: 0, pauses: [], email: { result: "sent", sent: [] }, verdicts: {} };
  const deps: Partial<OnboardingDeps> = {
    // The chat brain: a person-like answer plus the action it read, never a format error.
    async replyAtStep(ctx: FlowContext, step: StepSpec) {
      const text = ctx.event.text.toLowerCase();
      brain.asked.push({ text, step });
      const can = (name: string) => step.canDo.some((c) => c.name === name);
      if (/start over/.test(text) && can("start_over")) return { bubbles: ["sure, from the top"], action: "start_over" };
      if (/wrong one|go back/.test(text) && can("back_to_student_or_judge")) return { bubbles: ["no prob, let's back up"], action: "back_to_student_or_judge" };
      if (/never got|didn't get|send it again/.test(text) && can("resend_code")) return { bubbles: ["on it, sending another"], action: "resend_code" };
      if (/different email|wrong email/.test(text) && can("change_email")) return { bubbles: ["sure, which one should i use?"], action: "change_email" };
      if (/^why/.test(text) && can("why_do_u_ask")) return { bubbles: ["so things fit where u actually are"], action: "why_do_u_ask" };
      if (/don't want|move on|rather not/.test(text) && can("skip_optional_step")) return { bubbles: ["all good, no pressure"], action: "skip_optional_step" };
      if (/text me about/.test(text) && can("suggest_topic")) return { bubbles: [], action: "suggest_topic" };
      if (/what can u do/.test(text)) return { bubbles: ["i get u to whoever can actually help on campus"], action: null };
      return { bubbles: ["haha fair"], action: null };
    },
    // No model: the first fallback, exactly as a real sayInHisWords would when the model is down.
    async sayInHisWords(_ctx: FlowContext, brief: Brief) {
      brain.said.push(brief);
      return brief.fallback[0]!;
    },
    async afterOnboarding() {
      brain.finished++;
    },
    // John's own version of each dictated line, so the assertions below can name it.
    pickLine: (_ctx, key) => [...REFERENCE_LINES[key][0]],
    async judgeTopic(text: string) {
      return brain.verdicts[text] ?? "unsure";
    },
    async sendEmail(to: string, code: string) {
      brain.email.sent.push({ to, code });
      return brain.email.result;
    },
    async pause(ms: number) {
      brain.pauses.push(ms);
    },
    cardBeatMs: 1500,
    // Long enough that a burst never settles by itself mid-test: tests settle it by hand.
    settleMs: 60_000,
    gifPath: GIF,
  };
  setOnboardingDeps(deps);
});

afterEach(async () => {
  await settleAlertVotes();
  setOnboardingDeps(null);
});

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
  /** Let a burst of votes settle and return what Troy said about it. */
  const settled = async () => {
    const before = fake.texts().length;
    await settleAlertVotes();
    return fake.texts().slice(before);
  };
  const tap = (id: string, type: "love" | "like" | "dislike" = "like", removed = false) => send({ reaction: { targetMessageId: id, type, removed } });
  const user = () => getUserByHandle(db, HANDLE)!;
  const step = () => getFlowState(db, user().id)?.step ?? null;
  const subs = () => topicsFor(db, user().id).map((t) => t.key);
  const idOf = (bubble: string) => fake.calls.findLast((c) => c.method === "sendMessage" && c.text === bubble)!.id!;
  return { db, fake, pipeline, event, text, send, tap, settled, user, step, subs, idOf, saved };
}

function codeFor(db: DatabaseSync): string {
  return (db.prepare("SELECT code FROM verification_codes ORDER BY id DESC LIMIT 1").get() as { code: string }).code;
}
const codeCount = (db: DatabaseSync) => (db.prepare("SELECT COUNT(*) AS n FROM verification_codes").get() as { n: number }).n;

async function asJudge(opts: Fake = {}) {
  const t = setup(opts);
  await t.text("hey troy");
  await t.text("judge");
  assert.equal(t.step(), "alerts");
  return t;
}

async function toLocationStep(opts: Fake = {}) {
  const t = await asJudge(opts);
  await t.text("none");
  assert.equal(t.step(), "location");
  return t;
}

/** The one bubble a judge can tap for plain English (src/judge.ts). */
const TONE_TAPS = ["tap ❤️ on this if u want me to drop the slang", "want me to drop the slang? tap ❤️ on this one", "heart this text if u'd rather i drop the slang"];

const ALERT_OPTIONS = [...BUILT_IN_TOPICS.map((b) => b.label), "something else"].join(" / ");

// ---------- the whole student path ----------

test("student path: welcome, quick check, a silently fixed email, a spaced code, votes, a share, and the first ten minutes begin", async () => {
  const t = setup();

  const welcome = await t.text("hey troy i lost my airpods");
  // John's words, exactly.
  assert.deepEqual(welcome, [
    "hey i'm troy",
    "i'm an ai, but i know a guy for everything",
    "send me a photo of anything on campus and i'll get it to the right person. or just text me like 'lost my airpods at leavey'",
    "reply STOP anytime and i'll leave u alone until u want to talk again",
    "save my contact if u haven't so u know it's me",
  ]);
  const methods = t.fake.calls.map((c) => c.method);
  // "save my contact" is the bubble right before the card; then the longer beat; the quick check poll comes last.
  const card = methods.indexOf("sendContactCard");
  assert.equal(t.fake.calls[card - 1]!.text, "save my contact if u haven't so u know it's me");
  assert.equal(methods.filter((m) => m === "sendContactCard").length, 1);
  assert.deepEqual(brain.pauses, [1500]);
  assert.equal(methods[methods.length - 1], "sendPoll");
  assert.equal(t.fake.calls[methods.length - 1]!.text, `${QUICK_CHECK}: usc student / hackathon judge`);
  assert.equal(QUICK_CHECK, "quick check, are u a usc student or a hackathon judge? (pls be honest)");
  assert.equal(methods.filter((m) => m === "onAllowed").length, 1);
  assert.equal(t.step(), "who");
  assert.deepEqual(getFlowState(t.db, t.user().id)!.data.judge, { pollId: null, optionIds: ["j-0", "j-1"], mode: "tap" });
  // The old lines are gone.
  assert.ok(!t.fake.texts().join(" ").includes("gotta make sure ur a trojan"));
  assert.ok(!t.fake.texts().join(" ").includes("hackathon judges can skip this"));

  assert.deepEqual(await t.tap("j-0", "love"), ["great, what's ur usc email?"]);
  assert.equal(t.step(), "email");

  // Capitals, spaces around it and a trailing period are fixed without a word.
  const sent = await t.text("  Tommy.Trojan@USC.edu. ");
  assert.ok(!sent.join(" ").includes("did u mean"));
  assert.match(sent.join(" "), /6 digit code/);
  assert.match(sent.join(" "), /tommy\.trojan@usc\.edu/);
  assert.deepEqual(brain.email.sent.map((s) => s.to), ["tommy.trojan@usc.edu"]);
  assert.equal(t.step(), "code");
  assert.equal(t.user().verifiedAt, null);

  // Spaces or dashes inside the six digits are fine.
  const code = codeFor(t.db);
  const ok = await t.text(`${code.slice(0, 3)} - ${code.slice(3)}`);
  assert.match(ok[0]!, /verified/);
  assert.equal(t.user().uscEmail, "tommy.trojan@usc.edu");
  assert.equal(t.user().verifiedVia, "usc_email");
  assert.equal(t.user().name, "Tommy Trojan");
  assert.ok(t.user().verifiedAt);
  assert.equal(t.step(), "alerts");
  const alertsPoll = t.fake.polled()[1]!;
  assert.ok(alertsPoll.endsWith(`: ${ALERT_OPTIONS}`), alertsPoll);

  await t.tap("opt-0");
  await t.tap("opt-3", "love");
  assert.deepEqual(t.subs(), ["free_nearby", "pickup"]);
  const confirm = await t.settled();
  assert.match(confirm[0]!, /when there's free food or free stuff near u/);
  assert.match(confirm[0]!, /when there's a pickup game near u/);
  assert.ok(confirm.includes(LOCATION_ASK));
  assert.equal(t.step(), "location");

  const done = await t.send({ text: "", location: { lat: 34.0205, lng: -118.2856 } });
  assert.equal(done.length, 1);
  assert.deepEqual(t.saved.get(t.user().id), { lat: 34.0205, lng: -118.2856, source: "find_my" });
  assert.equal(getFlowState(t.db, t.user().id), null);
  assert.equal(brain.finished, 1);

  // A verified user never sees onboarding again.
  const later = await t.text("hey troy");
  assert.ok(!later.includes("hey i'm troy"));
  assert.ok(!later.join(" ").includes("usc email"));
  assert.equal(t.fake.polled().length, 2);
  assert.equal(brain.finished, 1);
});

// ---------- forgiving email ----------

test("readEmail: noise is fixed silently, likely typos are suggested, other things are never called an email", () => {
  for (const ok of ["tommy@usc.edu", "Tommy@USC.EDU", " tommy@usc.edu ", "tommy@usc.edu.", "my email is tommy@usc.edu", "it's tommy@usc.edu thanks"]) {
    assert.deepEqual(readEmail(ok), { kind: "ok", email: "tommy@usc.edu" }, ok);
  }
  for (const typo of ["tommy@usc,edu", "tommy@usc.eud", "tommy@uscedu", "tommy@usc.com", "tommy @usc.edu", "tommy@ usc.edu", "tommy@usc. edu", "Tommy@USC,EDU.", "tommy@usc"]) {
    assert.deepEqual(readEmail(typo), { kind: "typo", email: "tommy@usc.edu" }, typo);
  }
  // A space in the middle of the name.
  assert.deepEqual(readEmail("tommy trojan@usc.edu"), { kind: "typo", email: "tommytrojan@usc.edu" });
  // Lookalike and other domains never pass.
  assert.deepEqual(readEmail("tommy@gmail.com"), { kind: "not_usc", email: "tommy@gmail.com" });
  assert.deepEqual(readEmail("tommy@usc.edu.evil.com"), { kind: "not_usc", email: "tommy@usc.edu.evil.com" });
  assert.deepEqual(readEmail("tommy@ucsd.edu"), { kind: "not_usc", email: "tommy@ucsd.edu" });
  for (const attempt of ["@usc.edu", "tommy@", "ttrojan usc.edu", "ttrojan at usc dot edu"]) assert.deepEqual(readEmail(attempt), { kind: "attempt" }, attempt);
  for (const not of ["can we start over", "what can u do", "idk", "why do u need my usc email?", "", "i'm a judge"]) assert.equal(readEmail(not), null, not);
});

test("a likely typo gets did-u-mean with the fixed address in quotes, and a thumbs up on that bubble confirms it", async () => {
  for (const typed of ["tommy@usc,edu", "tommy@usc.eud", "tommy@uscedu", "tommy@usc.com", "tommy @usc.edu"]) {
    const t = setup();
    await t.text("hey troy");
    const ask = await t.text(typed);
    assert.deepEqual(ask, ['did u mean "tommy@usc.edu"? if so i\'ll send the code now'], typed);
    assert.equal(t.step(), "email_confirm");
    assert.equal(codeCount(t.db), 0);

    // A thumbs up on some other bubble is only an acknowledgment. A thumbs up on the question is a yes.
    assert.deepEqual(await t.tap("out-1"), []);
    assert.equal(codeCount(t.db), 0);
    const sent = await t.tap(t.idOf(ask[0]!));
    assert.match(sent.join(" "), /tommy@usc\.edu/);
    assert.equal(t.step(), "code");
    assert.deepEqual(brain.email.sent.at(-1)!.to, "tommy@usc.edu");
  }
});

test("did-u-mean: any typed yes confirms, a no asks for the right one, a question is never a yes", async () => {
  for (const yes of ["yes", "yep", "yeah", "ya", "sure", "ok", "bet", "do it", "Yes!", "y"]) {
    const t = setup();
    await t.text("hey troy");
    await t.text("tommy@usc,edu");
    await t.text(yes);
    assert.equal(t.step(), "code", yes);
  }
  const t = setup();
  await t.text("hey troy");
  await t.text("tommy@usc,edu");
  // "ok but why?" goes to the chat brain; nothing is sent.
  await t.text("ok but why?");
  assert.equal(codeCount(t.db), 0);
  assert.equal(t.step(), "email_confirm");
  assert.equal(brain.asked.length, 1);
  assert.match(brain.asked[0]!.step.waitingFor, /tommy@usc\.edu/);

  const again = await t.text("nah");
  assert.equal(t.step(), "email");
  assert.match(again.join(" "), /usc email/);
  assert.equal(codeCount(t.db), 0);
  // A thumbs down on the question is a no as well.
  const ask = await t.text("tommy@usc.eud");
  await t.tap(t.idOf(ask[0]!), "dislike");
  assert.equal(t.step(), "email");
});

// ---------- judge: three ways ----------

test("judge by native vote: the exact line, verifiedVia judge_skip, and a vote on another poll means nothing", async () => {
  const t = setup({ pollMode: "native" });
  await t.text("hey troy");
  assert.deepEqual(getFlowState(t.db, t.user().id)!.data.judge, { pollId: "poll-1", optionIds: ["poll-1", "poll-1"], mode: "native" });
  assert.deepEqual(await t.send({ pollVote: { pollMessageId: "someone-elses-poll", optionIndex: 1 } }), []);
  assert.equal(t.user().verifiedAt, null);

  assert.deepEqual(await t.send({ pollVote: { pollMessageId: "poll-1", optionIndex: 0 } }), [STUDENT_LINE]);
  assert.equal(t.step(), "email");
  // Tapped the wrong one first: the poll still works.
  const reply = await t.send({ pollVote: { pollMessageId: "poll-1", optionIndex: 1 } });
  assert.equal(reply[0], "thanks for checking me out. i'll go ahead and skip verification for u");
  assert.equal(reply[0], JUDGE_LINE);
  assert.equal(t.user().verifiedVia, "judge_skip");
  assert.equal(t.user().uscEmail, null);
  assert.equal(t.step(), "alerts");
});

test("judge by tapback on the option bubble", async () => {
  const t = setup();
  await t.text("hey troy");
  // A thumbs down, taking a tapback off, or a tapback on another bubble is not a choice.
  assert.deepEqual(await t.tap("j-1", "dislike"), []);
  assert.deepEqual(await t.tap("j-1", "like", true), []);
  assert.deepEqual(await t.tap("out-1"), []);
  assert.equal(t.user().verifiedAt, null);
  const reply = await t.tap("j-1");
  assert.equal(reply[0], JUDGE_LINE);
  assert.equal(t.user().verifiedVia, "judge_skip");
});

test("judge or student by typing, at any step before verification", async () => {
  for (const said of ["judge", "JUDGE", "hackathon judge", "i'm a judge", "2"]) {
    const t = setup({ pollMode: "numbered" });
    await t.text("hey troy");
    const reply = await t.text(said);
    assert.equal(reply[0], JUDGE_LINE, said);
    assert.equal(t.user().verifiedVia, "judge_skip", said);
  }
  for (const said of ["student", "usc student", "1", "im a student"]) {
    const t = setup();
    await t.text("hey troy");
    assert.deepEqual(await t.text(said), [STUDENT_LINE], said);
    assert.equal(t.step(), "email", said);
  }
  // At the code step too, and straight after STOP then START wiped the state.
  const mid = setup();
  await mid.text("hey troy");
  await mid.text("ttrojan@usc.edu");
  await mid.text("JUDGE");
  assert.equal(mid.user().verifiedVia, "judge_skip");

  const back = setup();
  await back.text("hey troy");
  await back.text("stop");
  await back.text("start");
  const reply = await back.text("JUDGE");
  assert.deepEqual(reply.slice(0, 5), [...TEMPLATES.welcome, TEMPLATES.saveContact]);
  assert.ok(reply.includes(JUDGE_LINE));
  assert.equal(back.user().verifiedVia, "judge_skip");
});

// ---------- discretion ----------

test('"can we start over" at the email step restarts instead of a format error', async () => {
  const t = setup();
  await t.text("hey troy");
  await t.text("student");
  const reply = await t.text("can we start over");
  assert.deepEqual(reply, ["sure, from the top"]);
  assert.ok(!reply.join(" ").includes("@usc.edu"));
  assert.ok(!/doesn't look like/.test(reply.join(" ")));
  // The chat brain knew which step was open and which actions were real.
  assert.equal(brain.asked.length, 1);
  assert.match(brain.asked[0]!.step.waitingFor, /usc email/);
  assert.deepEqual(brain.asked[0]!.step.canDo.map((c) => c.name), ["back_to_student_or_judge", "start_over", "why_do_u_ask", "continue"]);
  // Code performed it: the quick check went out again and the step is back at the start.
  assert.equal(t.fake.polled().length, 2);
  assert.equal(t.fake.polled()[1], `${QUICK_CHECK}: usc student / hackathon judge`);
  assert.equal(t.step(), "who");
});

test("the format hint is only for something that looks like an attempted email", async () => {
  const t = setup();
  await t.text("hey troy");
  for (const attempt of ["tommy@gmail.com", "tommy@usc.edu.evil.com", "ttrojan usc.edu", "@usc.edu"]) {
    const reply = await t.text(attempt);
    assert.match(reply.join(" "), /@usc\.edu/, attempt);
    assert.equal(codeCount(t.db), 0, attempt);
  }
  assert.equal(brain.asked.length, 0);
  // Never the same line twice in a row.
  const a = await t.text("tommy@gmail.com");
  const b = await t.text("tommy@gmail.com");
  assert.notDeepEqual(a, b);

  // Anything else is answered like a person and the step stays open.
  for (const other of ["idk", "what can u do", "lol"]) {
    const reply = await t.text(other);
    assert.ok(!reply.join(" ").includes("@usc.edu"), other);
  }
  assert.equal(brain.asked.length, 3);
  assert.equal(t.step(), "email");
});

test("code step: the brain can resend, change the email or go back, and code still does every check", async () => {
  const t = setup();
  await t.text("hey troy");
  await t.text("ttrojan@usc.edu");
  const first = codeFor(t.db);

  const resent = await t.text("i never got it");
  assert.equal(resent[0], "on it, sending another");
  assert.match(resent.join(" "), /ttrojan@usc\.edu/);
  assert.equal(brain.email.sent.length, 2);
  assert.equal(t.step(), "code");
  // The old code stopped working the moment the new one went out.
  if (first !== codeFor(t.db)) await t.text(first);
  assert.equal(t.user().verifiedAt, null);

  assert.deepEqual(await t.text("i put the wrong email"), ["sure, which one should i use?"]);
  assert.equal(t.step(), "email");
  await t.text("tommy.trojan@usc.edu");
  assert.equal(t.step(), "code");

  // Digits that aren't six of them are an attempt at the code: a plain hint, no brain.
  const asked = brain.asked.length;
  const hint = await t.text("12345");
  assert.match(hint.join(" "), /6 digit/);
  assert.equal(brain.asked.length, asked);

  await t.text("wait i picked the wrong one");
  assert.equal(t.step(), "who");
  assert.equal(t.user().verifiedAt, null);
});

test("wrong code: 5 tries, then even the right code is refused until resend", async () => {
  const t = setup();
  await t.text("hey troy");
  await t.text("ttrojan@usc.edu");
  const code = codeFor(t.db);
  const wrong = code === "000000" ? "111111" : "000000";
  const said: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const r = await t.text(wrong);
    said.push(r[0]!);
    if (i < 5) assert.ok(r[0]!.includes(`${5 - i} ${5 - i === 1 ? "try" : "tries"} left`), r[0]);
    else assert.match(r[0]!, /out of tries|last try/);
  }
  // The count is code's; the wording moves.
  assert.ok(new Set(said.map((s) => s.replace(/\d/g, "#"))).size > 1);
  const locked = await t.text(code);
  assert.match(locked[0]!, /"resend"/);
  assert.equal(t.user().verifiedAt, null);

  await t.text("resend");
  await t.text(codeFor(t.db));
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
  assert.match(r[0]!, /expired|timed out/);
  assert.match(r[0]!, /"resend"/);
  assert.equal(t.user().verifiedAt, null);
});

// ---------- a failed send ----------

test("a failed send says so honestly, never asks for the same email again, and offers real ways forward", async () => {
  for (const reason of ["error", "rejected", "no_key"] as const) {
    const t = setup();
    brain.email = { result: reason, sent: [] };
    await t.text("hey troy");
    const reply = await t.text("ttrojan@usc.edu");
    const all = reply.join(" ");
    assert.match(all, /didn't go out|couldn't send|couldn't get that code out/, reason);
    assert.ok(!/again to retry|email again/.test(all), reason);
    assert.ok(!/text me ur usc email/.test(all), reason);
    assert.match(all, /"try again"/, reason);
    assert.match(all, /judge/, reason);
    if (reason !== "no_key") assert.match(all, /different usc email|another usc email/, reason);
    // The brief the wording came from names every way forward.
    const brief = brain.said.at(-1)!;
    assert.ok(brief.mustCover.includes("the code email did not go out"), reason);
    assert.ok(brief.mustCover.some((m) => /try again/.test(m)), reason);
    // The step waits for an email, with the failed address remembered. No usable code is left behind.
    assert.equal(t.step(), "email", reason);
    assert.equal(t.user().verifiedAt, null, reason);
    await t.text(codeFor(t.db));
    assert.equal(t.user().verifiedAt, null, reason);

    // "try again" goes to the same address without it being typed twice.
    brain.email.result = "sent";
    const retry = await t.text("try again");
    assert.match(retry.join(" "), /ttrojan@usc\.edu/, reason);
    assert.deepEqual(brain.email.sent.map((s) => s.to), ["ttrojan@usc.edu", "ttrojan@usc.edu"], reason);
    assert.equal(t.step(), "code", reason);
  }
});

test("after a failed send: a different address, the judge path, or asking in other words all work", async () => {
  const other = setup();
  brain.email.result = "error";
  await other.text("hey troy");
  await other.text("ttrojan@usc.edu");
  brain.email.result = "sent";
  await other.text("tommy.trojan@usc.edu");
  assert.equal(other.step(), "code");
  assert.equal(brain.email.sent.at(-1)!.to, "tommy.trojan@usc.edu");

  const judge = setup();
  brain.email.result = "error";
  await judge.text("hey troy");
  await judge.text("ttrojan@usc.edu");
  const reply = await judge.text("i'm a judge");
  assert.equal(reply[0], JUDGE_LINE);
  assert.equal(judge.user().verifiedVia, "judge_skip");

  const words = setup();
  brain.email = { result: "error", sent: [] };
  await words.text("hey troy");
  await words.text("ttrojan@usc.edu");
  brain.email.result = "sent";
  // Read by the chat brain, performed by code.
  const again = await words.text("can u send it again");
  assert.equal(again[0], "on it, sending another");
  assert.equal(words.step(), "code");
  assert.deepEqual(brain.email.sent.map((s) => s.to), ["ttrojan@usc.edu", "ttrojan@usc.edu"]);
});

// ---------- alerts ----------

test("alerts poll: the options are the built-in topics in order plus something else, with no instructions repeated", async () => {
  const t = await asJudge({ pollMode: "native" });
  const poll = t.fake.polled()[1]!;
  assert.ok(
    poll.endsWith(": free food and stuff nearby 🌯 / rides home and to lax ✈️ / extra tickets for game day 🏈 / pickup games right now 🏀 / experienced trojans 💼 / something else"),
    poll,
  );
  // A native poll needs no how-to line: the last bubble before it is the judge's tone tap, not instructions.
  assert.ok(TONE_TAPS.includes(t.fake.texts().at(-1)!), t.fake.texts().at(-1) ?? "");
  assert.ok(t.fake.texts().includes(JUDGE_LINE));
});

test("votes are saved as they arrive, and a burst gets one reply in plain words", async () => {
  const t = await asJudge({ pollMode: "native" });
  const poll = "poll-2";
  // A late vote on the student / judge poll is not an alert.
  await t.send({ pollVote: { pollMessageId: "poll-1", optionIndex: 1 } });
  assert.deepEqual(t.subs(), []);

  assert.deepEqual(await t.send({ pollVote: { pollMessageId: poll, optionIndex: 0 } }), []);
  assert.deepEqual(t.subs(), ["free_nearby"]);
  assert.deepEqual(await t.send({ pollVote: { pollMessageId: poll, optionIndex: 2 } }), []);
  assert.deepEqual(await t.send({ pollVote: { pollMessageId: poll, optionIndex: 4 } }), []);
  // Saved with no "done" and before he has said a word.
  assert.deepEqual(t.subs(), ["free_nearby", "tickets", "experienced"]);
  assert.deepEqual(t.user().subscriptions, ["free_nearby", "tickets", "experienced"]);
  assert.equal(t.step(), "alerts");

  const reply = await t.settled();
  const confirm = reply.slice(0, reply.indexOf(LOCATION_ASK));
  // Two picks to a bubble, then the one line about adding more.
  assert.equal(confirm.length, 3);
  // Each topic's plain description, never the poll label.
  for (const key of ["free_nearby", "tickets", "experienced"]) assert.ok(confirm.join(" ").includes(BUILT_IN_TOPICS.find((b) => b.key === key)!.plain), key);
  for (const b of BUILT_IN_TOPICS) assert.ok(!confirm.join(" ").includes(b.label.replace(/ \S+$/, "")), b.label);
  assert.match(confirm[2]!, /add more|more later/);
  // No instructions repeated.
  assert.ok(!/numbers|text done|"done"/.test(confirm.join(" ")));
  assert.equal(t.step(), "location");
  // One reply for the burst: settling again says nothing.
  assert.deepEqual(await t.settled(), []);
  // The brief asked for natural words that cover every pick.
  const brief = brain.said.at(-1)!;
  assert.equal(brief.mustCover.length, 4);
});

test("alerts by tapback: taking one off before he answers drops it", async () => {
  const t = await asJudge();
  await t.tap("opt-0", "love");
  await t.tap("opt-1");
  await t.tap("opt-1", "like", true);
  await t.tap("opt-3");
  assert.deepEqual(t.subs(), ["free_nearby", "pickup"]);
  const reply = await t.settled();
  assert.ok(!reply.join(" ").includes("headed the same way"));
  assert.equal(t.step(), "location");
});

test("alerts typed: numbers, words, all, done and none all work, and typing covers votes still waiting", async () => {
  const nums = await asJudge({ pollMode: "numbered" });
  await nums.text("1 and 3");
  assert.deepEqual(nums.subs(), ["free_nearby", "tickets"]);
  assert.equal(nums.step(), "location");

  const words = await asJudge();
  const reply = await words.text("food and rides");
  assert.deepEqual(words.subs(), ["free_nearby", "rides"]);
  assert.match(reply[0]!, /free food or free stuff near u/);

  const all = await asJudge();
  await all.text("all of them");
  assert.equal(all.subs().length, 5);

  const done = await asJudge();
  await done.tap("opt-2");
  const said = await done.text("done");
  assert.deepEqual(done.subs(), ["tickets"]);
  assert.match(said[0]!, /extra ticket/);
  assert.equal(done.step(), "location");
  // The typed reply covered the vote: nothing more comes when the burst would have settled.
  assert.deepEqual(await done.settled(), []);

  const none = await asJudge();
  const no = await none.text("none");
  assert.deepEqual(none.subs(), []);
  assert.match(no[0]!, /no alerts|none for now/);
  assert.equal(none.step(), "location");
});

test('"what can u do" in the middle of the alerts step is answered, and the step continues', async () => {
  const t = await asJudge({ pollMode: "native" });
  const reply = await t.text("what can u do");
  assert.deepEqual(reply, ["i get u to whoever can actually help on campus"]);
  assert.equal(brain.asked.length, 1);
  assert.match(brain.asked[0]!.step.waitingFor, /which texts u want/);
  assert.equal(t.step(), "alerts");
  assert.deepEqual(t.subs(), []);
  // He never answered it with a topic confirmation.
  assert.ok(!reply.join(" ").includes("i'll text u"));

  await t.send({ pollVote: { pollMessageId: "poll-2", optionIndex: 3 } });
  const confirm = await t.settled();
  assert.match(confirm[0]!, /pickup game near u/);
  assert.equal(t.step(), "location");
});

test("the poll stays live: a late vote, long after onboarding, is saved and acknowledged once per burst", async () => {
  const t = await asJudge({ pollMode: "native" });
  await t.send({ pollVote: { pollMessageId: "poll-2", optionIndex: 0 } });
  await t.settled();
  await t.text("leavey and the village");
  assert.equal(getFlowState(t.db, t.user().id), null);
  assert.equal(brain.finished, 1);

  // What the pipeline does for a tap from a verified user: ask onboarding first.
  const out: string[] = [];
  const late = (over: Partial<IncomingEvent>): FlowContext => ({
    db: t.db,
    user: t.user(),
    event: t.event(over),
    intent: { flow: "food", action: "poll_vote", details: {}, source: "fallback" },
    state: getFlowState(t.db, t.user().id),
    adapter: t.fake.adapter,
    say: async (...bubbles) => bubbles.map((b) => (out.push(typeof b === "string" ? b : b.text), null)),
    sayTo: async (_id, ...bubbles) => bubbles.map(() => null),
    sayToOwed: async (_id, ...bubbles) => bubbles.map(() => null),
    setState: (s) => setFlowState(t.db, t.user().id, s),
    setStateFor: (id, s) => setFlowState(t.db, id, s),
  });

  // Some other poll, a tapback on some bubble, or a text: not his.
  assert.equal(await handleAlertPollVote(late({ pollVote: { pollMessageId: "try-me-poll", optionIndex: 0 } })), false);
  assert.equal(await handleAlertPollVote(late({ reaction: { targetMessageId: "out-3", type: "like", removed: false } })), false);
  assert.equal(await handleAlertPollVote(late({ text: "hi" })), false);
  assert.deepEqual(t.subs(), ["free_nearby"]);

  assert.equal(await handleAlertPollVote(late({ pollVote: { pollMessageId: "poll-2", optionIndex: 3 } })), true);
  assert.deepEqual(t.subs(), ["free_nearby", "pickup"]);
  assert.deepEqual(out, []);
  await settleAlertVotes();
  assert.equal(out.length, 1);
  assert.match(out[0]!, /that one/);

  // Two close together: one reply.
  out.length = 0;
  await handleAlertPollVote(late({ pollVote: { pollMessageId: "poll-2", optionIndex: 1 } }));
  await handleAlertPollVote(late({ pollVote: { pollMessageId: "poll-2", optionIndex: 2 } }));
  await settleAlertVotes();
  assert.deepEqual(t.subs(), ["free_nearby", "rides", "tickets", "pickup"]);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /those|them/);

  // A vote taken back is dropped the same way.
  out.length = 0;
  const removed = late({ pollVote: { pollMessageId: "poll-2", optionIndex: 1 } });
  (removed.event.pollVote as { removed?: boolean }).removed = true;
  assert.equal(await handleAlertPollVote(removed), true);
  await settleAlertVotes();
  assert.deepEqual(t.subs(), ["free_nearby", "tickets", "pickup"]);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /off|dropped/);
  // Onboarding did not reopen.
  assert.equal(getFlowState(t.db, t.user().id), null);

  // "something else", late: he asks what they have in mind, takes the answer, and nothing else restarts.
  out.length = 0;
  await handleAlertPollVote(late({ pollVote: { pollMessageId: "poll-2", optionIndex: 5 } }));
  await settleAlertVotes();
  assert.equal(out.length, 1);
  assert.match(out[0]!, /\?|tell me/);
  assert.equal(t.step(), "topic");
  brain.verdicts["board game nights"] = "ok";
  const made = await t.text("board game nights");
  assert.match(made.join(" "), /board game nights/);
  assert.ok(t.subs().includes("board_game_nights"));
  assert.equal(getFlowState(t.db, t.user().id), null);
  assert.ok(!made.includes(LOCATION_ASK));
  assert.equal(brain.finished, 1);
});

test("something else tapped while the location ask is open: the next text is the topic, never a usual spot, and the ask is not sent again", async () => {
  const t = await asJudge({ pollMode: "native" });
  await t.send({ pollVote: { pollMessageId: "poll-2", optionIndex: 0 } });
  await t.settled();
  assert.equal(t.step(), "location");

  await t.send({ pollVote: { pollMessageId: "poll-2", optionIndex: 5 } });
  const ask = await t.settled();
  assert.equal(ask.length, 1);
  assert.match(ask[0]!, /\?|tell me/);
  assert.equal(t.step(), "topic");

  brain.verdicts["language tutors"] = "ok";
  const reply = await t.text("language tutors");
  assert.ok(t.subs().includes("language_tutors"));
  assert.deepEqual(t.user().usualSpots, [], "not saved as a spot");
  // Back at the location ask, said once and lightly: no second GIF, no second full ask.
  assert.equal(t.step(), "location");
  assert.ok(!reply.includes(LOCATION_ASK));
  assert.match(reply.at(-1)!, /share ur location|location share/);
  assert.equal(t.fake.calls.filter((c) => c.method === "sendImage").length, 1);
  assert.equal(brain.finished, 0);

  // And the location step still works after it.
  await t.text("leavey and the village");
  assert.deepEqual(t.user().usualSpots, ["leavey", "the village"]);
  assert.equal(brain.finished, 1);
});

test("a why question the brain answers with no words still gets its answer, not the step's nudge", async () => {
  const t = await toLocationStep();
  setOnboardingDeps({ ...currentDeps(), replyAtStep: async () => ({ bubbles: [], action: "why_do_u_ask" }) });
  const why = await t.text("why do u need my location tho");
  assert.equal(why.length, 1);
  assert.match(why[0]!, /alerts and walking times|actually near u/);
  assert.match(why[0]!, /"forget my location"/);
  assert.equal(t.step(), "location");
});

// ---------- something else ----------

async function atSomethingElse() {
  const t = await asJudge({ pollMode: "native" });
  await t.send({ pollVote: { pollMessageId: "poll-2", optionIndex: 0 } });
  await t.send({ pollVote: { pollMessageId: "poll-2", optionIndex: 5 } });
  const ask = await t.settled();
  // He confirms the pick he got, then asks what they have in mind. No location ask yet.
  assert.match(ask[0]!, /free food or free stuff near u/);
  assert.equal(ask.length, 2);
  assert.ok(!ask.includes(LOCATION_ASK));
  assert.equal(t.step(), "topic");
  return t;
}

test("something else, a topic that already exists: they are added, nothing new is made", async () => {
  const t = await atSomethingElse();
  const before = listTopics(t.db).length;
  const reply = await t.text("study buddies for hoops");
  assert.equal(listTopics(t.db).length, before);
  assert.deepEqual(t.subs(), ["free_nearby", "pickup"]);
  assert.match(reply[0]!, /pickup game near u/);
  assert.ok(reply.includes(LOCATION_ASK));
  assert.equal(t.step(), "location");
});

test("something else, a new reasonable topic: created, they are on it, and he celebrates it", async () => {
  const t = await atSomethingElse();
  brain.verdicts["language tutors"] = "ok";
  const reply = await t.text("language tutors");
  const made = listTopics(t.db).find((x) => !x.builtIn)!;
  assert.equal(made.label, "language tutors");
  assert.ok(t.subs().includes(made.key));
  const suggestedBy = (t.db.prepare("SELECT suggestedBy FROM topics WHERE id = ?").get(made.id) as { suggestedBy: number }).suggestedBy;
  assert.equal(suggestedBy, t.user().id);
  const brief = brain.said.at(-1)!;
  assert.deepEqual(brief.mustCover.slice(0, 3), ["that topic didn't exist before", "it's a great idea", "it is now an option for everyone"]);
  assert.ok(brief.fallback.length >= 3);
  assert.match(reply.slice(0, 2).join(" "), /everyone/);
  assert.ok(reply.includes(LOCATION_ASK));

  // Created, not parked for review.
  assert.equal(openTopicRequests(t.db).length, 0);
});

test("something else, hard to judge: nothing is created, the request is saved for john, and he says he'll text them", async () => {
  const t = await atSomethingElse();
  const before = listTopics(t.db).length;
  const reply = await t.text("vibes");
  assert.equal(listTopics(t.db).length, before);
  assert.deepEqual(openTopicRequests(t.db).map((r) => [r.text, r.userId]), [["vibes", t.user().id]]);
  assert.deepEqual(t.subs(), ["free_nearby"]);
  assert.match(reply[0]!, /when something comes up|when there's something/);
  assert.ok(!/added|option for everyone/.test(reply[0]!));
  assert.equal(t.step(), "location");
});

test("something else, inappropriate: one easy line, never created, never saved", async () => {
  const t = await atSomethingElse();
  brain.verdicts["weed plugs"] = "no";
  const before = listTopics(t.db).length;
  const reply = await t.text("weed plugs");
  assert.equal(listTopics(t.db).length, before);
  assert.equal(openTopicRequests(t.db).length, 0);
  assert.match(reply[0]!, /sorry/);
  assert.ok(reply[0]!.length < 60);
  assert.deepEqual(t.subs(), ["free_nearby"]);
  assert.equal(t.step(), "location");
});

test("something else: typed instead of voted, a question is answered first, and never mind moves on", async () => {
  const typed = await asJudge();
  const ask = await typed.text("something else");
  assert.equal(ask.length, 1);
  assert.equal(typed.step(), "topic");
  // A question is not a topic.
  assert.deepEqual(await typed.text("like what kind of thing?"), ["haha fair"]);
  assert.equal(typed.step(), "topic");
  assert.match(brain.asked.at(-1)!.step.waitingFor, /what u'd want texts about/);
  const out = await typed.text("nvm");
  assert.equal(typed.step(), "location");
  assert.ok(out.includes(LOCATION_ASK));

  // A topic named in a sentence at the poll itself: the brain reads it, code runs the same three outcomes.
  const direct = await asJudge();
  const reply = await direct.text("can u text me about salsa nights?");
  assert.deepEqual(openTopicRequests(direct.db).map((r) => r.text), ["salsa nights"]);
  assert.match(reply[0]!, /when something comes up|when there's something/);
  assert.equal(direct.step(), "location");
});

// ---------- location ----------

test("location ask: john's line, the gif, what is kept and how to erase it, then a positive alternative. never the word skip", async () => {
  const t = await asJudge();
  const ask = (await t.text("none")).slice(1);
  assert.equal(ask[0], "btw, i work best when i know where u are. here's how to share ur location with me (takes 10 seconds, turn it off anytime) 👇");
  assert.equal(ask.length, 3);
  // The GIF goes out right under the line, through the adapter. No Find My request when it did.
  const calls = t.fake.calls;
  const gif = calls.findIndex((c) => c.method === "sendImage");
  assert.equal(calls[gif]!.text, GIF);
  assert.equal(calls[gif - 1]!.text, LOCATION_ASK);
  assert.equal(calls.filter((c) => c.method === "requestLocation").length, 0);
  assert.match(ask[1]!, /last spot u share/);
  assert.match(ask[1]!, /"forget my location"/);
  assert.match(ask[2]!, /where u usually|ur usual spots/);
  assert.match(ask[2]!, /"leavey and the village"/);
  assert.ok(!/skip/i.test(ask.join(" ")));
  assert.ok(!/[→>—]/.test(ask.join(" ")), "no arrows or em dashes");
});

test("location wording never suggests skip, in any variant or follow-up", async () => {
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    const t = setup({ canRequestLocation: i % 2 === 0 });
    // A different person each time, so the pools start in different places.
    for (let k = 0; k < i; k++) t.db.prepare("INSERT INTO users (handle, chatId, createdAt) VALUES (?, ?, ?)").run(`+1213555020${i}${k}`, `c-${i}-${k}`, Date.now());
    await t.text("hey troy");
    await t.text("judge");
    seen.push(...(await t.text("none")).slice(1));
    seen.push(...(await t.text("done")));
    seen.push(...(await t.text("why do u need that")));
    seen.push(...(await t.text("ok")));
  }
  assert.ok(seen.length > 20);
  assert.ok(!/\bskip/i.test(seen.join("\n")), seen.find((s) => /skip/i.test(s)) ?? "");
});

test("no gif on this machine: the find my request is the fallback, or the steps in words", async () => {
  setOnboardingDeps({ ...currentDeps(), gifPath: "/nope/share-location.gif" });
  const req = await asJudge({ canRequestLocation: true });
  const ask = (await req.text("none")).slice(1);
  assert.match(ask[0]!, /i work best when i know where u are/);
  assert.ok(!ask[0]!.includes("👇"));
  assert.equal(ask[1], "i sent u a location request. open find my, then people, and accept it");
  assert.equal(req.fake.calls.filter((c) => c.method === "requestLocation").length, 1);
  assert.equal(req.fake.calls.filter((c) => c.method === "sendImage").length, 0);
  assert.equal(ask.length, 4);

  const hand = await asJudge({ canRequestLocation: false });
  const words = (await hand.text("none")).slice(1);
  assert.match(words[1]!, /the \+ .* then location, then share/);
  assert.ok(!words.join(" ").includes("find my"));

  // The GIF exists but didn't send: the steps in words go under "here's how".
  setOnboardingDeps({ ...currentDeps(), gifPath: GIF });
  const failed = await asJudge({ canSendImage: false });
  const under = (await failed.text("none")).slice(1);
  assert.equal(under[0], LOCATION_ASK);
  assert.match(under[1]!, /then location, then share/);
});

/** The deps this file installed in beforeEach, to change one of them inside a test. */
function currentDeps(): Partial<OnboardingDeps> {
  return {
    replyAtStep: async (ctx, step) => (brain.asked.push({ text: ctx.event.text.toLowerCase(), step }), { bubbles: ["haha fair"], action: null }),
    sayInHisWords: async (_ctx, brief) => (brain.said.push(brief), brief.fallback[0]!),
    afterOnboarding: async () => void brain.finished++,
    judgeTopic: async (text) => brain.verdicts[text] ?? "unsure",
    sendEmail: async () => brain.email.result,
    pause: async () => {},
    pickLine: (_ctx, key) => [...REFERENCE_LINES[key][0]],
    cardBeatMs: 0,
    settleMs: 60_000,
  };
}

test("the dictated lines rotate: different students get different versions, and every version covers the same points", async () => {
  // Every welcome says who he is, that he's an ai, what to send, and ends on the STOP line word for word.
  for (const v of REFERENCE_LINES.welcome) {
    assert.match(v.join(" "), /troy/);
    assert.match(v.join(" "), /\bai\b/);
    assert.match(v.join(" "), /know a guy/);
    assert.match(v.join(" "), /photo|pic/);
    assert.equal(v.at(-1), REFERENCE_LINES.welcome[0].at(-1));
  }
  for (const v of REFERENCE_LINES.quick_check) assert.match(v[0]!, /usc student or a hackathon judge/);
  for (const v of REFERENCE_LINES.student) assert.match(v[0]!, /ur usc email\?$/);
  for (const v of REFERENCE_LINES.judge) assert.match(v[0]!, /skip.*verification|verification.*skip/);
  for (const v of REFERENCE_LINES.location_ask) {
    assert.match(v[0]!, /know where u are/);
    assert.match(v[0]!, /10 seconds/);
    assert.match(v[0]!, /turn it off anytime/);
    assert.ok(v[0]!.endsWith("👇"));
  }
  for (const pool of Object.values(REFERENCE_LINES)) for (const v of pool) for (const b of v) assert.ok(!/\byou\b|\byour\b|—/.test(b), b);

  // With the real picker, a handful of new students do not all open on the same words.
  const { pickLine: _pinned, ...rest } = currentDeps();
  setOnboardingDeps(rest);
  const t = setup();
  const openers = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const before = t.fake.texts().length;
    await t.pipeline.handleEvent(t.event({ text: "hey troy", userHandle: `+1213555${4100 + i}`, chatId: `chat-${i}` }));
    openers.add(t.fake.texts()[before]!);
  }
  assert.ok(openers.size > 1, [...openers].join(" | "));
  for (const o of openers) assert.ok(REFERENCE_LINES.welcome.some((v) => v[0] === o), o);
});

test("location answers: usual spots are saved, typing skip still works, a decline in any wording saves nothing", async () => {
  const spots = await toLocationStep();
  const done = await spots.text("leavey, the village and parkside");
  assert.deepEqual(spots.user().usualSpots, ["leavey", "the village", "parkside"]);
  assert.equal(done.length, 1);
  assert.equal(getFlowState(spots.db, spots.user().id), null);
  assert.equal(brain.finished, 1);

  for (const no of ["skip", "nah im good", "no im ok", "idk", "not now", "I'm good", "nah"]) {
    const t = await toLocationStep();
    const before: number = brain.finished;
    const end = await t.text(no);
    assert.equal(end.length, 1, no);
    assert.ok(!/skip/i.test(end[0]!), no);
    assert.deepEqual(t.user().usualSpots, [], no);
    assert.equal(getFlowState(t.db, t.user().id), null, no);
    assert.equal(brain.finished, before + 1, no);
  }
});

test("location step: a question is answered by the brain and the step stays open; saying no in other words moves on", async () => {
  const t = await toLocationStep();
  const why = await t.text("why do u need that");
  assert.deepEqual(why, ["so things fit where u actually are"]);
  const spec = brain.asked.at(-1)!.step;
  assert.match(spec.waitingFor, /ur location or ur usual spots/);
  assert.match(spec.facts!.erase!, /"forget my location"/);
  assert.deepEqual(t.user().usualSpots, []);
  assert.equal(t.step(), "location");
  assert.equal(brain.finished, 0);

  const moved = await t.text("can we just move on");
  assert.deepEqual(moved, ["all good, no pressure"]);
  assert.equal(getFlowState(t.db, t.user().id), null);
  assert.equal(brain.finished, 1);
});

test("location step: 'done' before the fix has arrived keeps the step open", async () => {
  const t = await toLocationStep({ canRequestLocation: true });
  const wait = await t.text("done");
  assert.match(wait[0]!, /not seeing it yet|nothing on my end yet/);
  assert.match(wait[0]!, /"done"/);
  assert.equal(t.step(), "location");
  assert.equal(t.saved.size, 0);
});

test("a share at an earlier step is saved, thanked, and the open question stays open", async () => {
  const t = setup();
  await t.text("hey troy");
  assert.deepEqual(await t.send({ text: "", location: { lat: 34.02, lng: -118.28 } }), ["got it, thx"]);
  assert.ok(t.saved.has(t.user().id));
  assert.equal(t.step(), "who");
});

test("a real request at an optional step ends onboarding and is handled as a request", async () => {
  const loc = await toLocationStep();
  const reply = await loc.text("i lost my wallet at leavey");
  assert.deepEqual(loc.user().usualSpots, []);
  assert.notEqual(getFlowState(loc.db, loc.user().id)?.flow, "onboarding");
  assert.ok(reply.length >= 1);
  assert.equal(brain.asked.length, 0);

  const alerts = await asJudge();
  await alerts.text("i lost my wallet at leavey");
  assert.notEqual(getFlowState(alerts.db, alerts.user().id)?.flow, "onboarding");
  assert.deepEqual(alerts.subs(), []);
});

test("with no model at all: starting over and a question about him still work, and nothing reads as a format error", async () => {
  const { replyAtStep: _none, ...rest } = currentDeps();
  setOnboardingDeps({ ...rest, gifPath: GIF });
  const t = setup();
  await t.text("hey troy");
  await t.text("student");
  const over = await t.text("can we start over");
  assert.equal(over.length, 1);
  assert.ok(!over[0]!.includes("@usc.edu"));
  assert.equal(t.fake.polled().length, 2);
  assert.equal(t.step(), "who");

  await t.text("judge");
  const what = await t.text("what can u do");
  // Answered first, then steered back. The step is still open.
  assert.ok(what.length >= 2);
  assert.match(what.join(" "), /lost|free food|broken/);
  assert.equal(t.step(), "alerts");
  await t.text("none");
  const why = await t.text("why do u need that?");
  assert.match(why.join(" "), /walking times/);
  assert.match(why.join(" "), /"forget my location"/);
  assert.equal(t.step(), "location");
  assert.equal(brain.asked.length, 0);
});

// ---------- quotes and voice ----------

test("every exact phrase to type is in double quotes, and the voice rules hold on every line", async () => {
  const said: string[] = [];
  const run = async (opts: Fake, steps: (t: ReturnType<typeof setup>) => Promise<void>) => {
    const t = setup(opts);
    await steps(t);
    await t.settled();
    said.push(...t.fake.texts());
  };
  await run({}, async (t) => {
    await t.text("hey troy");
    await t.text("tommy@gmail.com");
    await t.text("tommy@usc,edu");
    await t.text("yes");
    for (let i = 0; i < 6; i++) await t.text("000000");
    await t.text("12");
    t.db.prepare("UPDATE verification_codes SET expiresAt = 1").run();
    await t.text("111111");
    await t.text("resend");
    await t.text(codeFor(t.db));
    await t.tap("opt-1");
    await t.settled();
    await t.text("done");
    await t.text("leavey");
  });
  for (const reason of ["error", "rejected", "no_key"] as const) {
    await run({ canRequestLocation: true }, async (t) => {
      brain.email.result = reason;
      await t.text("hey troy");
      await t.text("ttrojan@usc.edu");
      brain.email.result = "sent";
      await t.text("judge");
      await t.text("something else");
      await t.text("vibes");
      await t.text("ok");
      await t.text("nah");
    });
  }
  const mine = said.filter((s) => !TEMPLATES.welcome.includes(s));
  const all = mine.join("\n");
  // Each phrase a student is told to text shows up, and only ever inside double quotes.
  for (const phrase of ["resend", "forget my location", "try again", "done", "leavey and the village"]) {
    const total = all.split(phrase).length - 1;
    const quoted = all.split(`"${phrase}"`).length - 1;
    assert.ok(total > 0, `${phrase} never came up`);
    assert.equal(quoted, total, `${phrase} without quotes`);
  }
  // "reply X" or "text X" is always followed by a quote when X is the thing to type.
  assert.ok(!/\b(?:reply|type) (?!")[a-z]/.test(all), all.match(/.*\b(?:reply|type) (?!")[a-z].*/)?.[0] ?? "");
  for (const line of mine) {
    assert.equal(line, line.toLowerCase(), line);
    assert.ok(!/\b(?:you|your|you're)\b/.test(line), line);
    assert.ok(!/[—–]/.test(line), line);
    assert.ok((line.match(/\p{Extended_Pictographic}/gu) ?? []).length <= 1, line);
  }
});

test("guessName only accepts first.last", () => {
  assert.equal(guessName("john.wang@usc.edu"), "John Wang");
  assert.equal(guessName("jwang72@usc.edu"), null);
  assert.equal(guessName("ttrojan@usc.edu"), null);
});

// ---------- judge mode in onboarding (John, "Judge mode") ----------

test("a judge is told once what is different for them and gets the one-tap tone switch, between the thanks line and the alerts poll", async () => {
  const t = setup();
  await t.text("hey troy");
  const reply = await t.text("judge");
  assert.equal(reply[0], JUDGE_LINE);
  // What is different, in his own words (the brief went through this file's composer).
  const brief = brain.said.find((b) => b.mustCover.some((p) => /faster/.test(p)));
  assert.ok(brief, "the disclaimer was composed, not canned");
  assert.ok(brief.mustCover.some((p) => /normal texting pace/.test(p)));
  assert.ok(brief.mustCover.some((p) => /built for students/.test(p)));
  assert.ok(brief.mustCover.some((p) => /say anything straight/.test(p)));
  const said = reply.join(" ");
  assert.match(said, /typing a bit faster to save u time/);
  assert.match(said, /a student would see me at a normal texting pace/);
  assert.match(said, /built for students/);
  assert.match(said, /straight/);
  // Then exactly one bubble to tap, and after it the alerts poll.
  const taps = reply.filter((b) => TONE_TAPS.includes(b));
  assert.equal(taps.length, 1);
  assert.equal(reply.indexOf(taps[0]!), reply.length - 2, "the tap is the last bubble before the poll (the tap-mode hint follows the poll)");
  assert.equal(t.fake.polled().length, 2);
  assert.equal(t.step(), "alerts");
  assert.equal(plainTone(t.db, t.user().id), false);

  // The tap turns plain tone on, and the alerts step is still open.
  const on = await t.tap(t.idOf(taps[0]!), "love");
  assert.equal(on.length, 1);
  assert.match(on[0]!, /"slang back on"/);
  assert.match(on[0]!, /^[A-Z]/, "already in plain english");
  assert.equal(plainTone(t.db, t.user().id), true);
  assert.equal(t.step(), "alerts");
  // Tapping again, or taking it back, says nothing more.
  assert.deepEqual(await t.tap(t.idOf(taps[0]!), "love"), []);
  assert.deepEqual(await t.tap(t.idOf(taps[0]!), "love", true), []);

  // Everything after is plain, including onboarding's own pools.
  const none = await t.text("none");
  assert.ok(none.every((b) => !/\b(?:u|ur)\b/.test(b.replace(/"[^"]*"/g, ""))), none.join(" / "));
  assert.equal(t.step(), "location");
  // Typed, mid-step: the slang comes back and the location ask stays open.
  const off = await t.text("slang back on");
  assert.match(off.join(" "), /"drop the slang"/);
  assert.equal(plainTone(t.db, t.user().id), false);
  assert.equal(t.step(), "location");
  // The disclaimer and the tap were sent once in all of that.
  assert.equal(t.fake.texts().filter((b) => TONE_TAPS.includes(b)).length, 1);
  assert.equal(t.fake.texts().filter((b) => /typing a bit faster/.test(b)).length, 1);
});

test("a student never sees the judge disclaimer or the tone tap", async () => {
  const t = setup();
  await t.text("hey troy");
  await t.text("student");
  await t.text("tommy@usc.edu");
  await t.text(codeFor(t.db));
  assert.equal(t.user().verifiedVia, "usc_email");
  await t.text("none");
  await t.text("leavey and the village");
  const all = t.fake.texts();
  assert.ok(!all.some((b) => TONE_TAPS.includes(b)));
  assert.ok(!all.some((b) => /typing a bit faster|drop the slang|built for students/.test(b)), all.join(" / "));
  assert.ok(!brain.said.some((b) => b.mustCover.some((p) => /faster/.test(p))));
  // And the words that switch a judge's tone do nothing for a student.
  await t.text("formal");
  assert.equal(plainTone(t.db, t.user().id), false);
});
