import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { config } from "../src/config.ts";
import { setModelCall } from "../src/ai.ts";
import { openDb } from "../src/db/index.ts";
import type { ItemProfile, LostReport } from "../src/flows/lostfound/types.ts";
import { normalizeCategory } from "../src/flows/lostfound/types.ts";
import { categoriesCompatible, findCandidates, loadListing, matchListing, rankCandidates, scoreFallback } from "../src/flows/lostfound/match.ts";

// No test may reach the network.
config.anthropicKey = "";
afterEach(() => setModelCall(null));

// Example data only. Coordinates are rough points for the tests, not surveyed places.
const NOW = Date.UTC(2026, 10, 14, 20, 0, 0);
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const SPOT = { lat: 34.0217, lng: -118.2828 };
const SPOT_NEARBY = { lat: 34.0221, lng: -118.2832 }; // about 60 m away
const SPOT_FAR = { lat: 34.0617, lng: -118.2828 }; // about 4.4 km north

let handleN = 0;
function addUser(db: DatabaseSync): number {
  handleN++;
  const r = db.prepare("INSERT INTO users (handle, chatId, createdAt) VALUES (?, ?, ?)").run(`example${handleN}@example.com`, `chat-${handleN}`, NOW);
  return Number(r.lastInsertRowid);
}

const profile = (over: Partial<ItemProfile> = {}): ItemProfile => ({
  category: "earbuds",
  title: "airpods pro case",
  brand: "Apple",
  color: "black",
  publicSummary: "black airpods case",
  distinguishing: ["small USC sticker on the back", "initials KT engraved on the lid", "green carabiner clip"],
  nameOnItem: null,
  isValuable: true,
  isDangerous: false,
  ...over,
});

const report = (over: Partial<LostReport> = {}): LostReport => ({
  category: "earbuds",
  description: "lost my black airpods near leavey yesterday",
  color: "black",
  brand: null,
  locationText: "leavey",
  happenedAt: NOW - 20 * HOUR,
  ...over,
});

type ListingOpts = { userId?: number; locationText?: string | null; lat?: number | null; lng?: number | null; happenedAt?: number | null; status?: string; createdAt?: number; category?: string | null };

