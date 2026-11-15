// Builds the example data the public copies of the staff dashboard and the "under the hood" panel run on.
// Run: node scripts/build-demo-data.ts            (writes public/demo-data/*.json)
// scripts/build-landing.ts calls buildDemoData() too, so every build of vercel-landing/ carries fresh files.
//
// How: an in-memory database, the labeled example seed (src/db/seed.ts), the lost and found matcher on rule
// scores only (no AI call, the same as the server with SEED_EXAMPLES=true), a few more example rows so every
// tab has something on it, then the real API routes (src/web/api.ts) are asked for their JSON.
//
// Nothing here reads the real database, .env or the network. Every row is example data.
// What is deliberately not in the output: pickup codes, full handles, emails, saved locations and usual spots,
// environment values (the .env allow-list, the provider, the kill switch's env state). check() refuses to
// return anything that breaks those rules.

import { randomInt } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";

const ROOT = join(import.meta.dirname, "..");
const HOUR = 60 * 60 * 1000;

/** "Now" for the example data. Fixed, so two builds give the same bytes. The pages count time from `generatedAt`. */
export const DEMO_NOW = Date.UTC(2026, 10, 14, 20, 0, 0);
/** The pickup code the demo pages accept. It is a constant of the demo, shown on the page, and opens nothing real. */
export const DEMO_PICKUP_CODE = "TRJN26";

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;

