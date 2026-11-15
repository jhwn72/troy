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
import { RELAY_COPY, activeRelayFor } from "../src/relay.ts";
import type { Brief } from "../src/flows/topics.ts";
import { setTopicsDeps } from "../src/flows/topics.ts";
import { GROUP_WAIT_MS, RIDE_WARNING, dayIn, destIn, exampleRiderCount, findRideMatches, rides, setRidesDeps, timeIn } from "../src/flows/rides.ts";

registerFlow(rides);
// Nothing in this file may reach the network.
setModelCall(async () => {
  throw new Error("off");
});

const DIRECTORY = JSON.parse(readFileSync(join(import.meta.dirname, "../src/db/seed-data/directory.json"), "utf8")) as { kind: string; name: string; topics: string[]; contactMethod: string | null; url: string | null; details: string | null; isExample?: boolean }[];
const SHUTTLE = DIRECTORY.find((d) => d.name === "USG LAX shuttle")!;

type Who = "a" | "b" | "c";

/** The real pipeline, a fake adapter, and the wording injected: each brief is recorded and its first fallback reply goes out. */
function world(opts: { caps?: Partial<AdapterCapabilities>; groupChat?: string | null; noShuttle?: boolean; intent?: (text: string) => Partial<Intent> | null } = {}) {
  const db: DatabaseSync = openDb(":memory:");
  if (!opts.noShuttle) db.prepare("INSERT INTO directory (kind, name, topics, contactMethod, url, details, isExample) VALUES (?, ?, ?, ?, ?, ?, 0)").run(SHUTTLE.kind, SHUTTLE.name, JSON.stringify(SHUTTLE.topics), SHUTTLE.contactMethod, SHUTTLE.url, SHUTTLE.details);

  const calls: { chatId: string; text: string; id: string }[] = [];
  const groups: { members: string[]; first: string }[] = [];
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
    async createGroupChat(members, first) {
      groups.push({ members, first });
      return opts.groupChat ?? null;
    },
    getLiveLocation: async () => null,
    requestLocation: async () => false,
    chatIdForHandle: (h) => `chat-${h}`,
  };

  const briefs: Brief[] = [];
  const clock = { now: Date.now() };
  setTopicsDeps(null);
  setTopicsDeps({
    sayInHisWords: async (_ctx, brief) => {
      briefs.push(brief);
      return brief.fallback[0]!;
    },
  });
  setRidesDeps(null);
  setRidesDeps({ now: () => clock.now });

  const pipeline = createPipeline({
    db,
    getAdapter: () => adapter,
    pause: async () => {},
    ackAfterMs: 60_000,
    detectIntent: async (input) => ({ flow: "rides", action: "find", details: {}, source: "fallback", ...(opts.intent?.(input.text) ?? {}) }) as Intent,
  });

  const handles: Record<Who, string> = { a: "+12135550401", b: "+12135550402", c: "+12135550403" };
  const ids = {} as Record<Who, number>;
  for (const who of ["a", "b", "c"] as const) {
    const u = getOrCreateUser(db, handles[who], `chat-${who}`);
    updateUser(db, u.id, { verifiedAt: Date.now(), verifiedVia: "usc_email" });
    ids[who] = u.id;
  }
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
  type Listing = { id: number; userId: number; type: string; status: string; isExample: number; details: Record<string, unknown> };
  const listings = (): Listing[] =>
    (db.prepare("SELECT * FROM listings WHERE type = 'ride' ORDER BY id").all() as Record<string, unknown>[]).map((r) => ({ ...(r as unknown as Listing), details: JSON.parse(r.details as string) as Record<string, unknown> }));
  return { db, adapter, calls, groups, pipeline, ids, handles, sentTo, textsTo, text, tap, listings, briefs, clock };
}

const FOUND = /^found (\d) trojans? leaving for lax on the 19th around noon\. want a group chat to split a ride\?$/;

