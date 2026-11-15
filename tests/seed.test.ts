import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { seed } from "../src/db/seed.ts";

type Row = Record<string, unknown>;

const DATA = join(import.meta.dirname, "../src/db/seed-data");
const CATEGORIES = ["phone", "earbuds", "laptop", "tablet", "wallet", "id_card", "keys", "water_bottle", "bag", "clothing", "jewelry", "glasses", "charger", "book", "umbrella", "scooter", "other"];
const NOW = Date.UTC(2026, 10, 14, 20, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

function file<T>(name: string): T[] {
  return JSON.parse(readFileSync(join(DATA, name), "utf8")) as T[];
}

function seeded() {
  const db = openDb(":memory:");
  const counts = seed(db, { now: NOW });
  return { db, counts };
}

test("seeding twice gives the same counts", () => {
  const { db, counts } = seeded();
  const again = seed(db, { now: NOW + 3 * 60 * 60 * 1000 });
  assert.deepEqual(again, counts);
  assert.equal(counts.users, 12);
  assert.ok(counts.listings >= 26 && counts.listings <= 30, `listings ${counts.listings}`);
  assert.equal(counts.food_drops, 2);
  assert.equal(counts.reports, 9);
  assert.ok(counts.campus_places >= 45);
  assert.equal(counts.directory, file<unknown>("offices.json").length + file<unknown>("campus-offices.json").length + file<unknown>("directory.json").length);
});

test("the twelve campus offices load into the directory as real rows, once", () => {
  const { db } = seeded();
  const wanted = file<{ kind: string; name: string; url: string; contactMethod: string; details: string; isExample: boolean }>("campus-offices.json");
  assert.equal(wanted.length, 12);
  seed(db, { now: NOW });
  for (const w of wanted) {
    const rows = db.prepare("SELECT * FROM directory WHERE name = ?").all(w.name) as Row[];
    assert.equal(rows.length, 1, w.name);
    assert.equal(rows[0].kind, "office");
    assert.equal(rows[0].isExample, 0);
    assert.equal(rows[0].url, w.url);
    assert.equal(rows[0].contactMethod, w.contactMethod);
    assert.equal(rows[0].details, w.details);
    assert.ok((JSON.parse(rows[0].topics as string) as string[]).length > 0);
  }
  // Repairs still route to the same two offices.
  const repairOffices = (db.prepare("SELECT name FROM directory WHERE kind = 'office' AND (name LIKE '%FMS%' OR name LIKE '%Housing%')").all() as Row[]).map((r) => r.name);
  assert.deepEqual(repairOffices.sort(), ["Facilities Management Services (FMS)", "USC Housing maintenance"]);
});

test("example staff contacts are added only when asked, only for example handles, and never widen the allow-list", () => {
  const { db } = seeded();
  const has = () => !!db.prepare("SELECT name FROM sqlite_master WHERE name = 'staff_contacts'").get();
  // The default (SEED_EXAMPLES is not set in tests): none.
  assert.equal(has() ? (db.prepare("SELECT COUNT(*) AS n FROM staff_contacts").get() as Row).n : 0, 0);

  seed(db, { now: NOW, exampleStaff: true });
  seed(db, { now: NOW, exampleStaff: true });
  const staff = db.prepare("SELECT s.role, s.handle, s.isExample, u.isExample AS userExample FROM staff_contacts s JOIN users u ON u.id = s.userId ORDER BY s.role").all() as Row[];
  assert.equal(staff.length, 2);
  assert.deepEqual(staff.map((s) => s.role), ["fms", "usg:USG Committee on Sustainability and Campus Infrastructure"]);
  for (const s of staff) {
    assert.equal(s.isExample, 1);
    assert.equal(s.userExample, 1);
    assert.match(s.handle as string, /^\+121355501[1-4]\d$/);
  }
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM allow_list").get() as Row).n, 0);

  // A phone John assigned himself is never replaced by the example one.
  db.prepare("UPDATE staff_contacts SET handle = '+13105550123', userId = NULL WHERE role = 'fms'").run();
  seed(db, { now: NOW, exampleStaff: true });
  assert.equal((db.prepare("SELECT handle FROM staff_contacts WHERE role = 'fms'").get() as Row).handle, "+13105550123");

  // A handle that belongs to a real person is never made a staff contact by the seed.
  const fresh = openDb(":memory:");
  fresh.prepare("INSERT INTO users (handle, chatId, name, createdAt) VALUES ('+12135550119', 'c1', 'real person', 1)").run();
  seed(fresh, { now: NOW, exampleStaff: true });
  assert.equal((fresh.prepare("SELECT COUNT(*) AS n FROM staff_contacts WHERE role = 'fms'").get() as Row).n, 0);
});

test("every example row is labeled, and example handles are the reserved 555 range", () => {
  const { db } = seeded();
  for (const table of ["users", "listings", "food_drops", "reports"]) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE isExample != 1`).get() as { n: number }).n;
    assert.equal(n, 0, `${table} has unlabeled rows`);
  }
  for (const u of db.prepare("SELECT * FROM users").all() as Row[]) {
    assert.match(u.handle as string, /^\+121355501[1-4]\d$/);
    assert.ok(u.verifiedAt !== null && u.verifiedVia === "usc_email");
    assert.ok(Array.isArray(JSON.parse(u.subscriptions as string)));
    assert.ok(Array.isArray(JSON.parse(u.usualSpots as string)));
  }
  const subscribed = (db.prepare("SELECT * FROM users").all() as Row[]).filter((u) => JSON.parse(u.subscriptions as string).includes("free_food"));
  assert.ok(subscribed.length >= 4);
  assert.ok(subscribed.some((u) => JSON.parse(u.usualSpots as string).length > 0));
});

test("every listing's details parses and has the required fields", () => {
  const { db } = seeded();
  const rows = db.prepare("SELECT * FROM listings").all() as Row[];
  let found = 0;
  let lost = 0;
  for (const r of rows) {
    const d = JSON.parse(r.details as string) as Row;
    assert.ok(typeof r.title === "string" && r.title.length > 0);
    assert.ok(r.happenedAt as number <= NOW && (r.happenedAt as number) >= NOW - 6 * DAY, `${r.title} is outside the last 6 days`);
    assert.ok((r.createdAt as number) <= NOW && (r.createdAt as number) >= (r.happenedAt as number));
    assert.ok(typeof r.lat === "number" && typeof r.lng === "number", `${r.title} at "${r.locationText}" has no coordinates`);
    if (r.type === "found") {
      found++;
      assert.ok(CATEGORIES.includes(d.category as string), `${r.title} category`);
      assert.equal(d.category, r.category);
      assert.equal(d.title, r.title);
      assert.ok(d.brand === null || typeof d.brand === "string");
      assert.ok(d.color === null || typeof d.color === "string");
      assert.ok(typeof d.publicSummary === "string" && d.publicSummary.length > 0);
      assert.ok(Array.isArray(d.distinguishing) && d.distinguishing.length > 0 && d.distinguishing.every((x) => typeof x === "string"));
      assert.ok(d.nameOnItem === null || typeof d.nameOnItem === "string");
      assert.equal(typeof d.isValuable, "boolean");
      assert.equal(typeof d.isDangerous, "boolean");
      assert.equal(!!r.isDangerous, d.isDangerous);
      assert.ok(r.heldBy === "finder" || r.heldBy === "dps");
      // Hidden details must never leak into what a claimant can see.
      const summary = (d.publicSummary as string).toLowerCase();
      for (const hidden of d.distinguishing as string[]) assert.ok(!summary.includes(hidden.toLowerCase()));
      if (d.nameOnItem) assert.ok(!summary.includes((d.nameOnItem as string).toLowerCase()));
    } else {
      lost++;
      assert.equal(r.type, "lost");
      assert.ok(d.category === null || CATEGORIES.includes(d.category as string));
      assert.ok(typeof d.description === "string" && d.description.length > 0);
      assert.ok(d.color === null || typeof d.color === "string");
      assert.ok(d.brand === null || typeof d.brand === "string");
      assert.ok(d.locationText === null || typeof d.locationText === "string");
      assert.equal(d.happenedAt, r.happenedAt);
      assert.equal(r.heldBy, null);
    }
  }
  assert.ok(found >= 10 && lost >= 10, `found ${found}, lost ${lost}`);
});

test("the listings include the cases the demo and the eval need", () => {
  const { db } = seeded();
  const rows = (db.prepare("SELECT l.*, u.name AS userName FROM listings l JOIN users u ON u.id = l.userId").all() as Row[]).map((r): Row & { d: Row } => ({ ...r, d: JSON.parse(r.details as string) as Row }));
  const found = rows.filter((r) => r.type === "found");
  const lost = rows.filter((r) => r.type === "lost");

  // Look-alikes: two black AirPods cases with different hidden details.
  const airpods = found.filter((r) => r.d.publicSummary === "black airpods case");
  assert.equal(airpods.length, 2);
  assert.notDeepEqual(airpods[0]!.d.distinguishing, airpods[1]!.d.distinguishing);

  // A wallet with a name on it, and the person with that name reported a wallet lost.
  const wallet = found.find((r) => r.category === "wallet" && r.d.nameOnItem);
  assert.ok(wallet);
  assert.ok(lost.some((r) => r.category === "wallet" && r.userName === wallet.d.nameOnItem));

  // One dangerous item, held by DPS, never open for a student handoff.
  const dangerous = found.filter((r) => r.isDangerous === 1);
  assert.equal(dangerous.length, 1);
  assert.equal(dangerous[0]!.heldBy, "dps");
  assert.notEqual(dangerous[0]!.status, "open");

  // Nobody is on both sides of a true pair.
  for (const f of found) for (const l of lost) if (f.title === l.title) assert.notEqual(f.userId, l.userId);
});

test("food drops and reports are consistent", () => {
  const { db } = seeded();
  const drops = db.prepare("SELECT * FROM food_drops").all() as Row[];
  assert.equal(drops.filter((d) => d.status === "live").length, 1);
  for (const d of drops) {
    assert.ok((d.servingsLeft as number) >= 0 && (d.servingsLeft as number) <= (d.servingsTotal as number));
    assert.ok(typeof d.lat === "number" && typeof d.lng === "number");
    assert.ok((d.createdAt as number) <= NOW);
    if (d.status === "live") assert.ok((d.expiresAt as number) > NOW);
  }
  const reports = db.prepare("SELECT * FROM reports").all() as Row[];
  const repairs = reports.filter((r) => r.kind === "repair");
  const concerns = reports.filter((r) => r.kind === "usg_concern");
  assert.equal(repairs.length, 5);
  assert.equal(concerns.length, 4);
  assert.deepEqual([...new Set(repairs.map((r) => r.routedTo))].sort(), ["FMS", "Housing"]);
  assert.ok(new Set(repairs.map((r) => r.status)).size >= 3);
  assert.equal(new Set(concerns.map((r) => r.status)).size, 4);
  const userIds = new Set((db.prepare("SELECT id FROM users").all() as Row[]).map((u) => u.id));
  for (const r of reports) for (const id of JSON.parse(r.followers as string) as number[]) assert.ok(userIds.has(id));
  if (existsSync(join(DATA, "directory.json"))) {
    const names = new Set((db.prepare("SELECT name FROM directory WHERE kind = 'usg_committee'").all() as Row[]).map((d) => d.name));
    for (const c of concerns) assert.ok(names.has(c.routedTo), `"${c.routedTo}" is not a committee in the directory`);
  }
});

test("offices are in the directory with confirmed contact details", () => {
  const { db } = seeded();
  const offices = db.prepare("SELECT * FROM directory WHERE kind = 'office'").all() as Row[];
  // The three offices reports are routed to, plus the twelve verified campus offices.
  assert.equal(offices.length, 15);
  for (const o of offices) {
    assert.match(o.url as string, /^https:\/\/[a-z]+\.usc\.edu\//);
    assert.ok(o.contactMethod);
    assert.equal(o.isExample, 0);
  }
  const dps = offices.find((o) => o.name === "DPS Lost & Found")!;
  assert.ok((dps.details as string).includes("3667 McClintock Ave"));
  assert.ok((dps.details as string).includes("90 days"));
  assert.ok((dps.contactMethod as string).includes("213-740-9759"));
});

test("real rows are never touched, and reset only clears examples", () => {
  const { db } = seeded();
  db.prepare("INSERT INTO users (handle, chatId, name, createdAt) VALUES ('+13105550199', 'c1', 'real person', 1)").run();
  const realId = (db.prepare("SELECT id FROM users WHERE handle = '+13105550199'").get() as Row).id as number;
  db.prepare("INSERT INTO listings (userId, type, title, details, createdAt) VALUES (?, 'lost', 'black airpods pro case', '{}', 1)").run(realId);
  const before = db.prepare("SELECT * FROM users WHERE id = ?").get(realId);
  const counts = seed(db, { now: NOW + DAY, reset: true });
  assert.deepEqual(db.prepare("SELECT * FROM users WHERE id = ?").get(realId), before);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM listings WHERE isExample = 0").get() as Row).n, 1);
  assert.equal(counts.users, 13);
  assert.equal(counts.listings, file<unknown>("listings.json").length + 1);
  // After a reset the example times are fresh.
  const newest = (db.prepare("SELECT MAX(createdAt) AS t FROM listings WHERE isExample = 1").get() as Row).t as number;
  assert.ok(newest > NOW);
});

test("a real user on an example handle is left alone", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (handle, chatId, name, createdAt) VALUES ('+12135550110', 'c1', 'real person', 1)").run();
  const counts = seed(db, { now: NOW });
  const u = db.prepare("SELECT * FROM users WHERE handle = '+12135550110'").get() as Row;
  assert.equal(u.name, "real person");
  assert.equal(u.isExample, 0);
  assert.equal(counts.users, 12);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM listings WHERE userId = ?").get(u.id as number) as Row).n, 0);
});