/** A few more labeled example rows than the seed has, so the DPS code check, verification, handoffs and moderation show something. */
function addExampleRows(db: DatabaseSync, now: number): { dpsCode: string } {
  const user = (handle: string) => (db.prepare("SELECT id FROM users WHERE handle = ? AND isExample = 1").get(handle) as { id: number }).id;
  const listing = (type: string, title: string) => db.prepare("SELECT id FROM listings WHERE isExample = 1 AND type = ? AND title = ?").get(type, title) as { id: number } | undefined;
  const matchFor = (foundId: number, lostId: number, confidence: number, reasons: string[], at: number): number => {
    const old = db.prepare("SELECT id FROM matches WHERE foundListingId = ? AND lostListingId = ?").get(foundId, lostId) as { id: number } | undefined;
    if (old) {
      db.prepare("UPDATE matches SET status = 'verified' WHERE id = ?").run(old.id);
      return old.id;
    }
    return Number(db.prepare("INSERT INTO matches (foundListingId, lostListingId, confidence, reasons, source, status, createdAt) VALUES (?, ?, ?, ?, 'fallback', 'verified', ?)").run(foundId, lostId, confidence, JSON.stringify(reasons), at).lastInsertRowid);
  };
  const verify = (matchId: number, answer: string, score: number, result: "pass" | "fail", attempts: number, at: number) =>
    db.prepare("INSERT INTO verifications (matchId, method, ownerAnswer, score, result, attempts, createdAt) VALUES (?, 'blind_description', ?, ?, ?, ?, ?)").run(matchId, answer, score, result, attempts, at);

  // 1. The phone DPS is holding: its owner reported it, passed the blind check and was sent a pickup code.
  const phone = db.prepare("SELECT id FROM listings WHERE isExample = 1 AND type = 'found' AND heldBy = 'dps' AND isDangerous = 0 ORDER BY id LIMIT 1").get() as { id: number };
  const phoneRow = db.prepare("SELECT title, category, details FROM listings WHERE id = ?").get(phone.id) as { title: string; category: string | null; details: string };
  const phoneDetails = JSON.parse(phoneRow.details) as Row;
  const lostPhone = Number(
    db
      .prepare("INSERT INTO listings (userId, type, category, title, details, locationText, happenedAt, status, isValuable, isExample, createdAt) VALUES (?, 'lost', ?, ?, ?, ?, ?, 'handed_off', 1, 1, ?)")
      .run(
        user("+12135550121"),
        phoneRow.category,
        phoneRow.title,
        JSON.stringify({ category: phoneRow.category, description: `${phoneRow.title}, left it on a bench by the bookstore`, color: phoneDetails.color ?? null, brand: phoneDetails.brand ?? null, locationText: "bookstore" }),
        "bookstore",
        now - 92 * HOUR,
        now - 80 * HOUR,
      ).lastInsertRowid,
  );
  db.prepare("UPDATE listings SET status = 'handed_off' WHERE id = ?").run(phone.id);
  const phoneMatch = matchFor(phone.id, lostPhone, 86, ["same kind of item", "same color", "found a short walk from where it was lost", "lost and found within a few hours"], now - 80 * HOUR);
  verify(phoneMatch, "it has a cracked corner and a photo of my dog on the lock screen", 91, "pass", 1, now - 79 * HOUR);
  // The real code is random and never leaves this function's caller. The pages use DEMO_PICKUP_CODE instead.
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let dpsCode = "";
  while (dpsCode.length < 6 || dpsCode === DEMO_PICKUP_CODE) dpsCode = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join("");
  db.prepare("INSERT INTO handoffs (matchId, chosenBy, method, pickupCode, createdAt) VALUES (?, 'finder', 'dps_code', ?, ?)").run(phoneMatch, dpsCode, now - 79 * HOUR);

  // 2. The backpack the seed marks as returned: the pair, the check it passed and the finished handoff.
  const foundPack = db.prepare("SELECT id FROM listings WHERE isExample = 1 AND type = 'found' AND status = 'returned' ORDER BY id LIMIT 1").get() as { id: number } | undefined;
  const lostPack = db.prepare("SELECT id FROM listings WHERE isExample = 1 AND type = 'lost' AND status = 'returned' ORDER BY id LIMIT 1").get() as { id: number } | undefined;
  if (foundPack && lostPack) {
    const m = matchFor(foundPack.id, lostPack.id, 90, ["same kind of item", "same color", "same place", "lost and found within a few hours"], now - 128 * HOUR);
    verify(m, "there's a bike light clipped to the strap and my chem notebook is inside", 94, "pass", 1, now - 127 * HOUR);
    db.prepare("INSERT INTO handoffs (matchId, chosenBy, method, completedAt, thankYouNote, createdAt) VALUES (?, 'finder', 'group_chat', ?, ?, ?)").run(m, now - 124 * HOUR, "thank u so much, my whole semester was in there", now - 127 * HOUR);
  }

  // 3. A look-alike that did not pass: someone else's black airpods case.
  const otherCase = listing("found", "black airpods case with a loop");
  const glitter = listing("lost", "black airpods case with a keychain");
  if (otherCase && glitter) {
    const old = db.prepare("SELECT id FROM matches WHERE foundListingId = ? AND lostListingId = ?").get(otherCase.id, glitter.id) as { id: number } | undefined;
    const m = old ? old.id : Number(db.prepare("INSERT INTO matches (foundListingId, lostListingId, confidence, reasons, source, status, createdAt) VALUES (?, ?, 55, ?, 'fallback', 'rejected', ?)").run(otherCase.id, glitter.id, JSON.stringify(["same kind of item", "same color"]), now - 28 * HOUR).lastInsertRowid);
    db.prepare("UPDATE matches SET status = 'rejected' WHERE id = ?").run(m);
    verify(m, "black case with a gold glitter keychain on it", 22, "fail", 2, now - 27 * HOUR);
  }

  // 4. Food: a few claims on the live drop, and two reports on the old one so Moderation has a row.
  const live = db.prepare("SELECT id, createdAt FROM food_drops WHERE isExample = 1 AND status = 'live' ORDER BY id LIMIT 1").get() as { id: number; createdAt: number } | undefined;
  if (live) {
    const claim = db.prepare("INSERT INTO claims (foodDropId, userId, status, heldUntil, createdAt) VALUES (?, ?, ?, ?, ?)");
    claim.run(live.id, user("+12135550110"), "picked_up", live.createdAt + 20 * 60 * 1000, live.createdAt + 5 * 60 * 1000);
    claim.run(live.id, user("+12135550111"), "picked_up", live.createdAt + 22 * 60 * 1000, live.createdAt + 7 * 60 * 1000);
    claim.run(live.id, user("+12135550116"), "held", now + 10 * 60 * 1000, now - 5 * 60 * 1000);
  }
  db.prepare("UPDATE food_drops SET reports = 2 WHERE isExample = 1 AND status = 'ended'").run();

  return { dpsCode };
}

/** Example topics: one a student created, one request waiting for a person. */
async function addExampleTopics(db: DatabaseSync, now: number): Promise<void> {
  const { createTopic, saveTopicRequest } = await import("../src/topics.ts");
  const id = (handle: string) => (db.prepare("SELECT id FROM users WHERE handle = ?").get(handle) as { id: number }).id;
  const topic = createTopic(db, "pickup volleyball", id("+12135550113"));
  db.prepare("UPDATE topics SET createdAt = ? WHERE id = ?").run(now - 30 * HOUR, topic.id);
  saveTopicRequest(db, "late night study crew", id("+12135550117"));
  db.prepare("UPDATE topic_requests SET createdAt = ? WHERE status = 'open'").run(now - 2 * HOUR);
}

