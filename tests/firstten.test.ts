// The first ten minutes after onboarding: what goes out, when, what stops it, and that he pulls instead of waiting
// (John, "First ten minutes must pull, not wait").
// A fake clock drives everything (setFirstTenDeps), in-process timers are off, and the sweep is called by hand.
// No model here, so every line is one of the hand-written variants.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import type { FlowContext, IncomingEvent, Intent, MessagingAdapter, TapbackType } from "../src/types.ts";
import { openDb, getOrCreateUser, getUserById, updateUser, getFlowState, setFlowState, saveMessage } from "../src/db/index.ts";
import { createPipeline } from "../src/pipeline.ts";
import { registerFlow } from "../src/flows/index.ts";
import { fallbackIntent, setModelCall } from "../src/ai.ts";
import { untriedState, markMove as brainMarkMove } from "../src/brain.ts";
import { saveUserLocation } from "../src/location.ts";
import { FIRST_TEN, TRY_ME_OPTIONS, afterOnboarding, cancelFirstTen, dueNow, hasMove, isNeutral, isUntried, saysDone, setFirstTenDeps } from "../src/firstten.ts";
import { setSimulateDeps } from "../src/simulate.ts";

console.warn = () => {};

const SEC = 1000;
const MIN = 60 * SEC;
let clock = 0;

beforeEach(() => {
  clock = Date.now();
  setFirstTenDeps({ now: () => clock, timers: false });
  setSimulateDeps({ pause: async () => {} });
  setModelCall(null);
});
after(() => {
  setFirstTenDeps(null);
  setSimulateDeps(null);
  setModelCall(null);
});

/** What reads as leaving a new person with nothing to do. */
const DEAD_END = /no rush|whenever|if u want|lmk|i'm around|take ur time/;

type Sent = { chatId: string; text: string; id: string };

function world(opts: { pollMode?: "native" | "tap" | "numbered" } = {}) {
  const db = openDb(":memory:");
  const place = db.prepare("INSERT OR IGNORE INTO campus_places (name, nicknames, lat, lng, kind) VALUES (?, ?, ?, ?, 'campus')");
  place.run("Leavey Library", '["leavey"]', 34.0217, -118.2829);
  place.run("Tutor Campus Center", '["tcc"]', 34.0203, -118.2863);
  const sent: Sent[] = [];
  const polls: { chatId: string; question: string; options: string[]; id: string }[] = [];
  let n = 0;
  const adapter: MessagingAdapter = {
    provider: "webchat",
    capabilities: () => ({ tapbacks: true, typing: true, readReceipts: true, edits: false, effects: true, polls: true, groupChats: false, contactCard: true, liveLocation: false }),
    async sendMessage(chatId, text) {
      const id = `out-${++n}`;
      sent.push({ chatId, text, id });
      return { messageId: id };
    },
    sendImage: async () => null,
    sendContactCard: async () => ({ messageId: `out-${++n}` }),
    markRead: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    react: async () => true,
    editMessage: async () => false,
    async sendPoll(chatId, question, options) {
      const mode = opts.pollMode ?? "native";
      const id = `poll-${++n}`;
      polls.push({ chatId, question, options, id });
      if (mode === "native") return { optionMessageIds: options.map(() => id), mode };
      if (mode === "tap") return { optionMessageIds: options.map((_, i) => `${id}-opt-${i}`), mode };
      return { optionMessageIds: options.map(() => null), mode };
    },
    createGroupChat: async () => null,
    getLiveLocation: async () => null,
    requestLocation: async () => false,
    chatIdForHandle: (h) => `chat-${h}`,
  };
  const pipeline = createPipeline({ db, getAdapter: () => adapter, pause: async () => {}, ackAfterMs: 60_000, detectIntent: async (i) => fallbackIntent(i), readSafety: null });

  let m = 0;
  function person(handle: string, fields: Record<string, string | number | null> = {}) {
    const chatId = `chat-${handle}`;
    const created = getOrCreateUser(db, handle, chatId);
    updateUser(db, created.id, { verifiedAt: Date.now(), verifiedVia: "usc_email", subscriptions: JSON.stringify(["free_nearby"]), ...fields });
    const id = created.id;
    const event = (over: Partial<IncomingEvent>): IncomingEvent => ({ provider: "webchat", userHandle: handle, chatId, isGroup: false, messageId: `in-${++m}`, text: "", images: [], receivedAt: clock, ...over });
    const mine = () => sent.filter((s) => s.chatId === chatId);
    const texts = () => mine().map((s) => s.text);
    const idle: Intent = { flow: "onboarding", action: "", details: {}, source: "fallback" };
    /** What onboarding has in hand when it finishes: its own context. */
    const ctx = (): FlowContext => ({
      db,
      user: getUserById(db, id)!,
      event: event({}),
      intent: idle,
      state: null,
      adapter,
      async say(...bubbles) {
        const out: (string | null)[] = [];
        for (const b of bubbles) {
          const text = typeof b === "string" ? b : b.text;
          const res = await adapter.sendMessage(chatId, text);
          saveMessage(db, { userId: id, chatId, direction: "out", providerMessageId: res!.messageId, text });
          out.push(res!.messageId);
        }
        return out;
      },
      sayTo: async (_u, ...b) => b.map(() => null),
      sayToOwed: async (_u, ...b) => b.map(() => null),
      setState: (s) => setFlowState(db, id, s),
      setStateFor: (u, s) => setFlowState(db, u, s),
    });
    const finishOnboarding = async () => {
      const before = texts().length;
      await afterOnboarding(ctx());
      return texts().slice(before);
    };
    const say = async (text: string) => {
      const before = texts().length;
      await pipeline.handleEvent(event({ text }));
      return texts().slice(before);
    };
    const tap = async (onText: RegExp, type: TapbackType) => {
      const target = [...mine()].reverse().find((s) => onText.test(s.text));
      assert.ok(target, `no bubble matching ${onText}`);
      const before = texts().length;
      await pipeline.handleEvent(event({ reaction: { targetMessageId: target.id, type, removed: false } }));
      return texts().slice(before);
    };
    const vote = async (optionIndex: number) => {
      const poll = polls.filter((p) => p.chatId === chatId).at(-1)!;
      const before = texts().length;
      await pipeline.handleEvent(event({ pollVote: { pollMessageId: poll.id, optionIndex } }));
      return texts().slice(before);
    };
    return { id, chatId, finishOnboarding, say, tap, vote, texts, state: () => getFlowState(db, id), polls: () => polls.filter((p) => p.chatId === chatId) };
  }
  /** Run the sweep at the fake clock's time and return what it sent this person. */
  const sweepAt = async (p: { texts: () => string[] }, at: number) => {
    clock = at;
    const before = p.texts().length;
    await pipeline.sweep(clock);
    return p.texts().slice(before);
  };
  return { db, sent, polls, pipeline, person, sweepAt };
}

