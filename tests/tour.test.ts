// The try-it tour, each variant through the real pipeline. The person plays a part against example data and goes
// through the real checks. Nothing may be written where it could match a real report or reach a real person.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { IncomingEvent, IncomingImage, Intent, MessagingAdapter, TapbackType } from "../src/types.ts";
import { openDb, getOrCreateUser, getUserById, updateUser, getFlowState } from "../src/db/index.ts";
import { createPipeline } from "../src/pipeline.ts";
import { fallbackIntent, setModelCall } from "../src/ai.ts";
import { saveUserLocation } from "../src/location.ts";
import { hasMove, setFirstTenDeps } from "../src/firstten.ts";
import { setSimulateDeps } from "../src/simulate.ts";
import { EXAMPLE_DROP, EXAMPLE_ITEM, TOUR_HOLDS } from "../src/flows/tour.ts";
import { THRESHOLDS, scoreDescription } from "../src/flows/lostfound/verify.ts";

console.warn = () => {};
setFirstTenDeps({ timers: false });
// The example finder's pauses are real time in production. Not here.
setSimulateDeps({ pause: async () => {} });
after(() => {
  setFirstTenDeps(null);
  setSimulateDeps(null);
  setModelCall(null);
});
beforeEach(() => setModelCall(null));

const PHOTO: IncomingImage = { path: "/tmp/troy-test/broken.jpg", mime: "image/jpeg" };
const GOOD = "navy hydro flask with a usc sticker on the side and a dent on the bottom";
const BAD = "plain black bottle, nothing on it";

function world(opts: { edits?: boolean } = {}) {
  const db = openDb(":memory:");
  const place = db.prepare("INSERT OR IGNORE INTO campus_places (name, nicknames, lat, lng, kind) VALUES (?, ?, ?, ?, 'campus')");
  place.run("Leavey Library", '["leavey"]', 34.0217, -118.2829);
  place.run("Tutor Campus Center", '["tcc"]', 34.0203, -118.2863);
  const sent: { text: string; id: string }[] = [];
  const edits: { id: string; text: string }[] = [];
  const groups: unknown[] = [];
  let n = 0;
  const adapter: MessagingAdapter = {
    provider: "webchat",
    capabilities: () => ({ tapbacks: true, typing: true, readReceipts: true, edits: !!opts.edits, effects: true, polls: false, groupChats: true, contactCard: true, liveLocation: false }),
    async sendMessage(_chatId, text) {
      const id = `out-${++n}`;
      sent.push({ text, id });
      return { messageId: id };
    },
    sendImage: async () => null,
    sendContactCard: async () => null,
    markRead: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    react: async () => true,
    async editMessage(_chatId, id, text) {
      if (!opts.edits) return false;
      edits.push({ id, text });
      return true;
    },
    sendPoll: async (_c, _q, options) => ({ optionMessageIds: options.map(() => null), mode: "numbered" }),
    async createGroupChat(members) {
      groups.push(members);
      return "group-1";
    },
    getLiveLocation: async () => null,
    requestLocation: async () => false,
    chatIdForHandle: (h) => `chat-${h}`,
  };
  // "show me the lost / food / repair one" stands in for intent detection sending someone to the tour.
  const detect = (i: { text: string; hasImage: boolean; state: Intent extends never ? never : Parameters<typeof fallbackIntent>[0]["state"] }): Intent => {
    const m = /^show me the (lost|food|repair) one/.exec(i.text);
    return m ? { flow: "tour", action: m[1]!, details: {}, source: "ai" } : fallbackIntent(i);
  };
  const pipeline = createPipeline({ db, getAdapter: () => adapter, pause: async () => {}, ackAfterMs: 60_000, detectIntent: async (i) => detect(i), readSafety: null });
  const handle = "+12135550301";
  const chatId = `chat-${handle}`;
  const u = getOrCreateUser(db, handle, chatId);
  updateUser(db, u.id, { verifiedAt: Date.now(), verifiedVia: "usc_email", name: "Tess Tour", uscEmail: "tess.tour@usc.edu" });
  let m = 0;
  const event = (over: Partial<IncomingEvent>): IncomingEvent => ({ provider: "webchat", userHandle: handle, chatId, isGroup: false, messageId: `in-${++m}`, text: "", images: [], receivedAt: Date.now(), ...over });
  const texts = () => sent.map((s) => s.text);
  const say = async (text: string, images: IncomingImage[] = []) => {
    const before = sent.length;
    await pipeline.handleEvent(event({ text, images }));
    return texts().slice(before);
  };
  const tap = async (onText: RegExp, type: TapbackType) => {
    const target = [...sent].reverse().find((s) => onText.test(s.text));
    assert.ok(target, `no bubble matching ${onText}`);
    const before = sent.length;
    await pipeline.handleEvent(event({ reaction: { targetMessageId: target.id, type, removed: false } }));
    return texts().slice(before);
  };
  return { db, id: u.id, say, tap, texts, sent, edits, groups, state: () => getFlowState(db, u.id), user: () => getUserById(db, u.id)! };
}