/** Walks a JSON value and calls fn for every key and value. */
function walk(value: unknown, fn: (key: string | null, value: unknown) => void, key: string | null = null): void {
  fn(key, value);
  if (Array.isArray(value)) for (const v of value) walk(v, fn, null);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, fn, k);
}

/** Throws when the output holds anything it must not. `secrets` are exact strings that may never appear. */
export function check(files: Record<string, string>, secrets: string[]): void {
  const fail = (name: string, why: string): never => {
    throw new Error(`build-demo-data: ${name} would publish ${why}. nothing was written.`);
  };
  const banned = /^(?:pickupCode|chatId|uscEmail|email|lat|lng|lastLat|lastLng|lastLocationAt|lastLocationSource|usualSpots|subscriptions|quietHours|password|token|apiKey|key_secret)$/;
  for (const [name, text] of Object.entries(files)) {
    for (const secret of secrets) if (secret && secret.length >= 4 && text.includes(secret)) fail(name, "a value that has to stay private");
    // A full phone number: ten or more digits in a row, with or without a plus.
    if (/\+?\d{10,}/.test(text.replace(/"(?:createdAt|completedAt|heldSince|pickedUpAt|addedAt|happenedAt|expiresAt|now|generatedAt)":\s*\d+/g, ""))) fail(name, "what looks like a full phone number");
    walk(JSON.parse(text), (key, value) => {
      if (key && banned.test(key)) fail(name, `the field "${key}"`);
      // Every handle is masked to its last four digits, and those are the seed's reserved 555-01XX numbers.
      if (key === "handle" && value !== null && !(typeof value === "string" && /^•••• 01\d\d$/.test(value))) fail(name, "a handle that is not a masked example number");
      // The directory is the one list that is not about people: real, public offices and USG programs sit in it next to examples.
      if (key === "isExample" && value !== true && name !== "directory.json") fail(name, "a row that is not marked as an example");
      if (key === "hasPhoto" && value !== false) fail(name, "a photo");
    });
  }
}

