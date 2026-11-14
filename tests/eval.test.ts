import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const CASES_PATH = join(ROOT, "evals", "cases.json");
const MATCHER = join(ROOT, "src", "flows", "lostfound", "match.ts");
const VERIFIER = join(ROOT, "src", "flows", "lostfound", "verify.ts");

// Kept in step with src/flows/lostfound/types.ts (not imported so this test runs before that file exists).
const CATEGORIES = ["phone", "earbuds", "laptop", "tablet", "wallet", "id_card", "keys", "water_bottle", "bag", "clothing", "jewelry", "glasses", "charger", "book", "umbrella", "scooter", "other"];
const KIND_RANGES: Record<string, [number, number]> = {
  true_match: [12, 16],
  look_alike: [8, 12],
  fraud: [6, 10],
  wrong_item: [4, 6],
  hard: [2, 4],
};

type AnyCase = Record<string, any>;

function readCases(): { file: AnyCase; cases: AnyCase[] } {
  const file = JSON.parse(readFileSync(CASES_PATH, "utf8")) as AnyCase;
  return { file, cases: file.cases as AnyCase[] };
}

const strOrNull = (v: unknown): boolean => v === null || (typeof v === "string" && v.length > 0);

test("cases.json is labeled as example data and has 40 unique cases", () => {
  const { file, cases } = readCases();
  assert.equal(file.isExample, true);
  assert.match(String(file.label), /example data/i);
  assert.ok(Array.isArray(cases));
  assert.equal(cases.length, 40);
  const ids = cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
});

test("every case has a valid shape", () => {
  const { cases } = readCases();
  for (const c of cases) {
    const where = `case ${c.id}`;
    assert.ok(typeof c.id === "string" && c.id.length > 0, where);
    assert.ok(c.kind in KIND_RANGES, `${where}: kind`);
    assert.ok(c.expected === "handoff" || c.expected === "no_handoff", `${where}: expected`);
    assert.ok(typeof c.note === "string" && c.note.length > 0, `${where}: note`);
    assert.ok(typeof c.ownerDescription === "string" && c.ownerDescription.length > 5, `${where}: ownerDescription`);

    const f = c.found;
    assert.ok(CATEGORIES.includes(f.category), `${where}: found.category`);
    assert.ok(typeof f.title === "string" && f.title.length > 0, `${where}: found.title`);
    assert.ok(strOrNull(f.brand) && strOrNull(f.color) && strOrNull(f.nameOnItem), `${where}: found nullable strings`);
    assert.ok(typeof f.publicSummary === "string" && f.publicSummary.length > 0, `${where}: publicSummary`);
    assert.ok(Array.isArray(f.distinguishing) && f.distinguishing.length >= 2, `${where}: distinguishing`);
    assert.ok(f.distinguishing.every((d: unknown) => typeof d === "string" && d.length > 0), `${where}: distinguishing strings`);
    assert.equal(typeof f.isValuable, "boolean", where);
    assert.equal(f.isDangerous, false, `${where}: dangerous items never reach matching`);
    assert.ok(strOrNull(f.locationText), `${where}: found.locationText`);
    assert.ok(typeof f.hoursAgo === "number" && f.hoursAgo >= 0, `${where}: found.hoursAgo`);

    const l = c.lost;
    assert.ok(l.category === null || CATEGORIES.includes(l.category), `${where}: lost.category`);
    assert.ok(typeof l.description === "string" && l.description.length > 0, `${where}: lost.description`);
    assert.ok(strOrNull(l.color) && strOrNull(l.brand) && strOrNull(l.locationText), `${where}: lost nullable strings`);
    assert.ok(typeof l.hoursAgo === "number" && l.hoursAgo >= 0, `${where}: lost.hoursAgo`);

    // Real owners should be handed off to; everyone else should not.
    const ownerKind = c.kind === "true_match" || c.kind === "hard";
    assert.equal(c.expected, ownerKind ? "handoff" : "no_handoff", `${where}: expected fits kind`);
  }
});

