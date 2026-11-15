// Quick lookup: the off switch, the blocked categories, the daily cap, the cache and the timeout. No network.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { openDb } from "../src/db/index.ts";
import { quickLookup as fromAi } from "../src/ai.ts";
import { LOOKUP_CACHE_MS, LOOKUP_DAILY_CAP, clearLookupCache, lookupBlocked, lookupsToday, normalizeQuestion, quickLookup, setLookupSearch, setLookupTiming } from "../src/lookup.ts";

config.anthropicKey = "";

const LEAVEY = { text: "Leavey Library is open 24 hours during the fall semester.", sources: [{ url: "https://libraries.usc.edu/locations/leavey-library", title: "Leavey Library | USC Libraries" }] };
let calls: string[] = [];
const answerWith = (out: typeof LEAVEY | null) =>
  setLookupSearch(async ({ question }) => {
    calls.push(question);
    return out;
  });

beforeEach(() => {
  process.env.TROY_LOOKUP = "on";
  calls = [];
  clearLookupCache();
  setLookupTiming();
  answerWith(LEAVEY);
});
afterEach(() => {
  delete process.env.TROY_LOOKUP;
  setLookupSearch(null);
  setLookupTiming();
});

test("returns a short answer with its official source, and ai.ts re-exports it", async () => {
  const db = openDb(":memory:");
  assert.equal(fromAi, quickLookup);
  assert.deepEqual(await quickLookup({ question: "is leavey open all night?", userId: 1, db }), {
    answer: "Leavey Library is open 24 hours during the fall semester.",
    sourceUrl: "https://libraries.usc.edu/locations/leavey-library",
    sourceTitle: "Leavey Library | USC Libraries",
  });
  assert.equal(lookupsToday(db, 1), 1);
});

test("off unless TROY_LOOKUP is on", async () => {
  const db = openDb(":memory:");
  for (const v of [undefined, "", "off", "true", "yes"]) {
    if (v === undefined) delete process.env.TROY_LOOKUP;
    else process.env.TROY_LOOKUP = v;
    assert.equal(await quickLookup({ question: "is leavey open all night?", userId: 1, db }), null);
  }
  assert.deepEqual(calls, []);
  assert.equal(lookupsToday(db, 1), 0);
  // With lookups on but no key and no injected search, the real call returns null without touching the network.
  process.env.TROY_LOOKUP = "ON";
  setLookupSearch(null);
  assert.equal(await quickLookup({ question: "is leavey open all night?", userId: 1, db }), null);
});

test("never used for hard rules, another person, or medical, legal, visa and financial-aid decisions", async () => {
  const db = openDb(":memory:");
  const blocked: [string, string][] = [
    ["what's the phone number for housing", "hard_rule"],
    ["when does the lax shuttle run this year", "hard_rule"],
    ["what's the pickup code for the wallet", "hard_rule"],
    ["how does usg club funding work", "hard_rule"],
    ["there's a fire in my dorm what do i do", "hard_rule"],
    ["who is jordan lee in my econ class", "person"],
    ["what's my roommate's class schedule", "person"],
    ["where does this guy live", "person"],
    ["should i take my adderall prescription before the exam", "sensitive"],
    ["can my landlord evict me", "sensitive"],
    ["can i work off campus on my f-1 visa", "sensitive"],
    ["when can i start opt", "sensitive"],
    ["will dropping a class change my financial aid", "sensitive"],
    ["is my scholarship taxable", "sensitive"],
  ];
  for (const [q, why] of blocked) {
    assert.equal(lookupBlocked(q), why, q);
    assert.equal(await quickLookup({ question: q, userId: 1, db }), null, q);
  }
  assert.deepEqual(calls, []);
  assert.equal(lookupsToday(db, 1), 0);
  for (const q of ["is leavey open all night?", "where is the registrar's office", "what time does the village gym close on sundays", "how do i opt out of the meal plan"]) assert.equal(lookupBlocked(q), null, q);
  // Too short or far too long to be one factual question.
  assert.equal(await quickLookup({ question: "why", userId: 1, db }), null);
  assert.equal(await quickLookup({ question: `where is ${"the place ".repeat(60)}`, userId: 1, db }), null);
  assert.deepEqual(calls, []);
});

