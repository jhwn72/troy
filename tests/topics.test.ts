import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateUser, getUserById, openDb, updateUser } from "../src/db/index.ts";
import { setModelCall } from "../src/ai.ts";
import {
  BUILT_IN_TOPICS,
  cleanTopicName,
  createTopic,
  findTopic,
  judgeTopic,
  listTopics,
  migrateSubscriptions,
  openTopicRequests,
  removeTopic,
  saveTopicRequest,
  screenedOut,
  subscribe,
  subscriptionKeys,
  topicsFor,
  topicWords,
  unsubscribe,
} from "../src/topics.ts";

const student = (db: ReturnType<typeof openDb>, n: number, subs: string[] = []) => {
  const u = getOrCreateUser(db, `+1213555020${n}`, `chat-${n}`);
  updateUser(db, u.id, { verifiedAt: Date.now(), verifiedVia: "usc_email", subscriptions: JSON.stringify(subs) });
  return u.id;
};

test("the built-in topics are the poll options, in order, each with a plain description", () => {
  assert.deepEqual(
    BUILT_IN_TOPICS.map((t) => t.label),
    ["free food and stuff nearby 🌯", "rides home and to lax ✈️", "extra tickets for game day 🏈", "pickup games right now 🏀", "experienced trojans 💼"],
  );
  assert.deepEqual(
    BUILT_IN_TOPICS.map((t) => t.plain),
    [
      "when there's free food or free stuff near u",
      "when someone's headed the same way as u",
      "when someone has an extra ticket",
      "when there's a pickup game near u",
      "when an older trojan can help with what ur working on",
    ],
  );
  const db = openDb(":memory:");
  const all = listTopics(db);
  assert.deepEqual(all.map((t) => t.label), BUILT_IN_TOPICS.map((t) => t.label));
  assert.ok(all.every((t) => t.builtIn && t.id > 0));
  // Opening again never duplicates them.
  const row = db.prepare("SELECT COUNT(*) AS n FROM topics").get() as { n: number };
  assert.equal(row.n, 5);
  for (const t of BUILT_IN_TOPICS) assert.ok(!/\byou\b|\byour\b|—/.test(`${t.label} ${t.plain}`));
  db.close();
});

test("findTopic matches loosely: plurals, -ing, synonyms, and what people call the built-in ones", () => {
  const db = openDb(":memory:");
  const me = student(db, 1);
  const key = (text: string) => findTopic(db, text)?.key ?? null;

  assert.equal(key("stop the ticket texts"), "tickets");
  assert.equal(key("extra ticket for saturday"), "tickets");
  assert.equal(key("sign me up for pickup games"), "pickup");
  assert.equal(key("anyone want to play pickup at lyon at 6"), "pickup");
  assert.equal(key("i can help with econ 351"), "experienced");
  assert.equal(key("find me people going to lax"), "rides");
  assert.equal(key("stop the food texts"), "free_nearby");
  assert.equal(key("free food and stuff nearby 🌯"), "free_nearby");
  // Picking something up is not a pickup game.
  assert.equal(key("can i pick up my wallet"), null);
  assert.equal(key("how was ur day"), null);

  const made = createTopic(db, "Study Groups", me);
  assert.equal(made.label, "study groups");
  assert.equal(made.key, "study_groups");
  assert.equal(made.plain, "when someone posts about study groups");
  assert.equal(key("study buddies"), "study_groups");
  assert.equal(key("sign me up for the study group texts"), "study_groups");
  assert.equal(key("studying"), null, "one word of a two word topic is not that topic");

  // The more specific created topic beats the built-in it overlaps.
  createTopic(db, "pickup soccer", me);
  assert.equal(key("add me to pickup soccer"), "pickup_soccer");
  assert.equal(key("pickup basketball at lyon"), "pickup");

  assert.deepEqual(topicWords("Study Buddies!"), ["study", "group"]);
  db.close();
});

test("createTopic stores who suggested it, never makes a twin, and a removed topic stops matching", () => {
  const db = openDb(":memory:");
  const a = student(db, 1);
  const b = student(db, 2);
  const first = createTopic(db, "  Spanish Tutors!! ", a);
  const again = createTopic(db, "spanish tutors", b);
  assert.equal(again.id, first.id);
  const row = db.prepare("SELECT suggestedBy, builtIn, status, createdAt FROM topics WHERE id = ?").get(first.id) as Record<string, number | string>;
  assert.equal(row.suggestedBy, a);
  assert.equal(row.builtIn, 0);
  assert.equal(row.status, "active");
  assert.ok(Number(row.createdAt) > 0);
  // Created topics are offered to later students, after the built-in ones.
  assert.equal(listTopics(db).at(-1)!.key, "spanish_tutors");
  assert.equal(listTopics(db).at(-1)!.builtIn, false);

  subscribe(db, b, first.id);
  removeTopic(db, first.id);
  assert.equal(findTopic(db, "spanish tutors"), null);
  assert.deepEqual(topicsFor(db, b), []);
  // Built-in topics can't be removed this way.
  removeTopic(db, listTopics(db)[0]!.id);
  assert.equal(listTopics(db).length, 5);
  assert.equal(cleanTopicName("  Board   Games <script> "), "board games script");
  db.close();
});

