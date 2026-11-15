import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AdapterCapabilities, IncomingEvent, Intent, MessagingAdapter, TapbackType, User } from "../src/types.ts";
import { openDb, getOrCreateUser, getUserById, updateUser, getFlowState } from "../src/db/index.ts";
import { createPipeline } from "../src/pipeline.ts";
import { registerFlow } from "../src/flows/index.ts";
import { fallbackIntent, setModelCall } from "../src/ai.ts";
import { walkingMinutes } from "../src/places.ts";
import { laMinutes } from "../src/quiet.ts";
import { RELAY_COPY, activeRelayFor, startRelay } from "../src/relay.ts";
import { FOOD_COPY, FOOD_POOLS, FOOD_VOICE, claimServing, findRecipients, food, setFoodDeps, startFoodTimers, sweepFood, walkLine } from "../src/flows/food.ts";
import { LOCATION_STALE_MS, getUserLocation, saveUserLocation } from "../src/location.ts";
import { poolProblems, setVariantPicker } from "../src/flows/reports-shared.ts";
import type { VariantPicker, Voice } from "../src/flows/reports-shared.ts";

registerFlow(food);
// Nothing in this file may reach the network: every model call fails, so every reply is fallback copy.
setModelCall(async () => {
  throw new Error("off");
});

const PLACES = JSON.parse(readFileSync(join(import.meta.dirname, "../src/db/seed-data/campus_places.json"), "utf8")) as { name: string; nicknames: string[]; lat: number; lng: number; kind: string }[];
const DIRECTORY = JSON.parse(readFileSync(join(import.meta.dirname, "../src/db/seed-data/directory.json"), "utf8")) as { kind: string; name: string; topics: string[]; contactMethod: string | null; url: string | null; details: string | null; isExample?: boolean }[];
const place = (name: string) => PLACES.find((p) => p.name === name)!;
const LEAVEY = place("Leavey Library");
const TCC = place("Ronald Tutor Campus Center");
const VILLAGE = place("USC Village");

type Call = { method: "sendMessage" | "editMessage"; chatId: string; text: string; id: string; raw: string };

/**
 * Facts locked, wording varied: any line Troy sends may be any variant from FOOD_POOLS. The fake adapter records
 * each bubble read back to its first wording, with every count, place and time kept exactly as sent, so the
 * assertions below hold for whichever variant went out. `raw` keeps the words as they were sent.
 */
const canon = (text: string): string => FOOD_VOICE.canonical(text);
type Who = "poster" | "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "k";