const count = (db: ReturnType<typeof openDb>, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

test("the exact trigger times", () => {
  assert.equal(FIRST_TEN.pollAfterMs, 0, "the poll goes out with the 'near u' bubbles");
  assert.equal(FIRST_TEN.questionAfterMs, 25 * SEC, "about 25 seconds of silence, not two minutes");
  assert.equal(FIRST_TEN.silentQuestionAfterMs, 90 * SEC);
  assert.equal(FIRST_TEN.settleMs, 25 * SEC);
  assert.equal(FIRST_TEN.followUpAfterMs, 7 * MIN);
  assert.equal(FIRST_TEN.planMs, 10 * MIN);
  assert.equal(FIRST_TEN.windowMs, 60 * MIN);
  assert.deepEqual([...TRY_ME_OPTIONS], ["pretend i lost something", "show me free food near me", "stump me"]);
});

test("right when onboarding ends: the 'what else' line, then the 'near u' bubbles with example numbers and no label", async () => {
  const w = world();
  const p = w.person("+12135550201");
  const out = await p.finishOnboarding();
  const all = out.join(" \n ");
  // The four things he is also for, and that they just tell him.
  assert.match(all, /find|found/);
  assert.match(all, /los[et]/);
  assert.match(all, /broken/);
  assert.match(all, /student government/);
  // The near-u bubbles: example numbers, unlabeled, the food spot held back, and no question in either one:
  // the "try me" poll right after them is the only thing he asks for.
  const food = out.find((b) => /pizza/.test(b))!;
  assert.match(food, /8 min/);
  const lost = out.find((b) => /3 people/.test(b))!;
  assert.ok(!/\?/.test(`${food} ${lost}`), `${food} / ${lost}`);
  assert.equal(w.polls.length, 1);
  assert.ok(!/example|hackathon|demo|pretend/.test(all), "nothing is labeled until they ask");
  assert.ok(!/leavey|tutor|tcc|village/i.test(`${food} ${lost}`), "no place is named for something that isn't there");
  // The "try me" poll goes out right away, in the same turn: one tap starts something.
  assert.equal(w.polls.length, 1, "the poll does not wait for silence");
  assert.deepEqual(w.polls[0].options, [...TRY_ME_OPTIONS]);
  assert.match(w.polls[0].question, /tap one|pick one/);
  assert.equal(p.state(), null);
  assert.ok(isUntried(w.db, p.id), "new and untried from here");
  assert.equal(dueNow(w.db, p.id), null, "the poll was part of the turn, not the unprompted message");
});

test("no food line for someone who didn't pick the food topic", async () => {
  const w = world();
  const p = w.person("+12135550202", { subscriptions: JSON.stringify(["pickup"]) });
  const out = await p.finishOnboarding();
  assert.ok(!out.some((b) => /pizza/.test(b)));
  assert.ok(out.some((b) => /3 people/.test(b)));
});

test("silence after the poll: the one question at 90 seconds, and then nothing else unprompted in the first hour", async () => {
  const w = world();
  const p = w.person("+12135550203");
  const start = clock;
  await p.finishOnboarding();
  assert.equal(w.polls.length, 1);
  assert.deepEqual(await w.sweepAt(p, start + 26 * SEC), [], "the poll is still the open ask");
  assert.deepEqual(await w.sweepAt(p, start + 89 * SEC), []);
  const asked = await w.sweepAt(p, start + 91 * SEC);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /usc/);
  assert.match(asked[0], /\?$/);
  // Every later mark passes with nothing more: one unprompted message per hour.
  for (const at of [2 * MIN, 3 * MIN, 7 * MIN, 8 * MIN, 9 * MIN, 30 * MIN, 59 * MIN]) assert.deepEqual(await w.sweepAt(p, start + at), [], `nothing at ${at / MIN} min`);
  assert.equal(w.polls.length, 1);
});

test("a tap on the poll starts that move: the tour, and 'stump me' sends the next text to the chat brain without filing anything", async () => {
  const w = world();
  const p = w.person("+12135550204");
  const start = clock;
  await p.finishOnboarding();
  await w.sweepAt(p, start + 31 * SEC);
  const tour = await p.vote(0);
  assert.match(tour.join(" "), /example|pretend|not real|nothing here is real/);
  assert.deepEqual({ flow: p.state()?.flow, step: p.state()?.step }, { flow: "tour", step: "describe" });

  const q = world();
  const s = q.person("+12135550205");
  await s.finishOnboarding();
  await q.sweepAt(s, clock + 31 * SEC);
  const picked = await s.vote(2);
  // The pizza and the lost reports were example numbers they never asked about: one honest line first, then the dare.
  assert.equal(picked.length, 2, picked.join(" / "));
  assert.match(picked[0], /hackathon/);
  assert.match(picked[0], /example/);
  const dare = picked.slice(1);
  assert.match(dare[0], /campus problem/);
  assert.match(dare[0], /who (?:handles|deals)/);
  const answer = await s.say("the elevator in my dorm is broken");
  assert.ok(answer.length > 0);
  assert.equal(count(q.db, "reports"), 0, "naming a problem as a stumper files nothing");
  assert.equal(s.state(), null);
  // After that one answer, a broken thing is a report again.
  await s.say("the water fountain in leavey is broken");
  assert.ok(count(q.db, "reports") > 0 || s.state()?.flow === "repair");
});