test("reading a trip: where, which day, roughly when", () => {
  const now = Date.UTC(2026, 10, 14, 20, 0); // saturday nov 14, noon in los angeles
  assert.equal(destIn("find me people going to lax"), "lax");
  assert.equal(destIn("anyone driving to burbank friday"), "burbank");
  assert.equal(destIn("need a ride to san diego on friday"), "san diego");
  assert.equal(destIn("need a ride home"), null);
  assert.equal(destIn("find me a ride"), null);

  assert.deepEqual(dayIn("on the 19th around noon", now), { dayKey: "2026-11-19", dayText: "on the 19th" });
  assert.deepEqual(dayIn("nov 19", now), { dayKey: "2026-11-19", dayText: "on nov 19" });
  assert.deepEqual(dayIn("11/19 works", now), { dayKey: "2026-11-19", dayText: "on nov 19" });
  assert.deepEqual(dayIn("thursday", now), { dayKey: "2026-11-19", dayText: "on thursday" });
  assert.deepEqual(dayIn("tomorrow morning", now), { dayKey: "2026-11-15", dayText: "tomorrow" });
  assert.deepEqual(dayIn("the 3rd", now), { dayKey: "2026-12-03", dayText: "on the 3rd" });
  assert.deepEqual(dayIn("first day of break", now), { dayKey: "first day of break", dayText: "the first day of break" });
  assert.equal(dayIn("idk yet", now), null);

  assert.deepEqual(timeIn("around noon"), { minutes: 720, timeText: "around noon" });
  assert.deepEqual(timeIn("2pm"), { minutes: 840, timeText: "around 2pm" });
  assert.deepEqual(timeIn("at 2"), { minutes: 840, timeText: "around 2pm" });
  assert.deepEqual(timeIn("like 9:30"), { minutes: 570, timeText: "around 9:30am" });
  assert.deepEqual(timeIn("6:15 am"), { minutes: 375, timeText: "around 6:15am" });
  assert.deepEqual(timeIn("friday at 2:30pm"), { minutes: 870, timeText: "around 2:30pm" });
  assert.deepEqual(timeIn("around 12:30pm"), { minutes: 750, timeText: "around 12:30pm" });
  assert.deepEqual(timeIn("in the morning"), { minutes: 540, timeText: "in the morning" });
  assert.equal(timeIn("on the 19th"), null, "a date is not a time");
  assert.equal(timeIn("idk"), null);
});

test("example mode: he asks one thing at a time, answers like the real thing, and says right after that the riders are examples", async () => {
  const w = world();
  const q1 = await w.text("a", "find me people going to lax");
  assert.equal(q1.length, 1);
  assert.match(q1[0]!, /day/);
  assert.equal(getFlowState(w.db, w.ids.a)?.step, "ask");
  assert.equal(w.listings().length, 0);

  const q2 = await w.text("a", "the 19th");
  assert.equal(q2.length, 1);
  assert.match(q2[0]!, /time/);

  const out = await w.text("a", "around noon");
  assert.equal(out.length, 3);
  // The shuttle USG runs, with only what the directory says.
  assert.equal(out[0], SHUTTLE.details);
  // The answer reads like the real thing, with the day and time they gave.
  const m = out[1]!.match(FOUND);
  assert.ok(m, out[1]);
  const need = { dest: "lax", dayKey: String(w.listings()[0]!.details.dayKey), dayText: "on the 19th", minutes: 720, timeText: "around noon" };
  assert.equal(Number(m![1]), exampleRiderCount(need));
  assert.ok(Number(m![1]) >= 2 && Number(m![1]) <= 4);
  // And the very next bubble says so plainly.
  assert.match(out[2]!, /examples/);
  assert.match(out[2]!, /hackathon/);
  assert.match(out[2]!, /more trojans/);
  const note = w.briefs.at(-1)!;
  assert.deepEqual(note.facts, { examples: "examples", hackathon: "hackathon" });
  for (const variant of note.fallback) assert.match(variant.join(" "), /examples.*hackathon|hackathon.*examples/);
  assert.ok(!out.join(" ").includes(RIDE_WARNING), "no contact warning for riders who don't exist");
  for (const line of out.slice(1)) {
    assert.equal(line, line.toLowerCase());
    assert.ok(!/—|\byou\b|\byour\b/.test(line));
  }

  // The trip is saved as a real listing of type ride.
  const [trip] = w.listings();
  assert.equal(trip!.type, "ride");
  assert.equal(trip!.status, "open");
  assert.equal(trip!.userId, w.ids.a);
  assert.equal(trip!.isExample, 0);
  assert.deepEqual({ dest: trip!.details.dest, minutes: trip!.details.minutes }, { dest: "lax", minutes: 720 });
  assert.match(String(trip!.details.dayKey), /^\d{4}-\d\d-19$/);
  assert.equal(getFlowState(w.db, w.ids.a)?.data.mode, "example");

  // Yes in example mode: no group chat, no relay, he says what would happen, and the trip stays saved.
  const yes = await w.text("a", "yes");
  assert.equal(w.groups.length, 0);
  assert.equal(activeRelayFor(w.db, w.ids.a), null);
  assert.match(yes[0]!, /examples/);
  assert.match(yes.join(" "), /contact info/);
  assert.match(yes.join(" "), /saved/);
  assert.equal(w.listings()[0]!.status, "open");

  // Following the rides topic is offered once.
  assert.match(yes.at(-1)!, /headed the same way as u\?$/);
  assert.equal(getFlowState(w.db, w.ids.a)?.step, "sub_offer");
  const sub = await w.text("a", "sure");
  assert.equal(sub.length, 1);
  assert.deepEqual(getUserById(w.db, w.ids.a)!.subscriptions, ["rides"]);
  assert.equal(getFlowState(w.db, w.ids.a), null);
  w.db.close();
});

