// Flow 1 driven through the real pipeline with fake users and a fake adapter.
// The model is replaced by a fake that only answers the photo, ranking, description and same-item prompts
// with numbers each test picks, so every reply bubble here is Troy's fixed copy.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { AdapterCapabilities, IncomingEvent, IncomingImage, MessagingAdapter, TapbackType } from "../src/types.ts";
import { openDb, getOrCreateUser, updateUser, getFlowState, getUserById } from "../src/db/index.ts";
import { createPipeline } from "../src/pipeline.ts";
import { registerFlow } from "../src/flows/index.ts";
import { fallbackIntent, setModelCall } from "../src/ai.ts";
import { CLAIM_TTL_MS, COPY, HOLD_TTL_MS, LF_POOLS, LF_VOICE, claimantBlocked, completeHandoff, isDescriptionAttempt, lostFound, parseWhen } from "../src/flows/lostfound/handler.ts";
import { repair } from "../src/flows/repair.ts";
import { RELAY_COPY } from "../src/relay.ts";
import { poolProblems, setVariantPicker } from "../src/flows/reports-shared.ts";
import type { VariantPicker } from "../src/flows/reports-shared.ts";
import { pendingFor } from "../src/pending.ts";
import { THRESHOLDS } from "../src/flows/lostfound/verify.ts";
import { activeRelayFor } from "../src/relay.ts";

registerFlow(lostFound);
registerFlow(repair);
// Failed fake model calls log a one-line reason. Not useful here.
console.warn = () => {};

const HIDDEN = ["pink dinosaur sticker on the lid", "engraved initials MK", "small crack near the hinge"];
const HIDDEN_WORDS = ["dinosaur", "engraved", "initials", "crack", "hinge", "pink"];
const AIRPODS = {
  category: "earbuds",
  title: "airpods pro case",
  brand: "Apple",
  color: "white",
  publicSummary: "white airpods case",
  distinguishing: HIDDEN,
  nameOnItem: null,
  isValuable: true,
  isDangerous: false,
};
const PHOTO: IncomingImage = { path: "/tmp/troy-test/found.jpg", mime: "image/jpeg" };
const PROOF: IncomingImage = { path: "/tmp/troy-test/proof.jpg", mime: "image/jpeg" };
const DPS_ADDRESS = "3667 mcclintock ave, los angeles, ca 90089";
const CODE = /\b[A-HJ-NP-Z2-9]{6}\b/;

type ModelCfg = {
  profile: Record<string, unknown> | null;
  rank: (lostDescription: string) => number;
  describe: (answer: string) => number;
  same: { same: boolean; confidence: number } | null;
};
let model: ModelCfg;

beforeEach(() => {
  model = { profile: AIRPODS, rank: () => 90, describe: (a) => (/dinosaur/i.test(a) ? 92 : 10), same: null };
  setModelCall(async (opts) => {
    if (opts.system.startsWith("You read one photo")) {
      if (!model.profile) throw new Error("off");
      return JSON.stringify(model.profile);
    }
    if (opts.system.startsWith("You match lost-item")) {
      const { pairs } = JSON.parse(opts.prompt) as { pairs: { candidateId: number; lost: { description: string } }[] };
      return JSON.stringify({ results: pairs.map((p) => ({ candidateId: p.candidateId, confidence: model.rank(p.lost.description), reasons: ["test"] })) });
    }
    if (opts.system.startsWith("You check whether")) {
      const { claimantDescription } = JSON.parse(opts.prompt) as { claimantDescription: string };
      return JSON.stringify({ score: model.describe(claimantDescription), reasons: [] });
    }
    if (opts.system.startsWith("You compare two photos")) {
      if (!model.same) throw new Error("off");
      return JSON.stringify(model.same);
    }
    throw new Error("off");
  });
});

type Sent = { chatId: string; text: string; effect?: string; raw: string };

/**
 * Facts locked, wording varied: every line Troy sends may be any variant from the exported pools. The fake
 * adapter records each bubble read back to its first wording (values such as codes and summaries kept exactly as
 * sent), so the assertions below hold for whichever variant went out. `raw` keeps the words as they were sent.
 */
const canon = (text: string): string => LF_VOICE.canonical(text);

function world(opts: { caps?: Partial<AdapterCapabilities>; groupChat?: string | null } = {}) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO directory (kind, name, topics, contactMethod, url, details) VALUES ('office', 'DPS Lost & Found', '[]', ?, ?, ?)").run(
    "213-740-9759 or lostandfound@dps.usc.edu",
    "https://dps.usc.edu/services/lost-and-found/",
    "University Park Campus: 3667 McClintock Ave, Los Angeles, CA 90089. Students report a lost item by calling or emailing, and drop found items off at that address. Found items are kept for 90 days from the date DPS receives them.",
  );
  const place = db.prepare("INSERT INTO campus_places (name, nicknames, lat, lng, kind) VALUES (?, ?, ?, ?, 'campus')");
  place.run("Leavey Library", '["leavey"]', 34.0217, -118.2829);
  place.run("Tutor Campus Center", '["tcc"]', 34.0203, -118.2863);

  const sent: Sent[] = [];
  const groups: { members: string[]; first: string }[] = [];
  const images: { chatId: string; path: string; caption?: string }[] = [];
  const reacts: { chatId: string; id: string; type: string }[] = [];
  let n = 0;
  const adapter: MessagingAdapter = {
    provider: "webchat",
    capabilities: () => ({ tapbacks: true, typing: true, readReceipts: true, edits: false, effects: true, polls: false, groupChats: true, contactCard: true, liveLocation: false, ...opts.caps }),
    async sendMessage(chatId, text, o) {
      sent.push({ chatId, text: canon(text), effect: o?.effect, raw: text });
      return { messageId: `out-${++n}` };
    },
    async sendImage(chatId, path, caption) {
      images.push({ chatId, path, caption });
      return { messageId: `out-${++n}` };
    },
    async sendContactCard() {
      return { messageId: `out-${++n}` };
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
    async createGroupChat(members, first) {
      groups.push({ members, first });
      return opts.groupChat === undefined ? "group-1" : opts.groupChat;
    },
    async getLiveLocation() {
      return null;
    },
    requestLocation: async () => false,
    chatIdForHandle: (h) => `chat-${h}`,
  };
  const pipeline = createPipeline({ db, getAdapter: () => adapter, pause: async () => {}, ackAfterMs: 60_000, detectIntent: async (i) => fallbackIntent(i) });

  let m = 0;
  function person(handle: string, name: string, email: string) {
    const chatId = `chat-${handle}`;
    const u = getOrCreateUser(db, handle, chatId);
    updateUser(db, u.id, { verifiedAt: Date.now(), verifiedVia: "usc_email", name, uscEmail: email });
    const event = (over: Partial<IncomingEvent>): IncomingEvent => ({ provider: "webchat", userHandle: handle, chatId, isGroup: false, messageId: `in-${++m}`, text: "", images: [], receivedAt: Date.now(), ...over });
    const texts = () => sent.filter((s) => s.chatId === chatId).map((s) => s.text);
    /** Send one message and return only what Troy sent this person because of it. */
    const say = async (text: string, imgs: IncomingImage[] = []) => {
      const before = texts().length;
      await pipeline.handleEvent(event({ text, images: imgs }));
      return texts().slice(before);
    };
    const tap = async (text: string, type: TapbackType) => {
      const out = db.prepare("SELECT providerMessageId AS id, text FROM messages WHERE chatId = ? AND direction = 'out' ORDER BY id DESC").all(chatId) as { id: string; text: string }[];
      const target = out.find((r) => canon(r.text) === text)!;
      await pipeline.handleEvent(event({ reaction: { targetMessageId: target.id, type, removed: false } }));
    };
    return { id: u.id, handle, chatId, say, tap, texts, state: () => getFlowState(db, u.id), sent: () => sent.filter((s) => s.chatId === chatId) };
  }
  const finder = person("+12135550101", "Fiona Finder", "fiona.finder@usc.edu");
  const owner = person("+12135550102", "Owen Owner", "owen.owner@usc.edu");
  return { db, sent, groups, images, reacts, finder, owner, person, pipeline };
}

type World = ReturnType<typeof world>;

