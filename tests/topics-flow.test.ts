import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AdapterCapabilities, IncomingEvent, Intent, MessagingAdapter, TapbackType } from "../src/types.ts";
import { openDb, getOrCreateUser, getUserById, updateUser, getFlowState } from "../src/db/index.ts";
import { createPipeline } from "../src/pipeline.ts";
import { registerFlow } from "../src/flows/index.ts";
import { setModelCall } from "../src/ai.ts";
import { laMinutes } from "../src/quiet.ts";
import { RELAY_COPY, activeRelayFor } from "../src/relay.ts";
import { FOOD_COPY, FOOD_VOICE, food } from "../src/flows/food.ts";
import type { Brief } from "../src/flows/topics.ts";
import { MAX_ALERTS_PER_HOUR, MAX_POSTS_PER_HOUR, POST_TTL_MS, REPORTS_TO_HIDE, getPost, redactContacts, setTopicsDeps, suggestedName, topics, whenIn } from "../src/flows/topics.ts";
import { BUILT_IN_TOPICS, listTopics, openTopicRequests, topicByKey, topicsFor } from "../src/topics.ts";

registerFlow(food);
registerFlow(topics);
// Nothing in this file may reach the network.
setModelCall(async () => {
  throw new Error("off");
});

const PLACES = JSON.parse(readFileSync(join(import.meta.dirname, "../src/db/seed-data/campus_places.json"), "utf8")) as { name: string; nicknames: string[]; lat: number; lng: number; kind: string }[];