test("tap-to-pick and numbered polls work too", async () => {
  const w = world({ pollMode: "tap" });
  const p = w.person("+12135550206");
  const out = await p.finishOnboarding();
  assert.match(out.at(-1)!, /heart|thumbs up/);
  const poll = w.polls[0];
  await w.pipeline.handleEvent({ provider: "webchat", userHandle: "+12135550206", chatId: p.chatId, isGroup: false, messageId: "tap-1", text: "", images: [], receivedAt: clock, reaction: { targetMessageId: `${poll.id}-opt-0`, type: "like", removed: false } });
  assert.equal(p.state()?.flow, "tour");

  const n = world({ pollMode: "numbered" });
  const q = n.person("+12135550207");
  const how = await q.finishOnboarding();
  assert.match(how.at(-1)!, /"1", "2" or "3"/);
  await q.say("3");
  assert.equal(q.state(), null);
  assert.match(q.texts().at(-1)!, /campus problem/);
});

test("judges get the same immediate poll, and at most one unprompted message after it", async () => {
  const w = world();
  const p = w.person("+12135550208", { verifiedVia: "judge_skip" });
  const start = clock;
  await p.finishOnboarding();
  assert.equal(w.polls.length, 1);
  assert.deepEqual(await w.sweepAt(p, start + 31 * SEC), []);
  assert.equal((await w.sweepAt(p, start + 91 * SEC)).length, 1);
  for (const at of [3 * MIN, 8 * MIN]) assert.deepEqual(await w.sweepAt(p, start + at), []);
  assert.equal(w.polls.length, 1);
});

// ---------- the pull (what John saw on his phone, and what happens now) ----------

test("john's transcript: 'ok' gets a concrete next step, never 'no rush', and a second 'ok' starts it", async () => {
  const w = world();
  const p = w.person("+12135550209");
  const start = clock;
  const opening = await p.finishOnboarding();
  assert.ok(opening.some((b) => /3 people/.test(b)));
  clock = start + 10 * SEC;
  const first = await p.say("ok");
  assert.equal(first.length, 1, "one short bubble, not a wall");
  assert.match(first[0], /pretend u lost something/);
  assert.match(first[0], /real check/);
  assert.match(first[0], /\?$/, "it ends on one easy ask");
  assert.ok(!DEAD_END.test(first.join(" ")), first.join(" / "));
  assert.deepEqual({ flow: p.state()?.flow, step: p.state()?.step }, { flow: "tour", step: "offer" });
  assert.ok(isUntried(w.db, p.id), "an offer is not a try");
  // The second "ok" is a yes to that: the run starts, and now they have tried something.
  clock = start + 20 * SEC;
  const second = await p.say("ok");
  assert.ok(!DEAD_END.test(second.join(" ")), second.join(" / "));
  assert.equal(p.state()?.step, "describe");
  assert.ok(!isUntried(w.db, p.id), "started the tour: he relaxes");
  assert.equal(untriedState(w.db, p.id, clock), null);
  // Nobody in this exchange ever got the passive lines.
  assert.ok(!p.texts().some((t) => /no rush|those are there if u want/.test(t)));
});

test("a thumbs up means keep going too, and a no is not a dead end: the one question comes as the next move", async () => {
  const w = world();
  const p = w.person("+12135550231");
  await p.finishOnboarding();
  const up = await p.tap(/student government|connect u|right person|whoever handles/, "like");
  assert.equal(up.length, 1);
  assert.match(up[0], /pretend u lost something/);
  assert.equal(p.state()?.step, "offer");
  const no = await p.say("nah");
  assert.equal(no.length, 1);
  assert.match(no[0], /usc/);
  assert.match(no[0], /\?$/);
  assert.ok(!DEAD_END.test(no[0]), no[0]);
  assert.equal(p.state(), null);
  assert.ok(hasMove(w.db, p.id, "question"));
  // The answer goes somewhere real, and answering it is trying something.
  await p.say("finding people to study with tbh");
  assert.ok(p.state()?.flow === "usg" || count(w.db, "reports") > 0, "the wish is on its way to student government");
  assert.ok(!isUntried(w.db, p.id));
});

test("the order on neutral replies: the tour offer, then one specific nearby thing, then the one question, then he relaxes", async () => {
  const w = world();
  const p = w.person("+12135550232");
  await p.finishOnboarding();
  assert.match((await p.say("cool")).join(" "), /pretend u lost something/);
  // Not an answer to the offer, so it lapses. With the model down the pool line can't pull, so code closes on ONE
  // line (the one question). It never launches a whole example run after something they actually said.
  const second = await p.say("what even is this");
  assert.ok(second.length <= 3, second.join(" / "));
  assert.match(second.at(-1)!, /usc/);
  assert.match(second.at(-1)!, /\?$/);
  assert.equal(p.state(), null, "no example run was started for them");
  // A bare "ok" to that question is their answer: he relaxes and makes no new move.
  const third = await p.say("ok");
  assert.equal(third.length, 1, third.join(" / "));
  assert.ok(!/\?$/.test(third[0]!), third[0]);
  assert.equal(p.state(), null);
  assert.ok(!isUntried(w.db, p.id), "he relaxed");

  // The specific nearby thing on a neutral reply, for someone who already heard the tour offer (here: in free chat).
  const n = world();
  const r = n.person("+12135550239");
  await r.finishOnboarding();
  brainMarkMove(n.db, r.id, "tour");
  const foodRun = await r.say("k");
  assert.match(foodRun.join(" "), /example/, "the labeled free food run is the specific nearby thing when nothing real is around");
  assert.equal(r.state()?.step, "food_claim");
  assert.ok(!isUntried(n.db, r.id), "started a run: tried");

  // Someone with a real lost report nearby gets that as the specific thing, and then the question.
  const v = world();
  const other = v.person("+12135550233");
  const q = v.person("+12135550234", { subscriptions: "[]" });
  saveUserLocation(v.db, q.id, { lat: 34.0217, lng: -118.2829 }, "pin");
  v.db.prepare("INSERT INTO listings (userId, type, category, title, details, locationText, lat, lng, status, isExample, createdAt) VALUES (?, 'lost', 'wallet', 'brown wallet', '{}', 'Leavey Library', 34.0217, -118.2829, 'open', 0, ?)").run(other.id, clock);
  await q.finishOnboarding();
  assert.match((await q.say("k")).join(" "), /pretend u lost something/);
  setFlowState(v.db, q.id, null);
  const nearby = await q.say("lol");
  assert.match(nearby.join(" "), /Leavey Library/);
  assert.match(nearby.join(" "), /pic/);
  assert.ok(!/wallet|brown/.test(nearby.join(" ")));
  const question = await q.say("sounds good");
  assert.equal(question.length, 1);
  assert.match(question[0], /usc/);
  assert.match(question[0], /\?$/);
  for (const out of [nearby, question]) assert.ok(!DEAD_END.test(out.join(" ")), out.join(" / "));
});