const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
/** Nothing real: no listing, match, check, handoff, drop, claim or report was written. */
function assertNothingSaved(db: DatabaseSync): void {
  for (const table of ["listings", "matches", "verifications", "handoffs", "food_drops", "claims", "reports", "relays"]) assert.equal(count(db, table), 0, `${table} is empty`);
}
const saysExample = (bubbles: string[]) => /example|pretend|simulation|not real|nothing here is real|none of this is real/.test(bubbles.join(" "));

test("the example item is checked by the real scoring: the right description passes the rules, a wrong or vague one doesn't", async () => {
  const good = await scoreDescription(EXAMPLE_ITEM, GOOD, { useAi: false });
  assert.ok(good.score >= THRESHOLDS.descriptionPass, `good scored ${good.score}`);
  for (const t of [BAD, "its a water bottle", "blue bottle", "red hydro flask with a nike sticker"]) {
    const r = await scoreDescription(EXAMPLE_ITEM, t, { useAi: false });
    assert.ok(r.score < THRESHOLDS.descriptionPass, `"${t}" scored ${r.score}`);
  }
  assert.ok(TOUR_HOLDS.has("describe"));
});

test("lost: example labelled at the start, the real blind check, a pretend handoff, labelled again at the end, nothing saved", async () => {
  const w = world();
  const start = await w.say("show me the lost one");
  assert.ok(saysExample(start), start.join(" / "));
  assert.match(start.join(" "), /navy hydro flask/);
  assert.match(start.join(" "), /usc sticker on the side, a dent on the bottom and a green carabiner on the lid/);
  assert.match(start.at(-1)!, /describe|tell me about it/);
  assert.equal(w.state()?.step, "describe");
  assert.ok(hasMove(w.db, w.id, "tour_lost"));

  // No model here, so it goes the way the real flow goes then: the finder reads the description and decides.
  const passed = await w.say(GOOD);
  assert.match(passed.join(" "), /finder/);
  assert.match(passed.join(" "), /meet/);
  assert.match(passed.at(-1)!, /"yes" or "no"/);
  assert.match(passed.join(" "), /contact info/);
  assert.equal(w.state()?.step, "handoff");

  const done = await w.say("yes");
  assert.match(done.join(" "), /group chat/);
  assert.match(done.join(" "), /"got it"/);
  assert.ok(saysExample(done), done.join(" / "));
  assert.match(done.join(" "), /nothing (?:got |was )?(?:saved|kept)/);
  // One more is offered once, as a question (never a menu).
  assert.match(done.at(-1)!, /food/);
  assert.deepEqual({ step: w.state()?.step, variant: w.state()?.data.variant }, { step: "offer", variant: "food" });
  assert.equal(w.groups.length, 0, "no real group chat");
  assertNothingSaved(w.db);
});

test("lost, with the model up: the same check a real owner gets, scored by the model", async () => {
  const seen: string[] = [];
  setModelCall(async (opts) => {
    if (opts.system.startsWith("You check whether")) {
      const { claimantDescription, item } = JSON.parse(opts.prompt) as { claimantDescription: string; item: { distinguishing: string[] } };
      seen.push(claimantDescription);
      assert.deepEqual(item.distinguishing, EXAMPLE_ITEM.distinguishing);
      return JSON.stringify({ score: /sticker/.test(claimantDescription) ? 93 : 12, reasons: [] });
    }
    throw new Error("off");
  });
  const w = world();
  await w.say("show me the lost one");
  const retry = await w.say("its a bottle with stuff on it");
  assert.equal(w.state()?.step, "describe");
  assert.equal(w.state()?.data.tries, 1);
  assert.ok(!/sticker|dent|carabiner/.test(retry.join(" ")), "a miss never says what was wrong");
  const passed = await w.say("it has a usc sticker and a dent");
  assert.match(passed[0], /checks out|lines up/);
  assert.equal(w.state()?.step, "handoff");
  assert.equal(seen.length, 2);
  const no = await w.say("no");
  assert.match(no.join(" "), /no group chat|relay|pass messages|carry messages/);
  assertNothingSaved(w.db);
});