type Who = "poster" | "near" | "far" | "other" | "nowhere" | "paused" | "stopped" | "quiet" | "extra";
const hhmm = (mins: number) => {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/**
 * The real pipeline over an in-memory database and a fake adapter. The intent is injected (routing is another
 * file's job): everything goes to the topics flow unless a test says otherwise. Wording is injected too: every
 * brief Troy was asked to say is recorded, and its first fallback reply is what goes out.
 */
function world(opts: { caps?: Partial<AdapterCapabilities>; intent?: (text: string) => Partial<Intent> | null; verdict?: (name: string) => "ok" | "unsure" | "no"; modelDown?: boolean } = {}) {
  const db: DatabaseSync = openDb(":memory:");
  const addPlace = db.prepare("INSERT INTO campus_places (name, nicknames, lat, lng, kind) VALUES (?, ?, ?, ?, ?)");
  for (const p of PLACES) addPlace.run(p.name, JSON.stringify(p.nicknames), p.lat, p.lng, p.kind);

  const calls: { chatId: string; text: string; id: string }[] = [];
  let n = 0;
  const adapter: MessagingAdapter = {
    provider: "webchat",
    capabilities: () => ({ tapbacks: true, typing: true, readReceipts: true, edits: false, effects: true, polls: false, groupChats: false, contactCard: true, liveLocation: false, ...opts.caps }),
    async sendMessage(chatId, text) {
      const id = `out-${++n}`;
      calls.push({ chatId, text, id });
      return { messageId: id };
    },
    sendImage: async () => null,
    sendContactCard: async () => null,
    async markRead() {},
    async startTyping() {},
    async stopTyping() {},
    react: async () => true,
    editMessage: async () => false,
    sendPoll: async (_c, _q, options) => ({ optionMessageIds: options.map(() => null), mode: "tap" }),
    createGroupChat: async () => null,
    getLiveLocation: async () => null,
    requestLocation: async () => false,
    chatIdForHandle: (h) => `chat-${h}`,
  };

  const briefs: Brief[] = [];
  const judged: string[] = [];
  const clock = { now: Date.now() };
  setTopicsDeps(null);
  setTopicsDeps({
    sayInHisWords: async (_ctx, brief) => {
      briefs.push(brief);
      // Model down: the brain has nothing, so the flow rotates through the brief's fallback replies itself.
      return opts.modelDown ? [] : brief.fallback[0]!;
    },
    judgeTopic: async (name) => {
      judged.push(name);
      return opts.verdict?.(name) ?? "unsure";
    },
    now: () => clock.now,
  });

  const pipeline = createPipeline({
    db,
    getAdapter: () => adapter,
    pause: async () => {},
    ackAfterMs: 60_000,
    detectIntent: async (input) => ({ flow: "topics", action: "", details: {}, source: "fallback", ...(opts.intent?.(input.text) ?? {}) }) as Intent,
  });

  const names: Who[] = ["poster", "near", "far", "other", "nowhere", "paused", "stopped", "quiet", "extra"];
  const handles = Object.fromEntries(names.map((w, i) => [w, `+1213555030${i}`])) as Record<Who, string>;
  const ids = {} as Record<Who, number>;
  const make = (who: Who, fields: Record<string, string | number | null> = {}) => {
    const u = getOrCreateUser(db, handles[who], `chat-${who}`);
    updateUser(db, u.id, { verifiedAt: Date.now(), verifiedVia: "usc_email", subscriptions: JSON.stringify(["pickup"]), ...fields });
    ids[who] = u.id;
  };
  const nowMins = laMinutes();
  make("poster", { subscriptions: "[]" });
  make("near", { usualSpots: JSON.stringify(["village gym"]) }); // a short walk from lyon
  make("far", { usualSpots: JSON.stringify(["parkside"]), alertMinutes: 5 }); // too far for their own limit
  make("other", { subscriptions: JSON.stringify(["tickets"]), usualSpots: JSON.stringify(["lyon"]) }); // follows a different topic
  make("nowhere"); // no location at all: still told, with no walking time
  make("paused", { paused: 1, usualSpots: JSON.stringify(["lyon"]) });
  make("stopped", { stopped: 1, usualSpots: JSON.stringify(["lyon"]) });
  make("quiet", { usualSpots: JSON.stringify(["lyon"]), quietHours: JSON.stringify({ start: hhmm(nowMins - 60), end: hhmm(nowMins + 60) }) });

  let m = 0;
  const event = (who: Who, over: Partial<IncomingEvent>): IncomingEvent => ({ provider: "webchat", userHandle: handles[who], chatId: `chat-${who}`, isGroup: false, messageId: `in-${++m}`, text: "", images: [], receivedAt: Date.now(), ...over });
  const sentTo = (who: Who) => calls.filter((c) => c.chatId === `chat-${who}`);
  const textsTo = (who: Who) => sentTo(who).map((c) => c.text);
  const text = async (who: Who, t: string) => {
    const before = textsTo(who).length;
    await pipeline.handleEvent(event(who, { text: t }));
    return textsTo(who).slice(before);
  };
  const tap = async (who: Who, targetMessageId: string, type: TapbackType = "like") => {
    const before = textsTo(who).length;
    await pipeline.handleEvent(event(who, { reaction: { targetMessageId, type, removed: false } }));
    return textsTo(who).slice(before);
  };
  const subs = (who: Who) => getUserById(db, ids[who])!.subscriptions;
  const posts = () => db.prepare("SELECT * FROM topic_posts ORDER BY id").all() as Record<string, unknown>[];
  const lastBrief = () => briefs[briefs.length - 1]!;
  return { db, adapter, calls, pipeline, ids, handles, make, sentTo, textsTo, text, tap, subs, posts, briefs, lastBrief, judged, clock };
}

const GAME = "anyone want to play pickup at lyon at 6";
const LABELS = BUILT_IN_TOPICS.map((t) => t.label);
/** Nothing Troy says may break the voice rules, whoever wrote the words. */
function voiceOk(lines: string[]): void {
  for (const line of lines) {
    assert.ok(!/—|–/.test(line), `no dashes: ${line}`);
    assert.ok(!/\byou\b|\byour\b|\byou're\b/i.test(line.replace(/"[^"]*"/g, "")), `u and ur: ${line}`);
    assert.equal(line.replace(/"[^"]*"/g, ""), line.replace(/"[^"]*"/g, "").toLowerCase(), `lowercase: ${line}`);
    assert.ok((line.match(/\p{Extended_Pictographic}/gu) ?? []).length <= 1, `one emoji at most: ${line}`);
  }
}

test("a post to a topic goes only to followers who are near enough, awake and reachable", async () => {
  const w = world();
  const out = await w.text("poster", GAME);

  // The poster hears it back in Troy's words: what, where, when, and how many people were texted.
  assert.equal(out.length, 2);
  assert.match(out[0]!, /pickup game at lyon at 6/);
  assert.match(out[1]!, /2 people/);
  voiceOk(out);
  const brief = w.lastBrief();
  assert.deepEqual(brief.facts, { told: "2 people", where: "lyon", when: "at 6" });
  assert.ok(brief.mustCover.some((c) => c.includes("how many")));

  // Near enough: the poster's words, a walking time from the alert engine, and how to join.
  const near = w.textsTo("near");
  assert.equal(near.length, 3);
  assert.ok(near[0]!.includes(`"${GAME}"`));
  assert.match(FOOD_VOICE.canonical(near[1]!), /^it's about an? \d+ min walk from village gym$/);
  assert.match(near[2]!, /react/);
  voiceOk(near);
  // No location at all: still told, without a walking time.
  assert.equal(w.textsTo("nowhere").length, 2);
  assert.ok(w.textsTo("nowhere")[0]!.includes(`"${GAME}"`));

  for (const who of ["far", "other", "paused", "stopped", "quiet"] as const) assert.deepEqual(w.textsTo(who), [], who);

  const post = w.posts()[0]!;
  assert.equal(post.topicId, topicByKey(w.db, "pickup")!.id);
  assert.equal(post.posterUserId, w.ids.poster);
  assert.equal(post.locationText, "lyon");
  assert.equal(post.status, "live");
  assert.equal(getFlowState(w.db, w.ids.poster), null);
  assert.equal(getFlowState(w.db, w.ids.near)?.step, "alerted");
  w.db.close();
});

test("quiet hours hold the alert back, and it is not sent later", async () => {
  const w = world();
  await w.text("poster", GAME);
  assert.deepEqual(w.textsTo("quiet"), []);
  assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM topic_alert_bubbles WHERE userId = ?").get(w.ids.quiet)!.n, 0);
  assert.equal(getFlowState(w.db, w.ids.quiet), null);
  await w.pipeline.sweep();
  assert.deepEqual(w.textsTo("quiet"), []);
  w.db.close();
});

test("a post with no place gets one question, a question back gets answered, and then it goes out", async () => {
  const w = world();
  const asked = await w.text("poster", "anyone want to play pickup rn");
  assert.equal(asked.length, 1);
  assert.equal(w.posts().length, 0);
  assert.equal(getFlowState(w.db, w.ids.poster)?.step, "post_place");
  assert.deepEqual(w.textsTo("near"), []);

  // Not a format error: he answers, and the step stays open.
  const why = await w.text("poster", "why do u need that?");
  assert.equal(why.length, 1);
  assert.notEqual(why[0], asked[0]);
  assert.equal(getFlowState(w.db, w.ids.poster)?.step, "post_place");
  assert.equal(w.posts().length, 0);

  const out = await w.text("poster", "the lyon center");
  assert.match(out[0]!, /lyon/);
  assert.equal(w.posts().length, 1);
  assert.equal(w.textsTo("near").length, 3);

  // A topic that doesn't need a place never asks for one.
  const w2 = world();
  updateUser(w2.db, w2.ids.near, { subscriptions: JSON.stringify(["tickets"]) });
  const out2 = await w2.text("poster", "extra ticket for saturday");
  assert.equal(w2.posts().length, 1);
  assert.match(out2[0]!, /extra ticket on saturday/);
  assert.equal(w2.textsTo("near").length, 2, "no coordinates, so no walking time");
  assert.equal(w2.textsTo("other").length, 2);
  assert.deepEqual(w2.textsTo("nowhere"), [], "pickup followers don't get ticket posts");

  // "nvm" at the question drops it.
  const w3 = world();
  await w3.text("poster", "anyone want to play pickup");
  await w3.text("poster", "actually nvm");
  assert.equal(w3.posts().length, 0);
  assert.equal(getFlowState(w3.db, w3.ids.poster), null);
  w.db.close();
  w2.db.close();
  w3.db.close();
});

test("a banned poster gets the fixed ban lines and nothing goes out; unsafe posts are declined", async () => {
  const w = world();
  updateUser(w.db, w.ids.poster, { bannedFromPosting: 1 });
  assert.deepEqual(await w.text("poster", GAME), FOOD_COPY.banned);
  assert.equal(w.posts().length, 0);
  assert.deepEqual(w.textsTo("near"), []);
  assert.equal(w.briefs.length, 0, "the ban is code and fixed copy, never the model's words");

  updateUser(w.db, w.ids.poster, { bannedFromPosting: 0 });
  const no = await w.text("poster", "anyone want to buy weed, pickup at lyon");
  assert.equal(no.length, 1);
  assert.match(no[0]!, /sorry/);
  assert.equal(w.posts().length, 0);
  assert.deepEqual(w.textsTo("near"), []);
  w.db.close();
});

test("contact details never go out in a post", async () => {
  assert.equal(redactContacts("extra ticket for saturday, text me 213-555-0142 or @jake.m"), "extra ticket for saturday");
  assert.equal(redactContacts('selling "two" tickets jake@usc.edu https://x.co/a'), "selling 'two' tickets");
  const w = world();
  updateUser(w.db, w.ids.near, { subscriptions: JSON.stringify(["tickets"]) });
  await w.text("poster", "extra ticket for saturday hmu at (213) 555-0142");
  const alert = w.textsTo("near")[0]!;
  assert.ok(alert.includes("extra ticket for saturday"));
  assert.ok(!/\d{3}.?\d{4}/.test(alert));
  assert.ok(!/555/.test(String(w.posts()[0]!.text)));
  w.db.close();
});

test("a reply to an alert connects the two through relay, with a yes on both sides", async () => {
  const w = world();
  await w.text("poster", GAME);
  const posterBefore = w.textsTo("poster").length;

  const joined = await w.text("near", "i'm in");
  assert.equal(joined.length, 2);
  assert.match(joined.join(" "), /no numbers shared/);
  assert.equal(activeRelayFor(w.db, w.ids.near), null, "nothing is connected until the poster agrees");
  const ask = w.textsTo("poster").slice(posterBefore);
  assert.equal(ask.length, 2);
  assert.match(ask[0]!, /pickup game/);
  assert.match(ask[1]!, /no numbers shared/);
  voiceOk([...joined, ...ask]);
  assert.equal(getFlowState(w.db, w.ids.poster)?.step, "join_ask");
  // Saying it twice doesn't ask the poster twice.
  await w.text("near", "im in");
  assert.equal(w.textsTo("poster").length, posterBefore + 2);

  const yes = await w.text("poster", "yes");
  assert.deepEqual(yes, RELAY_COPY.start);
  assert.deepEqual(w.textsTo("near").slice(-2), RELAY_COPY.start);
  const relay = activeRelayFor(w.db, w.ids.near)!;
  assert.equal(relay.otherUserId, w.ids.poster);
  assert.equal(relay.context, "topic:1");

  // From here their texts go to each other, by role, never by name or number.
  await w.text("near", "which court?");
  assert.equal(w.textsTo("poster").at(-1), "from the person who's in: which court?");
  await w.text("poster", "the far one");
  assert.equal(w.textsTo("near").at(-1), "from the poster: the far one");
  for (const line of [...w.textsTo("near"), ...w.textsTo("poster")]) assert.ok(!line.includes("+1213"), "no numbers");

  // A second person who taps the alert: the poster just hears one more is in.
  const alertId = w.sentTo("nowhere")[0]!.id;
  const tapped = await w.tap("nowhere", alertId, "like");
  assert.equal(tapped.length, 1);
  assert.match(w.textsTo("poster").at(-1)!, /pickup game/);
  assert.equal(activeRelayFor(w.db, w.ids.poster)!.otherUserId, w.ids.near);
  w.db.close();
});

test("a thumbs up on the alert joins, a thumbs up on the poster's question is their yes, and a no connects nobody", async () => {
  const w = world();
  await w.text("poster", GAME);
  const joinBubble = w.sentTo("near").at(-1)!.id;
  const out = await w.tap("near", joinBubble, "love");
  assert.equal(out.length, 2);
  const askId = w.sentTo("poster").at(-1)!.id;
  // A tapback on some other bubble of Troy's is not an answer.
  await w.tap("poster", w.sentTo("poster")[0]!.id, "like");
  assert.equal(activeRelayFor(w.db, w.ids.poster), null);
  assert.deepEqual(await w.tap("poster", askId, "like"), RELAY_COPY.start);
  assert.ok(activeRelayFor(w.db, w.ids.near));

  const w2 = world();
  await w2.text("poster", GAME);
  await w2.text("near", "i'm down");
  const declined = await w2.text("poster", "nah");
  assert.equal(declined.length, 1);
  assert.equal(activeRelayFor(w2.db, w2.ids.near), null);
  assert.match(w2.textsTo("near").at(-1)!, /sorry/);
  assert.equal(getFlowState(w2.db, w2.ids.poster), null);
  w.db.close();
  w2.db.close();
});

test("contact rules are enforced in code on both sides", async () => {
  const w = world();
  await w.text("poster", GAME);
  const posterBefore = w.textsTo("poster").length;
  updateUser(w.db, w.ids.near, { contactMode: "no_contact" });
  const out = await w.text("near", "i'm in");
  assert.equal(out.length, 1);
  assert.equal(w.textsTo("poster").length, posterBefore, "the poster is never asked");

  // The poster turns contact off after someone asked: their yes can't connect anyone.
  await w.text("nowhere", "i'm in");
  updateUser(w.db, w.ids.poster, { contactMode: "no_contact" });
  await w.text("poster", "yes");
  assert.equal(activeRelayFor(w.db, w.ids.nowhere), null);
  assert.equal(activeRelayFor(w.db, w.ids.poster), null);

  const w2 = world();
  await w2.text("poster", GAME);
  updateUser(w2.db, w2.ids.poster, { contactMode: "no_contact" });
  const before = w2.textsTo("poster").length;
  assert.equal((await w2.text("near", "i'm in")).length, 1);
  assert.equal(w2.textsTo("poster").length, before);
  w.db.close();
  w2.db.close();
});

test("a post expires after 3 hours, or after the time they gave", async () => {
  const now = Date.UTC(2026, 10, 14, 22, 0); // 2pm in los angeles
  assert.equal(whenIn("anyone want to play pickup at lyon", now).expiresAt, now + POST_TTL_MS);
  assert.equal(whenIn("anyone want to play pickup at lyon", now).whenText, null);
  const at6 = whenIn(GAME, now);
  assert.equal(at6.whenText, "at 6");
  assert.equal(at6.expiresAt, now + 5 * 60 * 60 * 1000, "6pm is four hours off, plus an hour of play");
  const tomorrow = whenIn("extra ticket for the game tomorrow", now);
  assert.equal(tomorrow.whenText, "tomorrow");
  assert.equal(tomorrow.expiresAt, now + 34 * 60 * 60 * 1000, "the end of tomorrow");
  assert.equal(whenIn("spanish tutor free thursdays", now).whenText, "on thursdays");
  assert.ok(whenIn("lifting at 5:30pm", now).expiresAt - now === 4.5 * 60 * 60 * 1000);

  const w = world();
  await w.text("poster", "anyone want to play pickup at lyon");
  const post = getPost(w.db, 1)!;
  assert.equal(post.expiresAt, w.clock.now + POST_TTL_MS);

  // Just before the end it still works; after it, the post is over for everyone.
  w.clock.now = post.expiresAt + 1000;
  const late = await w.text("near", "i'm in");
  assert.equal(late.length, 1);
  assert.match(late[0]!, /over/);
  assert.equal(getFlowState(w.db, w.ids.poster), null, "the poster was never asked");

  await w.pipeline.sweep(post.expiresAt + 2000);
  assert.equal(getPost(w.db, 1)!.status, "ended");
  assert.equal(getFlowState(w.db, w.ids.nowhere), null, "the pointer to the dead post is gone");

  // An expired post closes a chat that was opened for it, and both are told.
  const w2 = world();
  await w2.text("poster", GAME);
  await w2.text("near", "i'm in");
  await w2.text("poster", "yes");
  assert.ok(activeRelayFor(w2.db, w2.ids.near));
  await w2.pipeline.sweep(getPost(w2.db, 1)!.expiresAt + 1);
  assert.equal(activeRelayFor(w2.db, w2.ids.near), null);
  assert.match(w2.textsTo("near").at(-1)!, /closed/);
  assert.match(w2.textsTo("poster").at(-1)!, /closed/);
  w.db.close();
  w2.db.close();
});

test("the poster can take a post down by saying so", async () => {
  const w = world();
  await w.text("poster", GAME);
  const out = await w.text("poster", "we're full, take it down");
  assert.equal(out.length, 1);
  assert.match(out[0]!, /pickup game/);
  assert.equal(getPost(w.db, 1)!.status, "ended");
  assert.match((await w.text("near", "i'm in"))[0]!, /over|done|missed/);
  w.db.close();
});

test("following and unfollowing by asking, in words that never quote the poll label", async () => {
  const w = world();
  const on = await w.text("poster", "sign me up for pickup games");
  assert.deepEqual(w.subs("poster"), ["pickup"]);
  assert.equal(on.length, 1);
  assert.ok(on[0]!.includes("when there's a pickup game near u"));
  for (const label of LABELS) assert.ok(!on[0]!.includes(label), "the label is never quoted");
  assert.ok(w.lastBrief().mustCover.join(" ").includes("never quote a poll label"));
  voiceOk(on);

  // Asking again changes nothing and doesn't repeat the same line.
  const again = await w.text("poster", "text me about pickup games");
  assert.deepEqual(w.subs("poster"), ["pickup"]);
  assert.notEqual(again[0], on[0]);

  await w.text("poster", "add me to the ticket alerts too");
  assert.deepEqual(w.subs("poster"), ["pickup", "tickets"]);

  // A partial wish changes that one setting, not everything.
  const off = await w.text("poster", "stop the ticket texts");
  assert.deepEqual(w.subs("poster"), ["pickup"]);
  assert.equal(off.length, 1);
  assert.ok(off[0]!.includes("when someone has an extra ticket"));
  assert.equal(getUserById(w.db, w.ids.poster)!.stopped, false);
  voiceOk(off);

  const never = await w.text("poster", "unsubscribe me from rides");
  assert.deepEqual(w.subs("poster"), ["pickup"]);
  assert.equal(never.length, 1);

  // "stop the alerts" with more than one topic: one question, then the answer does it.
  await w.text("poster", "sign me up for experienced trojans");
  const which = await w.text("poster", "stop the alerts");
  assert.equal(which.length, 1);
  assert.match(which[0]!, /pickup games right now, experienced trojans/);
  assert.deepEqual(w.subs("poster"), ["pickup", "experienced"]);
  await w.text("poster", "the pickup ones");
  assert.deepEqual(w.subs("poster"), ["experienced"]);

  // A command read by meaning arrives on the intent; code does the same thing.
  const w2 = world({ intent: () => ({ flow: "notes", action: "", command: { name: "unsubscribe_topic", topic: "pickup games", certainty: "clear" } }) });
  await w2.text("near", "ugh enough with the basketball stuff");
  assert.deepEqual(w2.subs("near"), []);

  // What they follow, and what exists.
  const mine = await w.text("poster", "what am i signed up for");
  assert.match(mine[0]!, /experienced trojans/);
  const all = await w.text("poster", "what topics are there");
  assert.match(all[0]!, /free food and stuff nearby, rides home and to lax, extra tickets for game day, pickup games right now, experienced trojans/);
  w.db.close();
  w2.db.close();
});

test("suggesting a topic: clearly fine creates it and celebrates, and the next student who names it is just added", async () => {
  const w = world({ verdict: () => "ok" });
  const ask = await w.text("poster", "something else");
  assert.equal(ask.length, 1);
  assert.match(ask[0]!, /\?$/);
  assert.equal(getFlowState(w.db, w.ids.poster)?.step, "suggest_ask");
  assert.deepEqual(w.judged, []);

  const made = await w.text("poster", "study buddies");
  assert.deepEqual(w.judged, ["study buddies"]);
  const topic = listTopics(w.db).at(-1)!;
  assert.equal(topic.label, "study buddies");
  assert.equal(topic.builtIn, false);
  assert.equal((w.db.prepare("SELECT suggestedBy FROM topics WHERE id = ?").get(topic.id) as { suggestedBy: number }).suggestedBy, w.ids.poster);
  assert.deepEqual(topicsFor(w.db, w.ids.poster).map((t) => t.key), ["study_buddies"]);
  assert.equal(getFlowState(w.db, w.ids.poster), null);
  // His own words, covering the three things John asked for.
  const brief = w.lastBrief();
  assert.deepEqual(brief.facts, { name: "study buddies" });
  assert.equal(brief.mustCover.length, 4);
  assert.match(brief.mustCover.join(" | "), /didn't exist.*great idea.*every trojan/);
  assert.ok(brief.fallback.length >= 3, "never one fixed line");
  assert.ok(made.join(" ").includes("study buddies"));
  voiceOk(made);
  voiceOk(brief.fallback.flat());

  // A loose match on an existing topic adds them; nothing new is created and nothing is judged.
  const joined = await w.text("near", "can u add a topic for study groups");
  assert.equal(listTopics(w.db).length, 6);
  assert.deepEqual(w.judged, ["study buddies"]);
  assert.ok(topicsFor(w.db, w.ids.near).some((t) => t.key === "study_buddies"));
  assert.equal(joined.length, 1);

  // Typing a new topic at any time works without the "something else" step.
  await w.text("far", "i wish there was a board games alert");
  assert.equal(listTopics(w.db).at(-1)!.label, "board games");

  // And the created topic is real: a post to it reaches its followers.
  await w.text("near", "anyone down for study buddies at leavey tonight");
  assert.ok(w.textsTo("poster").at(-2)!.includes("anyone down for study buddies at leavey tonight") || w.textsTo("poster").at(-3)!.includes("anyone down for study buddies at leavey tonight"));
  w.db.close();
});

test("suggesting a topic: unclear saves a request and creates nothing; unsafe is declined in one line", async () => {
  const w = world({ modelDown: true, verdict: (name) => (name.includes("basket") ? "unsure" : "no") });
  const unsure = await w.text("poster", "can u make a topic for underwater basket weaving");
  assert.equal(listTopics(w.db).length, 5);
  assert.deepEqual(w.subs("poster"), []);
  const saved = openTopicRequests(w.db);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.userId, w.ids.poster);
  assert.match(saved[0]!.text, /underwater basket weaving/);
  assert.match(w.lastBrief().mustCover.join(" | "), /text them when something comes up/);
  assert.match(unsure.join(" "), /i'll (?:text|hit) u/);
  voiceOk(unsure);

  // The keyword screen declines without asking the model at all.
  const judgedBefore = w.judged.length;
  const screened = await w.text("poster", "add a topic for weed plugs");
  assert.equal(w.judged.length, judgedBefore);
  assert.equal(screened.length, 1);
  assert.match(screened[0]!, /sorry/);
  assert.ok(!/\p{Extended_Pictographic}/u.test(screened[0]!));

  // The model's "no" gets the same short decline, in different words than last time.
  const declined = await w.text("poster", "add a topic for rating professors by looks");
  assert.equal(declined.length, 1);
  assert.match(declined[0]!, /sorry/);
  assert.notEqual(declined[0], screened[0]);
  assert.equal(listTopics(w.db).length, 5);
  assert.equal(openTopicRequests(w.db).length, 1);
  w.db.close();

  assert.equal(suggestedName("can u add a topic for meeting new friends pls"), "meeting new friends");
  assert.equal(suggestedName("something else"), "");
  assert.equal(suggestedName("i want texts about language tutors"), "language tutors");
});

test("rate limits: a poster's fourth post in an hour is held, and nobody gets more than a few topic texts an hour", async () => {
  const w = world();
  updateUser(w.db, w.ids.near, { subscriptions: JSON.stringify(["pickup", "tickets"]) });
  const lines = ["anyone want to play pickup at lyon", "extra ticket for saturday", "i have an extra ticket for the ucla game", "need one more for pickup at lyon"];
  for (let i = 0; i < MAX_POSTS_PER_HOUR; i++) await w.text("poster", lines[i]!);
  assert.equal(w.posts().length, MAX_POSTS_PER_HOUR);
  const held = await w.text("poster", lines[3]!);
  assert.equal(w.posts().length, MAX_POSTS_PER_HOUR);
  assert.equal(held.length, 1);
  assert.match(held[0]!, /hour/);

  // A second poster's posts stop reaching someone who already got their share this hour.
  w.make("extra", { subscriptions: "[]" });
  await w.text("extra", "anyone want to play pickup at lyon");
  const alertsToNear = () => (w.db.prepare("SELECT COUNT(*) AS n FROM topic_alert_bubbles WHERE userId = ? AND role = 'alert'").get(w.ids.near) as { n: number }).n;
  assert.equal(alertsToNear(), MAX_ALERTS_PER_HOUR);
  await w.text("extra", "extra ticket for sunday");
  assert.equal(alertsToNear(), MAX_ALERTS_PER_HOUR);
  // An hour later both are fine again.
  w.clock.now += 61 * 60 * 1000;
  await w.text("poster", lines[3]!);
  assert.equal(w.posts().length, MAX_POSTS_PER_HOUR + 3);
  assert.equal(alertsToNear(), MAX_ALERTS_PER_HOUR + 1);
  w.db.close();
});

test("the report path: one report per person, thanks from the food flow's copy, and enough reports hide the post", async () => {
  const w = world();
  w.make("extra", { usualSpots: JSON.stringify(["lyon"]) });
  await w.text("poster", GAME);
  const thanks = await w.text("near", "that was fake");
  assert.deepEqual(thanks.map((t) => FOOD_VOICE.canonical(t)), FOOD_COPY.reportThanks);
  await w.text("near", "that was fake");
  assert.equal(getPost(w.db, 1)!.reports, 1);
  assert.equal(getPost(w.db, 1)!.status, "live");
  await w.text("nowhere", "report that, it's spam");
  await w.text("extra", "nothing was there");
  assert.equal(getPost(w.db, 1)!.reports, REPORTS_TO_HIDE);
  assert.equal(getPost(w.db, 1)!.status, "removed");
  // Nothing was decided about the poster here: bans stay with staff.
  assert.equal(getUserById(w.db, w.ids.poster)!.bannedFromPosting, false);
  w.db.close();
});

test("a message that isn't about topics passes through, and the alert pointer stays for a later reply", async () => {
  const w = world();
  await w.text("poster", GAME);
  const before = w.textsTo("near").length;
  const out = await w.text("near", "lol how was ur day");
  assert.ok(out.length >= 1, "free chat answered");
  assert.equal(getFlowState(w.db, w.ids.near)?.step, "alerted");
  assert.equal(w.posts().length, 1);
  assert.ok(w.textsTo("near").length > before);
  assert.equal((await w.text("near", "ok i'm in")).length, 2);
  w.db.close();
});