const one = <T>(db: DatabaseSync, sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as T;
const foundListing = (db: DatabaseSync) => one<{ id: number; status: string; heldBy: string; isDangerous: number; photoUrl: string | null; category: string; locationText: string | null }>(db, "SELECT * FROM listings WHERE type = 'found' ORDER BY id DESC LIMIT 1");
const lostListing = (db: DatabaseSync) => one<{ id: number; status: string; details: string }>(db, "SELECT * FROM listings WHERE type = 'lost' ORDER BY id DESC LIMIT 1");
const match = (db: DatabaseSync) => one<{ id: number; status: string; confidence: number }>(db, "SELECT * FROM matches ORDER BY id DESC LIMIT 1");
const checks = (db: DatabaseSync) => db.prepare("SELECT method, result, score, attempts, ownerAnswer FROM verifications ORDER BY id").all().map((r) => ({ ...r })) as { method: string; result: string; score: number | null; attempts: number; ownerAnswer: string | null }[];
const handoff = (db: DatabaseSync) => one<{ id: number; method: string; pickupCode: string | null; completedAt: number | null; thankYouNote: string | null; chosenBy: string }>(db, "SELECT * FROM handoffs ORDER BY id DESC LIMIT 1");

/** Nothing Troy sent this person may contain a hidden detail. */
function assertNoLeak(texts: string[], extra: string[] = []): void {
  for (const t of texts) {
    const low = t.toLowerCase();
    for (const h of [...HIDDEN, ...HIDDEN_WORDS, ...extra]) assert.ok(!low.includes(h.toLowerCase()), `leaked "${h}" in: ${t}`);
  }
}

/** Photo, loss report, 80+ match: the owner is at the blind description step. */
async function toDescribe(w: World) {
  const logged = await w.finder.say("found these at leavey", [PHOTO]);
  const asked = await w.owner.say("lost my airpods near leavey yesterday");
  return { logged, asked };
}

/** Through a passed description: the finder is being asked how to hand it off. */
async function toHandoffChoice(w: World) {
  await toDescribe(w);
  const before = w.finder.texts().length;
  await w.owner.say("white case with a dinosaur sticker on the lid");
  return w.finder.texts().slice(before);
}

/** Two failed descriptions: the owner is being asked for a proof photo. */
async function toProof(w: World) {
  await toDescribe(w);
  const first = await w.owner.say("plain black case, nothing on it");
  const second = await w.owner.say("there's a blue stripe on the side");
  return { first, second };
}

test("happy path: photo, loss report, 80+ match, blind description, meet, both yes, group chat, thank-you, confetti", async () => {
  const w = world();
  const { logged, asked } = await toDescribe(w);
  assert.deepEqual(logged, ["logged it: white airpods case", COPY.holdOnto]);
  assert.deepEqual(asked, [COPY.checking, COPY.mightHave, COPY.quickCheck, COPY.describe]);
  const found = foundListing(w.db);
  assert.equal(found.photoUrl, PHOTO.path);
  assert.equal(found.category, "earbuds");
  assert.equal(found.locationText, "Leavey Library");
  assert.equal(found.status, "verifying");
  assert.equal(w.owner.state()?.step, "verify_describe");

  const finderBefore = w.finder.texts().length;
  const passed = await w.owner.say("white case with a dinosaur sticker on the lid");
  assert.equal(passed[0], COPY.passed);
  assert.deepEqual(checks(w.db), [{ method: "blind_description", result: "pass", score: 92, attempts: 1, ownerAnswer: "white case with a dinosaur sticker on the lid" }]);
  assert.equal(match(w.db).status, "verified");
  // The handoff preference is asked now, not when the photo came in. No nudge for earbuds.
  assert.deepEqual(w.finder.texts().slice(finderBefore), ["the owner of the white airpods case u found just checked out", COPY.handoffAsk]);

  assert.deepEqual(await w.finder.say("1"), [COPY.consent]);
  assert.equal(w.owner.texts().at(-1), COPY.consent);
  assert.equal(w.groups.length, 0);
  assert.deepEqual(await w.finder.say("yes"), ["cool. waiting on them to ok it too"]);
  assert.equal(w.groups.length, 0, "no group chat until both say yes");

  const joined = await w.owner.say("yes");
  assert.equal(w.groups.length, 1);
  assert.deepEqual(w.groups[0]!.members, [w.finder.handle, w.owner.handle]);
  assert.match(w.groups[0]!.first, /handing you off/);
  assert.deepEqual(joined, ["ur both in a group chat now", COPY.gotItHint]);
  assert.equal(handoff(w.db).method, "group_chat");
  assert.equal(handoff(w.db).chosenBy, "finder");
  assert.equal(foundListing(w.db).status, "handed_off");
  assert.equal(activeRelayFor(w.db, w.owner.id), null);

  assert.deepEqual(await w.owner.say("got it"), ["love that", COPY.askThanks]);
  assert.equal(foundListing(w.db).status, "returned");
  assert.equal(lostListing(w.db).status, "returned");
  assert.ok(handoff(w.db).completedAt);

  const finderBeforeNote = w.finder.sent().length;
  const win = await w.owner.say("thank u so much, u saved my week");
  assert.deepEqual(win, [COPY.win]);
  assert.equal(COPY.win, "that's a win. fight on 🎉");
  assert.equal(w.owner.sent().at(-1)!.effect, "confetti");
  const toFinder = w.finder.sent().slice(finderBeforeNote);
  assert.deepEqual(toFinder.map((s) => s.text), ["the owner of the white airpods case wanted u to have this:", '"thank u so much, u saved my week"', COPY.win]);
  assert.equal(toFinder.at(-1)!.effect, "confetti");
  assert.equal(handoff(w.db).thankYouNote, "thank u so much, u saved my week");
  assert.equal(w.owner.state(), null);
  assert.equal(w.finder.state(), null);

  // Nothing hidden ever reached the owner, before or after passing.
  assertNoLeak(w.owner.texts());
  for (const t of [...w.owner.texts(), ...w.finder.texts()]) assert.ok(!t.includes("—"), "no em dashes");
});

test("dps code path: the same code goes to both with the directory address, then got it, skip, confetti", async () => {
  const w = world();
  await toHandoffChoice(w);
  const toFinder = await w.finder.say("2");
  const code = handoff(w.db).pickupCode!;
  assert.match(code, CODE);
  assert.deepEqual(toFinder, ["drop it at dps lost and found when u can", `dps lost and found is at ${DPS_ADDRESS}`, `tell them it's for pickup code ${code}`]);
  assert.deepEqual(w.owner.texts().slice(-4), ["the finder's dropping it at dps lost and found", `dps lost and found is at ${DPS_ADDRESS}`, `ur pickup code is ${code}`, COPY.gotItHint]);
  assert.equal(handoff(w.db).method, "dps_code");
  assert.equal(foundListing(w.db).heldBy, "dps");
  assert.equal(foundListing(w.db).status, "handed_off");
  assert.equal(w.groups.length, 0);

  assert.deepEqual(await w.owner.say("got it"), ["love that", COPY.askThanks]);
  assert.deepEqual(await w.owner.say("skip"), [COPY.win]);
  assert.equal(w.finder.texts().at(-1), COPY.win);
  assert.equal(handoff(w.db).thankYouNote, null);
  assert.equal(foundListing(w.db).status, "returned");
});

test("dps code path without a directory row: no address is invented", async () => {
  const w = world();
  w.db.exec("DELETE FROM directory");
  await toHandoffChoice(w);
  const toFinder = await w.finder.say("dps");
  assert.equal(toFinder.length, 2);
  assert.ok(![...toFinder, ...w.owner.texts()].some((t) => /mcclintock|\d{3}-\d{3}/.test(t)));
});

test("the dashboard can complete a dps handoff", async () => {
  const w = world();
  await toHandoffChoice(w);
  await w.finder.say("2");
  const notified: { userId: number; bubbles: string[] }[] = [];
  const ok = await completeHandoff({ db: w.db, notify: async (userId, bubbles) => void notified.push({ userId, bubbles }) }, handoff(w.db).id);
  assert.equal(ok, true);
  assert.deepEqual(notified.map((n) => ({ userId: n.userId, bubbles: n.bubbles.map(canon) })), [{ userId: w.owner.id, bubbles: ["love that", COPY.askThanks] }]);
  assert.ok(handoff(w.db).completedAt);
  assert.equal(foundListing(w.db).status, "returned");
  assert.equal(w.owner.state()?.step, "thanks_note");
  assert.equal(await completeHandoff({ db: w.db, notify: async () => {} }, handoff(w.db).id), false);
  assert.deepEqual(await w.owner.say("tysm"), [COPY.win]);
});

test("wallets get the dps nudge, and the finder still chooses", async () => {
  const w = world();
  model.profile = { ...AIRPODS, category: "wallet", title: "leather wallet", brand: null, color: "brown", publicSummary: "brown wallet" };
  await w.finder.say("found this at leavey", [PHOTO]);
  await w.owner.say("lost my wallet near leavey yesterday");
  const before = w.finder.texts().length;
  await w.owner.say("it has a dinosaur sticker inside");
  assert.deepEqual(w.finder.texts().slice(before), ["the owner of the brown wallet u found just checked out", "dps is safest for wallets, but ur call", COPY.handoffAsk]);
});

/** A found item with nothing on file only the owner would know: the finder has to be the judge. */
async function toFinderCheck(w: World) {
  model.profile = { ...AIRPODS, distinguishing: [] };
  await w.finder.say("found these at leavey", [PHOTO]);
  await w.owner.say("lost my airpods near leavey yesterday");
  const before = w.finder.texts().length;
  const toOwner = await w.owner.say("there's a sticker on it i think");
  return { toOwner, toFinder: w.finder.texts().slice(before) };
}

test("finder check, yes (by tapback): the finder sees the owner's words and their yes verifies", async () => {
  const w = world();
  const { toOwner, toFinder } = await toFinderCheck(w);
  assert.deepEqual(toOwner, COPY.checkingHolder);
  assert.deepEqual(toFinder, ["someone says the white airpods case u found are theirs", "here's how they described it:", '"there\'s a sticker on it i think"', COPY.finderCheck]);
  assert.equal(match(w.db).status, "finder_check");
  assert.equal(w.owner.state()?.step, "await_finder");
  assert.deepEqual(await w.owner.say("hello? any update"), [COPY.stillWaiting]);

  const before = w.finder.texts().length;
  // A thumbs down switched to a heart: the latest tapback is the answer. A tapback on another bubble is ignored.
  await w.finder.tap("here's how they described it:", "like");
  assert.equal(match(w.db).status, "finder_check");
  await w.finder.tap(COPY.finderCheck, "love");
  assert.deepEqual(checks(w.db).map((c) => [c.method, c.result]), [["blind_description", "pass"], ["finder_confirm", "pass"]]);
  assert.equal(match(w.db).status, "verified");
  assert.equal(w.finder.texts().slice(before).at(-1), COPY.handoffAsk);
  assert.ok(w.owner.texts().includes("good news. the person who found it says it sounds like urs"));
  assertNoLeak(w.owner.texts());
});

test("finder check, no: the match is rejected and the owner keeps looking", async () => {
  const w = world();
  await toFinderCheck(w);
  const ownerBefore = w.owner.texts().length;
  assert.deepEqual(await w.finder.say("nah that's not it"), ["ok, not a match. i'll keep looking for the owner"]);
  assert.deepEqual(w.owner.texts().slice(ownerBefore), [COPY.nothingYet, COPY.willText]);
  assert.equal(match(w.db).status, "rejected");
  assert.deepEqual(checks(w.db).map((c) => [c.method, c.result]), [["blind_description", "fail"], ["finder_confirm", "fail"]]);
  assert.equal(foundListing(w.db).status, "open");
  assert.equal(lostListing(w.db).status, "open");
  assert.equal(w.finder.state(), null);
  assertNoLeak(w.owner.texts());
});

test("two failed descriptions: attempts are counted in code and the owner is never told what was wrong", async () => {
  const w = world();
  const { first, second } = await toProof(w);
  assert.deepEqual(first, COPY.retry);
  assert.deepEqual(second, [COPY.cantConfirmDescription, COPY.askProof]);
  assert.equal(THRESHOLDS.maxAttempts, 2);
  assert.deepEqual(checks(w.db).map((c) => [c.method, c.result, c.score, c.attempts]), [
    ["blind_description", "fail", 10, 1],
    ["blind_description", "fail", 10, 2],
  ]);
  assert.equal(match(w.db).status, "proof_requested");
  // Still open for other claimants while this one is unresolved.
  assert.equal(foundListing(w.db).status, "open");
  assert.equal(w.owner.state()?.step, "proof");
  assert.equal(w.images.length, 0, "the finder's photo is never sent to a claimant");
  assertNoLeak(w.owner.texts());
});

test("a question or a stall at the describe step is answered, not scored: no try is counted and the step stays open", async () => {
  // What counts as an attempt, by the rules.
  for (const no of ["wait do u actually have them", "how many tries do i get", "idk man i cant even think rn", "hold on lemme think", "who found it?"]) assert.equal(isDescriptionAttempt(no), false, no);
  // A guess phrased as a question is never free, and a plain description always counts.
  for (const yes of ["is it the one w the sticker on the lid or the plain one?", "white case", "its got a dinosaur on it, black", "plain, nothing on it", "there's a scratch on the back"]) assert.equal(isDescriptionAttempt(yes), true, yes);

  const w = world();
  await toDescribe(w);
  const finderBefore = w.finder.texts().length;
  const reply = await w.owner.say("wait do u actually have them");
  assert.equal(reply.length, 1);
  assert.ok(!COPY.retry.includes(reply[0]!), "never the didn't-line-up line");
  assert.deepEqual(checks(w.db), [], "nothing scored, nothing counted");
  assert.equal(w.owner.state()?.step, "verify_describe");
  assert.equal(w.finder.texts().length, finderBefore, "the finder is shown nothing");
  assertNoLeak(w.owner.texts());

  // Both tries are still theirs.
  await w.owner.say("white case with a dinosaur sticker on the lid");
  assert.deepEqual(checks(w.db).map((c) => [c.result, c.attempts]), [["pass", 1]]);
});

test("proof photo can't be checked, finder picks 1: meet anyway, with the busy-place reminder (relay when group chats are off)", async () => {
  const w = world({ caps: { groupChats: false } });
  await toProof(w);
  const finderBefore = w.finder.texts().length;
  assert.deepEqual(await w.owner.say("", [PROOF]), ["can't check photos rn", COPY.askingHolder]);
  assert.deepEqual(w.finder.texts().slice(finderBefore), [
    "someone's trying to claim the white airpods case u found",
    "here's how they described it:",
    '"lost my airpods near leavey yesterday"',
    '"plain black case, nothing on it"',
    '"there\'s a blue stripe on the side"',
    COPY.finderCall,
  ]);
  assert.equal(match(w.db).status, "finder_deciding");
  assert.equal(foundListing(w.db).status, "open");

  const toFinder = await w.finder.say("1");
  assert.equal(toFinder.at(-1), COPY.meetBusy);
  assert.equal(match(w.db).status, "verified");
  assert.deepEqual(checks(w.db).at(-1), { method: "finder_judgment", result: "pass", score: null, attempts: 1, ownerAnswer: null });
  assert.equal(handoff(w.db).method, "relay");
  assert.equal(activeRelayFor(w.db, w.owner.id)?.otherUserId, w.finder.id);
  assert.ok(w.owner.texts().includes("the person holding it is ok to meet u"));
  assert.equal(w.groups.length, 0);
  assertNoLeak(w.owner.texts());
});

test("no proof, finder picks 2: drop it at dps, the claimant is sent to dps in person", async () => {
  const w = world();
  await toProof(w);
  assert.deepEqual(await w.owner.say("no i don't have one"), [COPY.askingHolder]);
  const ownerBefore = w.owner.texts().length;
  assert.deepEqual(await w.finder.say("2"), ["ok, drop it at dps lost and found when u can", `dps lost and found is at ${DPS_ADDRESS}`, "they'll take it from there"]);
  assert.deepEqual(w.owner.texts().slice(ownerBefore), [
    COPY.dpsInPerson,
    "the person holding it is dropping it there",
    `dps lost and found is at ${DPS_ADDRESS}`,
    "u can reach them at 213-740-9759 or lostandfound@dps.usc.edu",
  ]);
  assert.equal(match(w.db).status, "rejected");
  assert.equal(foundListing(w.db).heldBy, "dps");
  assert.equal(foundListing(w.db).status, "open");
  assert.equal(one<{ n: number }>(w.db, "SELECT COUNT(*) AS n FROM handoffs").n, 0);
  assertNoLeak(w.owner.texts());
});

test("no proof, finder picks 3: keep holding, and the failed claimant can never try that item again", async () => {
  const w = world();
  await toProof(w);
  await w.owner.say("no");
  const ownerBefore = w.owner.texts().length;
  assert.deepEqual(await w.finder.say("3"), ["ok, hang onto it. i'll text u if someone else claims it"]);
  assert.deepEqual(w.owner.texts().slice(ownerBefore), ["couldn't confirm this one's urs, so i can't connect u", "ur report stays open in case another one turns up"]);
  assert.equal(match(w.db).status, "rejected");
  assert.equal(foundListing(w.db).status, "open");
  assert.equal(foundListing(w.db).heldBy, "finder");

  // Same person, new report, now with the right words: no second round on that item.
  const tries = checks(w.db).length;
  const again = await w.owner.say("lost my airpods near leavey yesterday, dinosaur sticker on the lid");
  assert.deepEqual(again, [COPY.checking, COPY.nothingYet, COPY.willText]);
  assert.equal(w.owner.state(), null);
  assert.equal(checks(w.db).length, tries);
  assert.equal(foundListing(w.db).status, "open");

  // Someone else can still claim it.
  const other = w.person("+12135550103", "Rita Real", "rita.real@usc.edu");
  const asked = await other.say("lost my airpods at leavey yesterday");
  assert.deepEqual(asked.slice(1), [COPY.mightHave, COPY.quickCheck, COPY.describe]);
  assert.equal(await other.say("dinosaur sticker on the lid").then((t) => t[0]), COPY.passed);
  assertNoLeak(w.owner.texts());
  assertNoLeak(other.texts());
});

test("a claimant waiting on the finder can't open a second round with a new report", async () => {
  const w = world();
  await toProof(w);
  await w.owner.say("no");
  assert.equal(match(w.db).status, "finder_deciding");
  const again = await w.owner.say("lost my airpods near leavey yesterday");
  assert.deepEqual(again, [COPY.checking, COPY.nothingYet, COPY.willText]);
  assert.equal(w.owner.state(), null);
});

test("proof photo that matches verifies the owner", async () => {
  const w = world();
  await toProof(w);
  model.same = { same: true, confidence: 91 };
  const finderBefore = w.finder.texts().length;
  assert.equal((await w.owner.say("here", [PROOF]))[0], "that's the same one. it's urs");
  assert.deepEqual(checks(w.db).at(-1), { method: "proof_photo", result: "pass", score: 91, attempts: 1, ownerAnswer: null });
  assert.equal(match(w.db).status, "verified");
  assert.equal(w.finder.texts().slice(finderBefore).at(-1), COPY.handoffAsk);
});

test("proof photo that doesn't match goes to the finder", async () => {
  const w = world();
  await toProof(w);
  model.same = { same: true, confidence: 40 };
  assert.deepEqual(await w.owner.say("", [PROOF]), ["that pic didn't settle it", COPY.askingHolder]);
  assert.equal(checks(w.db).at(-1)!.result, "fail");
  assert.equal(w.finder.state()?.step, "finder_decide");
});

test("an item already at dps: after the misses the claimant is sent to dps, with no proof step and no finder call", async () => {
  const w = world();
  await w.finder.say("found these at leavey", [PHOTO]);
  w.db.exec("UPDATE listings SET heldBy = 'dps' WHERE type = 'found'");
  await w.owner.say("lost my airpods near leavey yesterday");
  await w.owner.say("plain black case");
  const finderBefore = w.finder.texts().length;
  assert.deepEqual(await w.owner.say("blue stripe"), [COPY.dpsInPerson, `dps lost and found is at ${DPS_ADDRESS}`, "u can reach them at 213-740-9759 or lostandfound@dps.usc.edu"]);
  assert.equal(match(w.db).status, "rejected");
  assert.equal(w.owner.state(), null);
  assert.equal(w.finder.texts().length, finderBefore);
  assertNoLeak(w.owner.texts());
});

test("dangerous item: fixed reply, dps address, saved for dps, never matched to a student", async () => {
  const w = world();
  model.profile = null;
  const reply = await w.finder.say("found a knife on the ground at leavey", [PHOTO]);
  assert.deepEqual(reply, ["that one goes to dps, please don't carry it around", `dps lost and found is at ${DPS_ADDRESS}`]);
  const l = foundListing(w.db);
  assert.equal(l.isDangerous, 1);
  assert.equal(l.heldBy, "dps");
  assert.equal(l.status, "handed_off");
  assert.equal(w.finder.state(), null);

  const asked = await w.owner.say("lost my keys near leavey yesterday, there was a pocket knife on them");
  assert.equal(asked.at(-1), COPY.willText);
  assert.equal(one<{ n: number }>(w.db, "SELECT COUNT(*) AS n FROM matches").n, 0);
  assert.equal(one<{ n: number }>(w.db, "SELECT COUNT(*) AS n FROM handoffs").n, 0);
});

test("dangerous item read from the photo by the model is routed the same way", async () => {
  const w = world();
  model.profile = { ...AIRPODS, category: "other", title: "folding knife", publicSummary: "black folding knife", distinguishing: ["belt clip"], isDangerous: true };
  assert.equal((await w.finder.say("", [PHOTO]))[0], COPY.dangerous);
  assert.equal(foundListing(w.db).heldBy, "dps");
});

test("no ai: a bare photo gets 'what is it?', then the place, then a listing built from the finder's words", async () => {
  const w = world();
  setModelCall(null);
  assert.deepEqual(await w.finder.say("", [PHOTO]), ["what is it?"]);
  assert.equal(w.finder.state()?.step, "found_what");
  assert.deepEqual(await w.finder.say("a black wallet with a metal clip"), ["where'd u find it?"]);
  assert.deepEqual(await w.finder.say("tcc"), ["logged it: black wallet", COPY.holdOnto]);
  const l = foundListing(w.db);
  assert.equal(l.category, "wallet");
  assert.equal(l.locationText, "Tutor Campus Center");
  assert.equal(l.photoUrl, PHOTO.path);
  assert.equal(w.finder.state(), null);
});

test("no ai: a finder who only names the item is asked once for what only the owner would know, and that stays hidden", async () => {
  const w = world();
  setModelCall(null);
  assert.deepEqual(await w.finder.say("found these airpods at leavey", [PHOTO]), [COPY.askMarks]);
  assert.equal(w.finder.state()?.step, "found_marks");
  assert.deepEqual(await w.finder.say("white case with a dinosaur sticker on the lid, initials MK engraved"), ["logged it: earbuds", COPY.holdOnto]);
  const details = JSON.parse(one<{ details: string }>(w.db, "SELECT details FROM listings WHERE type = 'found'").details) as { distinguishing: string[]; publicSummary: string };
  assert.deepEqual(details.distinguishing, ["white case with a dinosaur sticker on the lid", "initials MK engraved"]);
  assert.equal(details.publicSummary, "earbuds");
  assert.equal(w.finder.state(), null);
});

test("no ai: 'idk' to the marks question still saves the listing", async () => {
  const w = world();
  setModelCall(null);
  await w.finder.say("found a wallet at tcc");
  assert.deepEqual(await w.finder.say("idk"), ["logged it: wallet", COPY.holdOnto]);
  assert.equal(foundListing(w.db).status, "open");
});

test("no ai: a description that passes on the rule score alone goes to the finder, who decides", async () => {
  const w = world();
  setModelCall(null);
  await w.finder.say("found these airpods at leavey", [PHOTO]);
  await w.finder.say("white case with a dinosaur sticker on the lid, initials MK engraved");
  const asked = await w.owner.say("lost my airpods near leavey yesterday");
  assert.equal(asked.at(-1), COPY.describe);
  const before = w.finder.texts().length;
  assert.deepEqual(await w.owner.say("white case, dinosaur sticker on the lid and my initials mk engraved"), COPY.checkingHolder);
  assert.equal(match(w.db).status, "finder_check");
  assert.equal(w.owner.state()?.step, "await_finder");
  assert.deepEqual(await w.owner.say("hello? any update"), [COPY.stillWaiting]);
  const toFinder = w.finder.texts().slice(before);
  assert.equal(toFinder.at(-1), COPY.finderCheck);
  assert.ok(toFinder.some((t) => t.includes("dinosaur sticker on the lid and my initials mk engraved")), "the finder sees the claimant's own words");
  assert.deepEqual(checks(w.db).map((c) => [c.method, c.result]), [["blind_description", null]]);
  await w.finder.say("yes");
  assert.equal(match(w.db).status, "verified");
  assert.deepEqual(checks(w.db).map((c) => [c.method, c.result]), [["blind_description", "pass"], ["finder_confirm", "pass"]]);
  assert.equal(w.finder.texts().at(-1), COPY.handoffAsk);
  assertNoLeak(w.owner.texts());
});

test("no ai: the finder's no after a rule-score pass is a miss, and that claimant can't try the item again", async () => {
  const w = world();
  setModelCall(null);
  await w.finder.say("found these airpods at leavey", [PHOTO]);
  await w.finder.say("white case with a dinosaur sticker on the lid, initials MK engraved");
  await w.owner.say("lost my airpods near leavey yesterday");
  await w.owner.say("white case, dinosaur sticker on the lid and my initials mk engraved");
  await w.finder.say("no");
  assert.equal(match(w.db).status, "rejected");
  assert.ok(claimantBlocked(w.db, foundListing(w.db).id, w.owner.id));
  const again = await w.owner.say("lost my airpods at leavey yesterday");
  assert.deepEqual(again.slice(-2), [COPY.nothingYet, COPY.willText]);
});

test("example listings never match a real student's report", async () => {
  const w = world();
  setModelCall(null);
  await w.finder.say("found these airpods at leavey", [PHOTO]);
  await w.finder.say("white case with a dinosaur sticker on the lid");
  w.db.prepare("UPDATE listings SET isExample = 1").run();
  const asked = await w.owner.say("lost my airpods near leavey yesterday");
  assert.deepEqual(asked.slice(-2), [COPY.nothingYet, COPY.willText]);
  assert.equal(one<{ n: number }>(w.db, "SELECT COUNT(*) AS n FROM matches").n, 0);
});

test("owner intake asks one thing at a time and accepts idk", async () => {
  const w = world();
  assert.deepEqual(await w.owner.say("i lost something"), [COPY.askLostWhat]);
  assert.deepEqual(await w.owner.say("my wallet"), [COPY.askLostPlace]);
  assert.deepEqual(await w.owner.say("idk"), [COPY.askLostTime]);
  assert.deepEqual(await w.owner.say("idk"), [COPY.checking, COPY.nothingYet, COPY.willText]);
  const l = one<{ category: string; locationText: string | null; happenedAt: number | null; status: string }>(w.db, "SELECT * FROM listings WHERE type = 'lost'");
  assert.deepEqual([l.category, l.locationText, l.happenedAt, l.status], ["wallet", null, null, "open"]);
  assert.equal(w.owner.state(), null);
});

test("nvm works at every kind of step and never leaves anyone stuck", async () => {
  const w = world();
  await w.owner.say("i lost something");
  assert.deepEqual(await w.owner.say("nvm"), ["ok, dropped it. text me if u need me"]);
  assert.equal(w.owner.state(), null);

  await toDescribe(w);
  assert.deepEqual(await w.owner.say("cancel"), ["ok, stopped. ur report's still open and i'll text u if something turns up"]);
  assert.equal(w.owner.state(), null);
  assert.equal(foundListing(w.db).status, "open");
  assert.equal(match(w.db).status, "proposed");
});

test("nvm from the finder at the handoff choice falls back to dps so the verified owner isn't left waiting", async () => {
  const w = world();
  await toHandoffChoice(w);
  const out = await w.finder.say("nvm");
  assert.equal(out[0], "ok. the owner's waiting on it tho, so dps it is");
  assert.equal(handoff(w.db).method, "dps_code");
  assert.equal(w.finder.state(), null);
  assert.equal(w.owner.state()?.step, "await_pickup");
});

test("a choice step doesn't swallow a request for another flow, and its question is still pending after", async () => {
  const w = world();
  const seen: string[] = [];
  registerFlow({ name: "repair", handle: async (ctx) => void (seen.push(ctx.event.text), await ctx.say("repair reply")) });
  await toHandoffChoice(w);
  assert.deepEqual(await w.finder.say("the elevator in leavey is broken"), ["repair reply"]);
  assert.deepEqual(seen, ["the elevator in leavey is broken"]);
  assert.equal(w.finder.state()?.step, "handoff_choice");
  assert.deepEqual(await w.finder.say("hmm"), ["reply 1 to meet them or 2 to drop it at dps"]);
  assert.equal((await w.finder.say("2")).length, 3);
});

test("relay fallback: a relay_only user is never asked about a group chat and never added to one", async () => {
  const w = world();
  updateUser(w.db, w.owner.id, { contactMode: "relay_only" });
  await toHandoffChoice(w);
  const toFinder = await w.finder.say("meet");
  assert.equal(w.groups.length, 0);
  assert.ok(![...w.finder.texts(), ...w.owner.texts()].includes(COPY.consent));
  assert.equal(handoff(w.db).method, "relay");
  assert.equal(toFinder.length, 2);
  assert.equal(activeRelayFor(w.db, w.finder.id)?.context, `lost_found:${match(w.db).id}`);

  const ownerBefore = w.owner.texts().length;
  assert.deepEqual(await w.finder.say("i'm at leavey til 5, 2nd floor"), []);
  assert.deepEqual(w.owner.texts().slice(ownerBefore), ["from the finder: i'm at leavey til 5, 2nd floor"]);
  const finderBefore = w.finder.texts().length;
  await w.owner.say("omw, 10 min");
  assert.deepEqual(w.finder.texts().slice(finderBefore), ["from the owner: omw, 10 min"]);
  // No handle, name or email ever crosses.
  for (const t of [...w.finder.texts(), ...w.owner.texts()]) assert.ok(!/\+1213|fiona|owen|@usc\.edu/i.test(t), t);

  const closed = await w.owner.say("done");
  assert.equal(activeRelayFor(w.db, w.owner.id), null);
  assert.equal(closed.at(-1), "did u get it back? text me got it when u do");
  assert.deepEqual(await w.owner.say("got it"), ["love that", COPY.askThanks]);
  assert.equal(foundListing(w.db).status, "returned");
});

test("relay fallback: createGroupChat returns null after both say yes", async () => {
  const w = world({ groupChat: null });
  await toHandoffChoice(w);
  await w.finder.say("1");
  await w.owner.say("yes");
  const toFinder = await w.finder.say("yes");
  assert.equal(w.groups.length, 1);
  assert.equal(toFinder[0], "couldn't start the group chat");
  assert.ok(w.owner.texts().includes("couldn't start the group chat"));
  assert.equal(handoff(w.db).method, "relay");
  assert.ok(activeRelayFor(w.db, w.owner.id));
  assert.equal(w.owner.state()?.step, "await_pickup");
});

test("relay fallback: either person saying no to the contact warning means relay, with no group chat", async () => {
  const w = world();
  await toHandoffChoice(w);
  await w.finder.say("1");
  await w.finder.say("yes");
  const out = await w.owner.say("no");
  assert.equal(out[0], "no group chat then");
  assert.equal(w.groups.length, 0);
  assert.equal(handoff(w.db).method, "relay");
  assert.ok(activeRelayFor(w.db, w.finder.id));
});

test("relay handoff: the owner's 'got it' closes the handoff instead of being passed along", async () => {
  const w = world();
  updateUser(w.db, w.owner.id, { groupChatsAllowed: 0 });
  await toHandoffChoice(w);
  await w.finder.say("1");
  assert.ok(activeRelayFor(w.db, w.owner.id));
  assert.equal(w.owner.texts().at(-1), COPY.gotItHint);
  const before = w.finder.texts().length;
  assert.deepEqual(await w.owner.say("got it"), ["love that", COPY.askThanks]);
  assert.equal(activeRelayFor(w.db, w.owner.id), null);
  assert.ok(!w.finder.texts().slice(before).some((t) => t.includes("got it")), "the finder is not sent the owner's 'got it'");
  assert.equal(lostListing(w.db).status, "returned");
});

test("groupChatsAllowed false also means relay", async () => {
  const w = world();
  updateUser(w.db, w.finder.id, { groupChatsAllowed: 0 });
  await toHandoffChoice(w);
  await w.finder.say("1");
  assert.equal(w.groups.length, 0);
  assert.equal(handoff(w.db).method, "relay");
});

test("no_contact: the finder isn't offered a meet, both get the dps code", async () => {
  const w = world();
  updateUser(w.db, w.owner.id, { contactMode: "no_contact" });
  const toFinder = await toHandoffChoice(w);
  assert.ok(!toFinder.includes(COPY.handoffAsk));
  const code = handoff(w.db).pickupCode!;
  assert.match(code, CODE);
  assert.ok(toFinder.includes(`tell them it's for pickup code ${code}`));
  assert.ok(w.owner.texts().includes(`ur pickup code is ${code}`));
  assert.equal(activeRelayFor(w.db, w.owner.id), null);
  assert.equal(w.groups.length, 0);
});

test("two-sided matching: lost report first, found photo later, and troy texts the owner first", async () => {
  const w = world();
  assert.deepEqual(await w.owner.say("lost my airpods near leavey yesterday"), [COPY.checking, COPY.nothingYet, COPY.willText]);
  assert.equal(w.owner.state(), null);
  const ownerBefore = w.owner.texts().length;
  const toFinder = await w.finder.say("found these at leavey", [PHOTO]);
  assert.deepEqual(toFinder, ["logged it: white airpods case", COPY.holdOnto, COPY.finderHeadsUp]);
  assert.deepEqual(w.owner.texts().slice(ownerBefore), [COPY.turnedUp, COPY.quickCheck, COPY.describe]);
  assert.equal(w.owner.state()?.step, "verify_describe");
  assert.equal((await w.owner.say("the one with the dinosaur sticker"))[0], COPY.passed);
  assertNoLeak(w.owner.texts());
});

test("ids use the name on the card against the usc account, and a wrong claimant never sees the name", async () => {
  const w = world();
  model.profile = { category: "id_card", title: "usc id card", brand: null, color: null, publicSummary: "usc id card", distinguishing: ["card ending 4821"], nameOnItem: "OWEN OWNER", isValuable: true, isDangerous: false };
  await w.finder.say("found this at leavey", [PHOTO]);

  const wrong = w.person("+12135550104", "Sam Scammer", "sam.scammer@usc.edu");
  const out = await wrong.say("lost my usc id near leavey yesterday");
  // The same neutral line as any other miss: nothing about a name, or what it was checked against.
  assert.deepEqual(out.slice(1), [COPY.cantConfirm, COPY.askProof]);
  assert.ok(!wrong.texts().some((t) => /name|account/.test(t)));
  assert.deepEqual(checks(w.db).map((c) => [c.method, c.result]), [["name_match", "fail"]]);
  assertNoLeak(wrong.texts(), ["owen", "owner", "4821"]);
  await wrong.say("no");
  await w.finder.say("3");

  const finderBefore = w.finder.texts().length;
  const right = await w.owner.say("lost my usc id near leavey yesterday");
  assert.deepEqual(right.slice(1, 3), [COPY.mightHave, "the name on it matches ur usc account, so ur good"]);
  assert.deepEqual(checks(w.db).at(-1), { method: "name_match", result: "pass", score: null, attempts: 1, ownerAnswer: null });
  assert.equal(w.finder.texts().slice(finderBefore).at(-1), COPY.handoffAsk);
  assert.ok(getUserById(w.db, w.owner.id));
});

test("found my item nvm closes the owner's open report", async () => {
  const w = world();
  await w.owner.say("lost my airpods near leavey yesterday");
  assert.deepEqual(await w.owner.say("nvm found my airpods thanks"), ["glad u got it back", "closed out ur report"]);
  assert.equal(lostListing(w.db).status, "returned");
});

test("no api key at all: the whole exchange still answers from fixed copy and rule scores", async () => {
  const w = world();
  setModelCall(null);
  assert.deepEqual(await w.finder.say("found airpods at leavey, white case with a dinosaur sticker on the lid", [PHOTO]), ["logged it: white earbuds", COPY.holdOnto]);
  const asked = await w.owner.say("lost my airpods near leavey yesterday, they have a dinosaur sticker");
  assert.equal(asked[0], COPY.checking);
  const last = asked.at(-1)!;
  assert.ok([COPY.describe, COPY.willText].includes(last), last);
  if (last === COPY.describe) {
    const out = await w.owner.say("white case, dinosaur sticker on the lid");
    assert.ok(out[0] === COPY.passed || out[0] === COPY.retry[0], out[0]);
  }
  assertNoLeak(w.owner.texts(), []);
});

// ---------- trust and safety: what a claimant can learn, and what a claim can lock ----------

const REPORT = "lost my airpods near leavey yesterday";
const FIRST = [COPY.checking, COPY.mightHave, COPY.quickCheck, COPY.describe];
const ruleScoresOnly = () => {
  model.rank = () => {
    throw new Error("off");
  };
  model.describe = () => {
    throw new Error("off");
  };
};

test("re-reporting with guesses tells a claimant nothing: the first reply is the same whether or not a word is a hidden detail", async () => {
  for (const mode of ["rules", "ai"] as const) {
    const w = world();
    if (mode === "rules") ruleScoresOnly();
    else model.rank = (d) => (/dinosaur|hinge|crack|initials/i.test(d) ? 95 : /star/i.test(d) ? 20 : 60);
    await w.finder.say("found these at leavey", [PHOTO]);
    const scammer = w.person("+12135550104", "Sam Scammer", "sam.scammer@usc.edu");
    const replies: string[][] = [];
    for (const guess of ["cat sticker", "dinosaur", "hinge", "crack", "initials", "star charm"]) {
      replies.push(await scammer.say(`${REPORT}, ${guess}`));
      assert.deepEqual(await scammer.say("nvm"), ["ok, stopped. ur report's still open and i'll text u if something turns up"]);
    }
    for (const r of replies) assert.deepEqual(r, FIRST, `${mode}: every probe gets the same reply`);
    // One report, told six times. Not six listings and six fresh matches.
    assert.equal((w.db.prepare("SELECT COUNT(*) AS n FROM listings WHERE type = 'lost'").get() as { n: number }).n, 1);
    assert.equal((w.db.prepare("SELECT COUNT(*) AS n FROM matches").get() as { n: number }).n, 1);
    assert.equal(foundListing(w.db).status, "open");
    assertNoLeak(scammer.texts());
  }
});

test("every scored description counts as a try, across nvm and new reports, and two misses end it for that item", async () => {
  const w = world();
  await w.finder.say("found these at leavey", [PHOTO]);
  const scammer = w.person("+12135550104", "Sam Scammer", "sam.scammer@usc.edu");
  assert.deepEqual(await scammer.say(REPORT), FIRST);
  assert.deepEqual(await scammer.say("a cat sticker"), COPY.retry);
  await scammer.say("nvm");
  assert.deepEqual(checks(w.db).map((c) => [c.result, c.attempts]), [["fail", 1]], "backing out resets nothing");

  assert.deepEqual(await scammer.say(REPORT), FIRST);
  assert.deepEqual(await scammer.say("a star sticker"), [COPY.cantConfirmDescription, COPY.askProof]);
  assert.deepEqual(checks(w.db).map((c) => [c.result, c.attempts]), [["fail", 1], ["fail", 2]]);
  assert.ok(claimantBlocked(w.db, foundListing(w.db).id, scammer.id));

  // The right words now, in a new report: no third try.
  await scammer.say("no");
  await w.finder.say("3");
  assert.deepEqual(await scammer.say(`${REPORT}, dinosaur sticker on the lid`), [COPY.checking, COPY.nothingYet, COPY.willText]);
  assert.equal(checks(w.db).filter((c) => c.method === "blind_description").length, 2);
  assert.equal(THRESHOLDS.maxAttempts, 2);
});

test("a claimant who goes silent only holds the item until someone else is waiting: after an hour the real owner is asked", async () => {
  const w = world();
  await w.finder.say("found these at leavey", [PHOTO]);
  const scammer = w.person("+12135550104", "Sam Scammer", "sam.scammer@usc.edu");
  await scammer.say(REPORT);
  assert.equal(foundListing(w.db).status, "verifying");
  assert.deepEqual(await w.owner.say("lost my airpods at leavey yesterday, white case"), [COPY.checking, COPY.nothingYet, COPY.willText]);

  // Not yet: an hour hasn't passed.
  await w.pipeline.sweep(Date.now() + CLAIM_TTL_MS - 60_000);
  assert.equal(w.owner.state(), null);

  const ownerBefore = w.owner.texts().length;
  await w.pipeline.sweep(Date.now() + CLAIM_TTL_MS + 60_000);
  assert.deepEqual(scammer.texts().slice(-2), COPY.timedOut);
  assert.equal(scammer.state(), null);
  assert.deepEqual(w.owner.texts().slice(ownerBefore), [COPY.turnedUp, COPY.quickCheck, COPY.describe]);
  assert.equal((await w.owner.say("the one with the dinosaur sticker"))[0], COPY.passed);
});

test("a slow owner with nobody else waiting keeps the claim for a day, and 'still looking' picks it back up", async () => {
  const w = world();
  await w.finder.say("found these at leavey", [PHOTO]);
  await w.owner.say(REPORT);
  await w.pipeline.sweep(Date.now() + CLAIM_TTL_MS * 5);
  assert.equal(w.owner.state()?.step, "verify_describe", "nobody else wants it, so the question stays open");
  await w.pipeline.sweep(Date.now() + HOLD_TTL_MS + 60_000);
  assert.equal(w.owner.state(), null);
  assert.equal(foundListing(w.db).status, "open");
  assert.deepEqual(w.owner.texts().slice(-2), COPY.timedOut);
  assert.deepEqual(await w.owner.say("still looking"), FIRST);
  assert.equal((await w.owner.say("dinosaur sticker on the lid"))[0], COPY.passed);
});

test("STOP from a claimant releases the item at once and the owner who reported during the lock is picked up", async () => {
  const w = world();
  await w.finder.say("found these at leavey", [PHOTO]);
  const scammer = w.person("+12135550104", "Sam Scammer", "sam.scammer@usc.edu");
  await scammer.say(REPORT);
  await w.owner.say("lost my airpods at leavey yesterday, white case");
  const ownerBefore = w.owner.texts().length;
  await scammer.say("STOP");
  assert.deepEqual(w.owner.texts().slice(ownerBefore), [COPY.turnedUp, COPY.quickCheck, COPY.describe]);
  assert.equal(w.owner.state()?.step, "verify_describe");
});

test("a released item goes to the next owner: the one who reported while a failed claimant had it is asked without texting again", async () => {
  const w = world();
  await w.finder.say("found these at leavey", [PHOTO]);
  const scammer = w.person("+12135550104", "Sam Scammer", "sam.scammer@usc.edu");
  await scammer.say(REPORT);
  await w.owner.say("lost my airpods at leavey yesterday, white case");
  const ownerBefore = w.owner.texts().length;
  await scammer.say("plain black case, nothing on it");
  await scammer.say("there's a blue stripe on the side");
  // Out of tries: the item is back in the pool and the waiting owner is asked.
  assert.deepEqual(w.owner.texts().slice(ownerBefore), [COPY.turnedUp, COPY.quickCheck, COPY.describe]);
  assertNoLeak(scammer.texts());
});

test("a finder who texts STOP mid-check doesn't leave the claimant waiting on an answer that can't come", async () => {
  const w = world();
  await toFinderCheck(w);
  const before = w.owner.texts().length;
  await w.finder.say("STOP");
  assert.deepEqual(w.owner.texts().slice(before), COPY.lostTouch);
  assert.equal(w.owner.state(), null);
  assert.equal(foundListing(w.db).status, "open");
});

// ---------- quiet hours, contact rules, premature closes ----------

const ALWAYS_QUIET = JSON.stringify({ start: "00:00", end: "23:59" });

test("quiet hours never drop a text the other person is owed: the contact warning reaches the owner before any yes can count", async () => {
  const w = world();
  updateUser(w.db, w.owner.id, { quietHours: ALWAYS_QUIET });
  await toHandoffChoice(w);
  await w.finder.say("1");
  assert.equal(w.owner.texts().at(-1), COPY.consent, "the owner was shown the warning");
  assert.equal(typeof w.owner.state()?.data.qid, "string");
  await w.finder.say("yes");
  // A question is not consent.
  assert.deepEqual(await w.owner.say("ok so any update on my airpods?"), ["reply yes for the group chat, or no and i'll pass messages between u instead"]);
  assert.equal(w.groups.length, 0);
  await w.owner.say("yes");
  assert.equal(w.groups.length, 1);
});

test("quiet hours: a match that turns up overnight still reaches the owner, so their next text isn't scored as a description of words they never saw", async () => {
  const w = world();
  updateUser(w.db, w.owner.id, { quietHours: ALWAYS_QUIET });
  await w.owner.say(REPORT);
  const before = w.owner.texts().length;
  await w.finder.say("found these at leavey", [PHOTO]);
  assert.deepEqual(w.owner.texts().slice(before), [COPY.turnedUp, COPY.quickCheck, COPY.describe]);
});

test("quiet hours: the pickup code is delivered, and 'whats my pickup code' sends it again", async () => {
  const w = world();
  updateUser(w.db, w.owner.id, { quietHours: ALWAYS_QUIET });
  await toHandoffChoice(w);
  await w.finder.say("2");
  const code = handoff(w.db).pickupCode!;
  assert.ok(w.owner.texts().includes(`ur pickup code is ${code}`));
  assert.deepEqual(await w.owner.say("whats my pickup code"), [`ur pickup code is ${code}`, `dps lost and found is at ${DPS_ADDRESS}`]);
  assert.equal(lostListing(w.db).status, "handed_off");
});

test("no_contact set during the consent step: no group chat and no relay, both get the dps code", async () => {
  const w = world();
  await toHandoffChoice(w);
  await w.finder.say("1");
  updateUser(w.db, w.owner.id, { contactMode: "no_contact" });
  await w.finder.say("yes");
  assert.equal(w.groups.length, 0);
  assert.equal(activeRelayFor(w.db, w.owner.id), null);
  assert.equal(handoff(w.db).method, "dps_code");
  const code = handoff(w.db).pickupCode!;
  assert.ok(w.owner.texts().includes(`ur pickup code is ${code}`));
  assert.ok(w.finder.texts().includes(`tell them it's for pickup code ${code}`));
  // And saying no instead of yes takes the same road.
  const v = world();
  await toHandoffChoice(v);
  await v.finder.say("1");
  updateUser(v.db, v.finder.id, { contactMode: "no_contact" });
  await v.owner.say("no");
  assert.equal(activeRelayFor(v.db, v.owner.id), null);
  assert.equal(handoff(v.db).method, "dps_code");
});

test("a relay that is already running stops forwarding the moment either person goes no_contact", async () => {
  const w = world({ caps: { groupChats: false } });
  await toHandoffChoice(w);
  await w.finder.say("1");
  assert.ok(activeRelayFor(w.db, w.owner.id));
  updateUser(w.db, w.owner.id, { contactMode: "no_contact" });
  const before = w.owner.texts().length;
  assert.deepEqual(await w.finder.say("hey where are u, i'm at leavey"), [RELAY_COPY.closed]);
  assert.deepEqual(w.owner.texts().slice(before), [RELAY_COPY.closed]);
  assert.equal(activeRelayFor(w.db, w.owner.id), null);
});

test("'ok thanks' after saying yes to the group chat doesn't mark the item returned or kill the pending chat", async () => {
  const w = world();
  await toHandoffChoice(w);
  await w.finder.say("1");
  assert.deepEqual(await w.owner.say("yes"), ["cool. waiting on them to ok it too"]);
  assert.deepEqual(await w.owner.say("ok thanks"), [COPY.waitingConsent]);
  assert.equal(lostListing(w.db).status, "verified");
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM handoffs").get()!.n, 0);
  await w.finder.say("yes");
  assert.equal(w.groups.length, 1, "the group chat still happens");
  assert.equal(handoff(w.db).method, "group_chat");
});

test("at dps pickup only 'got it' closes: 'ok bet' and a heart on the code bubble don't mark it returned", async () => {
  const w = world();
  await toHandoffChoice(w);
  await w.finder.say("2");
  const code = handoff(w.db).pickupCode!;
  await w.owner.tap(`ur pickup code is ${code}`, "love");
  await w.owner.tap(COPY.gotItHint, "like");
  assert.deepEqual(await w.owner.say("ok bet, heading there tmrw"), ["sounds good", COPY.gotItHint]);
  assert.deepEqual(await w.owner.say("ok thanks"), ["sounds good", COPY.gotItHint]);
  assert.equal(lostListing(w.db).status, "handed_off");
  assert.equal(handoff(w.db).completedAt, null);
  assert.deepEqual(await w.owner.say("got it"), ["love that", COPY.askThanks]);
  assert.equal(lostListing(w.db).status, "returned");
});

test("dangerous items written as one word or missing from the old list go to dps and never become a student handoff", async () => {
  for (const said of ["found a handgun by leavey", "found a pocketknife at leavey", "found a shotgun shell at leavey", "found a razor at leavey", "found a glock at leavey", "found some scissors at leavey"]) {
    const w = world();
    setModelCall(null);
    assert.deepEqual(await w.finder.say(said), [COPY.dangerous, `dps lost and found is at ${DPS_ADDRESS}`], said);
    const found = foundListing(w.db);
    assert.equal(found.isDangerous, 1, said);
    assert.equal(found.status, "handed_off", said);
    assert.equal(found.heldBy, "dps", said);
  }
  // Said in answer to "what is it?" too.
  const w = world();
  setModelCall(null);
  assert.deepEqual(await w.finder.say("found this", [PHOTO]), [COPY.askWhat]);
  assert.deepEqual(await w.finder.say("a handgun"), [COPY.dangerous, `dps lost and found is at ${DPS_ADDRESS}`]);
});

test("a first name written on a water bottle doesn't skip the blind description or tell anyone a name is on it", async () => {
  const w = world();
  model.profile = { category: "water_bottle", title: "hydro flask", brand: "Hydro Flask", color: "blue", publicSummary: "blue hydro flask", distinguishing: ["usc sticker", "name written on the bottom in sharpie"], nameOnItem: "Owen", isValuable: false, isDangerous: false };
  model.describe = (a) => (/usc sticker/i.test(a) ? 90 : 10);
  await w.finder.say("found this at leavey", [PHOTO]);
  assert.deepEqual(await w.owner.say("lost my hydro flask at leavey yesterday"), FIRST);
  assert.deepEqual(checks(w.db), []);
  assert.ok(!w.owner.texts().some((t) => /name|account/.test(t)));
  assert.equal((await w.owner.say("blue one with a usc sticker, my name's on the bottom"))[0], COPY.passed);
});

test("no ai: a rule-score pass sent to the finder is a used try, and the finder's nvm doesn't hand it back", async () => {
  const w = world();
  setModelCall(null);
  await w.finder.say("found these airpods at leavey", [PHOTO]);
  await w.finder.say("white case with a dinosaur sticker on the lid, initials MK engraved");
  const scammer = w.person("+12135550104", "Sam Scammer", "sam.scammer@usc.edu");
  for (const round of [1, 2]) {
    assert.equal((await scammer.say(REPORT)).at(-1), COPY.describe, `round ${round}`);
    assert.deepEqual(await scammer.say("dinosaur sticker on the lid and initials mk engraved"), COPY.checkingHolder);
    assert.deepEqual(await w.finder.say("nvm"), ["ok, skipping that one"]);
  }
  assert.deepEqual(checks(w.db).map((c) => [c.method, c.result]), [["blind_description", "fail"], ["blind_description", "fail"]]);
  assert.ok(claimantBlocked(w.db, foundListing(w.db).id, scammer.id));
  assert.deepEqual((await scammer.say(REPORT)).slice(-2), [COPY.nothingYet, COPY.willText]);
});

// ---------- no-ai verification leans on the finder (CLAUDE.md Decisions) ----------

const GOOD_ANSWER = "white case, dinosaur sticker on the lid and my initials mk engraved";

test("ai down mid-claim: a description that would pass on the rule score never verifies by itself, it waits on the finder", async () => {
  const w = world();
  await toDescribe(w);
  // The photo was read by the model, then the model went down before the description was scored.
  ruleScoresOnly();
  const before = w.finder.texts().length;
  assert.deepEqual(await w.owner.say(GOOD_ANSWER), COPY.checkingHolder);
  const row = checks(w.db)[0]!;
  assert.ok((row.score ?? 0) >= THRESHOLDS.descriptionPass, `the rule score alone would pass: ${row.score}`);
  assert.equal(row.result, null, "no result until the finder answers");
  assert.equal(match(w.db).status, "finder_check");
  assert.equal(foundListing(w.db).status, "verifying");
  assert.equal(one<{ n: number }>(w.db, "SELECT COUNT(*) AS n FROM handoffs").n, 0);
  assert.ok(!w.owner.texts().includes(COPY.passed), "the owner is never told it checked out on the rule score");
  // The finder sees the owner's words. The owner sees nothing of the finder's.
  assert.deepEqual(w.finder.texts().slice(before), ["someone says the white airpods case u found are theirs", "here's how they described it:", `"${GOOD_ANSWER}"`, COPY.finderCheck]);
  assertNoLeak(w.owner.texts());

  await w.finder.say("yes");
  assert.deepEqual(checks(w.db).map((c) => [c.method, c.result]), [["blind_description", "pass"], ["finder_confirm", "pass"]]);
  assert.equal(match(w.db).status, "verified");
  assertNoLeak(w.owner.texts());
});

test("ai down: a wrong color is a miss by the rules alone, and the finder is never bothered", async () => {
  const w = world();
  await toDescribe(w);
  ruleScoresOnly();
  const before = w.finder.texts().length;
  // Two hidden details right, but the item is white.
  assert.deepEqual(await w.owner.say("black case, dinosaur sticker on the lid and my initials mk engraved"), COPY.retry);
  assert.equal(w.owner.state()?.step, "verify_describe");
  assert.equal(match(w.db).status, "verifying");
  assert.deepEqual(await w.owner.say("its black with a dinosaur sticker and engraved initials"), [COPY.cantConfirmDescription, COPY.askProof]);
  assert.deepEqual(checks(w.db).map((c) => [c.method, c.result, c.attempts]), [["blind_description", "fail", 1], ["blind_description", "fail", 2]]);
  assert.ok(checks(w.db).every((c) => (c.score ?? 100) <= 15), "contradictions stay at or under the cap");
  assert.equal(w.finder.texts().length, before, "nothing was sent to the finder");
  assert.equal(w.finder.state(), null);
  assertNoLeak(w.owner.texts());
});

test("ai down: a different name than the one on the item is a miss without asking the finder", async () => {
  const w = world();
  model.profile = { ...AIRPODS, nameOnItem: "Maya Kim" };
  await toDescribe(w);
  ruleScoresOnly();
  const before = w.finder.texts().length;
  assert.deepEqual(await w.owner.say("dinosaur sticker on the lid, engraved initials, and the name on it is tyler brooks"), COPY.retry);
  assert.deepEqual(checks(w.db).map((c) => [c.method, c.result]), [["blind_description", "fail"]]);
  assert.equal(w.finder.texts().length, before);
  assertNoLeak(w.owner.texts(), ["maya", "kim"]);
});

test("ai down: a wrong size is a miss without asking the finder", async () => {
  const w = world();
  model.profile = { category: "clothing", title: "red flannel shirt", brand: null, color: "red", publicSummary: "red flannel shirt", distinguishing: ["size small", "elbow patch sewn on the right arm", "top button is missing"], nameOnItem: null, isValuable: false, isDangerous: false };
  await w.finder.say("found this at leavey", [PHOTO]);
  assert.equal((await w.owner.say("lost my red flannel shirt near leavey yesterday")).at(-1), COPY.describe);
  ruleScoresOnly();
  const before = w.finder.texts().length;
  assert.deepEqual(await w.owner.say("red flannel, size large, elbow patch on the right arm"), COPY.retry);
  assert.deepEqual(checks(w.db).map((c) => [c.method, c.result]), [["blind_description", "fail"]]);
  assert.equal(w.finder.texts().length, before);
});

test("ai down, item already at dps: a rule-score pass sends the claimant to dps in person and never to the finder", async () => {
  const w = world();
  await w.finder.say("found these at leavey", [PHOTO]);
  w.db.exec("UPDATE listings SET heldBy = 'dps' WHERE type = 'found'");
  await w.owner.say(REPORT);
  ruleScoresOnly();
  const before = w.finder.texts().length;
  assert.deepEqual(await w.owner.say(GOOD_ANSWER), [COPY.dpsInPerson, `dps lost and found is at ${DPS_ADDRESS}`, "u can reach them at 213-740-9759 or lostandfound@dps.usc.edu"]);
  assert.equal(match(w.db).status, "rejected");
  assert.equal(one<{ n: number }>(w.db, "SELECT COUNT(*) AS n FROM handoffs").n, 0);
  assert.equal(w.owner.state(), null);
  assert.equal(w.finder.texts().length, before);
  assert.equal(w.finder.state(), null);
  assertNoLeak(w.owner.texts());
});

test("ai down: the question for the finder waits behind one they already have open, and their yes can't land on the wrong claim", async () => {
  const w = world();
  await toHandoffChoice(w);
  assert.equal(w.finder.state()?.step, "handoff_choice");
  const m1 = Number(w.finder.state()?.data.matchId);
  // The same finder turns in a second item and its owner describes it while the model is down.
  model.profile = { category: "water_bottle", title: "blue water bottle", brand: null, color: "blue", publicSummary: "blue water bottle", distinguishing: ["dented bottom", "climbing gym sticker"], nameOnItem: null, isValuable: false, isDangerous: false };
  await w.finder.say("found this at leavey", [PHOTO]);
  const two = w.person("+12135550106", "Bea Bottle", "bea.bottle@usc.edu");
  assert.equal((await two.say("lost my blue water bottle near leavey yesterday")).at(-1), COPY.describe);
  ruleScoresOnly();
  const before = w.finder.texts().length;
  assert.deepEqual(await two.say("blue bottle, dented bottom and a climbing gym sticker"), COPY.checkingHolder);
  assert.equal(w.finder.texts().length, before, "parked, not sent");
  assert.equal(w.finder.state()?.step, "handoff_choice");
  assert.equal(Number(w.finder.state()?.data.matchId), m1);
  assert.equal(pendingFor(w.db, w.finder.id).length, 1);
  // The finder answers the question they were actually asked. Only then does the bottle question arrive.
  await w.finder.say("2");
  assert.equal(w.finder.state()?.step, "finder_check");
  assert.ok(w.finder.texts().some((t) => t.includes("dented bottom and a climbing gym sticker")));
  assert.equal(w.finder.texts().at(-1), COPY.finderCheck);
  await w.finder.say("yes");
  const statuses = (w.db.prepare("SELECT status FROM matches ORDER BY id").all() as { status: string }[]).map((r) => r.status);
  assert.equal(statuses.filter((s) => s === "verified" || s === "handed_off").length, 2);
});

// ---------- one open step per person ----------

const WALLET = { category: "wallet", title: "black wallet", brand: null, color: "black", publicSummary: "black wallet", distinguishing: [], nameOnItem: null, isValuable: true, isDangerous: false };

test("a finder with two claims answers them one at a time: the second question waits and neither match gets stuck", async () => {
  const w = world();
  model.profile = { ...AIRPODS, distinguishing: [] };
  await w.finder.say("found these at leavey", [PHOTO]);
  model.profile = WALLET;
  await w.finder.say("found this at leavey", [PHOTO]);
  const two = w.person("+12135550105", "Wendy Wallet", "wendy.wallet@usc.edu");

  await w.owner.say(REPORT);
  await w.owner.say("there's a sticker on it i think");
  const m1 = Number(w.finder.state()?.data.matchId);
  await two.say("lost my wallet near leavey yesterday");
  await two.say("black leather one with a zipper");
  // The second question is parked, not sent: the finder's "yes" can only mean the airpods.
  assert.equal(Number(w.finder.state()?.data.matchId), m1);
  assert.ok(!w.finder.texts().some((t) => t.includes("zipper")));
  assert.equal(pendingFor(w.db, w.finder.id).length, 1);

  await w.finder.say("yes");
  assert.equal(w.finder.state()?.step, "handoff_choice");
  assert.equal(Number(w.finder.state()?.data.matchId), m1);
  await w.finder.say("2");
  // Free again: now the wallet question arrives, with the claimant's words.
  assert.ok(w.finder.texts().some((t) => t.includes("zipper")));
  assert.equal(w.finder.texts().at(-1), COPY.finderCheck);
  assert.equal(w.finder.state()?.step, "finder_check");
  await w.finder.say("yes");
  const statuses = (w.db.prepare("SELECT status FROM matches ORDER BY id").all() as { status: string }[]).map((r) => r.status);
  assert.deepEqual(statuses.filter((x) => x === "verified").length, 2, "both owners were verified, nobody is waiting forever");
  assert.equal(two.texts().includes("good news. the person who found it says it sounds like urs"), true);
});

test("a finder who sends a photo of another item mid-question gets the question back afterwards", async () => {
  const w = world();
  await toFinderCheck(w);
  model.profile = WALLET;
  await w.finder.say("found this too", [PHOTO]);
  const back = await w.finder.say("tcc");
  assert.deepEqual(back.slice(-2), ["back to the white airpods case u found", COPY.finderCheck]);
  assert.equal(w.finder.state()?.step, "finder_check");
  await w.finder.say("yes");
  assert.equal(w.db.prepare("SELECT status FROM matches ORDER BY id LIMIT 1").get()!.status, "verified");
});

test("another flow can't wipe a pending handoff question: a repair report in the middle leaves it answerable", async () => {
  registerFlow(repair);
  const w = world();
  await toHandoffChoice(w);
  const filed = await w.finder.say("also the light on the 2nd floor of leavey is broken");
  assert.match(filed[0]!, /^reported to fms/);
  assert.equal(w.finder.state()?.step, "handoff_choice");
  assert.deepEqual(await w.finder.say("1"), [COPY.consent]);

  // When the other flow needs a step of its own, the question steps aside and comes back.
  const v = world();
  await toHandoffChoice(v);
  assert.deepEqual(await v.finder.say("the elevator is broken"), ["which building and floor?"]);
  assert.equal(v.finder.state()?.flow, "repair");
  const after = await v.finder.say("taper hall 2nd floor");
  assert.deepEqual(after.slice(-2), ["back to the white airpods case u found", COPY.handoffAsk]);
  assert.deepEqual(await v.finder.say("1"), [COPY.consent]);
});

test("the finder's answer never clears a step the owner has since opened for something else", async () => {
  const w = world();
  await toFinderCheck(w);
  await w.owner.say("nvm");
  assert.deepEqual(await w.owner.say("i lost my wallet"), [COPY.askLostPlace]);
  await w.finder.say("no");
  assert.equal(w.owner.state()?.step, "lost_place", "the wallet report is still open");
  assert.deepEqual(await w.owner.say("leavey"), [COPY.askLostTime]);
});

test("the thank-you step expires and never forwards a greeting or a question to the finder", async () => {
  const w = world();
  await toHandoffChoice(w);
  await w.finder.say("2");
  await w.owner.say("got it");
  assert.equal(w.owner.state()?.step, "thanks_note");
  w.db.prepare("UPDATE flow_state SET updatedAt = ? WHERE userId = ?").run(Date.now() - 5 * 24 * 60 * 60 * 1000, w.owner.id);
  const before = w.finder.texts().length;
  await w.owner.say("yo troy u up");
  assert.deepEqual(w.finder.texts().slice(before), []);
  assert.equal(w.owner.state(), null);
  assert.equal(handoff(w.db).thankYouNote, null);

  // Fresh, but not a thank-you.
  const v = world();
  await toHandoffChoice(v);
  await v.finder.say("2");
  await v.owner.say("got it");
  const vBefore = v.finder.texts().length;
  await v.owner.say("wait where do i return the case?");
  await v.owner.say("yo troy");
  assert.deepEqual(v.finder.texts().slice(vBefore), []);
  assert.equal(handoff(v.db).thankYouNote, null);
});

test("parseWhen reads rough times and gives null for anything else", () => {
  const now = new Date(2026, 10, 14, 15, 0, 0).getTime();
  assert.equal(parseWhen("2 hours ago", now), now - 2 * 60 * 60 * 1000);
  assert.equal(parseWhen("like an hour ago", now), now - 60 * 60 * 1000);
  assert.equal(new Date(parseWhen("yesterday", now)!).getDate(), 13);
  assert.equal(new Date(parseWhen("last night", now)!).getHours(), 21);
  assert.equal(parseWhen("this morning", now), new Date(2026, 10, 14, 9).getTime());
  assert.ok(parseWhen("on tuesday", now)! < now);
  assert.equal(parseWhen("idk", now), null);
});

// ---------- facts locked, wording varied ----------

/** A picker for tests: plain rotation per person and pool, and a record of everything each choice was made from. */
function recordingPicker() {
  const calls: { userId: number; key: string; variants: string[] }[] = [];
  const turn = new Map<string, number>();
  const pick: VariantPicker = (_db, userId, key, variants) => {
    calls.push({ userId, key, variants: [...variants] });
    const n = (turn.get(`${userId}:${key}`) ?? 0) + 1;
    turn.set(`${userId}:${key}`, n);
    return variants[n % variants.length]!;
  };
  return { calls, pick };
}

test("wording pools: 3 to 5 variants each, same values and bubble count in every variant, lowercase, no dashes, no emoji", () => {
  assert.deepEqual(poolProblems(LF_POOLS), []);
  // Stressful flow: no emoji in any variant.
  for (const def of Object.values(LF_POOLS)) {
    const variants = typeof def === "function" ? def(...Array.from({ length: def.length }, () => "x")) : def.flat();
    for (const v of variants) assert.ok(!/\p{Extended_Pictographic}/u.test(v), v);
  }
  // Nothing after a miss says how close the description was or which part was off.
  const afterMiss = ["retry", "cantConfirmDescription", "cantConfirm", "askProof", "dpsInPerson", "askingHolder", "cantConnect", "reportStaysOpen", "nothingYet", "stillWaiting", "checkingHolder"];
  for (const key of afterMiss) {
    for (const v of (LF_POOLS[key] as (string | string[])[]).flat()) {
      assert.ok(!/close|almost|nearly|not quite|partly|part of|some of|warm|color|colour|sticker|brand|name|size|wrong/i.test(v), `${key}: "${v}" hints at what was off`);
    }
  }
});

test("tier 1 lines have no variants: the dangerous-item line, the contact warning, the group chat opener and the confetti line", () => {
  for (const line of [COPY.dangerous, COPY.consent, COPY.consentHow, COPY.groupFirst, COPY.win, ...RELAY_COPY.start]) {
    assert.deepEqual(LF_VOICE.variantsOf(line), [line]);
    const picker = recordingPicker();
    setVariantPicker(picker.pick);
    try {
      const db = openDb(":memory:");
      for (let i = 0; i < 6; i++) assert.equal(LF_VOICE.line(db, 1, line), line);
      assert.equal(picker.calls.length, 0, "the picker is never even asked");
    } finally {
      setVariantPicker(null);
    }
  }
});

test("the pickup code, the summary and the dps address are the same in every variant", async () => {
  const picker = recordingPicker();
  setVariantPicker(picker.pick);
  try {
    const w = world();
    await toHandoffChoice(w);
    await w.finder.say("2");
    const code = handoff(w.db).pickupCode!;
    assert.match(code, CODE);
    const all = [...w.finder.sent(), ...w.owner.sent()];
    // The wording really did vary, and every varied line is one of its pool's variants.
    assert.ok(all.some((b) => b.raw !== b.text));
    for (const b of all) assert.ok(LF_VOICE.variantsOf(b.text).includes(b.raw), b.raw);
    // Exactly one bubble to each of them carries the code, and it is the code on the handoff, whatever the wording.
    for (const who of [w.finder, w.owner]) assert.deepEqual(who.sent().filter((b) => CODE.test(b.raw)).map((b) => b.raw.match(CODE)![0]), [code]);
    assert.ok(w.owner.sent().some((b) => b.raw === `dps lost and found is at ${DPS_ADDRESS}`), "directory text is never reworded");
    assert.ok(w.finder.sent().some((b) => b.raw.includes("white airpods case")));
    for (const v of LF_VOICE.variantsOf(`ur pickup code is ${code}`)) assert.ok(v.includes(code));
  } finally {
    setVariantPicker(null);
  }
});

test("what a claimant is told is one of the allowed variants, and which one never depends on the match score or the description score", async () => {
  // The same person sends the same texts. Only the hidden numbers change: how well the report matched, and how
  // far off each description was (always a miss).
  const below = THRESHOLDS.descriptionPass - 1;
  const probes: { rank: number; scores: [number, number] }[] = [
    { rank: 95, scores: [0, 0] },
    { rank: 95, scores: [below, below] },
    { rank: 55, scores: [10, below] },
    { rank: 55, scores: [below, 3] },
    { rank: 81, scores: [40, 60] },
  ];
  const runs: { raw: string[]; text: string[]; calls: { key: string; variants: string[] }[] }[] = [];
  for (const probe of probes) {
    const picker = recordingPicker();
    setVariantPicker(picker.pick);
    try {
      const w = world();
      const scores = [...probe.scores];
      model.rank = () => probe.rank;
      model.describe = () => scores.shift() ?? 0;
      await w.finder.say("found these at leavey", [PHOTO]);
      const scammer = w.person("+12135550104", "Sam Scammer", "sam.scammer@usc.edu");
      await scammer.say(REPORT);
      await scammer.say("a cat sticker on the front");
      await scammer.say("it has a blue stripe");
      await scammer.say("no");
      assert.deepEqual(checks(w.db).map((c) => [c.result, c.score]), [["fail", probe.scores[0]], ["fail", probe.scores[1]]], "the scores really were different");
      runs.push({
        raw: scammer.sent().map((b) => b.raw),
        text: scammer.texts(),
        calls: picker.calls.filter((c) => c.userId === scammer.id).map((c) => ({ key: c.key, variants: c.variants })),
      });
      assertNoLeak(scammer.sent().map((b) => b.raw));
    } finally {
      setVariantPicker(null);
    }
  }
  const first = runs[0]!;
  assert.deepEqual(first.text, [...FIRST, ...COPY.retry, COPY.cantConfirmDescription, COPY.askProof, COPY.askingHolder]);
  // One of the allowed variants, every time, and the wording did move off the first one somewhere.
  first.raw.forEach((raw, i) => assert.ok(LF_VOICE.variantsOf(first.text[i]!).includes(raw), raw));
  assert.ok(first.raw.some((raw, i) => raw !== first.text[i]));
  for (const run of runs.slice(1)) {
    // Word for word the same bubbles in the same order, whatever the scores were.
    assert.deepEqual(run.raw, first.raw);
    // And the reason why: every choice was made from the same pool names and the same variant lists.
    // The picker is handed the person and the pool's name. No score is ever part of what it sees.
    assert.deepEqual(run.calls, first.calls);
  }
  for (const c of first.calls) {
    assert.match(c.key, /^lost_found\.[a-zA-Z]+$/);
    assert.ok(!/\d/.test(c.key), "no number rides along in the key");
  }
});

test("with the real picker a claimant's lines still come only from the pools, across repeated probes", async () => {
  const w = world();
  model.rank = (d) => (/dinosaur|hinge|crack|initials/i.test(d) ? 95 : 60);
  await w.finder.say("found these at leavey", [PHOTO]);
  const scammer = w.person("+12135550104", "Sam Scammer", "sam.scammer@usc.edu");
  for (const guess of ["cat sticker", "dinosaur", "hinge", "crack"]) {
    assert.deepEqual(await scammer.say(`${REPORT}, ${guess}`), FIRST);
    await scammer.say("nvm");
  }
  for (const b of scammer.sent()) assert.ok(LF_VOICE.variantsOf(b.text).includes(b.raw), b.raw);
  // Each opener went out four times, and every time as one of its pool's own wordings.
  for (const line of FIRST) {
    const seen = scammer.sent().filter((b) => b.text === line).map((b) => b.raw);
    assert.equal(seen.length, 4);
    assert.ok(seen.every((raw) => LF_VOICE.variantsOf(line).includes(raw)));
  }
});
