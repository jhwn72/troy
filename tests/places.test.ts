import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { seed } from "../src/db/seed.ts";
import { findPlace, normalizePlaceText, walkingMinutes } from "../src/places.ts";

const places = JSON.parse(readFileSync(join(import.meta.dirname, "../src/db/seed-data/campus_places.json"), "utf8")) as {
  name: string;
  nicknames: string[];
  lat: number;
  lng: number;
  kind: string;
}[];

function seeded() {
  const db = openDb(":memory:");
  seed(db);
  return db;
}

test("at least 45 places, all inside the University Park Campus bounding box", () => {
  assert.ok(places.length >= 45, `only ${places.length} places`);
  for (const p of places) {
    assert.ok(p.lat >= 34.016 && p.lat <= 34.032, `${p.name} lat ${p.lat}`);
    assert.ok(p.lng >= -118.295 && p.lng <= -118.276, `${p.name} lng ${p.lng}`);
    assert.ok(["campus", "dorm", "other"].includes(p.kind), `${p.name} kind ${p.kind}`);
    assert.ok(Array.isArray(p.nicknames));
  }
});

test("no two places share a name or nickname", () => {
  const seen = new Map<string, string>();
  for (const p of places) {
    for (const label of new Set([p.name, ...p.nicknames].map(normalizePlaceText))) {
      assert.ok(label.length > 0);
      assert.ok(!seen.has(label), `"${label}" is on both ${seen.get(label)} and ${p.name}`);
      seen.set(label, p.name);
    }
  }
});

test("findPlace finds places inside free text", () => {
  const db = seeded();
  assert.equal(findPlace(db, "near leavey")?.name, "Leavey Library");
  assert.equal(findPlace(db, "taper hall 2nd floor")?.name, "Taper Hall");
  assert.equal(findPlace(db, "i think i left it at THH")?.name, "Taper Hall");
  assert.equal(findPlace(db, "at tcc rn")?.name, "Ronald Tutor Campus Center");
  assert.equal(findPlace(db, "EVK!!")?.name, "Everybody's Kitchen");
  assert.equal(findPlace(db, "everybody's kitchen")?.name, "Everybody's Kitchen");
  assert.equal(findPlace(db, "the lyon center, by the courts")?.name, "Lyon Recreation Center");
  assert.equal(findPlace(db, "dropped it off at dps")?.name, "DPS Lost and Found");
  assert.equal(findPlace(db, "trader joe's")?.name, "Trader Joe's at USC Village");
});

test("findPlace prefers the longest match", () => {
  const db = seeded();
  assert.equal(findPlace(db, "by the village dining hall")?.name, "USC Village Dining Hall");
  assert.equal(findPlace(db, "somewhere in the village")?.name, "USC Village");
  assert.equal(findPlace(db, "village gym")?.name, "USC Village Fitness Center");
  assert.equal(findPlace(db, "parkside dining hall")?.name, "Parkside Dining Hall");
  assert.equal(findPlace(db, "parkside")?.name, "Parkside Apartments");
  assert.equal(findPlace(db, "mccarthy quad")?.name, "McCarthy Quad");
  assert.equal(findPlace(db, "ronald tutor hall lobby")?.name, "Ronald Tutor Hall");
});

test("findPlace does not match a short nickname inside another word", () => {
  const db = seeded();
  assert.equal(findPlace(db, "i had a salad"), null);
  assert.equal(findPlace(db, "kaput"), null);
  assert.equal(findPlace(db, "my webbed gloves"), null);
  assert.equal(findPlace(db, "evka"), null);
  assert.equal(findPlace(db, ""), null);
  assert.equal(findPlace(db, "no idea honestly"), null);
  assert.equal(findPlace(db, "sal 101")?.name, "Salvatori Computer Science Center");
});

test("findPlace returns the row shape and works on an empty table", () => {
  const db = seeded();
  const p = findPlace(db, "leavey");
  assert.ok(p);
  assert.equal(typeof p.id, "number");
  assert.equal(p.kind, "campus");
  assert.ok(Math.abs(p.lat - 34.02177) < 1e-6 && Math.abs(p.lng - -118.28288) < 1e-6);
  assert.equal(findPlace(db, "birnkrant")?.kind, "dorm");
  assert.equal(findPlace(openDb(":memory:"), "leavey"), null);
});

test("walkingMinutes: 80 m per minute, x1.25, rounded up, at least 1", () => {
  const a = { lat: 34.02, lng: -118.285 };
  assert.equal(walkingMinutes(a, a), 1);
  // 0.001 degrees of latitude is about 111.2 m; x1.25 = 139 m; / 80 = 1.74 -> 2
  assert.equal(walkingMinutes(a, { lat: 34.021, lng: -118.285 }), 2);
  // 0.005 degrees of latitude is about 556 m; x1.25 = 695 m; / 80 = 8.7 -> 9
  assert.equal(walkingMinutes(a, { lat: 34.025, lng: -118.285 }), 9);
  assert.equal(walkingMinutes({ lat: 34.025, lng: -118.285 }, a), 9);
});

test("walkingMinutes between real places is believable", () => {
  const db = seeded();
  const leavey = findPlace(db, "leavey")!;
  const village = findPlace(db, "the village")!;
  const tommy = findPlace(db, "tommy trojan")!;
  const mins = walkingMinutes(leavey, village);
  assert.ok(mins >= 6 && mins <= 12, `leavey to village was ${mins}`);
  assert.ok(walkingMinutes(leavey, tommy) <= 6);
});