const hhmm = (mins: number) => {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

function world(opts: { caps?: Partial<AdapterCapabilities>; editOk?: boolean; photoCount?: number | null; intent?: (text: string) => Intent | null } = {}) {
  const db: DatabaseSync = openDb(":memory:");
  const addPlace = db.prepare("INSERT INTO campus_places (name, nicknames, lat, lng, kind) VALUES (?, ?, ?, ?, ?)");
  for (const p of PLACES) addPlace.run(p.name, JSON.stringify(p.nicknames), p.lat, p.lng, p.kind);

  const calls: Call[] = [];
  const live = new Map<string, { lat: number; lng: number; at: number }>();
  const settings = { editOk: opts.editOk ?? true };
  let n = 0;
  const adapter: MessagingAdapter = {
    provider: "webchat",
    capabilities: () => ({ tapbacks: true, typing: true, readReceipts: true, edits: true, effects: true, polls: false, groupChats: false, contactCard: true, liveLocation: true, ...opts.caps }),
    async sendMessage(chatId, text) {
      const id = `out-${++n}`;
      calls.push({ method: "sendMessage", chatId, text: canon(text), id, raw: text });
      return { messageId: id };
    },
    sendImage: async () => null,
    sendContactCard: async () => null,
    async markRead() {},
    async startTyping() {},
    async stopTyping() {},
    react: async () => true,
    async editMessage(chatId, messageId, text) {
      calls.push({ method: "editMessage", chatId, text, id: messageId, raw: text });
      return settings.editOk;
    },
    sendPoll: async (_c, _q, options) => ({ optionMessageIds: options.map(() => null), mode: "tap" }),
    createGroupChat: async () => null,
    getLiveLocation: async (handle) => live.get(handle) ?? null,
    requestLocation: async () => false,
    chatIdForHandle: (h) => `chat-${h}`,
  };

  const photo = { count: opts.photoCount === undefined ? null : opts.photoCount };
  const relays: { a: number; b: number; context: string }[] = [];
  setFoodDeps(null);
  setFoodDeps({
    countServings: async () => (photo.count === null ? null : { count: photo.count, item: "bowls", confident: true }),
    startRelay: (_db, a, b, context) => {
      relays.push({ a, b, context });
      return relays.length;
    },
  });

  const pipeline = createPipeline({
    db,
    getAdapter: () => adapter,
    pause: async () => {},
    ackAfterMs: 60_000,
    detectIntent: async (input) => opts.intent?.(input.text) ?? fallbackIntent(input),
  });

  const handles: Record<Who, string> = { poster: "+12135550100", a: "+12135550101", b: "+12135550102", c: "+12135550103", d: "+12135550104", e: "+12135550105", f: "+12135550106", g: "+12135550107", h: "+12135550108", k: "+12135550109" };
  const ids = {} as Record<Who, number>;
  const make = (who: Who, fields: Record<string, string | number | null> = {}) => {
    const u = getOrCreateUser(db, handles[who], `chat-${who}`);
    updateUser(db, u.id, { verifiedAt: Date.now(), verifiedVia: "usc_email", subscriptions: JSON.stringify(["free_food"]), ...fields });
    ids[who] = u.id;
  };
  make("poster", { subscriptions: "[]" });
  make("a", { usualSpots: JSON.stringify(["tcc"]) });
  make("b"); // shares live location, set below
  live.set(handles.b, { lat: VILLAGE.lat, lng: VILLAGE.lng, at: Date.now() });
  make("c", { usualSpots: JSON.stringify(["parkside"]), alertMinutes: 5 }); // too far for their own limit
  make("d", { subscriptions: JSON.stringify(["events"]), usualSpots: JSON.stringify(["leavey"]) }); // not subscribed
  make("e", { paused: 1, usualSpots: JSON.stringify(["leavey"]) });
  make("f", { stopped: 1, usualSpots: JSON.stringify(["leavey"]) });
  make("g", { usualSpots: JSON.stringify(["my apartment off campus"]) }); // nothing findPlace can resolve
  const nowMins = laMinutes();
  make("h", { usualSpots: JSON.stringify(["leavey"]), quietHours: JSON.stringify({ start: hhmm(nowMins - 60), end: hhmm(nowMins + 60) }) });

  let m = 0;
  const event = (who: Who, over: Partial<IncomingEvent>): IncomingEvent => ({
    provider: "webchat",
    userHandle: handles[who],
    chatId: `chat-${who}`,
    isGroup: false,
    messageId: `in-${++m}`,
    text: "",
    images: [],
    receivedAt: Date.now(),
    ...over,
  });
  const sentTo = (who: Who) => calls.filter((c) => c.method === "sendMessage" && c.chatId === `chat-${who}`);
  const textsTo = (who: Who) => sentTo(who).map((c) => c.text);
  const edits = () => calls.filter((c) => c.method === "editMessage");
  /** Send a text and return the bubbles that came back to that same person. */
  const text = async (who: Who, t: string, images: IncomingEvent["images"] = []) => {
    const before = textsTo(who).length;
    await pipeline.handleEvent(event(who, { text: t, images }));
    return textsTo(who).slice(before);
  };
  const tap = async (who: Who, targetMessageId: string, type: TapbackType = "love", removed = false) => {
    const before = textsTo(who).length;
    await pipeline.handleEvent(event(who, { reaction: { targetMessageId, type, removed } }));
    return textsTo(who).slice(before);
  };
  const drop = (id = 1) => db.prepare("SELECT * FROM food_drops WHERE id = ?").get(id) as Record<string, unknown>;
  const claims = () => (db.prepare("SELECT userId, status FROM claims ORDER BY id").all() as { userId: number; status: string }[]).map((c) => ({ userId: c.userId, status: c.status }));
  /** The id of the "react if u want one" bubble a user got for a drop. */
  const claimBubble = (who: Who, id = 1) => (JSON.parse(drop(id).alertMessageIds as string) as Record<string, string>)[String(ids[who])];
  const user = (who: Who): User => getUserById(db, ids[who])!;
  /** A plain post with no questions left: count, spot and club all in the text. */
  const post = async (count: number, extra = "") => text("poster", `${count} bowls of chipotle from acm at leavey${extra}`, [{ path: "/nonexistent/food.jpg", mime: "image/jpeg" }]);
  return { db, adapter, calls, settings, photo, relays, pipeline, ids, handles, make, event, sentTo, textsTo, edits, text, tap, drop, claims, claimBubble, user, post, live };
}

const PHOTO = [{ path: "/nonexistent/food.jpg", mime: "image/jpeg" }];
const LEAD = "yo acm is giving away free chipotle at leavey";

test("the known walks: tcc to leavey is 6 min, the village to leavey is 8", () => {
  assert.equal(walkingMinutes(TCC, LEAVEY), 6);
  assert.equal(walkingMinutes(VILLAGE, LEAVEY), 8);
});

test("photo post: count confirmed, club asked once, alert goes only to subscribed users in range", async () => {
  const w = world({ photoCount: 3 });
  assert.deepEqual(await w.text("poster", "3 bowls of chipotle at leavey", PHOTO), ["looks like 3 bowls, right?"]);
  assert.equal(w.drop(), undefined, "nothing is posted before the poster confirms");
  assert.deepEqual(await w.text("poster", "yes"), [FOOD_COPY.askClub]);
  const done = await w.text("poster", "acm");
  assert.deepEqual(done, ["posted. i texted 3 people nearby", "text me how many are left anytime, or 'we're out' when it's done"]);

  // a has only a usual spot, so the walk is named from it.
  assert.deepEqual(w.textsTo("a"), [`${LEAD}, about 3 bowls left`, "it's about a 6 min walk from tcc", "react if u want one"]);
  // b shares live location (the village); "an 8", not "a 8".
  assert.deepEqual(w.textsTo("b"), [`${LEAD}, about 3 bowls left`, "it's about an 8 min walk from u", "react if u want one"]);
  // g has no usable location: still alerted, no walking-time bubble.
  assert.deepEqual(w.textsTo("g"), [`${LEAD}, about 3 bowls left`, "react if u want one"]);
  for (const who of ["c", "d", "e", "f", "h"] as const) assert.deepEqual(w.textsTo(who), [], `${who} should get nothing`);

  const d = w.drop();
  assert.equal(d.posterUserId, w.ids.poster);
  assert.equal(d.clubName, "acm");
  assert.equal(d.description, "chipotle");
  assert.equal(d.locationText, "leavey");
  assert.equal(d.lat, LEAVEY.lat);
  assert.equal(d.lng, LEAVEY.lng);
  assert.equal(d.servingsTotal, 3);
  assert.equal(d.servingsLeft, 3);
  assert.equal(d.holdMinutes, 15);
  assert.equal(d.status, "live");
  const alertIds = JSON.parse(d.alertMessageIds as string) as Record<string, string>;
  assert.deepEqual(Object.keys(alertIds).sort(), [w.ids.a, w.ids.b, w.ids.g].map(String).sort());
  assert.equal(alertIds[String(w.ids.a)], w.sentTo("a")[2].id, "the claimable bubble is the 'react' one");
  assert.equal(getFlowState(w.db, w.ids.poster), null, "the poster is not left in a state");
  // b's live fix is kept as their last known location; it never becomes a usual spot.
  assert.equal(w.user("b").usualSpots.length, 0);
  const saved = getUserLocation(w.db, w.user("b"))!;
  assert.deepEqual({ lat: saved.lat, lng: saved.lng, source: saved.source, stale: saved.stale }, { lat: VILLAGE.lat, lng: VILLAGE.lng, source: "find_my", stale: false });
  // Nobody else's row was touched.
  assert.equal(getUserLocation(w.db, w.user("g")), null);
});

test("the photo count is only a suggestion: the poster's correction wins", async () => {
  const w = world({ photoCount: 7 });
  assert.deepEqual(await w.text("poster", "free chipotle from acm at leavey", PHOTO), ["looks like 7 bowls, right?"]);
  await w.text("poster", "no, 5");
  assert.equal(w.drop().servingsLeft, 5);
  assert.equal(w.textsTo("a")[0], `${LEAD}, about 5 bowls left`);
});

test("no ai: the number comes from the text, hold time and club too, with no questions", async () => {
  const w = world({ photoCount: null });
  const out = await w.text("poster", "5 pizzas from acm at tcc, hold each one for 10 min", PHOTO);
  assert.equal(out[0], "posted. i texted 3 people nearby");
  const d = w.drop();
  assert.equal(d.servingsTotal, 5);
  assert.equal(d.holdMinutes, 10);
  assert.equal(d.clubName, "acm");
  assert.equal(d.description, "pizzas");
  assert.equal(d.locationText, "tcc");
  assert.equal(d.photoUrl, PHOTO[0].path);
  // From tcc itself it's a 1 min walk; c (parkside, 5 min limit) is still out of range, h is in quiet hours.
  assert.deepEqual(w.textsTo("a"), ["yo acm is giving away free pizzas at tcc, about 5 left", "it's about a 1 min walk from tcc", "react if u want one"]);
  assert.deepEqual(w.textsTo("c"), []);
  assert.deepEqual(w.textsTo("h"), []);
});

test("no ai and nothing stated: asks how many, then where, then who (skippable), one at a time", async () => {
  const w = world({ photoCount: null });
  assert.deepEqual(await w.text("poster", "free pizza come grab some"), [FOOD_COPY.askCount]);
  assert.deepEqual(await w.text("poster", "like 8"), [FOOD_COPY.askSpot]);
  assert.deepEqual(await w.text("poster", "outside tcc"), [FOOD_COPY.askClub]);
  const out = await w.text("poster", "skip");
  assert.match(out[0], /^posted\. i texted \d people nearby$/);
  const d = w.drop();
  assert.equal(d.clubName, null);
  assert.equal(d.servingsLeft, 8);
  assert.equal(d.locationText, "outside tcc");
  assert.equal(d.lat, TCC.lat);
  assert.equal(w.textsTo("a")[0], "yo there's free pizza at outside tcc, about 8 left");
});

test("nvm drops a half-made post, and a new request in the middle is not swallowed", async () => {
  const w = world({ photoCount: null });
  await w.text("poster", "free pizza come grab some");
  assert.deepEqual(await w.text("poster", "nvm"), [FOOD_COPY.dropped]);
  assert.equal(getFlowState(w.db, w.ids.poster), null);
  assert.equal(w.drop(), undefined);

  await w.text("poster", "free pizza come grab some");
  // "i lost my wallet" is lost_found by the keyword rules, so the lost and found flow takes it from here.
  const out = await w.text("poster", "i lost my wallet at leavey");
  assert.ok(out.length >= 1);
  assert.ok(!out.includes(FOOD_COPY.askCountAgain), "the food flow must not treat it as an answer");
  assert.notEqual(getFlowState(w.db, w.ids.poster)?.flow, "food", "the post state is cleared");
});

test("a banned poster gets a fixed refusal and nothing is posted", async () => {
  const w = world({ photoCount: 3 });
  updateUser(w.db, w.ids.poster, { bannedFromPosting: 1 });
  assert.deepEqual(await w.text("poster", "3 bowls of chipotle at leavey", PHOTO), FOOD_COPY.banned);
  assert.equal(w.drop(), undefined);
  assert.deepEqual(w.textsTo("a"), []);
  assert.equal(getFlowState(w.db, w.ids.poster), null);
});

test("a tapback claims one, the count drops, and with edits on the count bubble is edited silently", async () => {
  const w = world({ editOk: true });
  await w.post(3);
  const before = w.calls.filter((c) => c.method === "sendMessage").length;
  const out = await w.tap("a", w.claimBubble("a"));
  assert.deepEqual(out, ["it's yours, grab it in the next 15 min", "text 'got it' once u have it", "lmk if u want to talk to acm"]);
  assert.equal(w.drop().servingsLeft, 2);
  assert.deepEqual(w.claims(), [{ userId: w.ids.a, status: "held" }]);

  // Every alerted user's count bubble (their first one) was edited to the new line.
  const edits = w.edits();
  assert.equal(edits.length, 3);
  for (const who of ["a", "b", "g"] as const) {
    const e = edits.find((x) => x.chatId === `chat-${who}`)!;
    assert.equal(e.id, w.sentTo(who)[0].id);
    assert.equal(e.text, `${LEAD}, 2 left`);
  }
  // Silent: the only new texts are the claimer's confirmation.
  assert.equal(w.calls.filter((c) => c.method === "sendMessage").length, before + 3);

  // Switching the tapback from love to like is not a second claim.
  assert.deepEqual(await w.tap("a", w.claimBubble("a"), "like"), []);
  assert.equal(w.drop().servingsLeft, 2);

  // A tapback on any bubble of the alert counts, not only the last one.
  await w.tap("b", w.sentTo("b")[0].id, "like");
  assert.equal(w.drop().servingsLeft, 1);
  assert.equal(w.edits().at(-1)!.text, `${LEAD}, last one`);

  // Taking the tapback off gives it back.
  assert.deepEqual(await w.tap("a", w.claimBubble("a"), "love", true), [FOOD_COPY.released]);
  assert.equal(w.drop().servingsLeft, 2);
  assert.deepEqual(w.claims().map((c) => c.status), ["released", "held"]);
  assert.equal(w.edits().at(-1)!.text, `${LEAD}, 2 left`);
});

test("two claims racing for the last serving: exactly one winner and one 'all gone, sorry'", async () => {
  const w = world();
  await w.post(1);
  assert.equal(w.textsTo("a")[0], `${LEAD}, just 1 left`);
  await Promise.all([w.pipeline.handleEvent(w.event("a", { reaction: { targetMessageId: w.claimBubble("a"), type: "love", removed: false } })), w.pipeline.handleEvent(w.event("b", { reaction: { targetMessageId: w.claimBubble("b"), type: "like", removed: false } }))]);
  const replies = [w.textsTo("a").slice(3), w.textsTo("b").slice(3)];
  const winners = replies.filter((r) => r[0] === "it's yours, grab it in the next 15 min");
  const losers = replies.filter((r) => r.length === 1 && r[0] === FOOD_COPY.gone);
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(w.drop().servingsLeft, 0);
  assert.equal(w.claims().length, 1);
  assert.equal(w.edits().at(-1)!.text, `${LEAD}, all gone 😔`);

  // The pool can never go below zero, however many try.
  assert.equal(claimServing(w.db, 1, w.ids.g, Date.now()).result, "gone");
  assert.equal(w.drop().servingsLeft, 0);
});

test("edits off: new texts only at 'last one' and 'all gone', never for every change", async () => {
  const w = world({ editOk: false });
  w.make("k"); // a fourth subscriber who never claims
  await w.post(3);
  const news = (who: "a" | "b" | "g" | "k") => w.textsTo(who).slice(who === "a" || who === "b" ? 3 : 2);

  await w.tap("a", w.claimBubble("a")); // 3 -> 2
  assert.ok(w.edits().length >= 4, "the edit is still tried first");
  assert.deepEqual(news("b"), []);
  assert.deepEqual(news("g"), []);
  assert.deepEqual(news("k"), []);

  await w.tap("b", w.claimBubble("b")); // 2 -> 1
  assert.deepEqual(news("g"), ["last one at leavey"]);
  assert.deepEqual(news("k"), ["last one at leavey"]);
  assert.equal(news("a").length, 3, "someone holding one hears nothing more");
  assert.equal(news("b").length, 3, "the claimer only gets their confirmation");

  await w.tap("g", w.claimBubble("g")); // 1 -> 0
  assert.deepEqual(news("k"), ["last one at leavey", "all gone at leavey 😔"]);
  assert.equal(news("a").length, 3);
  assert.equal(news("g").length, 1 + 3);

  // Late tapback after it's gone.
  assert.deepEqual(await w.tap("k", w.claimBubble("k")), [FOOD_COPY.gone]);
  assert.equal(w.claims().length, 3);
});

test("no tapbacks: the alert says reply 'me', 'me' claims, 'got it' marks it picked up", async () => {
  const w = world({ caps: { tapbacks: false } });
  await w.post(2);
  assert.equal(w.textsTo("a").at(-1), "reply 'me' if u want one");
  assert.equal((await w.text("a", "me"))[0], "it's yours, grab it in the next 15 min");
  assert.deepEqual(await w.text("a", "me"), [FOOD_COPY.alreadyHeld]);
  assert.equal(w.drop().servingsLeft, 1);
  assert.deepEqual(await w.text("a", "got it"), [FOOD_COPY.pickedUp]);
  assert.deepEqual(w.claims(), [{ userId: w.ids.a, status: "picked_up" }]);
  assert.deepEqual(await w.text("a", "me"), [FOOD_COPY.alreadyGot], "one per person per drop");

  // A picked-up claim is not returned to the pool by the sweep.
  await sweepFood({ db: w.db, getAdapter: () => w.adapter }, Date.now() + 60 * 60_000);
  assert.equal(w.drop().servingsLeft, 1);

  // The last one picked up ends the drop.
  await w.text("b", "me");
  await w.text("b", "got it");
  assert.equal(w.drop().status, "ended");
  assert.deepEqual(await w.text("g", "me"), [FOOD_COPY.gone]);
});

test("a hold that isn't picked up goes back to the pool and the count updates again", async () => {
  const w = world({ editOk: true });
  await w.post(2);
  await w.tap("a", w.claimBubble("a"));
  assert.equal(w.drop().servingsLeft, 1);
  const deps = { db: w.db, getAdapter: () => w.adapter };

  assert.deepEqual(await sweepFood(deps, Date.now() + 14 * 60_000), { released: 0, ended: 0 });
  assert.equal(w.drop().servingsLeft, 1);

  const before = w.textsTo("a").length;
  assert.deepEqual(await sweepFood(deps, Date.now() + 16 * 60_000), { released: 1, ended: 0 });
  assert.equal(w.drop().servingsLeft, 2);
  assert.deepEqual(w.claims(), [{ userId: w.ids.a, status: "released" }]);
  assert.deepEqual(w.textsTo("a").slice(before), [FOOD_COPY.holdExpired]);
  assert.equal(w.edits().at(-1)!.text, `${LEAD}, 2 left`);
  // They can claim again afterwards.
  assert.equal((await w.text("a", "me"))[0], "it's yours, grab it in the next 15 min");

  // A drop nobody closes ends by itself.
  const res = await sweepFood(deps, Date.now() + 3 * 60 * 60_000);
  assert.equal(res.ended, 1);
  assert.equal(w.drop().status, "ended");
  assert.equal(w.edits().at(-1)!.text, `${LEAD}, all gone 😔`);

  const stop = startFoodTimers(deps);
  stop();
});

test("the poster's hold time is used for the claim", async () => {
  const w = world();
  await w.post(2, ", hold each one for 10 min");
  assert.equal(w.drop().holdMinutes, 10);
  const t0 = Date.now();
  assert.equal((await w.tap("a", w.claimBubble("a")))[0], "it's yours, grab it in the next 10 min");
  const claim = w.db.prepare("SELECT heldUntil FROM claims").get() as { heldUntil: number };
  assert.ok(Math.abs(claim.heldUntil - (t0 + 10 * 60_000)) < 5000);
});

test("poster corrections: '6 left' sets the count, 'we're out' ends the drop", async () => {
  const w = world({ editOk: true });
  await w.post(3);
  assert.deepEqual(await w.text("poster", "6 left"), ["updated, 6 left"]);
  assert.equal(w.drop().servingsLeft, 6);
  assert.equal(w.edits().at(-1)!.text, `${LEAD}, 6 left`);

  // Someone who isn't the poster can't change it.
  assert.deepEqual(await w.text("a", "2 left"), [FOOD_COPY.notYourCount]);
  assert.equal(w.drop().servingsLeft, 6);

  await w.tap("a", w.claimBubble("a"));
  const before = w.textsTo("a").length;
  assert.deepEqual(await w.text("poster", "we're out"), [FOOD_COPY.closed]);
  assert.equal(w.drop().status, "ended");
  assert.equal(w.drop().servingsLeft, 0);
  assert.equal(w.edits().at(-1)!.text, `${LEAD}, all gone 😔`);
  // The person still on their way is told once.
  assert.deepEqual(w.textsTo("a").slice(before), ["heads up, the chipotle at leavey just ran out. sorry"]);
  assert.deepEqual(await w.tap("b", w.claimBubble("b")), [FOOD_COPY.gone]);
  assert.deepEqual(await w.text("g", "me"), [FOOD_COPY.gone]);
});

test("'that was fake' from someone alerted adds one report and nothing else happens", async () => {
  const w = world();
  await w.post(3);
  assert.deepEqual(await w.text("a", "that was fake"), FOOD_COPY.reportThanks);
  assert.equal(w.drop().reports, 1);
  // The same person can't stack reports; a second person can add theirs.
  await w.pipeline.handleEvent(w.event("a", { text: "there was nothing there" }));
  assert.equal(w.drop().reports, 1);
  await w.text("b", "that was fake");
  assert.equal(w.drop().reports, 2);
  // Staff decide: the drop is still live and the poster is not banned.
  assert.equal(w.drop().status, "live");
  assert.equal(w.user("poster").bannedFromPosting, false);
  assert.equal(w.textsTo("poster").length, 2, "the poster hears nothing about it");
});

test("paused, stopped, unsubscribed, out-of-range and quiet-hours users get no alert and no count texts", async () => {
  const w = world({ editOk: false });
  await w.post(1);
  await w.tap("a", w.claimBubble("a"));
  for (const who of ["c", "d", "e", "f", "h"] as const) assert.deepEqual(w.textsTo(who), [], `${who} should get nothing`);
  assert.ok(!w.edits().some((e) => ["chat-c", "chat-d", "chat-e", "chat-f", "chat-h"].includes(e.chatId)));
  // Someone alerted who pauses afterwards gets no "all gone" text either.
  const w2 = world({ editOk: false });
  await w2.post(1);
  updateUser(w2.db, w2.ids.g, { paused: 1 });
  await w2.tap("a", w2.claimBubble("a"));
  assert.equal(w2.textsTo("g").length, 2);
  assert.deepEqual(w2.textsTo("b").slice(3), ["all gone at leavey 😔"]);
});

test("an unrelated text after an alert goes to smalltalk and 'me' still works afterwards", async () => {
  const w = world();
  await w.post(2);
  const out = await w.text("a", "lol thanks troy");
  assert.ok(out.length >= 1);
  assert.equal(w.claims().length, 0);
  assert.equal((await w.text("a", "me"))[0], "it's yours, grab it in the next 15 min");
  // nvm gives it back.
  assert.deepEqual(await w.text("a", "nvm"), [FOOD_COPY.released]);
  assert.equal(w.drop().servingsLeft, 2);
});

test("talking to the poster takes a yes from both, then relay mode starts", async () => {
  const w = world();
  await w.post(2);
  await w.tap("a", w.claimBubble("a"));
  assert.deepEqual(await w.text("a", "can i talk to them"), [FOOD_COPY.relayOffer]);
  const posterBefore = w.textsTo("poster").length;
  assert.deepEqual(await w.text("a", "yes"), FOOD_COPY.relayAsking);
  assert.deepEqual(w.textsTo("poster").slice(posterBefore), ["someone who claimed ur chipotle wants to talk", FOOD_COPY.relayAskPoster]);
  assert.equal(w.relays.length, 0, "nothing opens until the poster agrees");

  const aBefore = w.textsTo("a").length;
  assert.deepEqual(await w.text("poster", "yes"), RELAY_COPY.start);
  assert.deepEqual(w.relays, [{ a: w.ids.a, b: w.ids.poster, context: "food:1" }]);
  assert.deepEqual(w.textsTo("a").slice(aBefore), ["they said yes", ...RELAY_COPY.start]);
  assert.equal(getFlowState(w.db, w.ids.poster), null);
  assert.equal(getFlowState(w.db, w.ids.a), null);
});

test("the poster can say no, and a no_contact poster is never asked", async () => {
  const w = world();
  await w.post(2);
  await w.tap("a", w.claimBubble("a"));
  await w.text("a", "can i talk to acm");
  await w.text("a", "yes");
  const aBefore = w.textsTo("a").length;
  assert.deepEqual(await w.text("poster", "no"), [FOOD_COPY.relayDeclinedPoster]);
  assert.deepEqual(w.textsTo("a").slice(aBefore), [FOOD_COPY.relayDeclined]);
  assert.equal(w.relays.length, 0);
  assert.equal(getFlowState(w.db, w.ids.a)?.step, "claimed");

  updateUser(w.db, w.ids.poster, { contactMode: "no_contact" });
  await w.text("a", "can i talk to them");
  const posterBefore = w.textsTo("poster").length;
  assert.deepEqual(await w.text("a", "yes"), [FOOD_COPY.relayNotAvailable]);
  assert.equal(w.textsTo("poster").length, posterBefore);
});

test("free stuff is posted the same way and goes to free_stuff subscribers", async () => {
  const w = world();
  updateUser(w.db, w.ids.g, { subscriptions: JSON.stringify(["free_stuff"]) });
  const intent = (): Intent => ({ flow: "food", action: "post_food", details: {}, source: "ai" });
  const w2 = world({ intent });
  updateUser(w2.db, w2.ids.g, { subscriptions: JSON.stringify(["free_stuff"]) });
  const out = await w2.text("poster", "10 hoodies from acm at tcc");
  assert.equal(out[0], "posted. i texted 1 person nearby");
  assert.deepEqual(w2.textsTo("g"), ["yo acm is giving away free hoodies at tcc, about 10 left", "react if u want one"]);
  assert.deepEqual(w2.textsTo("a"), []);
  w.db.close();
});

test("asking where to get free clothes points to usg thrift with only what the directory row says", async () => {
  const w = world({ intent: () => ({ flow: "food", action: "status", details: {}, source: "ai" }) });
  const thrift = DIRECTORY.find((d) => d.name === "USG thrift")!;
  w.db.prepare("INSERT INTO directory (kind, name, topics, contactMethod, url, details, isExample) VALUES (?, ?, ?, ?, ?, ?, ?)").run(thrift.kind, thrift.name, JSON.stringify(thrift.topics), thrift.contactMethod, thrift.url, thrift.details, thrift.isExample ? 1 : 0);
  const out = await w.text("a", "where can i get free clothes?");
  assert.equal(out[0], "usg thrift is the one for that");
  assert.ok(out.includes(thrift.details!));
  if (!thrift.url) assert.ok(!out.join(" ").includes("http"), "no link is made up");
  else assert.ok(out.includes(thrift.url));
  for (const line of out) assert.equal(line.replace(thrift.contactMethod ?? "", ""), line.replace(thrift.contactMethod ?? "", "").toLowerCase());

  // With no row at all, Troy says to check with usg instead of guessing.
  const w2 = world({ intent: () => ({ flow: "food", action: "status", details: {}, source: "ai" }) });
  assert.deepEqual(await w2.text("a", "is there a thrift on campus?"), [`not sure on that one. ${FOOD_COPY.checkUsg}`]);
});

test("the poster's count is what is on the table: held servings come off it, so it can't oversell or go above the total", async () => {
  const w = world();
  w.make("k");
  await w.post(3);
  await w.text("a", "me");
  await w.text("b", "me");
  assert.equal(w.drop().servingsLeft, 1);
  // Three bowls still on the table, two of them spoken for.
  assert.deepEqual(await w.text("poster", "3 left"), ["updated. 2 of those are already claimed, so last one for everyone else"]);
  assert.equal(w.drop().servingsLeft, 1);
  assert.equal((await w.text("g", "me"))[0], "it's yours, grab it in the next 15 min");
  assert.deepEqual(await w.text("k", "me"), [FOOD_COPY.gone]);
  assert.equal(w.claims().filter((c) => c.status === "held").length, 3, "three bowls, three holds");

  const v = world();
  await v.post(3);
  await v.text("a", "me");
  await v.text("poster", "3 left");
  assert.deepEqual(await v.text("a", "nvm"), [FOOD_COPY.released]);
  assert.equal(v.drop().servingsLeft, 3);
  assert.ok((v.drop().servingsLeft as number) <= (v.drop().servingsTotal as number));
});

test("edits off: one person toggling a tapback on the last serving texts everyone once per milestone, not once per toggle", async () => {
  const w = world({ editOk: false });
  await w.post(1);
  const news = (who: "b" | "g") => w.textsTo(who).slice(who === "b" ? 3 : 2);
  for (let i = 0; i < 4; i++) {
    await w.tap("a", w.claimBubble("a"));
    await w.tap("a", w.claimBubble("a"), "love", true);
  }
  assert.deepEqual(news("b"), ["all gone at leavey 😔"]);
  assert.deepEqual(news("g"), ["all gone at leavey 😔"]);
  // And the toggling itself stops counting after a couple of rounds.
  assert.equal(w.claims().length, 2);
  assert.deepEqual(await w.text("a", "me"), [FOOD_COPY.tooManyGrabs]);
  assert.equal(w.drop().servingsLeft, 1);
});

test("backing out of a post is understood however it's said: nothing is published and nobody is texted", async () => {
  for (const [step, said] of [
    ["post_club", "actually nvm"],
    ["post_club", "wait no dont post it"],
    ["post_club", "nvm sorry"],
    ["post_club", "cancel pls"],
    ["post_spot", "nvm sorry"],
    ["post_spot", "actually never mind"],
  ] as const) {
    const w = world();
    if (step === "post_club") await w.text("poster", "3 bowls of chipotle at leavey");
    else {
      await w.text("poster", "free pizza come grab some");
      await w.text("poster", "like 8");
    }
    assert.equal(getFlowState(w.db, w.ids.poster)?.step, step);
    assert.deepEqual(await w.text("poster", said), [FOOD_COPY.dropped], said);
    assert.equal(w.drop(), undefined, said);
    assert.deepEqual(w.textsTo("a"), [], said);
    assert.equal(getFlowState(w.db, w.ids.poster), null);
  }
  // A club name is still a club name, and "skip" still posts.
  const w = world();
  await w.text("poster", "3 bowls of chipotle at leavey");
  await w.text("poster", "acm");
  assert.equal(w.drop().clubName, "acm");
});

test("a food relay doesn't swallow the poster's 'we're out', a second ask, or a new report, and ends with the drop", async () => {
  const w = world();
  setFoodDeps({ startRelay });
  w.make("k");
  await w.post(5);
  await w.tap("a", w.claimBubble("a"));
  await w.text("a", "can i talk to them");
  await w.text("a", "yes");
  await w.text("poster", "yes");
  assert.ok(activeRelayFor(w.db, w.ids.poster));

  // Ordinary texts are still passed along.
  const aBefore = w.textsTo("a").length;
  await w.text("poster", "im by the stairs");
  assert.deepEqual(w.textsTo("a").slice(aBefore), ["from the poster: im by the stairs"]);

  // A new report from the claimer is theirs, not a message for the poster.
  const posterBefore = w.textsTo("poster").length;
  await w.text("a", "found a wallet at tcc");
  assert.ok(!w.textsTo("poster").slice(posterBefore).some((t) => t.includes("wallet")));

  // The poster ending the drop is a count update: the drop closes, and so does the chat.
  assert.equal((await w.text("poster", "we're out"))[0], FOOD_COPY.closed);
  assert.equal(w.drop().status, "ended");
  assert.equal(activeRelayFor(w.db, w.ids.poster), null);
  assert.ok(w.textsTo("a").includes(FOOD_COPY.relayOver));
  assert.ok(!w.textsTo("a").some((t) => t.includes("from the poster: we're out")));
  assert.deepEqual(await w.text("b", "me"), [FOOD_COPY.gone]);
});

test("voice: every food bubble is lowercase, has no em dash and at most one emoji", async () => {
  const w = world({ editOk: false, photoCount: 3 });
  w.make("k");
  await w.text("poster", "3 bowls of chipotle at leavey", PHOTO);
  await w.text("poster", "yes");
  await w.text("poster", "acm");
  await w.tap("a", w.claimBubble("a"));
  await w.tap("b", w.claimBubble("b"));
  await w.text("a", "can i talk to them");
  await w.text("a", "nvm");
  await w.text("a", "got it");
  await w.text("g", "that was fake");
  await w.text("poster", "we're out");
  await w.tap("k", w.claimBubble("k"));
  const all = w.calls.map((c) => c.text);
  assert.ok(all.length > 20);
  for (const t of all) {
    assert.equal(t.replace(/HUMAN/g, ""), t.replace(/HUMAN/g, "").toLowerCase(), t);
    assert.ok(!/[—–]/.test(t), t);
    assert.ok((t.match(/\p{Extended_Pictographic}/gu) ?? []).length <= 1, t);
    assert.ok(t.length <= 160, t);
  }
});

// ---------- last known location ----------

const savedRow = (w: ReturnType<typeof world>, who: Who) => ({
  ...(w.db.prepare("SELECT lastLat, lastLng, lastLocationAt, lastLocationSource FROM users WHERE id = ?").get(w.ids[who]) as { lastLat: number | null; lastLng: number | null; lastLocationAt: number | null; lastLocationSource: string | null }),
});

test("walking-time wording: fresh says from u, stale says from where u last shared, a usual spot is named", () => {
  assert.equal(walkLine(8), "it's about an 8 min walk from u");
  assert.equal(walkLine(8, { kind: "fresh" }), "it's about an 8 min walk from u");
  assert.equal(walkLine(8, { kind: "stale" }), "it's about an 8 min walk from where u last shared");
  assert.equal(walkLine(6, { kind: "spot", name: "tcc" }), "it's about a 6 min walk from tcc");
});

test("a saved fix is used for the alert: fresh at exactly 3 hours, stale one ms later", async () => {
  const now = Date.now();
  for (const [age, line] of [
    [60_000, "it's about an 8 min walk from u"],
    [LOCATION_STALE_MS, "it's about an 8 min walk from u"],
    [LOCATION_STALE_MS + 1, "it's about an 8 min walk from where u last shared"],
    [26 * 60 * 60 * 1000, "it's about an 8 min walk from where u last shared"],
  ] as const) {
    const w = world({ photoCount: null });
    setFoodDeps({ now: () => now });
    // k has no usual spots and shares nothing live: only the saved fix.
    w.make("k");
    saveUserLocation(w.db, w.ids.k, { lat: VILLAGE.lat, lng: VILLAGE.lng }, "pin", now - age);
    await w.post(3);
    assert.deepEqual(w.textsTo("k"), [`${LEAD}, about 3 bowls left`, line, "react if u want one"], `age ${age}`);
    assert.equal(savedRow(w, "k").lastLocationAt, now - age, "reading a fix never refreshes its time");
  }
});

test("a saved fix beats usual spots, and decides who is in range", async () => {
  const now = Date.now();
  const w = world({ photoCount: null });
  setFoodDeps({ now: () => now });
  // a's usual spot is tcc (6 min), but they last shared from the village (8 min).
  saveUserLocation(w.db, w.ids.a, { lat: VILLAGE.lat, lng: VILLAGE.lng }, "find_my", now - 60_000);
  // c's usual spot (parkside) is out of their 5 min range, but they told troy they're at leavey.
  saveUserLocation(w.db, w.ids.c, { lat: LEAVEY.lat, lng: LEAVEY.lng }, "asked", now - 60_000);
  // k is usually at leavey but last shared from far away, hours ago: the stale fix still decides, so they're skipped.
  w.make("k", { usualSpots: JSON.stringify(["leavey"]), alertMinutes: 5 });
  saveUserLocation(w.db, w.ids.k, { lat: 34.0407, lng: -118.2468 }, "pin", now - 5 * 60 * 60 * 1000);
  await w.post(3);
  assert.equal(w.textsTo("a")[1], "it's about an 8 min walk from u");
  assert.deepEqual(w.textsTo("c"), [`${LEAD}, about 3 bowls left`, "it's about a 1 min walk from u", "react if u want one"]);
  assert.deepEqual(w.textsTo("k"), [], "outside their alert distance by the best available location");
  // g has no location at all: still alerted, no walking bubble.
  assert.deepEqual(w.textsTo("g"), [`${LEAD}, about 3 bowls left`, "react if u want one"]);
});

test("a live find my fix is saved; an older one never replaces a newer saved fix", async () => {
  const now = Date.now();
  const w = world({ photoCount: null });
  setFoodDeps({ now: () => now });
  // b's live fix (set in world) is fresh: saved as find_my.
  // a told troy where they are a minute ago, and Find My only has a 2 hour old fix: the newer one stays.
  saveUserLocation(w.db, w.ids.a, { lat: LEAVEY.lat, lng: LEAVEY.lng }, "asked", now - 60_000);
  w.live.set(w.handles.a, { lat: VILLAGE.lat, lng: VILLAGE.lng, at: now - 2 * 60 * 60 * 1000 });
  // k's only fix is a 4 hour old live one: saved, used, and worded as stale.
  w.make("k");
  w.live.set(w.handles.k, { lat: VILLAGE.lat, lng: VILLAGE.lng, at: now - 4 * 60 * 60 * 1000 });
  const got = await findRecipients(w.db, w.adapter, { posterUserId: w.ids.poster, lat: LEAVEY.lat, lng: LEAVEY.lng }, "food", now);
  const by = (who: Who) => got.find((r) => r.user.id === w.ids[who])!;
  assert.deepEqual([by("b").minutes, by("b").from], [8, { kind: "fresh" }]);
  assert.equal(savedRow(w, "b").lastLocationSource, "find_my");
  assert.deepEqual([by("a").minutes, by("a").from], [1, { kind: "fresh" }]);
  assert.deepEqual(savedRow(w, "a"), { lastLat: LEAVEY.lat, lastLng: LEAVEY.lng, lastLocationAt: now - 60_000, lastLocationSource: "asked" });
  assert.deepEqual([by("k").minutes, by("k").from], [8, { kind: "stale" }]);
  assert.deepEqual(savedRow(w, "k"), { lastLat: VILLAGE.lat, lastLng: VILLAGE.lng, lastLocationAt: now - 4 * 60 * 60 * 1000, lastLocationSource: "find_my" });
  // People who are not alerted are never looked up, so nothing is saved for them.
  w.live.set(w.handles.f, { lat: VILLAGE.lat, lng: VILLAGE.lng, at: now });
  await findRecipients(w.db, w.adapter, { posterUserId: w.ids.poster, lat: LEAVEY.lat, lng: LEAVEY.lng }, "food", now);
  assert.equal(savedRow(w, "f").lastLat, null);
});

test("no text to anyone else ever carries a location: only the alert, a walking time, and the claim line", async () => {
  const now = Date.now();
  const w = world({ photoCount: null });
  setFoodDeps({ now: () => now });
  saveUserLocation(w.db, w.ids.g, { lat: 34.0251234, lng: -118.2812345 }, "pin", now - 60_000);
  await w.post(3);
  await w.tap("a", w.claimBubble("a"));
  await w.text("poster", "we're out");
  const everything = w.calls.map((c) => c.text).join("\n");
  for (const secret of ["34.02", "118.28", String(VILLAGE.lat), String(VILLAGE.lng), "lastLat", "village"]) assert.ok(!everything.includes(secret), `leaked ${secret}`);
  // What the poster hears is a head count, never who or where.
  assert.ok(w.textsTo("poster").every((t) => !/walk|near (?!by)|where u/.test(t)), w.textsTo("poster").join(" | "));
});

// ---------- facts locked, wording varied ----------

/** Always the last variant of a pool, so every pooled line goes out in words other than its first wording. */
const lastVariant: VariantPicker = (_db, _userId, _key, variants) => variants[variants.length - 1]!;
const numbersIn = (t: string): string => (t.match(/\d+/g) ?? []).join(",");
/** Every bubble is one of its line's own variants, and carries exactly the numbers its first wording carries. */
function assertSameFacts(voice: Voice, sent: { text: string; raw: string }[]): void {
  for (const b of sent) {
    assert.ok(voice.variantsOf(b.text).includes(b.raw), `not a known variant: ${b.raw}`);
    assert.equal(numbersIn(b.raw), numbersIn(b.text), b.raw);
  }
}

test("food wording pools are well formed, and the alert bubble, the ban and relay copy have no variants", () => {
  assert.deepEqual(poolProblems(FOOD_POOLS), []);
  for (const line of [`${LEAD}, about 6 bowls left`, `${LEAD}, 2 left`, `${LEAD}, last one`, `${LEAD}, all gone 😔`, ...FOOD_COPY.banned, ...RELAY_COPY.start]) {
    assert.deepEqual(FOOD_VOICE.variantsOf(line), [line]);
  }
  // Every wording of a line carries the same count, time and place.
  for (const v of FOOD_VOICE.variantsOf(walkLine(8, { kind: "spot", name: "tcc" }))) assert.match(v, /\ban 8 min walk from tcc$/);
  for (const v of FOOD_VOICE.variantsOf("it's yours, grab it in the next 15 min")) assert.match(v, /\b15 min\b/);
  for (const v of FOOD_VOICE.variantsOf("posted. i texted 3 people nearby")) assert.match(v, /\bi texted 3 people nearby$/);
  for (const v of FOOD_VOICE.variantsOf("all gone at leavey 😔")) assert.match(v, /at leavey 😔$/);
});

test("food: with other wording on every line, counts, walking times, hold time and places are exactly the same", async () => {
  setVariantPicker(lastVariant);
  try {
    const w = world();
    const done = await w.post(6);
    assert.deepEqual(done, ["posted. i texted 3 people nearby", "text me how many are left anytime, or 'we're out' when it's done"]);
    const alert = w.sentTo("a");
    // The count bubble is the one that gets edited: it is never reworded.
    assert.equal(alert[0].raw, `${LEAD}, about 6 bowls left`);
    assert.equal(alert[1].text, walkLine(6, { kind: "spot", name: "tcc" }));
    assert.notEqual(alert[1].raw, alert[1].text);
    assert.match(alert[1].raw, /\ba 6 min walk from tcc$/);
    const claimed = await w.text("a", "me");
    assert.equal(claimed[0], "it's yours, grab it in the next 15 min");
    assert.equal(w.drop().servingsLeft, 5);
    assert.deepEqual(await w.text("a", "got it"), [FOOD_COPY.pickedUp]);
    assert.deepEqual(await w.text("poster", "2 left"), ["updated, 2 left"]);
    const all = w.calls.filter((c) => c.method === "sendMessage");
    assertSameFacts(FOOD_VOICE, all);
    assert.ok(all.filter((c) => c.raw !== c.text).length >= 6, "the wording really did change");
    // One emoji at most in any bubble, whatever the wording.
    for (const c of all) assert.ok((c.raw.match(/\p{Extended_Pictographic}/gu) ?? []).length <= 1, c.raw);
  } finally {
    setVariantPicker(null);
  }
});
