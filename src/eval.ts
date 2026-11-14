// The eval for the lost and found matcher and verifier.
// Runs the written cases in evals/cases.json (all fictional example data) through the same
// code the live flow uses: match confidence first, then the blind description score.
// A "wrong handoff" (Troy would hand an item to someone who isn't the owner) is the worst outcome
// and is counted on its own.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { aiAvailable } from "./ai.ts";
import { openDb } from "./db/index.ts";
import { rankCandidates, scoreFallback } from "./flows/lostfound/match.ts";
import type { ListingRow } from "./flows/lostfound/match.ts";
import type { ItemProfile, LostReport } from "./flows/lostfound/types.ts";
import { THRESHOLDS, scoreDescription } from "./flows/lostfound/verify.ts";

export const EVAL_KINDS = ["true_match", "look_alike", "fraud", "wrong_item", "hard"] as const;
export type EvalKind = (typeof EVAL_KINDS)[number];
export type EvalDecision = "handoff" | "no_handoff";

export interface EvalCase {
  id: string;
  kind: EvalKind;
  /** The finder's item profile, plus where and how long ago it was found. */
  found: ItemProfile & { locationText: string | null; hoursAgo: number };
  /** The loss report as the student texted it. */
  lost: Omit<LostReport, "happenedAt"> & { hoursAgo: number };
  /** What the claimant says when asked to describe the item blind. */
  ownerDescription: string;
  expected: EvalDecision;
  note: string;
}

export interface EvalCaseResult {
  id: string;
  kind: EvalKind;
  /** Safe to show: the public summary only, never the hidden details. */
  item: string;
  expected: EvalDecision;
  decision: EvalDecision;
  correct: boolean;
  wrongHandoff: boolean;
  confidence: number;
  matchSource: "ai" | "fallback";
  /** Null when confidence was under the clarify threshold, so the verifier never ran. */
  descriptionScore: number | null;
  descriptionSource: "ai" | "fallback" | null;
  note: string;
  error?: string;
}

export interface EvalResult {
  total: number;
  correct: number;
  wrong: number;
  /** Handed off when it should not have. The worst outcome. */
  wrongHandoffs: number;
  /** Did not hand off to a real owner on this single try. */
  missedHandoffs: number;
  byKind: Record<string, { total: number; correct: number }>;
  cases: EvalCaseResult[];
  ranAt: number;
  mode: "ai" | "fallback";
  thresholds: { confidence: number; description: number };
  isExampleData: true;
}

const ROOT = join(import.meta.dirname, "..");
export const CASES_PATH = join(ROOT, "evals", "cases.json");
export const LATEST_PATH = join(ROOT, "data", "eval-latest.json");

const HOUR = 60 * 60 * 1000;

export function loadCases(path = CASES_PATH): EvalCase[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { cases?: EvalCase[] } | EvalCase[];
  const cases = Array.isArray(raw) ? raw : raw.cases;
  if (!Array.isArray(cases)) throw new Error("evals/cases.json has no cases array");
  return cases;
}

type PlaceFinder = (text: string) => { lat: number; lng: number } | null;

/**
 * Coordinates for a place name, when the seed data and places module are there.
 * Optional on purpose: without them listings simply have no coordinates.
 */
async function loadPlaceFinder(): Promise<PlaceFinder> {
  try {
    const seedMod = (await import(new URL("./db/seed.ts", import.meta.url).href)) as { seed: (db: DatabaseSync) => unknown };
    const placesMod = (await import(new URL("./places.ts", import.meta.url).href)) as {
      findPlace: (db: DatabaseSync, text: string) => { lat: number; lng: number } | null;
    };
    const db = openDb(":memory:");
    seedMod.seed(db);
    return (text) => {
      try {
        return placesMod.findPlace(db, text);
      } catch {
        return null;
      }
    };
  } catch {
    return () => null;
  }
}

function buildListings(c: EvalCase, index: number, now: number, place: PlaceFinder): { found: ListingRow; lost: ListingRow } {
  const { locationText: foundWhere, hoursAgo: foundHoursAgo, ...profile } = c.found;
  const foundAt = now - foundHoursAgo * HOUR;
  const foundSpot = foundWhere ? place(foundWhere) : null;
  const found: ListingRow = {
    id: index * 2 + 1,
    userId: index * 2 + 1,
    type: "found",
    category: profile.category,
    title: profile.title,
    details: profile,
    locationText: foundWhere,
    lat: foundSpot?.lat ?? null,
    lng: foundSpot?.lng ?? null,
    happenedAt: foundAt,
    status: "open",
    createdAt: foundAt,
  };

  const lostAt = now - c.lost.hoursAgo * HOUR;
  const report: LostReport = {
    category: c.lost.category,
    description: c.lost.description,
    color: c.lost.color,
    brand: c.lost.brand,
    locationText: c.lost.locationText,
    happenedAt: lostAt,
  };
  const lostSpot = report.locationText ? place(report.locationText) : null;
  const lost: ListingRow = {
    id: index * 2 + 2,
    userId: index * 2 + 2,
    type: "lost",
    category: report.category,
    title: null,
    details: report,
    locationText: report.locationText,
    lat: lostSpot?.lat ?? null,
    lng: lostSpot?.lng ?? null,
    happenedAt: lostAt,
    status: "open",
    createdAt: Math.min(now, lostAt + HOUR),
  };
  return { found, lost };
}