test("everything in one message skips the questions, and the topic offer is made only once", async () => {
  const w = world({ noShuttle: true });
  const out = await w.text("b", "find me people tryna go to lax friday at 2pm");
  assert.equal(out.length, 2, "no shuttle row in the directory, so nothing about a shuttle is said");
  assert.match(out[0]!, /^found \d trojans leaving for lax on friday around 2pm\. want a group chat to split a ride\?$/);
  assert.match(out[1]!, /examples/);

  const no = await w.text("b", "nah");
  assert.equal(w.groups.length, 0);
  assert.match(no[0]!, /saved/);
  assert.match(no.at(-1)!, /\?$/);
  await w.text("b", "no");
  assert.deepEqual(getUserById(w.db, w.ids.b)!.subscriptions, []);

  // Asking again later: same trip is updated, not duplicated, and he doesn't offer the topic a second time.
  await w.text("b", "find me people going to lax friday at 2:30pm");
  assert.equal(w.listings().length, 1);
  assert.equal(w.listings()[0]!.details.minutes, 870);
  const again = await w.text("b", "no");
  assert.equal(again.length, 1);
  assert.equal(getFlowState(w.db, w.ids.b), null);

  // A destination other than lax never mentions the lax shuttle.
  const w2 = world();
  const sd = await w2.text("a", "need a ride to san diego tomorrow around 9am");
  assert.ok(!sd.includes(SHUTTLE.details!));
  assert.match(sd[0]!, /leaving for san diego tomorrow around 9am/);
  w.db.close();
  w2.db.close();
});

test("a question in the middle of a step is answered and the step stays open; nvm drops it", async () => {
  const w = world();
  await w.text("a", "find me people going to lax");
  const why = await w.text("a", "why do u need the day?");
  assert.equal(why.length, 1);
  assert.equal(getFlowState(w.db, w.ids.a)?.step, "ask");
  assert.equal(getFlowState(w.db, w.ids.a)?.data.waiting, "day");
  const next = await w.text("a", "thursday");
  assert.match(next[0]!, /time/);
  // No idea about the time is fine: he matches on the day alone.
  const out = await w.text("a", "idk yet");
  assert.match(out[1]!, /^found \d trojans leaving for lax on thursday\. want a group chat to split a ride\?$/);

  const w2 = world();
  await w2.text("b", "find me people going to lax");
  await w2.text("b", "nvm");
  assert.equal(getFlowState(w2.db, w2.ids.b), null);
  assert.equal(w2.listings().length, 0);
  w.db.close();
  w2.db.close();
});

