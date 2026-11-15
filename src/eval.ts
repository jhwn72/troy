// The eval for the lost and found matcher and verifier.
// Runs the written cases in evals/cases.json (all fictional example data) through the same
// code the live flow uses: match confidence first, then the blind description score.
// A "wrong handoff" (Troy would hand an item to someone who isn't the owner) is the worst outcome
// and is counted on its own.
//
// When the description was scored by the rules only (no model), a passing score is never a handoff: the live
// flow shows the finder the claimant's words and the finder decides. The eval reports that as a third
// outcome, "sent_to_finder". It is not a wrong handoff, because Troy handed nothing over.
//
// A plain found item (isPlainItem in verify.ts) whose description "fits" also goes to the finder, whatever the
// score source: the finder decides. Those cases live in their own list (plainCases in evals/cases.json) and are
// reported apart (result.plain), so the 40 main cases and their totals read the same as before. An impostor whose
// vague, true-of-anything answer reaches the finder is counted in plain.sentToFinderNotOwner: not a wrong handoff,
// but the finder is the only check left.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { aiAvailable } from "./ai.ts";
import { openDb } from "./db/index.ts";
import { rankCandidates, scoreFallback } from "./flows/lostfound/match.ts";
import type { ListingRow } from "./flows/lostfound/match.ts";
import type { ItemProfile, LostReport } from "./flows/lostfound/types.ts";
import type { Verdict } from "./flows/lostfound/verify.ts";
import { THRESHOLDS, isPlainItem, scoreDescription } from "./flows/lostfound/verify.ts";

export const EVAL_KINDS = ["true_match", "look_alike", "fraud", "wrong_item", "hard"] as const;
export type EvalKind = (typeof EVAL_KINDS)[number];
export type EvalDecision = "handoff" | "no_handoff";
/** What Troy does by itself: hand off, don't, or (rule score only) ask the finder to decide. */
export type EvalOutcome = EvalDecision | "sent_to_finder";

export interface EvalCase {
  id: string;
  kind: EvalKind;
  /** The finder's item profile, plus where and how long ago it was found. */
  found: ItemProfile & { locationText: string | null; hoursAgo: number };
  /** The loss report as the student texted it. */
  lost: Omit<LostReport, "happenedAt"> & { hoursAgo: number };
  /** What the claimant says when asked to describe the item blind. */
  ownerDescription: string;
  /** Plain-item cases only: an earlier description by the same claimant, scored first as a counted try. */
  firstTry?: string;
  expected: EvalDecision;
  note: string;
}

export interface EvalCaseResult {
  id: string;
  kind: EvalKind;
  /** Safe to show: the public summary only, never the hidden details. */
  item: string;
  expected: EvalDecision;
  decision: EvalOutcome;
  /** True when Troy got it right alone, or sent a real owner's description to the finder. */
  correct: boolean;
  wrongHandoff: boolean;
  /** The description passed on the rule score only, so the finder decides. Never a handoff by Troy. */
  sentToFinder: boolean;
  confidence: number;
  matchSource: "ai" | "fallback";
  /** Null when confidence was under the clarify threshold, so the verifier never ran. */
  descriptionScore: number | null;
  descriptionSource: "ai" | "fallback" | null;
  /** The verdict on the (last) description, when one was scored. */
  verdict?: Verdict | null;
  /** The found item is plain, so a description that fits goes to the finder. */
  plain?: boolean;
  note: string;
  error?: string;
}

/** The plain-item cases, reported apart from the main ones. */
export interface EvalPlainResult {
  total: number;
  correct: number;
  wrongHandoffs: number;
  sentToFinder: number;
  sentToFinderNotOwner: number;
  cases: EvalCaseResult[];
}

export interface EvalResult {
  total: number;
  correct: number;
  wrong: number;
  /** Handed off when it should not have. The worst outcome. */
  wrongHandoffs: number;
  /** Did not hand off to a real owner on this single try. */
  missedHandoffs: number;
  /** Passed on the rule score only, so the finder is asked. Counted apart from handoffs. */
  sentToFinder: number;
  /** Of those, claimants who are not the owner: the finder is the last check. Not correct, not a wrong handoff. */
  sentToFinderNotOwner: number;
  byKind: Record<string, { total: number; correct: number }>;
  cases: EvalCaseResult[];
  ranAt: number;
  mode: "ai" | "fallback";
  thresholds: { confidence: number; description: number };
  /** The plain-item cases (evals/cases.json plainCases). Absent in results saved before they existed. */
  plain?: EvalPlainResult;
  isExampleData: true;
}

const ROOT = join(import.meta.dirname, "..");
export const CASES_PATH = join(ROOT, "evals", "cases.json");
export const LATEST_PATH = join(ROOT, "data", "eval-latest.json");

