// Quick lookup for a campus fact the directory can't answer: one cheap web search on usc.edu, a best guess back.
// The caller (the chat brain) says the answer as a best guess with "double check" and may show only the returned URL.
// Limits live here, in code: off unless TROY_LOOKUP=on, 8 per student per day, 9 seconds, a one hour cache.
// Nothing here stores or logs the question. The daily count is a number under a settings key.

import type { DatabaseSync } from "node:sqlite";
import { lookupOn } from "./config.ts";
import { getSetting, setSetting } from "./db/index.ts";
import { isCrisis, isEmergency } from "./commands.ts";
// Used only at call time, so the import cycle with ai.ts (which re-exports quickLookup) is harmless.
import { searchUscWeb } from "./ai.ts";
import type { WebAnswer } from "./ai.ts";

export type LookupResult = { answer: string; sourceUrl: string; sourceTitle: string };

export const LOOKUP_DAILY_CAP = 8;
export const LOOKUP_TIMEOUT_MS = 9000;
export const LOOKUP_CACHE_MS = 60 * 60 * 1000;
const CACHE_MAX = 200;
const MAX_QUESTION_CHARS = 300;

const SYSTEM = `You answer one factual question about the University of Southern California for a student. Run one web search, then answer from what the search returned and nothing else.
- Answer in one or two short plain sentences. No lists, no markdown, no links in the text, no advice.
- Only say what a returned usc.edu page states. If the results don't answer the question, or you aren't sure they do, reply with exactly NONE.
- Never give anything about a specific student or private person.`;

// ---------- what a lookup is never used for ----------

export type LookupBlock = "hard_rule" | "person" | "sensitive";