test("kind counts are in range", () => {
  const { cases } = readCases();
  const counts: Record<string, number> = {};
  for (const c of cases) counts[c.kind] = (counts[c.kind] ?? 0) + 1;
  for (const [kind, [min, max]] of Object.entries(KIND_RANGES)) {
    const n = counts[kind] ?? 0;
    assert.ok(n >= min && n <= max, `${kind}: ${n} cases, want ${min} to ${max}`);
  }
});

test("no em dashes in case copy", () => {
  assert.ok(!readFileSync(CASES_PATH, "utf8").includes("—"));
});

const ready = existsSync(MATCHER) && existsSync(VERIFIER);

test("runEval in fallback mode returns consistent totals", { skip: ready ? false : "skipped: src/flows/lostfound/match.ts or verify.ts isn't there yet" }, async () => {
  const { runEval } = await import("../src/eval.ts");
  const r = await runEval({ useAi: false, limit: 5, save: false });
  assert.equal(r.mode, "fallback");
  assert.equal(r.total, 5);
  assert.equal(r.cases.length, 5);
  assert.equal(r.correct + r.wrong, r.total);
  assert.equal(r.correct, r.cases.filter((c) => c.correct).length);
  assert.equal(r.wrongHandoffs, r.cases.filter((c) => c.wrongHandoff).length);
  assert.equal(r.missedHandoffs, r.cases.filter((c) => c.expected === "handoff" && c.decision === "no_handoff").length);
  assert.equal(r.sentToFinder, r.cases.filter((c) => c.sentToFinder).length);
  assert.equal(r.sentToFinderNotOwner, r.cases.filter((c) => c.sentToFinder && c.expected === "no_handoff").length);
  assert.equal(r.wrong, r.wrongHandoffs + r.missedHandoffs + r.sentToFinderNotOwner);
  const kindTotal = Object.values(r.byKind).reduce((n, k) => n + k.total, 0);
  assert.equal(kindTotal, r.total);
  for (const c of r.cases) {
    assert.ok(c.confidence >= 0 && c.confidence <= 100, `${c.id}: confidence in range`);
    assert.ok(c.descriptionScore === null || (c.descriptionScore >= 0 && c.descriptionScore <= 100), `${c.id}: description score in range`);
    assert.equal(c.matchSource, "fallback");
    assert.notEqual(c.decision, "handoff", `${c.id}: the rule score alone never hands an item over`);
    assert.equal(c.wrongHandoff, false);
    assert.equal(c.sentToFinder, c.decision === "sent_to_finder");
    if (c.sentToFinder) assert.ok(c.descriptionScore !== null && c.descriptionScore >= 70, `${c.id}: only a passing rule score goes to the finder`);
    assert.equal(c.error, undefined, `${c.id}: no error`);
  }
});

test("fallback mode: every pass is sent to the finder, counted apart from handoffs, across all cases", { skip: ready ? false : "skipped: matcher or verifier isn't there yet" }, async () => {
  const { runEval } = await import("../src/eval.ts");
  const r = await runEval({ useAi: false, save: false });
  assert.equal(r.mode, "fallback");
  assert.equal(r.cases.filter((c) => c.decision === "handoff").length, 0);
  assert.equal(r.wrongHandoffs, 0);
  assert.ok(r.sentToFinder > 0, "real owners with a good description reach the finder");
  // A real owner whose words reach the finder is the right outcome for this mode.
  for (const c of r.cases) if (c.sentToFinder) assert.equal(c.correct, c.expected === "handoff", c.id);
  assert.equal(r.sentToFinderNotOwner, 0, "no fraud or look-alike case gets as far as the finder on the rule score");
  assert.equal(r.correct + r.wrong, r.total);
});

test("decide: a model pass is a handoff, a rule-score pass goes to the finder, a miss is a miss on both", { skip: ready ? false : "skipped: matcher or verifier isn't there yet" }, async () => {
  const { decide } = await import("../src/eval.ts");
  assert.equal(decide(92, "ai"), "handoff");
  assert.equal(decide(92, "fallback"), "sent_to_finder");
  assert.equal(decide(70, "fallback"), "sent_to_finder");
  assert.equal(decide(69, "fallback"), "no_handoff");
  assert.equal(decide(15, "ai"), "no_handoff");
  assert.equal(decide(null, null), "no_handoff");
});