test("the one question on his own: about 25 seconds after their last text when nothing is open, not two minutes", async () => {
  const w = world();
  const p = w.person("+12135550235");
  const start = clock;
  await p.finishOnboarding();
  clock = start + 10 * SEC;
  // The model is up for this one chat reply, so no step is left open afterwards.
  const prompts: string[] = [];
  setModelCall(async (opts) => {
    prompts.push(opts.prompt);
    return JSON.stringify({ bubbles: ["an ai that knows a guy for most things on campus", "wanna see? pretend u lost something and i'll run the real check on u. down?"], handoff: null });
  });
  const reply = await p.say("so what even are u");
  setModelCall(null);
  assert.equal(reply.length, 2);
  assert.match(prompts.at(-1)!, /NEW AND UNTRIED/, "the chat brain is told on every reply in that stretch");
  assert.equal(p.state(), null);
  assert.ok(isUntried(w.db, p.id));
  assert.deepEqual(await w.sweepAt(p, start + 10 * SEC + 24 * SEC), [], "not before about 25 quiet seconds");
  const asked = await w.sweepAt(p, start + 10 * SEC + 26 * SEC);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /usc/);
  assert.match(asked[0], /\?$/);
  assert.ok(!DEAD_END.test(asked[0]));
  for (const at of [2 * MIN, 3 * MIN, 8 * MIN, 30 * MIN]) assert.deepEqual(await w.sweepAt(p, start + at), [], "still at most one unprompted message in the first hour");
});

test("the chat brain's sign-off is rejected while they are untried, and the retry goes out instead", async () => {
  const w = world();
  const p = w.person("+12135550236");
  await p.finishOnboarding();
  const prompts: string[] = [];
  const answers = [
    JSON.stringify({ bubbles: ["cool, those 3 loss reports near u are there if u want"], handoff: null }),
    JSON.stringify({ bubbles: ["bet, no rush on any of it"], handoff: null }),
  ];
  setModelCall(async (opts) => {
    prompts.push(opts.prompt);
    return answers[Math.min(prompts.length - 1, answers.length - 1)]!;
  });
  const out = await p.say("alright so what now");
  setModelCall(null);
  // Two tries at the chat reply (the later calls are code writing its own next move).
  assert.ok(prompts.length >= 2);
  assert.match(prompts[1]!, /was not sent/);
  assert.match(prompts[1]!, /one easy, concrete next step/);
  // Both of John's lines were refused, so a hand-written line went out, and code added the next move after it.
  assert.ok(!out.some((b) => /no rush|are there if u want/.test(b)), out.join(" / "));
  assert.match(out.at(-1)!, /pretend u lost something/);
});

test("once they say they're good he relaxes: no next step, no question later", async () => {
  const w = world();
  const p = w.person("+12135550237");
  const start = clock;
  await p.finishOnboarding();
  clock = start + 5 * SEC;
  const out = await p.say("im good thanks");
  assert.equal(out.length, 1);
  assert.ok(!/pretend|\?$/.test(out[0]), out[0]);
  assert.ok(!isUntried(w.db, p.id));
  assert.equal(p.state(), null);
  for (const at of [31 * SEC, 95 * SEC, 3 * MIN, 8 * MIN]) assert.deepEqual(await w.sweepAt(p, start + at), [], `nothing at ${at / SEC}s`);
  // And "ok" after that is just "ok".
  assert.ok(!(await p.say("ok")).some((b) => /pretend u lost/.test(b)));
});

test("what counts as neutral, and what counts as done", () => {
  for (const t of ["ok", "Ok.", "k", "cool", "lol", "sounds good", "bet", "ok cool", "👍", "nice", "got it"]) assert.ok(isNeutral(t), t);
  for (const t of ["ok but why", "ok?", "i lost my wallet", "where is it", "thanks", "no", "what"]) assert.ok(!isNeutral(t), t);
  for (const t of ["i'm good", "nah im good", "maybe later", "gtg", "that's all", "no thanks"]) assert.ok(saysDone(t), t);
  for (const t of ["ok", "good", "later is fine but where is it", "i'm good at this"]) assert.ok(!saysDone(t), t);
});

test("a real request clears all of it", async () => {
  const w = world();
  const p = w.person("+12135550210");
  const start = clock;
  await p.finishOnboarding();
  clock = start + 5 * SEC;
  await p.say("the water fountain in leavey is broken");
  // Whatever the repair flow left open, the plan itself is over.
  setFlowState(w.db, p.id, null);
  assert.ok(!isUntried(w.db, p.id), "a real request is trying something");
  for (const at of [31 * SEC, 95 * SEC, 2 * MIN + 10 * SEC, 3 * MIN, 7 * MIN + SEC, 9 * MIN]) {
    assert.equal(dueNow(w.db, p.id, start + at), null);
    assert.deepEqual(await w.sweepAt(p, start + at), []);
  }
  assert.equal(w.polls.filter((poll) => poll.options[0] === TRY_ME_OPTIONS[0]).length, 1, "only the poll that went out with onboarding");
});

