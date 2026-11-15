// The first ten minutes after onboarding: what goes out, when, and what stops it.
// A fake clock drives everything (setFirstTenDeps), in-process timers are off, and the sweep is called by hand.
// No model here, so every line is one of the hand-written variants.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import type { FlowContext, IncomingEvent, Intent, MessagingAdapter, TapbackType } from "../src/types.ts";
import { openDb, getOrCreateUser, getUserById, updateUser, getFlowState, setFlowState, saveMessage } from "../src/db/index.ts";
import { createPipeline } from "../src/pipeline.ts";
import { fallbackIntent } from "../src/ai.ts";
import { saveUserLocation } from "../src/location.ts";
import { FIRST_TEN, TRY_ME_OPTIONS, afterOnboarding, cancelFirstTen, dueNow, hasMove, setFirstTenDeps } from "../src/firstten.ts";

console.warn = () => {};

const SEC = 1000;
const MIN = 60 * SEC;
let clock = 0;

beforeEach(() => {
  clock = Date.now();
  setFirstTenDeps({ now: () => clock, timers: false });
});
after(() => setFirstTenDeps(null));

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
  assert.equal(FIRST_TEN.pollAfterMs, 30 * SEC);
  assert.equal(FIRST_TEN.questionAfterMs, 2 * MIN);
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
  // The near-u bubbles: example numbers, unlabeled, and the food spot held back.
  const food = out.find((b) => /pizza/.test(b))!;
  assert.match(food, /8 min/);
  assert.match(food, /spot\?$/);
  const lost = out.find((b) => /3 people/.test(b))!;
  assert.match(lost, /details/);
  assert.ok(!/example|hackathon|demo|pretend/.test(all), "nothing is labeled until they ask");
  assert.ok(!/leavey|tutor|tcc|village/i.test(`${food} ${lost}`), "no place is named for something that isn't there");
  assert.equal(w.polls.length, 0, "the poll waits");
  assert.equal(p.state(), null);
});

test("no food line for someone who didn't pick the food topic", async () => {
  const w = world();
  const p = w.person("+12135550202", { subscriptions: JSON.stringify(["pickup"]) });
  const out = await p.finishOnboarding();
  assert.ok(!out.some((b) => /pizza/.test(b)));
  assert.ok(out.some((b) => /3 people/.test(b)));
});

test("silence: the 'try me' poll after 30 seconds, and then nothing else unprompted in the first hour", async () => {
  const w = world();
  const p = w.person("+12135550203");
  const start = clock;
  await p.finishOnboarding();
  assert.deepEqual(await w.sweepAt(p, start + 29 * SEC), [], "not before 30 seconds");
  assert.equal(w.polls.length, 0);
  await w.sweepAt(p, start + 31 * SEC);
  assert.equal(w.polls.length, 1);
  assert.deepEqual(w.polls[0].options, [...TRY_ME_OPTIONS]);
  assert.match(w.polls[0].question, /tap one|pick one/);
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
  const dare = await s.vote(2);
  assert.equal(dare.length, 1);
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
  await p.finishOnboarding();
  const hint = await w.sweepAt(p, clock + 31 * SEC);
  assert.equal(hint.length, 1);
  assert.match(hint[0], /heart|thumbs up/);
  const poll = w.polls[0];
  await w.pipeline.handleEvent({ provider: "webchat", userHandle: "+12135550206", chatId: p.chatId, isGroup: false, messageId: "tap-1", text: "", images: [], receivedAt: clock, reaction: { targetMessageId: `${poll.id}-opt-0`, type: "like", removed: false } });
  assert.equal(p.state()?.flow, "tour");

  const n = world({ pollMode: "numbered" });
  const q = n.person("+12135550207");
  await q.finishOnboarding();
  const how = await n.sweepAt(q, clock + 31 * SEC);
  assert.match(how[0], /"1", "2" or "3"/);
  await q.say("3");
  assert.equal(q.state(), null);
  assert.match(q.texts().at(-1)!, /campus problem/);
});

