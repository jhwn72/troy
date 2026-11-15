// Yes and no, however a student gives them: a typed word or a tapback on the question that is open.
// See "Forgiving onboarding and thumbs-up as yes" in CLAUDE.md for the edge cases.

import type { DatabaseSync } from "node:sqlite";
import type { FlowState, IncomingEvent } from "./types.ts";
import { getFlowState, getSetting, setSetting } from "./db/index.ts";

const EMOJI = /(?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*)/gu;

/** Words that are a yes by themselves. */
const YES = new Set(["yes", "yess", "yesss", "yep", "yup", "yeah", "yea", "yeh", "ye", "ya", "yah", "sure", "ok", "okay", "k", "kk", "bet", "y", "definitely", "def", "absolutely", "alright", "aight", "please", "pls", "plz"]);
/** Words that may ride along with a yes ("yes please", "ok do it", "sure thing"). */
const YES_FILLER = new Set(["please", "pls", "plz", "thanks", "thx", "ty", "thank", "u", "you", "do", "it", "that", "go", "ahead", "for", "sure", "thing", "sounds", "good", "lets", "let's", "troy", "yes", "sir", "man", "bro", "ok", "okay", "bet", "yeah", "yep", "i", "am", "im", "down", "totally", "of", "course", "send", "show", "me"]);
/** Whole phrases that are a yes without any of the words above. */
const YES_PHRASES = new Set(["do it", "please do", "go ahead", "go for it", "sounds good", "for sure", "of course", "lets do it", "let's do it", "im down", "i'm down", "down", "why not", "send it", "lets go", "let's go"]);

const NO = new Set(["no", "nah", "nope", "n", "naw", "nay", "noo", "nooo", "negative"]);
const NO_FILLER = new Set(["thanks", "thx", "ty", "thank", "u", "you", "im", "i'm", "i", "am", "good", "ok", "okay", "all", "not", "now", "rn", "right", "way", "troy", "man", "bro", "its", "it's", "fine", "no", "nah", "need", "dont", "don't", "do", "that", "it"]);
const NO_PHRASES = new Set(["not now", "not rn", "no thanks", "no thank u", "no thank you", "im good", "i'm good", "dont", "don't", "pass", "never mind", "nevermind", "nvm", "not really", "rather not"]);

function readText(text: string): "yes" | "no" | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  // A question is never an answer: "ok but why?" and "yes?" both ask something.
  if (raw.includes("?")) return null;
  const thumbsUp = /\u{1F44D}|\u{2705}|\u{1F44C}/u.test(raw);
  const thumbsDown = /\u{1F44E}|\u{274C}/u.test(raw);
  const plain = raw
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .replace(EMOJI, " ")
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return thumbsUp && !thumbsDown ? "yes" : thumbsDown && !thumbsUp ? "no" : null;
  const words = plain.split(" ");
  if (words.length > 5) return null;
  if (NO_PHRASES.has(plain)) return "no";
  if (YES_PHRASES.has(plain)) return "yes";
  // "no" comes first: "no thanks" and "nah im good" carry words that also sit in the yes fillers.
  if (NO.has(words[0]!) && words.slice(1).every((w) => NO.has(w) || NO_FILLER.has(w))) return "no";
  // Every word has to be a yes or a filler: "ok but ..." and "yes if ..." come with strings attached, so they are not a yes.
  if (words.some((w) => YES.has(w)) && words.every((w) => YES.has(w) || YES_FILLER.has(w))) return "yes";
  return null;
}

/**
 * A yes, a no, or neither.
 * Text: yes, yep, yeah, ya, sure, ok, bet, do it, please do, y (and no, nah, nope, n), with punctuation and emoji
 * tolerated. Anything with a question in it is never a yes.
 * Tapback: a heart or a thumbs up on exactly `questionMessageId` is yes, a thumbs down on it is no. A tapback on
 * any other bubble, a removed tapback, a laugh or a "!!" is nothing. `allowTapback: false` (deleting data, a
 * verification step) ignores every tapback.
 */
export function readYesNo(input: { event: IncomingEvent; questionMessageId: string | null; allowTapback?: boolean }): "yes" | "no" | null {
  const { event } = input;
  if (event.reaction) {
    if (input.allowTapback === false) return null;
    const r = event.reaction;
    if (r.removed || !input.questionMessageId || r.targetMessageId !== input.questionMessageId) return null;
    if (r.type === "love" || r.type === "like") return "yes";
    if (r.type === "dislike") return "no";
    return null;
  }
  if (event.pollVote) return null;
  return readText(event.text);
}

// ---------- which bubble is the open question ----------
//
// A flow that tracks its own question keeps the bubble's id in its state as `data.qid` (lost and found does, and
// src/pending.ts sets it on delivery). For every other flow the pipeline writes down the last bubble of the turn
// that left a step open. Either way, a tapback only counts when it lands on that bubble while the same step is
// still open.

const slot = (userId: number) => `openq:${userId}`;

/** Called by the pipeline after a turn: the last bubble Troy sent while this step was left open. */
export function noteOpenQuestion(db: DatabaseSync, userId: number, state: Pick<FlowState, "flow" | "step"> | null, messageId: string | null): void {
  try {
    if (!state || !messageId) return;
    setSetting(db, slot(userId), JSON.stringify({ id: messageId, flow: state.flow, step: state.step }));
  } catch {
    // Never worth losing a reply over.
  }
}

/**
 * The id of the bubble that is this person's open question right now, or null when nothing is open.
 * The flow's own `qid` wins. A recorded bubble only counts while the step it was asked at is still the open one,
 * so a question that was answered or replaced never takes a late tapback.
 */
export function openQuestionId(db: DatabaseSync, userId: number, state: FlowState | null = getFlowState(db, userId)): string | null {
  if (!state) return null;
  const own = state.data?.qid;
  if (typeof own === "string" && own) return own;
  try {
    const raw = getSetting(db, slot(userId));
    if (!raw) return null;
    const rec = JSON.parse(raw) as { id?: unknown; flow?: unknown; step?: unknown };
    return typeof rec.id === "string" && rec.flow === state.flow && rec.step === state.step ? rec.id : null;
  } catch {
    return null;
  }
}