test("pause and STOP end it", async () => {
  for (const word of ["pause", "STOP"]) {
    const w = world();
    const p = w.person(`+1213555022${word.length}`);
    const start = clock;
    await p.finishOnboarding();
    clock = start + 5 * SEC;
    await p.say(word);
    if (word === "pause") await p.say("resume");
    for (const at of [31 * SEC, 95 * SEC, 3 * MIN, 8 * MIN]) assert.deepEqual(await w.sweepAt(p, start + at), [], `${word}: nothing at ${at / SEC}s`);
    assert.equal(w.polls.length, 1);
    assert.ok(!isUntried(w.db, p.id));
  }
});

test("quiet hours and a paused user hold everything back; cancelFirstTen is safe for someone with no plan", async () => {
  const w = world();
  const p = w.person("+12135550212", { quietHours: JSON.stringify({ start: "00:00", end: "23:59" }) });
  const start = clock;
  await p.finishOnboarding();
  assert.equal(dueNow(w.db, p.id, start + 95 * SEC), null);
  cancelFirstTen(w.db, 9999);
});

test("asking for the spot of an example gets the honest reveal and the tour offer, never a place to walk to", async () => {
  const w = world();
  const p = w.person("+12135550213");
  await p.finishOnboarding();
  clock += 8 * SEC;
  const out = await p.say("yeah where is it");
  const all = out.join(" ");
  assert.match(all, /hackathon/);
  assert.match(all, /example/);
  assert.match(all, /pretend u lost something|pretend/);
  assert.ok(!/leavey|tutor campus|tcc|village|doheny/i.test(all), "no building for a pizza that isn't there");
  assert.deepEqual({ flow: p.state()?.flow, step: p.state()?.step }, { flow: "tour", step: "offer" });
  // A yes (typed, or a thumbs up on the offer) starts the example.
  await p.say("sure");
  assert.equal(p.state()?.step, "describe");
  assert.ok(hasMove(w.db, p.id, "tour_lost"));
});

test("the reveal also comes from 'details?' and from a thumbs up on either bubble", async () => {
  for (const text of ["what are the details", "send me the spot", "ooh pizza"]) {
    const w = world();
    const p = w.person("+12135550214");
    await p.finishOnboarding();
    assert.match((await p.say(text)).join(" "), /hackathon/, text);
  }
  for (const bubble of [/pizza/, /3 people/]) {
    const w = world();
    const p = w.person("+12135550215");
    await p.finishOnboarding();
    assert.match((await p.tap(bubble, "like")).join(" "), /hackathon/);
    assert.equal(p.state()?.step, "offer");
    // The same question asked twice is not answered twice.
    assert.deepEqual(await p.tap(bubble, "like"), []);
  }
});

test("a no to the example offer is one easy line, and unrelated texts go through as usual", async () => {
  const w = world();
  const p = w.person("+12135550216");
  await p.finishOnboarding();
  const no = await p.say("nah im good");
  assert.equal(no.length, 1);
  assert.ok(!/hackathon/.test(no[0]));
  const v = world();
  const q = v.person("+12135550217");
  await q.finishOnboarding();
  await q.say("where is my wallet, i lost it at leavey");
  assert.ok(!q.texts().some((t) => /hackathon/.test(t)), "a real loss is not a question about the pizza");
});

test("a bare yes right after the poll starts the tour, and asking about the pizza still gets the honest answer later", async () => {
  const w = world();
  const p = w.person("+12135550230");
  await p.finishOnboarding();
  // "wanna see what i do?" was the last thing he asked, so yes means show me: no second question.
  const yes = await p.say("yes");
  // They were told about pizza and lost reports that were example numbers, and never asked: the honest line comes
  // first, exactly once, so nobody goes looking for pizza. Then the run starts.
  assert.equal(yes.filter((b) => /hackathon/.test(b)).length, 1, yes.join(" / "));
  assert.match(yes[0], /example/);
  assert.equal(p.state()?.step, "describe");

  const v = world();
  const q = v.person("+12135550238");
  await q.finishOnboarding();
  await q.say("haha nice");
  assert.equal(q.state()?.step, "offer");
  // The words themselves still get the honest reveal, even with his offer open.
  assert.match((await q.say("wait where's the pizza")).join(" "), /hackathon/);
});

test("a real drop nearby sends the spot straight away, with the walk computed in code", async () => {
  const w = world();
  const poster = w.person("+12135550218");
  const p = w.person("+12135550219");
  saveUserLocation(w.db, p.id, { lat: 34.0217, lng: -118.2829 }, "pin");
  w.db
    .prepare("INSERT INTO food_drops (posterUserId, description, locationText, lat, lng, servingsTotal, servingsLeft, status, createdAt) VALUES (?, 'chipotle bowls', 'Tutor Campus Center', 34.0203, -118.2863, 10, 10, 'live', ?)")
    .run(poster.id, clock);
  const out = await p.finishOnboarding();
  const food = out.find((b) => /chipotle bowls/.test(b))!;
  assert.ok(food, out.join(" / "));
  assert.match(food, /Tutor Campus Center/);
  assert.match(food, /\d+ min/);
  assert.ok(!/want the spot|want me to send/.test(food), "no hold-back when it's real");
  assert.ok(!out.some((b) => /pizza/.test(b)), "no example pizza next to a real drop");
  // Only the lost count is an example here, so "where" is not a question he has to come clean about.
  assert.ok(!(await p.say("ok cool")).some((b) => /hackathon/.test(b)));
});