const HOUR = 60 * 60 * 1000;

export function loadPlainCases(path = CASES_PATH): EvalCase[] {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { plainCases?: EvalCase[] } | EvalCase[];
  return Array.isArray(raw) ? [] : Array.isArray(raw.plainCases) ? raw.plainCases : [];
}

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

/**
 * The same rule the live flow uses (handleDescribe in the handler): a pass from the model is a handoff,
 * a pass on the rule score alone goes to the finder, anything under the pass mark is a miss.
 */
export function decide(score: number | null, source: "ai" | "fallback" | null, plainFits = false): EvalOutcome {
  if (score === null || score < THRESHOLDS.descriptionPass) return plainFits ? "sent_to_finder" : "no_handoff";
  return source === "ai" ? "handoff" : "sent_to_finder";
}

/** Roughly what the flow's whereWhen sees: a lost verb with a time word, or with a place the seed data knows. */
const LOST_VERB = /\b(?:lost|lose|left|dropped|forgot|misplaced|last (?:saw|had))\b/i;
const TIME_WORD = /\b(?:today|yesterday|tonight|last night|this morning|this afternoon|ago|\d{1,2}(?::\d\d)?\s?(?:am|pm))\b/i;
const saidWhereWhen = (text: string, place: PlaceFinder): boolean => LOST_VERB.test(text) && (TIME_WORD.test(text) || place(text) !== null);

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
    let verdict: Verdict | null = null;
    const profile = found.details as ItemProfile;
    const plain = isPlainItem(profile);
    let decision: EvalOutcome = "no_handoff";
    if (confidence >= THRESHOLDS.clarify) {
      // A first try (plain cases only) is scored like any other. A pass ends it there; a fit goes to the finder
      // (with the earlier try shown); a miss leaves one more try, as in the flow.
      const tries = c.firstTry ? [c.firstTry, c.ownerDescription] : [c.ownerDescription];
      for (const text of tries) {
        const scored = await scoreDescription(profile, text, { useAi, saidWhereWhen: plain && saidWhereWhen(text, place) });
        descriptionScore = scored.score;
        descriptionSource = scored.source;
        verdict = scored.verdict;
        // The same rule as handleDescribe: on a plain item, "fits" (or a rule-score "match") goes to the finder.
        const plainFits = plain && (scored.verdict === "fits" || (scored.verdict === "match" && scored.source === "fallback"));
        decision = decide(scored.score, scored.source, plainFits);
        if (decision !== "no_handoff") break;
      }
    }

    return {
      ...base,
      decision,
      correct: decision === c.expected || (decision === "sent_to_finder" && c.expected === "handoff"),
      wrongHandoff: decision === "handoff" && c.expected === "no_handoff",
      sentToFinder: decision === "sent_to_finder",
      confidence,
      matchSource,
      descriptionScore,
      descriptionSource,
      verdict,
      plain,
    };
  } catch (err) {
    // A crash never counts as a handoff.
    return {
      ...base,
      decision: "no_handoff",
      correct: c.expected === "no_handoff",
      wrongHandoff: false,
      sentToFinder: false,
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
  const runAll = async (list: EvalCase[], offset: number): Promise<EvalCaseResult[]> => {
    const out: EvalCaseResult[] = new Array(list.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < list.length) {
        const i = next++;
        out[i] = await runCase(list[i]!, offset + i, now, useAi, place);
      }
    };
    await Promise.all(Array.from({ length: useAi ? 4 : 1 }, worker));
    return out;
  };
  const results = await runAll(cases, 0);
  const plainResults = opts.limit !== undefined ? [] : await runAll(loadPlainCases(), cases.length);

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
    sentToFinder: results.filter((r) => r.sentToFinder).length,
    sentToFinderNotOwner: results.filter((r) => r.sentToFinder && r.expected === "no_handoff").length,
    byKind,
    cases: results,
    ranAt: now,
    mode: useAi ? "ai" : "fallback",
    thresholds: { confidence: THRESHOLDS.clarify, description: THRESHOLDS.descriptionPass },
    plain: {
      total: plainResults.length,
      correct: plainResults.filter((r) => r.correct).length,
      wrongHandoffs: plainResults.filter((r) => r.wrongHandoff).length,
      sentToFinder: plainResults.filter((r) => r.sentToFinder).length,
      sentToFinderNotOwner: plainResults.filter((r) => r.sentToFinder && r.expected === "no_handoff").length,
      cases: plainResults,
    },
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
    if (typeof parsed?.total !== "number" || !Array.isArray(parsed.cases)) return null;
    // Results saved before these fields existed read as zero.
    return { ...parsed, sentToFinder: parsed.sentToFinder ?? 0, sentToFinderNotOwner: parsed.sentToFinderNotOwner ?? 0 };
  } catch {
    return null;
  }
}