test("judges get the poll right after onboarding, and nothing else unprompted", async () => {
  const w = world();
  const p = w.person("+12135550208", { verifiedVia: "judge_skip" });
  const start = clock;
  await p.finishOnboarding();
  assert.equal(w.polls.length, 1);
  for (const at of [31 * SEC, 3 * MIN, 8 * MIN]) assert.deepEqual(await w.sweepAt(p, start + at), []);
  assert.equal(w.polls.length, 1);
});

test("they chat but start nothing: no poll, and the one question after a couple of quiet minutes. the answer goes somewhere real", async () => {
  const w = world();
  const p = w.person("+12135550209");
  const start = clock;
  await p.finishOnboarding();
  clock = start + 10 * SEC;
  await p.say("lol ok cool");
  assert.deepEqual(await w.sweepAt(p, start + 31 * SEC), [], "they spoke, so no poll");
  assert.deepEqual(await w.sweepAt(p, start + 10 * SEC + 2 * MIN - SEC), [], "not before two quiet minutes");
  const asked = await w.sweepAt(p, start + 10 * SEC + 2 * MIN + SEC);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /usc/);
  assert.match(asked[0], /\?$/);
  assert.equal(w.polls.length, 0);
  assert.deepEqual(await w.sweepAt(p, start + 8 * MIN), [], "one unprompted message, not two");

  clock = start + 9 * MIN;
  await p.say("finding people to study with tbh");
  assert.ok(p.state()?.flow === "usg" || count(w.db, "reports") > 0, "the wish is on its way to student government");
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
  for (const at of [31 * SEC, 2 * MIN + 10 * SEC, 3 * MIN, 7 * MIN + SEC, 9 * MIN]) {
    assert.equal(dueNow(w.db, p.id, start + at), null);
    assert.deepEqual(await w.sweepAt(p, start + at), []);
  }
  assert.equal(w.polls.length, 0);
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
    for (const at of [31 * SEC, 3 * MIN, 8 * MIN]) assert.deepEqual(await w.sweepAt(p, start + at), [], `${word}: nothing at ${at / SEC}s`);
    assert.equal(w.polls.length, 0);
  }
});

test("quiet hours and a paused user hold everything back; cancelFirstTen is safe for someone with no plan", async () => {
  const w = world();
  const p = w.person("+12135550212", { quietHours: JSON.stringify({ start: "00:00", end: "23:59" }) });
  const start = clock;
  await p.finishOnboarding();
  assert.equal(dueNow(w.db, p.id, start + 31 * SEC), null);
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

test("the reveal also comes from 'details?', from a plain yes, and from a thumbs up on either bubble", async () => {
  for (const text of ["what are the details", "yes", "send me the spot", "ooh pizza"]) {
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

test("a bare yes only answers the 'near u' bubbles while they are the last thing he said", async () => {
  const w = world();
  const p = w.person("+12135550230");
  await p.finishOnboarding();
  await p.say("haha nice");
  // Troy has said something else since, so this yes is not about the pizza.
  assert.ok(!(await p.say("yes")).some((b) => /hackathon/.test(b)));
  // The words themselves still are.
  assert.match((await p.say("wait where's the pizza")).join(" "), /hackathon/);
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
  assert.ok(out.some((b) => /pizza/.test(b) && /spot\?$/.test(b)));
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
  assert.equal(w.polls.length, 0);
  assert.ok(hasMove(w.db, p.id, "follow_up"));
});

test("he never talks over an open step, and nothing new starts after ten minutes", async () => {
  const w = world();
  const p = w.person("+12135550225");
  const start = clock;
  await p.finishOnboarding();
  setFlowState(w.db, p.id, { flow: "repair", step: "where", data: {} });
  assert.equal(dueNow(w.db, p.id, start + 31 * SEC), null);
  setFlowState(w.db, p.id, null);
  assert.equal(dueNow(w.db, p.id, start + 31 * SEC), "poll");
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
  clock = start + 40 * SEC;
  await fresh.sweep(clock);
  assert.equal(polls, 1);
});