test("a real drop that is too far, ended, an example or their own is not used", async () => {
  const w = world();
  const other = w.person("+12135550220");
  const p = w.person("+12135550221", { alertMinutes: 2 });
  saveUserLocation(w.db, p.id, { lat: 34.0217, lng: -118.2829 }, "pin");
  const add = w.db.prepare("INSERT INTO food_drops (posterUserId, description, locationText, lat, lng, servingsTotal, servingsLeft, status, isExample, createdAt) VALUES (?, ?, 'Tutor Campus Center', ?, ?, 10, ?, ?, ?, ?)");
  add.run(other.id, "far tacos", 34.03, -118.3, 10, "live", 0, clock);
  add.run(other.id, "gone donuts", 34.0217, -118.2829, 0, "live", 0, clock);
  add.run(other.id, "ended bagels", 34.0217, -118.2829, 5, "ended", 0, clock);
  add.run(other.id, "example sushi", 34.0217, -118.2829, 5, "live", 1, clock);
  add.run(p.id, "my own cookies", 34.0217, -118.2829, 5, "live", 0, clock);
  const out = await p.finishOnboarding();
  assert.ok(!out.some((b) => /tacos|donuts|bagels|sushi|cookies/.test(b)), out.join(" / "));
  assert.ok(out.some((b) => /pizza/.test(b) && /8 min/.test(b)), "the example line, since nothing real qualifies");
});

test("real lost reports nearby: a real count, and details never say what the items are", async () => {
  const w = world();
  const other = w.person("+12135550222");
  const p = w.person("+12135550223", { subscriptions: "[]" });
  saveUserLocation(w.db, p.id, { lat: 34.0217, lng: -118.2829 }, "pin");
  const add = w.db.prepare("INSERT INTO listings (userId, type, category, title, details, locationText, lat, lng, status, isExample, createdAt) VALUES (?, 'lost', ?, ?, '{}', ?, ?, ?, 'open', ?, ?)");
  add.run(other.id, "wallet", "brown leather wallet", "Leavey Library", 34.0217, -118.2829, 0, clock);
  add.run(other.id, "keys", "keys on a red lanyard", "Leavey Library", 34.0218, -118.283, 0, clock);
  add.run(other.id, "phone", "example phone", "Leavey Library", 34.0217, -118.2829, 1, clock);
  add.run(other.id, "bag", "far away bag", "Somewhere Else", 34.2, -118.5, 0, clock);
  const out = await p.finishOnboarding();
  const lost = out.find((b) => /\d+ (?:people|person)/.test(b))!;
  assert.match(lost, /2 people/);
  const details = await p.say("yeah what are the details");
  const all = details.join(" ");
  assert.match(all, /Leavey Library/);
  assert.ok(!/wallet|keys|lanyard|leather|brown|red/.test(all), "counts and places only, never the items");
  assert.ok(!/hackathon/.test(all), "nothing to come clean about: these are real");
  assert.equal(p.state(), null);
});

test("someone who did a move gets one follow-up about it, seven minutes in, and no move is played twice", async () => {
  const w = world();
  const p = w.person("+12135550224");
  const start = clock;
  await p.finishOnboarding();
  clock = start + 10 * SEC;
  await p.say("where is it");
  await p.say("yes");
  assert.equal(p.state()?.step, "describe");
  await p.say("nvm");
  assert.equal(p.state(), null);
  assert.deepEqual(await w.sweepAt(p, start + 3 * MIN), [], "not the one question: they did something");
  assert.deepEqual(await w.sweepAt(p, start + 7 * MIN - SEC), []);
  const follow = await w.sweepAt(p, start + 7 * MIN + SEC);
  assert.equal(follow.length, 1);
  assert.match(follow[0], /real/);
  assert.match(follow[0], /lose|missing/);
  assert.deepEqual(await w.sweepAt(p, start + 8 * MIN), []);
  assert.deepEqual(await w.sweepAt(p, start + 9 * MIN), []);
  assert.equal(w.polls.length, 1);
  assert.ok(hasMove(w.db, p.id, "follow_up"));
});

test("he never talks over an open step, and nothing new starts after ten minutes", async () => {
  const w = world();
  const p = w.person("+12135550225");
  const start = clock;
  await p.finishOnboarding();
  setFlowState(w.db, p.id, { flow: "repair", step: "where", data: {} });
  assert.equal(dueNow(w.db, p.id, start + 95 * SEC), null);
  setFlowState(w.db, p.id, null);
  assert.equal(dueNow(w.db, p.id, start + 31 * SEC), null, "the poll already went out");
  assert.equal(dueNow(w.db, p.id, start + 95 * SEC), "question");
  assert.equal(dueNow(w.db, p.id, start + 10 * MIN + SEC), null, "the plan is ten minutes long");
});

test("the state survives a restart: a new pipeline on the same database picks up what is due", async () => {
  const w = world();
  const p = w.person("+12135550226");
  const start = clock;
  await p.finishOnboarding();
  // Same database, fresh pipeline (what a restart looks like).
  const sent: string[] = [];
  let polls = 0;
  const fresh = createPipeline({
    db: w.db,
    getAdapter: () =>
      ({
        provider: "webchat",
        capabilities: () => ({ tapbacks: true, typing: true, readReceipts: true, edits: false, effects: true, polls: true, groupChats: false, contactCard: true, liveLocation: false }),
        sendMessage: async (_c: string, text: string) => (sent.push(text), { messageId: `r-${sent.length}` }),
        sendImage: async () => null,
        sendContactCard: async () => null,
        markRead: async () => {},
        startTyping: async () => {},
        stopTyping: async () => {},
        react: async () => true,
        editMessage: async () => false,
        sendPoll: async (_c: string, _q: string, options: string[]) => (polls++, { optionMessageIds: options.map(() => "r-poll"), mode: "native" as const }),
        createGroupChat: async () => null,
        getLiveLocation: async () => null,
        requestLocation: async () => false,
        chatIdForHandle: (h: string) => h,
      }) as MessagingAdapter,
    pause: async () => {},
    detectIntent: async (i) => fallbackIntent(i),
    readSafety: null,
  });
  clock = start + 95 * SEC;
  await fresh.sweep(clock);
  assert.equal(polls, 0, "the poll went out before the restart");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /usc/);
});

// ---------- review fixes (each through the real pipeline, model off) ----------