function addFound(db: DatabaseSync, p: ItemProfile, o: ListingOpts = {}): number {
  const r = db
    .prepare("INSERT INTO listings (userId, type, category, title, details, locationText, lat, lng, happenedAt, status, isExample, createdAt) VALUES (?, 'found', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
    .run(o.userId ?? addUser(db), o.category === undefined ? p.category : o.category, p.title, JSON.stringify(p), o.locationText === undefined ? "leavey library" : o.locationText, o.lat === undefined ? SPOT.lat : o.lat, o.lng === undefined ? SPOT.lng : o.lng, o.happenedAt === undefined ? NOW - 2 * HOUR : o.happenedAt, o.status ?? "open", o.createdAt ?? NOW);
  return Number(r.lastInsertRowid);
}

function addLost(db: DatabaseSync, rep: LostReport, o: ListingOpts = {}): number {
  const r = db
    .prepare("INSERT INTO listings (userId, type, category, title, details, locationText, lat, lng, happenedAt, status, isExample, createdAt) VALUES (?, 'lost', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
    .run(o.userId ?? addUser(db), o.category === undefined ? rep.category : o.category, rep.description.slice(0, 40), JSON.stringify(rep), o.locationText === undefined ? rep.locationText : o.locationText, o.lat === undefined ? SPOT_NEARBY.lat : o.lat, o.lng === undefined ? SPOT_NEARBY.lng : o.lng, o.happenedAt === undefined ? rep.happenedAt : o.happenedAt, o.status ?? "open", o.createdAt ?? NOW);
  return Number(r.lastInsertRowid);
}

const ids = (rows: { id: number }[]) => rows.map((r) => r.id).sort((a, b) => a - b);

// ---------- categories ----------

test("normalizeCategory maps loose words and unknowns", () => {
  assert.equal(normalizeCategory("Water Bottle"), "water_bottle");
  assert.equal(normalizeCategory("id"), "id_card");
  assert.equal(normalizeCategory("bottle"), "water_bottle");
  assert.equal(normalizeCategory("wheels"), "scooter");
  assert.equal(normalizeCategory("spaceship"), "other");
  assert.equal(normalizeCategory(null), "other");
});

test("category compatibility map", () => {
  assert.equal(categoriesCompatible("wallet", "id_card"), true);
  assert.equal(categoriesCompatible("laptop", "tablet"), true);
  assert.equal(categoriesCompatible("earbuds", "charger"), false);
  assert.equal(categoriesCompatible("phone", "keys"), false);
  assert.equal(categoriesCompatible("other", "phone"), true);
  assert.equal(categoriesCompatible(null, "umbrella"), true);
});

// ---------- candidates ----------

test("loadListing parses details and skips rides", () => {
  const db = openDb(":memory:");
  const f = addFound(db, profile());
  const l = loadListing(db, f)!;
  assert.equal(l.type, "found");
  assert.deepEqual((l.details as ItemProfile).distinguishing.length, 3);
  const u = addUser(db);
  const ride = Number(db.prepare("INSERT INTO listings (userId, type, createdAt) VALUES (?, 'ride', ?)").run(u, NOW).lastInsertRowid);
  assert.equal(loadListing(db, ride), null);
  assert.equal(loadListing(db, 9999), null);
});

test("candidates: opposite type, open or matched, compatible category", () => {
  const db = openDb(":memory:");
  const lost = addLost(db, report());
  const sameCat = addFound(db, profile());
  const matched = addFound(db, profile(), { status: "matched" });
  const other = addFound(db, profile({ category: "other", title: "small white case" }));
  addFound(db, profile({ category: "charger", title: "usb c charger" }));
  addFound(db, profile(), { status: "returned" });
  addFound(db, profile(), { status: "verifying" });
  addLost(db, report()); // same type, never a candidate
  const got = findCandidates(db, loadListing(db, lost)!);
  assert.deepEqual(ids(got), [sameCat, matched, other].sort((a, b) => a - b));
});

test("candidates: wallet and id card are a compatible pair", () => {
  const db = openDb(":memory:");
  const lost = addLost(db, report({ category: "wallet", description: "lost my brown wallet at leavey" }));
  const card = addFound(db, profile({ category: "id_card", title: "usc id card", distinguishing: [], brand: null }));
  assert.deepEqual(ids(findCandidates(db, loadListing(db, lost)!)), [card]);
});

test("candidates: a person never matches their own listing", () => {
  const db = openDb(":memory:");
  const u = addUser(db);
  const lost = addLost(db, report(), { userId: u });
  addFound(db, profile(), { userId: u });
  assert.equal(findCandidates(db, loadListing(db, lost)!).length, 0);
});

test("candidates: 7 day window", () => {
  const db = openDb(":memory:");
  const lost = addLost(db, report({ happenedAt: NOW - 1 * DAY }));
  const inside = addFound(db, profile(), { happenedAt: NOW - 1 * DAY + 6 * DAY });
  addFound(db, profile(), { happenedAt: NOW - 1 * DAY - 8 * DAY });
  // No happenedAt: falls back to createdAt.
  addFound(db, profile(), { happenedAt: null, createdAt: NOW + 9 * DAY });
  const viaCreated = addFound(db, profile(), { happenedAt: null, createdAt: NOW });
  assert.deepEqual(ids(findCandidates(db, loadListing(db, lost)!)), [inside, viaCreated].sort((a, b) => a - b));
});

test("candidates: distance with coordinates, place words without", () => {
  const db = openDb(":memory:");
  const lost = addLost(db, report());
  const near = addFound(db, profile());
  addFound(db, profile(), { lat: SPOT_FAR.lat, lng: SPOT_FAR.lng });
  assert.deepEqual(ids(findCandidates(db, loadListing(db, lost)!)), [near]);

  const db2 = openDb(":memory:");
  const lost2 = addLost(db2, report(), { lat: null, lng: null, locationText: "near leavey" });
  const samePlace = addFound(db2, profile(), { lat: null, lng: null, locationText: "leavey library 2nd floor" });
  addFound(db2, profile(), { lat: null, lng: null, locationText: "doheny library" });
  const noPlace = addFound(db2, profile(), { lat: null, lng: null, locationText: null });
  assert.deepEqual(ids(findCandidates(db2, loadListing(db2, lost2)!)), [samePlace, noPlace].sort((a, b) => a - b));
});

test("candidates: a claimant who failed verification can't try the same item again", () => {
  const db = openDb(":memory:");
  const claimant = addUser(db);
  const found = addFound(db, profile());
  const otherFound = addFound(db, profile());
  const firstTry = addLost(db, report(), { userId: claimant });
  const m = Number(db.prepare("INSERT INTO matches (foundListingId, lostListingId, confidence, status, createdAt) VALUES (?, ?, 85, 'rejected', ?)").run(found, firstTry, NOW).lastInsertRowid);
  db.prepare("INSERT INTO verifications (matchId, method, ownerAnswer, score, result, attempts, createdAt) VALUES (?, 'blind_description', 'example wrong answer', 10, 'fail', 2, ?)").run(m, NOW);

  // A fresh report from the same person still can't reach that found item, but can reach others.
  const secondTry = addLost(db, report(), { userId: claimant });
  assert.deepEqual(ids(findCandidates(db, loadListing(db, secondTry)!)), [otherFound]);

  // From the found side: the failed claimant's listings are out, someone else's is in.
  const someoneElse = addLost(db, report());
  assert.deepEqual(ids(findCandidates(db, loadListing(db, found)!)), [someoneElse]);
});

test("candidates: a rejected match without a failed verification only blocks that pair", () => {
  const db = openDb(":memory:");
  const claimant = addUser(db);
  const found = addFound(db, profile());
  const first = addLost(db, report(), { userId: claimant });
  db.prepare("INSERT INTO matches (foundListingId, lostListingId, confidence, status, createdAt) VALUES (?, ?, 60, 'rejected', ?)").run(found, first, NOW);
  const second = addLost(db, report(), { userId: claimant });
  assert.deepEqual(ids(findCandidates(db, loadListing(db, found)!)), [second]);
});

// ---------- rule score ----------

function pairScore(p: ItemProfile, r: LostReport, lostOpts: ListingOpts = {}, foundOpts: ListingOpts = {}) {
  const db = openDb(":memory:");
  const f = loadListing(db, addFound(db, p, foundOpts))!;
  const l = loadListing(db, addLost(db, r, lostOpts))!;
  return scoreFallback(f, l);
}

test("fallback: a clear match scores 80 or more", () => {
  const s = pairScore(profile(), report({ description: "black airpods pro, has a usc sticker on the back and a green carabiner", brand: "apple" }));
  assert.ok(s.confidence >= 80, `got ${s.confidence}`);
  assert.ok(s.reasons.length >= 3);
});

test("fallback: an identical generic item lands in the middle band", () => {
  const s = pairScore(profile(), report({ brand: "apple" }));
  assert.ok(s.confidence >= 50 && s.confidence <= 79, `got ${s.confidence}`);
  // Even with every generic signal lined up, nothing distinctive in common means no straight-to-verify.
  const plain = pairScore(profile({ distinguishing: [] }), report({ brand: "apple", description: "black apple airpods in the case, lost at leavey" }));
  assert.ok(plain.confidence >= 50 && plain.confidence <= 79, `got ${plain.confidence}`);
});

test("fallback: common words like 'case' don't count as a distinctive detail", () => {
  const s = pairScore(profile(), report({ brand: "apple", description: "black airpods in a small case with a sticker" }));
  assert.ok(s.confidence <= 79, `got ${s.confidence}`);
});

test("fallback: generic shared words like 'sticker' and 'lid' can't push two different items to 80", () => {
  // Same kind, color, brand, place and day, and both "have a sticker on the lid", but nothing says it's the same sticker.
  const found = profile({ category: "laptop", title: "macbook", color: "silver", publicSummary: "silver macbook", distinguishing: ["sticker of a sailboat on the lid", "sticker of a lighthouse on the lid", "scratch on the bottom corner"] });
  const other = pairScore(found, report({ category: "laptop", color: "silver", brand: "apple", description: "silver macbook, lots of stickers on the lid, small scratch on the corner, charger was with it" }));
  assert.ok(other.confidence <= 79, `got ${other.confidence}`);
  assert.ok(other.reasons.some((r) => r.includes("nothing distinctive")));
  // Naming which sticker does lift it.
  const same = pairScore(found, report({ category: "laptop", color: "silver", brand: "apple", description: "silver macbook with a sailboat sticker and a lighthouse one on the lid" }));
  assert.ok(same.confidence >= 80, `got ${same.confidence}`);
});

test("fallback: a detail the report says is absent is not a shared detail", () => {
  const found = profile({ distinguishing: ["monogram stitched on the pouch"] });
  const s = pairScore(found, report({ brand: "apple", description: "black airpods, no monogram or anything on them" }));
  assert.ok(s.confidence <= 79, `got ${s.confidence}`);
});

test("fallback: typos-free synonyms and word forms count as the same detail", () => {
  const found = profile({ distinguishing: ["initials engraved underneath", "lavender charm"] });
  const s = pairScore(found, report({ brand: "apple", description: "black airpods with an engraving of my initials" }));
  assert.ok(s.confidence >= 80, `got ${s.confidence}`);
});

test("fallback: a mismatch scores under 50", () => {
  const s = pairScore(profile({ color: "white", brand: "Samsung", title: "galaxy buds case", publicSummary: "white samsung earbuds case", distinguishing: ["cat sticker"] }), report({ brand: "apple" }));
  assert.ok(s.confidence < 50, `got ${s.confidence}`);
  const wrongKind = pairScore(profile(), report({ category: "umbrella", description: "black umbrella lost at leavey" }));
  assert.ok(wrongKind.confidence < 50, `got ${wrongKind.confidence}`);
});

test("fallback: same kind and nothing else stays under 50", () => {
  const s = pairScore(profile(), report({ description: "lost my earbuds", color: null, locationText: null }), { lat: null, lng: null, happenedAt: NOW - 5 * DAY });
  assert.ok(s.confidence < 50, `got ${s.confidence}`);
});

test("fallback: reasons never quote hidden details", () => {
  const s = pairScore(profile({ nameOnItem: "Example Person" }), report({ description: "black airpods, usc sticker, green carabiner, KT engraved" }));
  const text = s.reasons.join(" ").toLowerCase();
  for (const hidden of ["usc", "carabiner", "kt", "engraved", "example person"]) assert.ok(!text.includes(hidden), `leaked ${hidden}`);
});

test("fallback: deterministic", () => {
  const a = pairScore(profile(), report());
  const b = pairScore(profile(), report());
  assert.deepEqual(a, b);
});

// ---------- ranking ----------

test("rankCandidates: useAi false uses the fallback, best first", async () => {
  const db = openDb(":memory:");
  const lost = loadListing(db, addLost(db, report({ description: "black airpods with a usc sticker and a green carabiner", brand: "apple" })))!;
  const good = addFound(db, profile());
  const bad = addFound(db, profile({ color: "white", brand: "Samsung", publicSummary: "white earbuds", title: "galaxy buds", distinguishing: [] }));
  const ranked = await rankCandidates(lost, findCandidates(db, lost), { useAi: false });
  assert.deepEqual(ranked.map((r) => r.candidateId), [good, bad]);
  assert.ok(ranked.every((r) => r.source === "fallback"));
  assert.ok(ranked[0]!.confidence >= 80 && ranked[1]!.confidence < 50);
});

test("rankCandidates: uses the model's scores, clamps them, and fills gaps with the fallback", async () => {
  const db = openDb(":memory:");
  const lost = loadListing(db, addLost(db, report()))!;
  const a = addFound(db, profile());
  const b = addFound(db, profile());
  let sawHidden = false;
  setModelCall(async (opts) => {
    sawHidden = opts.prompt.includes("USC sticker") && opts.model === "smart";
    return JSON.stringify({ results: [{ candidateId: a, confidence: 250, reasons: ["a specific detail matches"] }, { candidateId: 424242, confidence: 99, reasons: [] }] });
  });
  const ranked = await rankCandidates(lost, findCandidates(db, lost));
  assert.equal(sawHidden, true);
  const ra = ranked.find((r) => r.candidateId === a)!;
  const rb = ranked.find((r) => r.candidateId === b)!;
  assert.deepEqual([ra.confidence, ra.source], [100, "ai"]);
  assert.equal(rb.source, "fallback");
  assert.equal(ranked.length, 2);
});

test("rankCandidates: malformed or failed model output falls back", async () => {
  const db = openDb(":memory:");
  const lost = loadListing(db, addLost(db, report()))!;
  addFound(db, profile());
  setModelCall(async () => "sure! here you go");
  const junk = await rankCandidates(lost, findCandidates(db, lost));
  assert.equal(junk[0]!.source, "fallback");
  setModelCall(async () => JSON.stringify({ results: "nope" }));
  assert.equal((await rankCandidates(lost, findCandidates(db, lost)))[0]!.source, "fallback");
  setModelCall(async () => {
    throw new Error("boom");
  });
  assert.equal((await rankCandidates(lost, findCandidates(db, lost)))[0]!.source, "fallback");
});

// ---------- two-sided matching ----------

test("matchListing: two-sided, one row per pair, idempotent, keeps status", async () => {
  const db = openDb(":memory:");
  const found = addFound(db, profile());
  const lostA = addLost(db, report({ description: "black airpods with a usc sticker and a green carabiner", brand: "apple" }));
  const lostB = addLost(db, report());
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM matches").get() as { n: number }).n;

  const fromFound = await matchListing(db, found, { useAi: false });
  assert.equal(fromFound.length, 2);
  assert.equal(count(), 2);
  assert.deepEqual(fromFound.map((m) => m.lostListingId), [lostA, lostB]);
  assert.ok(fromFound[0]!.confidence >= fromFound[1]!.confidence);
  assert.ok(fromFound.every((m) => m.foundListingId === found && m.source === "fallback"));

  // The same pair seen from the lost side reuses the row.
  const fromLost = await matchListing(db, lostA, { useAi: false });
  assert.equal(fromLost.length, 1);
  assert.equal(fromLost[0]!.matchId, fromFound[0]!.matchId);
  assert.equal(count(), 2);

  // Re-running keeps whatever status the handler has moved the row to.
  db.prepare("UPDATE matches SET status = 'verifying' WHERE id = ?").run(fromFound[0]!.matchId);
  await matchListing(db, found, { useAi: false });
  await matchListing(db, lostB, { useAi: false });
  assert.equal(count(), 2);
  const row = db.prepare("SELECT status, confidence, reasons, source FROM matches WHERE id = ?").get(fromFound[0]!.matchId) as { status: string; confidence: number; reasons: string; source: string };
  assert.equal(row.status, "verifying");
  assert.equal(row.confidence, fromFound[0]!.confidence);
  assert.ok(Array.isArray(JSON.parse(row.reasons)));
});

test("matchListing: nothing for a missing, closed or candidate-less listing", async () => {
  const db = openDb(":memory:");
  assert.deepEqual(await matchListing(db, 123, { useAi: false }), []);
  const lonely = addLost(db, report());
  assert.deepEqual(await matchListing(db, lonely, { useAi: false }), []);
  const closed = addFound(db, profile(), { status: "returned" });
  assert.deepEqual(await matchListing(db, closed, { useAi: false }), []);
});