async function runCase(c: EvalCase, index: number, now: number, useAi: boolean, place: PlaceFinder): Promise<EvalCaseResult> {
  const base = { id: c.id, kind: c.kind, item: c.found.publicSummary, expected: c.expected, note: c.note };
  try {
    const { found, lost } = buildListings(c, index, now, place);

    let confidence: number;
    let matchSource: "ai" | "fallback";
    const ranked = await rankCandidates(lost, [found], { useAi });
    const hit = ranked.find((r) => r.candidateId === found.id);
    if (hit) {
      confidence = hit.confidence;
      matchSource = hit.source;
    } else {
      confidence = scoreFallback(found, lost).confidence;
      matchSource = "fallback";
    }

    let descriptionScore: number | null = null;
    let descriptionSource: "ai" | "fallback" | null = null;
    if (confidence >= THRESHOLDS.clarify) {
      const scored = await scoreDescription(found.details as ItemProfile, c.ownerDescription, { useAi });
      descriptionScore = scored.score;
      descriptionSource = scored.source;
    }

    const decision: EvalDecision = descriptionScore !== null && descriptionScore >= THRESHOLDS.descriptionPass ? "handoff" : "no_handoff";
    return {
      ...base,
      decision,
      correct: decision === c.expected,
      wrongHandoff: decision === "handoff" && c.expected === "no_handoff",
      confidence,
      matchSource,
      descriptionScore,
      descriptionSource,
    };
  } catch (err) {
    // A crash never counts as a handoff.
    return {
      ...base,
      decision: "no_handoff",
      correct: c.expected === "no_handoff",
      wrongHandoff: false,
      confidence: 0,
      matchSource: "fallback",
      descriptionScore: null,
      descriptionSource: null,
      error: err instanceof Error ? err.message.slice(0, 200) : "error",
    };
  }
}

/**
 * Run the written cases through the matcher and the verifier.
 * useAi defaults to "on when there is an API key". save: false keeps data/eval-latest.json untouched (tests).
 */
export async function runEval(opts: { useAi?: boolean; limit?: number; save?: boolean } = {}): Promise<EvalResult> {
  const useAi = (opts.useAi ?? true) && aiAvailable();
  let cases = loadCases();
  if (opts.limit !== undefined && opts.limit >= 0) cases = cases.slice(0, opts.limit);

  const now = Date.now();
  const place = await loadPlaceFinder();
  const results: EvalCaseResult[] = new Array(cases.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < cases.length) {
      const i = next++;
      results[i] = await runCase(cases[i], i, now, useAi, place);
    }
  };
  await Promise.all(Array.from({ length: useAi ? 4 : 1 }, worker));

  const byKind: Record<string, { total: number; correct: number }> = {};
  for (const r of results) {
    const k = (byKind[r.kind] ??= { total: 0, correct: 0 });
    k.total++;
    if (r.correct) k.correct++;
  }
  const correct = results.filter((r) => r.correct).length;
  const result: EvalResult = {
    total: results.length,
    correct,
    wrong: results.length - correct,
    wrongHandoffs: results.filter((r) => r.wrongHandoff).length,
    missedHandoffs: results.filter((r) => r.expected === "handoff" && r.decision === "no_handoff").length,
    byKind,
    cases: results,
    ranAt: now,
    mode: useAi ? "ai" : "fallback",
    thresholds: { confidence: THRESHOLDS.clarify, description: THRESHOLDS.descriptionPass },
    isExampleData: true,
  };

  if (opts.save !== false) {
    try {
      mkdirSync(join(ROOT, "data"), { recursive: true });
      const tmp = `${LATEST_PATH}.tmp`;
      writeFileSync(tmp, JSON.stringify(result, null, 2));
      renameSync(tmp, LATEST_PATH);
    } catch {
      console.error("eval: could not save the latest result");
    }
  }
  return result;
}

/** The last saved eval result, or null when the eval hasn't been run (or the file is unreadable). */
export function latestEval(): EvalResult | null {
  try {
    if (!existsSync(LATEST_PATH)) return null;
    const parsed = JSON.parse(readFileSync(LATEST_PATH, "utf8")) as EvalResult;
    return typeof parsed?.total === "number" && Array.isArray(parsed.cases) ? parsed : null;
  } catch {
    return null;
  }
}