test("an unanswered delete question does not stay armed through a tap: a later yes to something else deletes nothing", async () => {
  const w = world();
  const p = w.person("+12135550260");
  await p.finishOnboarding();
  const ask = await p.say("delete me pls");
  assert.match(ask.join(" "), /"yes"/);
  // They change their mind and tap the try-me poll instead. He plays the example drop, which ends on 'text "claim"'.
  const drop = await p.vote(1);
  assert.match(drop.at(-1)!, /"claim"/);
  const yes = await p.say("yes");
  assert.ok(!yes.some((b) => /deleted/.test(b)), yes.join(" / "));
  const u = getUserById(w.db, p.id)!;
  assert.ok(u.verifiedAt, "still verified");
  assert.deepEqual(u.subscriptions, ["free_nearby"]);
  assert.ok(count(w.db, "messages") > 0, "nothing was wiped");
  // The yes went where it belonged: the example claim.
  assert.match(yes.join(" "), /held|got u one|one's urs/);

  // Same with a tapback on some other bubble of his, and with something he sends on his own in between.
  const v = world();
  const q = v.person("+12135550261");
  await q.finishOnboarding();
  await q.say("delete me pls");
  await q.tap(/student government/, "like");
  assert.ok(!(await q.say("yes")).some((b) => /deleted/.test(b)));
  assert.ok(getUserById(v.db, q.id)!.verifiedAt);

  // And the plain case still works: ask, typed yes, gone.
  const x = world();
  const r = x.person("+12135550262");
  await r.finishOnboarding();
  await r.say("delete me pls");
  assert.ok((await r.say("yes")).some((b) => /deleted/.test(b)));
  assert.equal(getUserById(x.db, r.id)!.verifiedAt, null);
});

test("saying they're good at the tour offer relaxes him: one easy line, no question, no demo, and nothing later", async () => {
  for (const bye of ["maybe later", "nah im good", "gtg"]) {
    const w = world();
    const p = w.person("+12135550263");
    const start = clock;
    await p.finishOnboarding();
    assert.match((await p.say("ok")).join(" "), /pretend u lost something/);
    const out = await p.say(bye);
    assert.equal(out.length, 1, `${bye}: ${out.join(" / ")}`);
    assert.ok(!/\?$/.test(out[0]!) && !/example|pretend|wish/.test(out[0]!), `${bye}: ${out[0]}`);
    assert.equal(p.state(), null);
    assert.ok(!isUntried(w.db, p.id), "he relaxed");
    // An "ok" after that is just an ok: no example run, no new offer.
    const after = await p.say("ok");
    assert.ok(!after.some((b) => /example|pretend u lost|wish (?:was|were)/.test(b)), after.join(" / "));
    assert.equal(p.state(), null);
    for (const at of [40 * SEC, 2 * MIN, 8 * MIN]) assert.deepEqual(await w.sweepAt(p, start + at), [], "nothing unprompted for someone who said they're good");
  }
});

test("a plain no to the tour gets the one question once, and a bare ok to that question is the answer, not a cue for another demo", async () => {
  const w = world();
  const p = w.person("+12135550264");
  await p.finishOnboarding();
  await p.say("ok");
  const q = await p.say("no");
  assert.equal(q.length, 1);
  assert.match(q[0], /usc/);
  const out = await p.say("ok");
  assert.equal(out.length, 1, out.join(" / "));
  assert.ok(!/example|pretend|\?$/.test(out[0]!), out[0]);
  assert.equal(p.state(), null);
  assert.ok(!isUntried(w.db, p.id));
});

test("the unprompted question is timed from the newest message in either direction, and waits longer behind an open ask of his", async () => {
  const w = world();
  const p = w.person("+12135550265");
  const start = clock;
  await p.finishOnboarding();
  clock = start + 10 * SEC;
  await p.say("what even is this");
  // Model down: the pool reply closes on the one question itself, so nothing is left for the timer.
  assert.equal(dueNow(w.db, p.id, clock + 40 * SEC), null);

  // His own reply landed well after their text, and it ended on a question: 25 seconds after THEIR text is too soon.
  const v = world();
  const q = v.person("+12135550266");
  const t0 = clock;
  await q.finishOnboarding();
  clock = t0 + 10 * SEC;
  v.db.prepare("UPDATE first_ten SET lastInAt = ? WHERE userId = ?").run(clock, q.id);
  const landed = clock + 15 * SEC;
  v.db.prepare("INSERT INTO messages (userId, chatId, direction, providerMessageId, text, media, createdAt, notice) VALUES (?, ?, 'out', 'late-1', ?, '[]', ?, 0)").run(q.id, q.chatId, "it's a hackathon thing. wanna try it?", landed);
  assert.equal(dueNow(v.db, q.id, clock + 26 * SEC), null, "26 s after their text is only 11 s after his reply");
  assert.equal(dueNow(v.db, q.id, landed + 26 * SEC), null, "his last bubble is still an open ask: no second ask stacked on it");
  assert.equal(dueNow(v.db, q.id, landed + 91 * SEC), "question");
  // When his last bubble asks nothing, 25 seconds of quiet after it is enough.
  v.db.prepare("UPDATE messages SET text = ? WHERE providerMessageId = 'late-1'").run("it's a hackathon build, john made me");
  assert.equal(dueNow(v.db, q.id, landed + 20 * SEC), null);
  assert.equal(dueNow(v.db, q.id, landed + 26 * SEC), "question");
});

test("what he starts on his own waits behind a reply that is still going out to that person", async () => {
  const w = world();
  const p = w.person("+12135550267");
  const start = clock;
  await p.finishOnboarding();
  // A slow turn: a registered flow that holds the queue until released.
  let release = () => {};
  const held = new Promise<void>((r) => (release = r));
  registerFlow({
    name: "notes",
    async handle(ctx) {
      await held;
      await ctx.say("here's ur answer. want to try it?");
    },
  });
  setFlowState(w.db, p.id, { flow: "notes", step: "x", data: {} });
  clock = start + 5 * SEC;
  const turn = p.say("a real question");
  await new Promise((r) => setTimeout(r, 5));
  // The sweep fires while that reply is in flight, at a time the old rule called due.
  clock = start + 95 * SEC;
  const sweeping = w.pipeline.sweep(clock);
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(!p.texts().some((t) => /wish|easier at usc|less of a hassle|worked better/.test(t)), "nothing lands mid-reply");
  setFlowState(w.db, p.id, null);
  release();
  await turn;
  await sweeping;
  const all = p.texts();
  const reply = all.indexOf("here's ur answer. want to try it?");
  assert.ok(reply !== -1);
  assert.ok(!all.slice(reply + 1).some((t) => /wish|easier at usc|less of a hassle|worked better/.test(t)), "and not right behind his own open ask either");
});

test("a bare ok to 'where do u usually study?' is not saved as a spot: he asks once more, then lets it go", async () => {
  const w = world();
  const p = w.person("+12135550268");
  await p.finishOnboarding();
  await p.vote(1);
  const claimed = await p.say("claim");
  assert.match(claimed.at(-1)!, /study|usually/);
  assert.equal(p.state()?.step, "study_spot");
  const again = await p.say("ok");
  assert.equal(again.length, 1);
  assert.ok(!/saved/.test(again[0]!), again[0]);
  assert.match(again[0], /"/, "an example of what to answer, in quotes");
  assert.deepEqual(getUserById(w.db, p.id)!.usualSpots, []);
  assert.equal(p.state()?.step, "study_spot");
  // A second non-answer ends it quietly, with nothing saved.
  const quiet = await p.say("sure");
  assert.ok(!quiet.some((b) => /saved/.test(b)), quiet.join(" / "));
  assert.deepEqual(getUserById(w.db, p.id)!.usualSpots, []);

  const v = world();
  const q = v.person("+12135550269");
  await q.finishOnboarding();
  await q.vote(1);
  await q.say("claim");
  await q.say("ok");
  assert.match((await q.say("leavey and the village")).join(" "), /saved|walking times/);
  assert.deepEqual(getUserById(v.db, q.id)!.usualSpots, ["leavey", "the village"]);
});

test("nah at the tour's describe step ends the example quietly: no failed check, no next offer", async () => {
  const w = world();
  const p = w.person("+12135550270");
  await p.finishOnboarding();
  await p.vote(0);
  assert.equal(p.state()?.step, "describe");
  const out = await p.say("nah");
  assert.equal(out.length, 1, out.join(" / "));
  assert.ok(!/line up|couldn't confirm|free food|\?$/.test(out[0]!), out[0]);
  assert.equal(p.state(), null);
});

test("with the model down, a reply in the middle of a tour step is written to the student, never about them", async () => {
  const w = world();
  const p = w.person("+12135550271");
  await p.finishOnboarding();
  await p.vote(0);
  const lines = [...(await p.say("ok")), ...(await p.say("ok")), ...(await p.say("wait what is this"))];
  for (const l of lines) assert.ok(!/\btheir\b|\bthey\b|\bthem\b/.test(l), l);
  assert.equal(p.state()?.step, "describe");

  const v = world();
  const q = v.person("+12135550272");
  await q.finishOnboarding();
  await q.vote(1);
  const mid = await q.say("wait what is this");
  for (const l of mid) assert.ok(!/\btheir\b|\bthey\b|\bthem to\b/.test(l), l);
});

// From the live replay of John's dorm conversation: "Yeah and my ra doesn't enforce it" brushed the example offer
// (the "yeah"), so this path answered it, and its reply was a third question in a row that nothing checked.
test("a long message that only starts with yeah is not about the example offer: the pizza is never pushed into a vent", async () => {
  const w = world();
  const p = w.person("+12135550292");
  await p.finishOnboarding();
  const systems: string[] = [];
  setModelCall(async (opts) => {
    systems.push(opts.prompt);
    return JSON.stringify({ bubbles: ["btw that pizza spot is still up if u want it"], action: null, handoff: null });
  });
  await p.say("Yeah and my ra doesn't enforce it");
  setModelCall(null);
  assert.ok(!systems.some((s) => /to know if u want that pizza spot/.test(s)), "the example-offer step never saw it");
  // A message that does ask about it still gets there.
  const w2 = world();
  const q = w2.person("+12135550293");
  await q.finishOnboarding();
  const seen: string[] = [];
  setModelCall(async (opts) => {
    seen.push(opts.prompt);
    return JSON.stringify({ bubbles: ["one sec"], action: null, handoff: null });
  });
  await q.say("hm is the food any good tho");
  setModelCall(null);
  assert.ok(seen.some((s) => /to know if u want that pizza spot/.test(s)), "a text about the food goes to the example-offer step");
});

test("chat about the example offer is held to the question limit too: a third question in a row is not sent from here", async () => {
  const w = world();
  const p = w.person("+12135550291");
  await p.finishOnboarding();
  const chatId = "chat-+12135550291";
  for (const [direction, text] of [["in", "i hardly get sleep"], ["out", "what's keeping u up?"], ["in", "dorm mates are annoying"], ["out", "what are they doing, loud at night?"]] as const) {
    saveMessage(w.db, { userId: p.id, chatId, direction, providerMessageId: null, text });
  }
  let calls = 0;
  setModelCall(async () => {
    calls++;
    // The first call is this path's own reply. Whatever answers after it is the ordinary chat path.
    if (calls === 1) return JSON.stringify({ bubbles: ["ugh, an ra who lets it slide is the worst part", "what does ur ra say when u bring it up"], action: null });
    return JSON.stringify({ bubbles: ["ugh, an ra who lets it slide is the worst part of that"], handoff: null });
  });
  const out = await p.say("where is the ra when u need them");
  setModelCall(null);
  assert.ok(calls >= 2, "the ordinary chat path answered instead");
  assert.ok(!out.some((b) => /what does ur ra say/.test(b)), out.join(" / "));
  assert.ok(out.length >= 1);
});