/** b saves a real trip first (and turns everything down), so a's request has someone real to match. */
async function withRealTrip(opts: Parameters<typeof world>[0], bTime = "12:30pm") {
  const w = world(opts);
  await w.text("b", `anyone going to lax on the 19th around ${bTime}`);
  await w.text("b", "no");
  await w.text("b", "no");
  assert.equal(getFlowState(w.db, w.ids.b), null);
  return w;
}

test("a real match: no example note, the contact warning, everyone's yes, then the group chat", async () => {
  const w = await withRealTrip({ caps: { groupChats: true }, groupChat: "group-1" });
  const bBefore = w.textsTo("b").length;

  const out = await w.text("a", "find me people going to lax on the 19th around noon");
  assert.deepEqual(out, [SHUTTLE.details, "found 1 trojan leaving for lax on the 19th around noon. want a group chat to split a ride?", RIDE_WARNING]);
  assert.ok(!out.join(" ").includes("example"), "real riders get no example note");
  assert.equal(getFlowState(w.db, w.ids.a)?.data.mode, "real");
  assert.equal(w.textsTo("b").length, bBefore, "the other rider hears nothing until a says yes");

  const yes = await w.text("a", "yes");
  assert.equal(yes.length, 2);
  assert.equal(w.groups.length, 0, "not before the other rider agrees");
  const asked = w.textsTo("b").slice(bBefore);
  assert.equal(asked.length, 2);
  assert.match(asked[0]!, /lax/);
  assert.match(asked[0]!, /on the 19th around 12:30pm/);
  assert.equal(asked[1], RIDE_WARNING);
  assert.equal(getFlowState(w.db, w.ids.b)?.step, "gc_ask");

  await w.text("b", "yeah");
  assert.equal(w.groups.length, 1);
  assert.deepEqual(w.groups[0]!.members.sort(), [w.handles.a, w.handles.b].sort());
  assert.match(w.textsTo("a").at(-1)!, /group chat/);
  assert.match(w.textsTo("b").at(-1)!, /group chat/);
  assert.deepEqual(w.listings().map((l) => l.status), ["handed_off", "handed_off"]);
  assert.equal(activeRelayFor(w.db, w.ids.a), null);
  // The group chat Troy made is allowed, so he can step back in it.
  assert.ok(w.db.prepare("SELECT 1 FROM allow_list WHERE chatId = 'group-1' AND reason = 'troy_group'").get());
  w.db.close();
});

test("a real match without a group chat falls back to relay; contact rules decide, not the provider", async () => {
  // The provider can't make group chats.
  const w = await withRealTrip({});
  await w.text("a", "find me people going to lax on the 19th around noon");
  await w.text("a", "yes");
  await w.text("b", "yes");
  assert.equal(w.groups.length, 0);
  const relay = activeRelayFor(w.db, w.ids.a)!;
  assert.equal(relay.otherUserId, w.ids.b);
  assert.deepEqual(w.textsTo("a").slice(-2), RELAY_COPY.start);
  assert.deepEqual(w.textsTo("b").slice(-2), RELAY_COPY.start);
  await w.text("a", "want to split a lyft?");
  assert.equal(w.textsTo("b").at(-1), "from the other rider: want to split a lyft?");

  // The provider can, but one rider is relay only: no group chat is even attempted.
  const w2 = await withRealTrip({ caps: { groupChats: true }, groupChat: "group-1" });
  updateUser(w2.db, w2.ids.b, { contactMode: "relay_only" });
  await w2.text("a", "find me people going to lax on the 19th around noon");
  await w2.text("a", "yes");
  await w2.text("b", "yes");
  assert.equal(w2.groups.length, 0);
  assert.ok(activeRelayFor(w2.db, w2.ids.b));

  // Someone who asked not to be connected with anyone is never matched at all.
  const w3 = await withRealTrip({});
  updateUser(w3.db, w3.ids.b, { contactMode: "no_contact" });
  const out = await w3.text("a", "find me people going to lax on the 19th around noon");
  assert.match(out[2]!, /examples/);
  w.db.close();
  w2.db.close();
  w3.db.close();
});