/** The example data, as file name to JSON text. Writes nothing. */
export async function buildDemoData(): Promise<Record<string, string>> {
  const realNow = Date.now;
  const realRandom = Math.random;
  const savedEnabled = process.env.TROY_ENABLED;
  // Fixed clock and fixed picks while the data is made, so the files only change when the seed or the code does.
  Date.now = () => DEMO_NOW;
  Math.random = () => 0;
  delete process.env.TROY_ENABLED;
  try {
    const { Hono } = await import("hono");
    const { openDb } = await import("../src/db/index.ts");
    const { seed, seedMatches } = await import("../src/db/seed.ts");
    const { createWebRoutes, STATUS_COPY, reportReference } = await import("../src/web/api.ts");

    const db = openDb(":memory:");
    seed(db, { now: DEMO_NOW, exampleStaff: true });
    await seedMatches(db);
    const { dpsCode } = addExampleRows(db, DEMO_NOW);
    await addExampleTopics(db, DEMO_NOW);

    const app = new Hono();
    app.route(
      "/",
      createWebRoutes({
        db,
        getAdapter: () => {
          throw new Error("no adapter in the demo build");
        },
        notify: async () => false,
      }),
    );
    const get = async (path: string): Promise<Json> => {
      const res = await app.request(path);
      const json = (await res.json()) as Json;
      if (res.status !== 200 || json.ok !== true) throw new Error(`build-demo-data: ${path} answered ${res.status}`);
      return json;
    };

    // Every GET the two pages make. The panel is asked for its staff view, then the pickup codes are taken out of it.
    const panel = await get("/api/panel?staff=1");
    const settings = await get("/api/settings");
    const dps = await get("/api/dps");
    const repairs = await get("/api/reports?kind=repair");
    const usg = await get("/api/reports?kind=usg_concern");
    const moderation = await get("/api/moderation");
    const staff = await get("/api/staff");
    const directory = await get("/api/directory");
    const evalRaw = ((await get("/api/eval")).eval ?? null) as Json | null;

    // The handoff card the DPS counter sees for the example pickup, asked for with the real code and stored without it.
    const checked = (await (await app.request("/api/dps/check-code", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: dpsCode }) })).json()) as Json;
    if (checked.found !== true) throw new Error("build-demo-data: the example pickup was not found");

    // Environment facts never go out: the page shows a plain "on" switch and an empty .env list.
    const allowList = settings.allowList as Json;
    const cleanSettings: Json = { ok: true, enabled: true, settingOn: true, envSet: false, envOff: false, provider: "demo", allowList: { entries: allowList.entries, envEntries: [] } };
    panel.enabled = true;
    panel.chatHealth = null;
    const panelStaff = panel.staff as { handoffs: Record<string, Json> };
    for (const id of Object.keys(panelStaff.handoffs)) panelStaff.handoffs[id] = {};

    // The eval is a real run of the written test pairs on this Mac. Only its counts are kept.
    const evalClean: Json | null = evalRaw && typeof evalRaw.total === "number" ? {} : null;
    if (evalClean && evalRaw) {
      for (const k of ["total", "correct", "wrongHandoffs", "sentToFinder", "sentToFinderNotOwner"]) if (typeof evalRaw[k] === "number") evalClean[k] = evalRaw[k];
      if (evalRaw.mode === "ai" || evalRaw.mode === "fallback") evalClean.mode = evalRaw.mode;
    }
    panel.eval = evalClean;

    // What the demo page needs to say what Troy would have texted: the fixed status lines, each report's reference
    // and how many students follow it, and which handoff the sample pickup code opens.
    const reports: Record<string, Json> = {};
    for (const r of db.prepare("SELECT id, kind, category, description, locationText, followers FROM reports").all() as Row[]) {
      const followers = JSON.parse(String(r.followers ?? "[]")) as unknown[];
      reports[String(r.id)] = {
        reference: reportReference({ kind: r.kind as string, category: r.category, description: r.description, locationText: r.locationText }),
        recipients: 1 + followers.length,
      };
    }
    const demo: Json = {
      ok: true,
      note: "Example data for the public demo pages. Every row is an example. Made by scripts/build-demo-data.ts.",
      statusCopy: STATUS_COPY,
      reports,
      samplePickup: { handoff: checked.handoff },
    };

    const files: Record<string, Json> = {
      "panel.json": panel,
      "settings.json": cleanSettings,
      "dps.json": dps,
      "reports-repair.json": repairs,
      "reports-usg.json": usg,
      "moderation.json": moderation,
      "staff.json": staff,
      "directory.json": directory,
      "eval.json": { ok: true, eval: evalClean },
      "demo.json": demo,
    };
    const out: Record<string, string> = {};
    for (const [name, json] of Object.entries(files)) out[name] = JSON.stringify({ ...json, generatedAt: DEMO_NOW }, null, 1) + "\n";

    // Things that may never appear: the real pickup code, every example user's full handle and email, and the
    // value of any environment variable that looks like a secret, a number or an address.
    const secrets = [dpsCode];
    for (const u of db.prepare("SELECT handle, uscEmail FROM users").all() as { handle: string; uscEmail: string | null }[]) {
      secrets.push(u.handle, u.handle.replace(/^\+1?/, ""));
      if (u.uscEmail) secrets.push(u.uscEmail);
    }
    for (const [name, value] of Object.entries(process.env)) {
      if (value && value.length >= 6 && /KEY|SECRET|PASSWORD|TOKEN|HANDLE|NUMBER|EMAIL|WEBHOOK|DATABASE/i.test(name)) for (const part of value.split(",")) secrets.push(part.trim());
    }
    check(out, secrets);
    db.close();
    return out;
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
    if (savedEnabled !== undefined) process.env.TROY_ENABLED = savedEnabled;
  }
}

/** Writes the files into dir, replacing the .json files that were there. Returns the file names. */
export function writeDemoData(dir: string, files: Record<string, string>): string[] {
  mkdirSync(dir, { recursive: true });
  for (const old of readdirSync(dir)) if (old.endsWith(".json") && !(old in files)) rmSync(join(dir, old));
  for (const [name, text] of Object.entries(files)) {
    // Leave an unchanged file alone, so a rebuild does not touch its date.
    let same = false;
    try {
      same = readFileSync(join(dir, name), "utf8") === text;
    } catch {
      same = false;
    }
    if (!same) writeFileSync(join(dir, name), text);
  }
  return Object.keys(files).sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const dir = join(ROOT, "public", "demo-data");
    const names = writeDemoData(dir, await buildDemoData());
    console.log(`wrote ${dir}`);
    for (const name of names) console.log(`  ${name}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