test("subscribe, unsubscribe and topicsFor keep topic keys in users.subscriptions", () => {
  const db = openDb(":memory:");
  const me = student(db, 1);
  const [free, rides, tickets] = listTopics(db);
  subscribe(db, me, tickets!.id);
  subscribe(db, me, free!.id);
  subscribe(db, me, free!.id);
  assert.deepEqual(getUserById(db, me)!.subscriptions, ["tickets", "free_nearby"]);
  // Poll order, not the order they signed up in.
  assert.deepEqual(topicsFor(db, me).map((t) => t.key), ["free_nearby", "tickets"]);
  unsubscribe(db, me, tickets!.id);
  unsubscribe(db, me, rides!.id);
  assert.deepEqual(getUserById(db, me)!.subscriptions, ["free_nearby"]);

  // A value written by older code still counts as the free topic, and leaving that topic clears it.
  updateUser(db, me, { subscriptions: JSON.stringify(["free_food", "free_stuff"]) });
  assert.deepEqual(topicsFor(db, me).map((t) => t.key), ["free_nearby"]);
  unsubscribe(db, me, free!.id);
  assert.deepEqual(getUserById(db, me)!.subscriptions, []);
  assert.deepEqual(subscriptionKeys("free_nearby"), ["free_nearby", "free_food", "free_stuff"]);
  assert.deepEqual(subscriptionKeys("pickup"), ["pickup"]);
  db.close();
});

test("old subscriptions migrate when the database opens: free food and free stuff become the first topic, events and class help are dropped", () => {
  assert.equal(migrateSubscriptions('["free_food","events"]'), '["free_nearby"]');
  assert.equal(migrateSubscriptions('["free food","free stuff"]'), '["free_nearby"]');
  assert.equal(migrateSubscriptions('["free_stuff","class_help","help others with classes"]'), '["free_nearby"]');
  assert.equal(migrateSubscriptions('["events"]'), "[]");
  assert.equal(migrateSubscriptions('["free_nearby","pickup"]'), null, "already migrated: untouched");
  assert.equal(migrateSubscriptions("not json"), "[]");

  const dir = mkdtempSync(join(tmpdir(), "troy-topics-"));
  try {
    const path = join(dir, "troy.db");
    let db = openDb(path);
    const ids = [["free_food", "events"], ["free_stuff"], ["events", "class_help"], ["free_food", "free_stuff", "pickup"], []].map((subs, i) => student(db, i, subs));
    db.close();

    db = openDb(path);
    assert.deepEqual(ids.map((id) => getUserById(db, id)!.subscriptions), [["free_nearby"], ["free_nearby"], [], ["free_nearby", "pickup"], []]);
    assert.deepEqual(topicsFor(db, ids[0]!).map((t) => t.label), ["free food and stuff nearby 🌯"]);
    assert.deepEqual(topicsFor(db, ids[2]!), [], "events and class help subscribers land on nothing");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM topics").get() as { n: number }).n, 5);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("judgeTopic: the keyword screen says no without the model; otherwise the model's ok, unsure or no", async () => {
  let calls = 0;
  let reply = '{"verdict":"ok"}';
  setModelCall(async (opts) => {
    calls++;
    assert.equal(opts.model, "fast");
    return reply;
  });
  try {
    for (const bad of ["weed plugs", "fake ids", "who's selling adderall", "guns", "hookups", "exam answers for bisc 120", "rate girls in my dorm", "tea on my ex", "stalking @jake.m", "text 213-555-0199"]) {
      assert.equal(await judgeTopic(bad), "no", bad);
      assert.ok(screenedOut(bad));
    }
    assert.equal(calls, 0, "screened topics never reach the model");

    assert.equal(await judgeTopic("meeting new friends"), "ok");
    reply = '{"verdict":"no"}';
    assert.equal(await judgeTopic("language tutors"), "no");
    reply = '{"verdict":"unsure"}';
    assert.equal(await judgeTopic("pickup basketball"), "unsure");
    reply = '{"verdict":"definitely"}';
    assert.equal(await judgeTopic("board games"), "unsure", "anything unexpected is unsure, never ok");
    reply = "sure, sounds great";
    assert.equal(await judgeTopic("board games"), "unsure");
    assert.equal(calls, 5);
    assert.equal(await judgeTopic("   "), "unsure");

    // Model unavailable: unsure, unless the screen already said no.
    setModelCall(async () => {
      throw new Error("off");
    });
    assert.equal(await judgeTopic("chess club"), "unsure");
    assert.equal(await judgeTopic("molly"), "no");
    for (const fine of ["meeting new friends", "language tutors", "pickup basketball", "study groups", "hiking", "selling a couch"]) assert.equal(screenedOut(fine), false, fine);
  } finally {
    setModelCall(null);
  }
});

test("an unsure suggestion is saved for John to review, and nothing is created", () => {
  const db = openDb(":memory:");
  const me = student(db, 1);
  saveTopicRequest(db, "underwater basket weaving", me);
  const open = openTopicRequests(db);
  assert.equal(open.length, 1);
  assert.equal(open[0]!.text, "underwater basket weaving");
  assert.equal(open[0]!.userId, me);
  assert.equal(listTopics(db).length, 5);
  db.close();
});