test("lost: two misses end it the way the real one does, with no hint about what was wrong", async () => {
  const w = world();
  await w.say("show me the lost one");
  const first = await w.say(BAD);
  assert.equal(w.state()?.step, "describe");
  assert.match(first.join(" "), /line up|matching/);
  const second = await w.say("it's just a bottle");
  const all = [...first, ...second].join(" ");
  assert.match(second.join(" "), /finder/);
  assert.match(second.join(" "), /guess/);
  assert.ok(!/sticker|dent|carabiner|tries|attempts|\b2\b/.test(all), "no answer key");
  assert.ok(saysExample(second));
  assert.notEqual(w.state()?.step, "describe");
  assertNothingSaved(w.db);
});

test("lost: a description that says 'lost' or 'broken' is still the description, and files nothing real", async () => {
  const w = world();
  await w.say("show me the lost one");
  await w.say("i lost my navy bottle, it has a usc sticker and the bottom is dented and kinda broken");
  assert.equal(w.state()?.flow, "tour");
  assert.equal(w.state()?.step, "handoff");
  assertNothingSaved(w.db);
});

test("lost: the pretend contact question takes a thumbs up only on that exact bubble", async () => {
  const w = world();
  await w.say("show me the lost one");
  await w.say(GOOD);
  assert.deepEqual(await w.tap(/sounds right|sounds like it/, "like"), [], "a thumbs up on another bubble is only an acknowledgement");
  assert.equal(w.state()?.step, "handoff");
  const done = await w.tap(/"yes" or "no"/, "like");
  assert.match(done.join(" "), /group chat/);
  assert.notEqual(w.state()?.step, "handoff");
  // The description step itself can't be answered with a tapback.
  const v = world();
  await v.say("show me the lost one");
  assert.deepEqual(await v.tap(/describe|tell me about it/, "like"), []);
  assert.equal(v.state()?.step, "describe");
});

test("a question in the middle of a step gets an answer and the step stays open with no try used", async () => {
  const w = world();
  await w.say("show me the lost one");
  const reply = await w.say("wait is this real?");
  assert.ok(reply.length > 0, "not left on read");
  assert.equal(w.state()?.step, "describe");
  assert.equal(w.state()?.data.tries, 0);
});

test("nvm ends the example at any step, and a real request leaves it for the real flow", async () => {
  const w = world();
  await w.say("show me the lost one");
  const out = await w.say("nvm");
  assert.equal(out.length, 1);
  assert.equal(w.state(), null);

  const r = world();
  await r.say("show me the lost one");
  await r.say("no really, i actually lost my wallet at leavey for real");
  assert.notEqual(r.state()?.flow, "tour");
  assert.ok(r.state()?.flow === "lost_found" || count(r.db, "listings") > 0, "the real lost and found flow has it now");
});