test("at most 8 lookups per student per day, counted in the database with no question text", async () => {
  const db = openDb(":memory:");
  let now = Date.UTC(2026, 10, 14, 20, 0, 0); // noon in los angeles
  setLookupTiming({ now: () => now });
  for (let i = 0; i < LOOKUP_DAILY_CAP; i++) assert.ok(await quickLookup({ question: `what floor is study room ${i} on in leavey`, userId: 1, db }));
  assert.equal(await quickLookup({ question: "what floor is the last study room on in leavey", userId: 1, db }), null);
  assert.equal(calls.length, LOOKUP_DAILY_CAP);
  assert.equal(lookupsToday(db, 1), LOOKUP_DAILY_CAP);
  // Another student has their own count.
  assert.ok(await quickLookup({ question: "what floor is the last study room on in leavey", userId: 2, db }));
  // Nothing but a number is stored.
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'lookup:%' ORDER BY key").all() as { key: string; value: string }[];
  assert.deepEqual(rows.map((r) => `${r.key}=${r.value}`), ["lookup:1:2026-11-14=8", "lookup:2:2026-11-14=1"]);
  const dump = JSON.stringify(db.prepare("SELECT * FROM settings").all());
  assert.ok(!/study room|leavey/.test(dump));
  // The next campus day starts fresh and drops the old row.
  now += 24 * 60 * 60 * 1000;
  assert.equal(lookupsToday(db, 1), 0);
  assert.ok(await quickLookup({ question: "what floor is the quiet study room on in doheny", userId: 1, db }));
  assert.deepEqual((db.prepare("SELECT key FROM settings WHERE key LIKE 'lookup:1:%'").all() as { key: string }[]).map((r) => r.key), ["lookup:1:2026-11-15"]);
});

test("a tiny cache by normalized question for an hour: no second search, no second count", async () => {
  const db = openDb(":memory:");
  let now = 1_800_000_000_000;
  setLookupTiming({ now: () => now });
  assert.equal(normalizeQuestion("Hey troy, is Leavey open all night??"), normalizeQuestion("is leavey open all night"));
  const first = await quickLookup({ question: "is leavey open all night?", userId: 1, db });
  const again = await quickLookup({ question: "Hey troy, is Leavey open all night??", userId: 2, db });
  assert.deepEqual(again, first);
  assert.equal(calls.length, 1);
  assert.equal(lookupsToday(db, 2), 0);
  // "nothing found" is remembered too.
  answerWith({ text: "NONE", sources: [] });
  assert.equal(await quickLookup({ question: "what color is the 4th floor carpet in taper", userId: 1, db }), null);
  assert.equal(await quickLookup({ question: "what color is the 4th floor carpet in taper", userId: 1, db }), null);
  assert.equal(calls.length, 2);
  // After an hour it is asked again.
  now += LOOKUP_CACHE_MS + 1;
  answerWith(LEAVEY);
  assert.ok(await quickLookup({ question: "is leavey open all night?", userId: 1, db }));
  assert.equal(calls.length, 3);
});

test("a search that hangs is cut off, counted, and not cached", async () => {
  const db = openDb(":memory:");
  setLookupTiming({ timeoutMs: 25 });
  setLookupSearch(() => new Promise(() => {}));
  const started = Date.now();
  assert.equal(await quickLookup({ question: "is leavey open all night?", userId: 1, db }), null);
  assert.ok(Date.now() - started < 1000);
  assert.equal(lookupsToday(db, 1), 1);
  // A failure or a throw is the same: null now, a fresh try next time.
  setLookupSearch(async () => { throw new Error("boom"); });
  assert.equal(await quickLookup({ question: "is leavey open all night?", userId: 1, db }), null);
  answerWith(LEAVEY);
  assert.ok(await quickLookup({ question: "is leavey open all night?", userId: 1, db }));
  assert.equal(lookupsToday(db, 1), 3);
});

test("only an official usc page counts as a source, and the answer is trimmed to two sentences", async () => {
  const db = openDb(":memory:");
  answerWith({ text: "It closes at 10pm.", sources: [{ url: "https://usc.edu.evil.example/hours", title: "hours" }, { url: "https://www.reddit.com/r/USC", title: "reddit" }] });
  assert.equal(await quickLookup({ question: "when does the bookstore close on fridays", userId: 1, db }), null);
  answerWith({ text: "It closes at 10pm.", sources: [] });
  assert.equal(await quickLookup({ question: "when does the bookstore close on saturdays", userId: 1, db }), null);
  answerWith({
    text: "I'll search for that. The **USC Bookstore** closes at 6pm on Sundays ([hours](https://bookstore.usc.edu/hours)). It opens at 10am. It also sells snacks. And hoodies.",
    sources: [{ url: "https://www.example.com/x", title: "nope" }, { url: "http://bookstore.usc.edu/hours#sunday", title: "  Store   Hours " }],
  });
  assert.deepEqual(await quickLookup({ question: "when does the bookstore close on sundays", userId: 1, db }), {
    answer: "The USC Bookstore closes at 6pm on Sundays (hours). It opens at 10am.",
    sourceUrl: "https://bookstore.usc.edu/hours",
    sourceTitle: "Store Hours",
  });
});