// Things code already decides or that come from the confirmed directory: emergencies, lost and found internals,
// contact details, USG programs and their dates.
const HARD_RULE = /\b(?:pick ?up code|verification|verify|verified|claim(?:ed|ing)?|lost|found|finder|owner|dps|public safety|police|911|emergency|weapons?|guns?|knife|drugs?|phone(?: number)?|number for|email(?: address)?|contact(?: info)?|hotline|usg|student government|senat(?:e|or)|lax shuttle|shuttle to lax|thrift|farmers'? market|club funding|rso funding|funding)\b/;

// Decisions that belong with an office, not a best guess from a search.
const SENSITIVE = /\b(?:medical|medicine|medication|meds|prescriptions?|symptoms?|diagnos\w*|doctor|sick|illness|injur\w*|pregnan\w*|std|sti|therap(?:y|ist)|counsel(?:or|ing)|mental health|antidepressants?|adderall|insurance|vaccin\w*|immuniz\w*|legal|lawyer|attorney|lawsuit|sue|suing|court|arrest(?:ed)?|citation|title ix|lease|evict\w*|landlord|visas?|i-?20|ds-?2019|sevis|f-?1|j-?1|cpt|immigration|green card|work authorization|ois|financial aid|fafsa|scholarships?|loans?|grants?|work[- ]study|aid package|aid appeal|tuition refund|refund|tax(?:es)?|1098)\b|\bopt\b(?! (?:out|in)\b)/;

// Another person's information.
const PERSON = /\b(?:who is|who'?s|whos|look up|lookup|find out about|stalk|info on|information on|dirt on)\b|\b(?:his|her|their|someone'?s|somebody'?s|my (?:roommate|ex|friend|crush|ta|classmate|neighbor|rm)'?s?) (?:\w+ )?(?:name|number|phone|email|address|room|dorm|schedule|major|instagram|ig|snap|socials?|last name|grade|gpa)\b|\bwhere (?:does|do|is|did) (?:he|she|they|this (?:guy|girl|person|student)|my (?:roommate|ex|friend|crush|ta|classmate)) (?:live|stay|work|sit|study)\b|\bis (?:he|she|this (?:guy|girl|person)) (?:a|an|really a) (?:student|trojan)\b|\b(?:student|person|guy|girl) named\b/;

/** Why a question may not be looked up, or null when it may. A small word list on purpose: wrong toward "blocked" is fine. */
export function lookupBlocked(question: string): LookupBlock | null {
  const t = question.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  if (isEmergency(question) || isCrisis(question)) return "hard_rule";
  if (SENSITIVE.test(t)) return "sensitive";
  if (PERSON.test(t)) return "person";
  if (HARD_RULE.test(t)) return "hard_rule";
  return null;
}

// ---------- seams for tests ----------

export type LookupSearch = (input: { system: string; question: string; timeoutMs: number }) => Promise<WebAnswer | null>;

let search: LookupSearch | null = null;
let clock: () => number = Date.now;
let timeoutMs = LOOKUP_TIMEOUT_MS;

/** Tests only: replace the network search. Pass null to restore the real one. */
export function setLookupSearch(fn: LookupSearch | null): void {
  search = fn;
}

/** Tests only: replace the clock and the timeout. Pass nothing to restore both. */
export function setLookupTiming(opts: { now?: () => number; timeoutMs?: number } = {}): void {
  clock = opts.now ?? Date.now;
  timeoutMs = opts.timeoutMs ?? LOOKUP_TIMEOUT_MS;
}

// ---------- cache ----------

const cache = new Map<string, { at: number; result: LookupResult | null }>();

export function clearLookupCache(): void {
  cache.clear();
}

/** Same question, same key: case, punctuation, filler and spacing don't matter. No user in the key; the answers are public pages. */
export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(?:hey|troy|pls|please|plz|do u know|do you know|can u tell me|can you tell me|btw|lol|rn|right now|u know)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- the daily count ----------

/** The calendar day on campus, so the cap resets at midnight in Los Angeles. */
function campusDay(at: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}

const countKey = (userId: number, at: number) => `lookup:${userId}:${campusDay(at)}`;

/** How many lookups this student has spent today. */
export function lookupsToday(db: DatabaseSync, userId: number, at: number = clock()): number {
  const n = Number(getSetting(db, countKey(userId, at)));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function spendLookup(db: DatabaseSync, userId: number, at: number): void {
  const key = countKey(userId, at);
  // Yesterday's count is of no use to anyone.
  db.prepare("DELETE FROM settings WHERE key LIKE ? AND key != ?").run(`lookup:${userId}:%`, key);
  setSetting(db, key, String(lookupsToday(db, userId, at) + 1));
}

// ---------- the lookup ----------

function officialUscUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (host !== "usc.edu" && !host.endsWith(".usc.edu")) return null;
    if (u.username || u.password) return null;
    u.protocol = "https:";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/** One or two sentences of plain text, or null when the model said it found nothing. */
function tidyAnswer(text: string): string | null {
  const flat = text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat || /^none\b/i.test(flat) || /\bNONE\b/.test(flat)) return null;
  // Drop "let me search for that" style lead-ins the model writes before it searches.
  const sentences = (flat.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [flat]).map((s) => s.trim()).filter(Boolean);
  const kept = sentences.filter((s) => !/^(?:i'?ll|i will|let me|i'?m going to|searching|looking|based on (?:the|my) search(?: results)?,?$)/i.test(s));
  const answer = kept.slice(0, 2).join(" ").trim();
  if (answer.length < 8) return null;
  return answer.length > 320 ? `${answer.slice(0, 317).replace(/\s+\S*$/, "")}...` : answer;
}

/**
 * A best-guess answer from one search of official USC pages, with its source. null when lookups are off, the question
 * is one a lookup is never used for, the student is at the daily cap, the search failed or timed out, or nothing was found.
 * Never throws. A cached answer costs nothing and doesn't count against the cap.
 */
export async function quickLookup(input: { question: string; userId: number; db: DatabaseSync }): Promise<LookupResult | null> {
  try {
    if (!lookupOn()) return null;
    const question = input.question.replace(/\s+/g, " ").trim();
    if (question.length < 6 || question.length > MAX_QUESTION_CHARS) return null;
    if (lookupBlocked(question)) return null;

    const key = normalizeQuestion(question);
    if (!key) return null;
    const now = clock();
    const hit = cache.get(key);
    if (hit && now - hit.at < LOOKUP_CACHE_MS) return hit.result;
    if (hit) cache.delete(key);

    if (lookupsToday(input.db, input.userId, now) >= LOOKUP_DAILY_CAP) return null;
    // Counted before the call: a search that times out still cost something.
    spendLookup(input.db, input.userId, now);

    let timer: NodeJS.Timeout | undefined;
    const found = await Promise.race([
      (search ?? searchUscWeb)({ system: SYSTEM, question, timeoutMs }).catch(() => null),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    // A failure or a timeout is not cached, so the next ask can try again.
    if (found === "timeout" || found === null) return null;

    const answer = tidyAnswer(found.text);
    const source = found.sources.map((s) => ({ url: officialUscUrl(s.url), title: s.title })).find((s) => s.url);
    // No answer, or no official page behind it: nothing found. That is worth remembering for the hour.
    const result: LookupResult | null = answer && source?.url ? { answer, sourceUrl: source.url, sourceTitle: source.title.replace(/\s+/g, " ").trim().slice(0, 120) || "usc.edu" } : null;
    if (cache.size >= CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: now, result });
    return result;
  } catch {
    return null;
  }
}