test("a thumbs up counts as yes only on the warning bubble, and a rider's no connects nobody", async () => {
  const w = await withRealTrip({ caps: { groupChats: true }, groupChat: "group-1" });
  await w.text("a", "find me people going to lax on the 19th around noon");
  const [shuttle, found, warning] = w.sentTo("a").slice(-3);
  assert.equal(warning!.text, RIDE_WARNING);
  const bBefore = w.textsTo("b").length;
  await w.tap("a", found!.id, "like");
  await w.tap("a", shuttle!.id, "love");
  assert.equal(w.textsTo("b").length, bBefore, "a thumbs up elsewhere is only an acknowledgment");
  await w.tap("a", warning!.id, "like");
  assert.equal(w.textsTo("b").length, bBefore + 2);

  const no = await w.text("b", "nah i'm good");
  assert.equal(no.length, 1);
  assert.equal(w.groups.length, 0);
  assert.equal(activeRelayFor(w.db, w.ids.a), null);
  assert.match(w.textsTo("a").at(-1)!, /lax trip/);
  assert.deepEqual(w.listings().map((l) => l.status), ["open", "open"]);
  w.db.close();
});

test("matching is the same place, the same day, within about an hour, and never an example or stopped user", async () => {
  // Three hours apart: not a match, so example riders and the honest note.
  const w = await withRealTrip({}, "3pm");
  const out = await w.text("a", "find me people going to lax on the 19th around noon");
  assert.match(out[1]!, FOUND);
  assert.match(out[2]!, /examples/);

  const now = Date.now();
  const need = { dest: "lax", dayKey: String(w.listings()[0]!.details.dayKey), dayText: "on the 19th", minutes: 15 * 60, timeText: "around 3pm" };
  assert.deepEqual(findRideMatches(w.db, w.ids.c, need, now).map((x) => x.userId), [w.ids.b]);
  assert.deepEqual(findRideMatches(w.db, w.ids.c, { ...need, minutes: 16 * 60 }, now).map((x) => x.userId), [w.ids.b], "exactly an hour is inside");
  assert.deepEqual(findRideMatches(w.db, w.ids.c, { ...need, minutes: 16 * 60 + 1 }, now), []);
  assert.deepEqual(findRideMatches(w.db, w.ids.c, { ...need, dest: "burbank" }, now), []);
  assert.deepEqual(findRideMatches(w.db, w.ids.c, { ...need, dayKey: "2026-12-25" }, now), []);
  assert.deepEqual(findRideMatches(w.db, w.ids.b, need, now), [], "never their own trip");
  w.db.prepare("UPDATE users SET stopped = 1 WHERE id = ?").run(w.ids.b);
  assert.deepEqual(findRideMatches(w.db, w.ids.c, need, now), []);
  w.db.prepare("UPDATE users SET stopped = 0, isExample = 1 WHERE id = ?").run(w.ids.b);
  assert.deepEqual(findRideMatches(w.db, w.ids.c, need, now), []);
  w.db.close();
});

test("a rider who never answers counts as a no after a while, so the requester isn't left waiting", async () => {
  const w = await withRealTrip({});
  await w.text("a", "find me people going to lax on the 19th around noon");
  await w.text("a", "yes");
  assert.equal(w.listings().find((l) => l.userId === w.ids.a)!.status, "matched");
  await w.pipeline.sweep(w.clock.now + GROUP_WAIT_MS - 1000);
  assert.equal(getFlowState(w.db, w.ids.b)?.step, "gc_ask");
  await w.pipeline.sweep(w.clock.now + GROUP_WAIT_MS + 1000);
  assert.equal(getFlowState(w.db, w.ids.b), null);
  assert.match(w.textsTo("a").at(-1)!, /lax trip/);
  assert.equal(w.listings().find((l) => l.userId === w.ids.a)!.status, "open");
  w.db.close();
});

test("someone who no longer needs the ride can say so", async () => {
  const w = world();
  await w.text("a", "find me people going to lax on the 19th around noon");
  await w.text("a", "no");
  await w.text("a", "no");
  const out = await w.text("a", "nvm found a ride");
  assert.equal(out.length, 1);
  assert.match(out[0]!, /lax trip/);
  assert.equal(w.listings()[0]!.status, "expired");
  w.db.close();
});