test("food: claim a serving of the example drop and watch the count change, with nothing to walk to and nothing saved", async () => {
  const w = world();
  saveUserLocation(w.db, w.id, { lat: 34.0217, lng: -118.2829 }, "pin");
  const start = await w.say("show me the food one");
  assert.ok(saysExample(start), start.join(" / "));
  assert.match(start.join(" "), /don't actually walk|no real pizza|nothing to walk/);
  assert.match(start.join(" "), new RegExp(`${EXAMPLE_DROP.servings} slices of ${EXAMPLE_DROP.what} at ${EXAMPLE_DROP.place}`));
  assert.match(start.join(" "), /\d+ min/, "a walking time computed from where they are");
  assert.ok(start.includes("12 left"));
  assert.match(start.at(-1)!, /"claim"/);
  assert.equal(w.state()?.step, "food_claim");

  const claimed = await w.say("claim");
  assert.equal(claimed[0], "11 left", "the count drops by one");
  assert.match(claimed.join(" "), /15 min/);
  assert.ok(saysExample(claimed));
  assert.equal(w.state(), null);
  assertNothingSaved(w.db);
});

test("food: a thumbs up claims too, and the count bubble is edited in place when the provider can", async () => {
  const w = world({ edits: true });
  saveUserLocation(w.db, w.id, { lat: 34.0217, lng: -118.2829 }, "pin");
  await w.say("show me the food one");
  const countBubble = w.sent.find((s) => s.text === "12 left")!;
  const claimed = await w.tap(/^12 left$/, "like");
  assert.deepEqual(w.edits, [{ id: countBubble.id, text: "11 left" }]);
  assert.ok(!claimed.includes("11 left"), "edited, not sent again");
  assert.ok(saysExample(claimed));
  assertNothingSaved(w.db);
});

test("food, with no location on file: no walking time is made up, and he asks once where they usually study", async () => {
  const w = world();
  const start = await w.say("show me the food one");
  assert.ok(!/\d+ min/.test(start.join(" ")), "no walking time without a place to walk from");
  const claimed = await w.say("claim");
  const ask = claimed.at(-1)!;
  assert.match(ask, /where (?:do|are) u usually/);
  assert.ok(!/skip/.test(ask), "never suggests skipping");
  assert.equal(w.state()?.step, "study_spot");
  const saved = await w.say("leavey and the village");
  assert.equal(saved.length, 1);
  assert.deepEqual(w.user().usualSpots, ["leavey", "the village"]);
  assert.equal(w.state(), null);
  // Asked once per person.
  await w.say("show me the food one");
  const again = await w.say("claim");
  assert.ok(!again.some((b) => /where (?:do|are) u usually/.test(b)));
});

test("repair: words work without a photo, the read comes from code, and nothing is filed", async () => {
  const w = world();
  const start = await w.say("show me the repair one");
  assert.match(start.join(" "), /photo|pic/);
  assert.ok(saysExample(start));
  assert.equal(w.state()?.step, "repair_photo");
  const out = await w.say("the elevator in fluor is stuck");
  assert.match(out.join(" "), /elevator/);
  assert.match(out.join(" "), /facilities/);
  assert.match(out.join(" "), /housing/);
  assert.match(out.join(" "), /nothing (?:was |goes |got )?filed|didn't file/);
  assert.equal(w.state(), null);
  assertNothingSaved(w.db);
});

test("repair: a photo is really read when the model is up, and said plainly when it can't be", async () => {
  setModelCall(async (opts) => {
    if (opts.system.startsWith("You look at one photo")) {
      assert.equal(opts.images?.length, 1);
      return JSON.stringify({ thing: "Water Fountain", problem: "leaking onto the floor!!" });
    }
    throw new Error("off");
  });
  const w = world();
  await w.say("show me the repair one");
  const out = await w.say("", [PHOTO]);
  assert.match(out.join(" "), /water fountain, leaking onto the floor/);
  assert.match(out.join(" "), /example/);
  assertNothingSaved(w.db);

  setModelCall(null);
  const v = world();
  await v.say("show me the repair one");
  const blind = await v.say("", [PHOTO]);
  assert.match(blind.join(" "), /can't read photos|photo reading is down/);
  assert.match(blind.join(" "), /nothing was filed/);
  assertNothingSaved(v.db);
});

test("the offer at the end: yes starts the next example, no is one easy line, anything else lets it lapse", async () => {
  const w = world();
  await w.say("show me the lost one");
  await w.say(GOOD);
  await w.say("yes");
  assert.equal(w.state()?.step, "offer");
  const food = await w.say("sure");
  assert.ok(food.includes("12 left"));
  assert.equal(w.state()?.step, "food_claim");

  const n = world();
  await n.say("show me the lost one");
  await n.say(GOOD);
  await n.say("yes");
  assert.equal((await n.say("nah")).length, 1);
  assert.equal(n.state(), null);
});

test("the lost round runs on the simulation engine, and a bare 'ok' is never scored as a description", async () => {
  const w = world();
  await w.say("show me the lost one");
  const sim = w.state()?.data.sim as { kind: string; tour: boolean; strict: boolean; tries: number };
  assert.deepEqual({ kind: sim.kind, tour: sim.tour, strict: sim.strict, tries: sim.tries }, { kind: "lost_found_owner", tour: true, strict: true, tries: 0 });
  const ok = await w.say("ok");
  assert.ok(ok.length > 0, "he says something");
  assert.ok(!/line up|matching/.test(ok.join(" ")), "and it is not a miss");
  assert.equal(w.state()?.step, "describe");
  assert.equal((w.state()?.data.sim as { tries: number }).tries, 0);
  // The fixed example item keeps the real pass mark: vague is still a miss.
  assert.match((await w.say("it's a bottle i think")).join(" "), /line up/);
  assertNothingSaved(w.db);
});
