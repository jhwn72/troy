// Free chat: everything that isn't one of the flows. One model call writes the reply in Troy's voice from the
// brain files (brain/*.md) plus the context src/brain.ts builds in code. Code checks the reply before it is sent,
// asks once more with the reason when a check fails, and falls back to hand-written lines when the model is down.
// When the message is really a request for a flow, the model hands it off and that flow answers instead.
// For a factual campus question the directory can't answer, the model may ask for one quick web lookup (when it is
// switched on); the result comes back as a source he answers from, with at most its one link.

import type { DatabaseSync } from "node:sqlite";
import type { Bubble, FlowContext, FlowHandler, IncomingEvent, Intent } from "../types.ts";
import * as ai from "../ai.ts";
import { askJson, asksToPassOn, chatModel, fallbackIntent, lastAskFailure, lastCacheUsage, modelReady, pullDetails } from "../ai.ts";
import {
  HANDOFF_FLOWS,
  askedWhatHeDoes,
  askedWhoHeIs,
  buildChatContext,
  chatSystem,
  checkReply,
  isHeavy,
  loadBrain,
  markHeavy,
  markMove,
  noteDoubleReject,
  QUESTION_LIMIT,
  asksSomething,
  questionStreak,
  recentMessages,
  sayInHisWords,
} from "../brain.ts";
import type { ChatContext, HandoffFlow, LookupResult } from "../brain.ts";
import { isCrisis, isEmergency } from "../commands.ts";
import { lookupOn } from "../config.ts";
import { getFlowState } from "../db/index.ts";
import { isProtected, pendingFor } from "../pending.ts";
import { isDistress, pickVariant } from "../voice.ts";
import { readYesNo } from "../yes.ts";
import { doneForNow, isNeutral, isUntried, nextMove, noteQuestionAsked } from "../firstten.ts";
import { OFFER_STEP, directoryRows, keepOfferStanding, offerLive, rowMentioned } from "./reports-shared.ts";
import { isConcern } from "./usg.ts";

// ---------- fallback lines (no model) ----------

export type Situation = "greeting" | "thanks" | "vent" | "question" | "unclear" | "heard" | "what_he_does" | "who_he_is" | "about_troy" | "insult" | "heavy";

/**
 * Hand-written lines for when the model can't be reached. Each entry is one reply; "|" splits it into bubbles.
 * Rotated per person, so nobody gets the same line twice in a row. None of them lists what Troy can do,
 * except the pool used when someone asks exactly that.
 */
export const FALLBACK_POOLS: Record<Situation, string[]> = {
  greeting: ["hey, what's up", "hey hey. what's going on", "yo. what do u need", "hi. what's the move", "hey, i'm around. what's up", "sup. talk to me"],
  thanks: ["anytime", "of course. that's what i'm here for", "got u", "np, text me whenever", "always. go be great", "easy. holler if u need anything else"],
  // A friend's reaction, not a counselor's. No emoji, no jokes.
  vent: [
    "ugh. that's rough, i'm sorry",
    "nooo. ok that's actually brutal",
    "oof, that would get to me too",
    "yeah no, that's a lot for one day",
    "wait that's awful. sorry ur dealing with it",
    "that's the worst, for real",
  ],
  question: [
    "honestly not sure on that one, and i don't wanna make something up",
    "idk that one for real, and a wrong answer is worse than none",
    "that's outside what i know for sure. i'd double check with someone who does",
    "can't say for sure, and i'd rather not guess wrong on u",
    "not something i know for certain. i'd ask someone who'd know before trusting me on it",
  ],
  unclear: [
    "hm, say a little more?",
    "wait, what do u mean?",
    "not sure i followed that. run it back?",
    "i'm a little lost. what's going on?",
    "say more, i wanna get it right",
  ],
  // He has already asked two questions in a row: a line that takes what they said and asks for nothing.
  heard: ["ok, i hear u", "yeah, that tracks", "got it, that makes sense", "ah ok, i get it now", "fair. that would get to me too"],
  what_he_does: [
    "i get u to the right person, office or thing on campus|lost or found stuff, free food, broken things, or who to talk to about a campus issue",
    "think of me as the guy who knows a guy|lose something, find something, spot free food, see something broken, or need usg? text me",
    "four things mostly: lost and found, free food, broken stuff on campus, and who to talk to about a campus issue|just text me like u would a friend",
    "i connect trojans to whoever can actually help|lost and found, free food, broken things, campus issues for usg",
  ],
  who_he_is: [
    "i'm troy. an ai, not a person|i connect trojans to the right person, office or thing",
    "troy. i'm an ai that knows a guy for most things on campus",
    "i'm an ai called troy. a usc student built me at a hackathon|i'm a prototype, not an official usc thing",
    "troy, an ai. nobody's typing for me, it's just me answering",
  ],
  // A question about himself or their privacy never gets an "idk". He's slow right now, and these commands answer without the model.
  about_troy: [
    'my brain\'s being slow rn so the short version: i only see what u send me in this chat|text "what do u know about me" and i\'ll show u everything i have saved',
    'that one deserves a real answer and i\'m running slow right now|text "settings" to see ur setup, or "delete my data" to erase all of it',
    'quick version while my brain catches up: i save this chat so i can follow it, and nothing else on ur phone|"what do u know about me" shows u all of it',
    'can\'t give u the full answer this second|"what do u know about me" and "settings" both work without me thinking, and "delete my data" wipes it',
  ],
  insult: ["fair enough", "ouch. noted", "ha, ok", "that's one review", "i'll survive"],
  // No model in a conversation that turned serious: short, kind, and always a way to reach a real person.
  heavy: [
    "i'm here and i'm listening. if u want a real person right now, 988 is a call or text away, any time",
    "that sounds really hard. i'm an ai so i can only do so much, but 988 has real people on it day and night",
    "thank u for telling me. if things feel unsafe, call or text 988, or 911",
    "i hear u. u can call or text 988 any time and a real person picks up",
  ],
};

const GREETING = /^(?:hi+|hey+|heyo|hello+|yo+|sup|wassup|what'?s up|whats good|hiya|howdy|gm|gn|good (?:morning|afternoon|evening|night))(?: troy)?$/;
const THANKS = /\b(?:thanks?|thank (?:u|you)|thx|ty|tysm|tyvm|appreciate (?:it|u|you)|ur the best|you'?re the best|goated|lifesaver)\b/;
const VENT = /\b(?:hate|annoy(?:ed|ing)|ugh+|so mad|pissed|sucks?|the worst|tired of|sick of|can'?t stand|over it|frustrat(?:ed|ing)|rough (?:day|week)|bad day|drama|is killing me|fml)\b/;
const QUESTION = /\?\s*$|^(?:what|whats|when|where|who|whos|why|how|is|are|does|do|did|can|could|will|would|should|which)\b/;
const ABOUT_TROY =
  /\bwhat (?:data|info|information|stuff) (?:do|does) (?:u|you|troy) (?:keep|have|store|save|collect)\b|\b(?:do|does|can|will) (?:u|you|troy|john|anyone|someone|usc|they) (?:read|see|save|store|keep|share|sell) (?:my|this|these|our|what i)\b|\bwho (?:can |else )?(?:sees?|reads?) (?:this|my|these)\b|\bis this (?:private|anonymous|confidential)\b|\bprivacy\b|\bwhere (?:does|do) my (?:data|texts|messages|info) go\b/;
const INSULT = /^(?:u|you|ur|troy)(?:'re| are| r)? ?(?:suck|stink|trash|useless|dumb|stupid|annoying|mid|the worst|a (?:joke|scam|waste))\b|\bshut up\b|\bscrew (?:u|you)\b|\bi hate (?:u|you|troy)\b/;

/** Which pool a message falls in. Plain rules: this runs exactly when there is no model to ask. */
export function situationOf(text: string): Situation {
  const t = (text ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  const plain = t.replace(/[^a-z0-9'\s]/g, "").trim();
  if (!plain) return "unclear";
  if (ABOUT_TROY.test(t)) return "about_troy";
  if (askedWhatHeDoes(t)) return "what_he_does";
  if (askedWhoHeIs(t)) return "who_he_is";
  if (INSULT.test(t)) return "insult";
  if (GREETING.test(plain)) return "greeting";
  if (isDistress(t) || VENT.test(t)) return "vent";
  if (THANKS.test(t) && plain.split(" ").length <= 8) return "thanks";
  if (QUESTION.test(t)) return "question";
  return "unclear";
}

/** One hand-written reply for this message, never the line this person got last time in the same situation. */
export function fallbackReply(db: DatabaseSync, userId: number, text: string, opts: { heavy?: boolean; noQuestion?: boolean } = {}): string[] {
  // In a heavy conversation the line never depends on how the message happens to be worded.
  let situation = opts.heavy ? "heavy" : situationOf(text);
  // Two questions in a row already: the hand-written line may not be a third ("hm, say a little more?").
  if (opts.noQuestion && (situation === "unclear" || situation === "greeting")) situation = "heard";
  return pickVariant(db, userId, `chat:${situation}`, FALLBACK_POOLS[situation]).split("|").map((b) => b.trim()).filter(Boolean);
}

// ---------- handoff ----------

/** A handoff the model asked for, if it names a flow and action Troy has. Anything else is ignored. */
export function readHandoff(raw: unknown): { flow: HandoffFlow; action: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const h = raw as { flow?: unknown; action?: unknown };
  if (typeof h.flow !== "string" || !Object.hasOwn(HANDOFF_FLOWS, h.flow)) return null;
  const flow = h.flow as HandoffFlow;
  const actions: readonly string[] = HANDOFF_FLOWS[flow];
  return { flow, action: typeof h.action === "string" && actions.includes(h.action) ? h.action : actions[0]! };
}

/** Events already handed to a flow once. If that flow passes the message back, Troy answers it himself: no ping-pong. */
const handedOff = new WeakSet<IncomingEvent>();

/**
 * What a handoff may do when the keyword rules do NOT read the message as that flow's. The model alone never
 * changes a note, a setting or a contact rule, never claims food, and never files a report:
 * - notes: dropped. Rules, settings and "forget" only happen when code reads them in the student's own words.
 * - repair: marked `unconfirmed` unless there is a photo to go on. The flow then asks nothing and files nothing:
 *   it offers to report it and waits for a yes. A chat line with a building in it is not a report to staff.
 * - food: a read-only look at what's out there. - usg: marked `fromChat`, with what the model meant. A concern is
 *   then only offered ("want me to pass this to ...?"), and nothing is sent without a yes.
 * - lost_found: the model's action. Both only open the flow's first question.
 * - topics: a neutral action, so the flow follows, posts or unfollows only when the student's own words say so.
 * - rides, tour: each opens with its own first question.
 */
function unconfirmedHandoff(to: { flow: HandoffFlow; action: string }, hasImage: boolean): { action: string; unconfirmed?: boolean; fromChat?: boolean } | null {
  switch (to.flow) {
    case "notes":
      return null;
    case "repair":
      return { action: "report", unconfirmed: !hasImage };
    case "food":
      return { action: "status" };
    case "usg":
      return { action: "question", fromChat: true };
    case "lost_found":
      return { action: to.action };
    // Following changes what they get texted and a post reaches other students, so the model's action is dropped:
    // the topics flow gets a neutral action and acts only on what it reads in the student's own words.
    case "topics":
      return { action: "from_chat", unconfirmed: true };
    // Both only open with their own first question.
    case "rides":
      return { action: "find" };
    case "tour":
      return { action: "start" };
  }
  return null;
}

/**
 * Give the message to the flow the model named. The intent is rebuilt in code: when the keyword rules agree on
 * the flow, their action and details are used and the model's action is ignored. When they don't agree, the
 * model picks the flow at most, never an action that changes or deletes something (see unconfirmedHandoff).
 * Returns false when the handoff is dropped, that flow isn't registered or it stayed silent, so the caller
 * still says something.
 */
async function handOff(ctx: FlowContext, to: { flow: HandoffFlow; action: string }): Promise<boolean> {
  // Loaded here, not at the top: the registry imports this file.
  const { getFlow } = await import("./index.ts");
  const other = getFlow(to.flow);
  if (!other || other.name === "smalltalk") return false;
  const hasImage = ctx.event.images.length > 0;
  const rules = fallbackIntent({ text: ctx.event.text, hasImage, state: null });
  // A yes to an offer troy made in his own words a moment ago: the flow starts without offering it a second time.
  const accepted = !hasImage && saidYesToHisOffer(ctx) ? { accepted: true } : {};
  let intent: Intent;
  if (rules.flow === to.flow) {
    intent = { ...rules, source: "ai" };
    // A complaint that only reads like one (it names dining, a shuttle, a policy) is still talk. Unless they asked
    // for it to be passed on, the concern flow gets it marked as from a chat, and offers before anything is sent.
    if (to.flow === "usg" && rules.action === "concern" && !asksToPassOn(ctx.event.text)) intent.details = { ...intent.details, fromChat: true, meant: "concern", ...accepted };
  } else {
    const safe = unconfirmedHandoff(to, hasImage);
    if (!safe) return false;
    // `unconfirmed` / `fromChat` tell the flow that only the model read this as its job: offer it, file nothing.
    intent = {
      flow: to.flow,
      action: safe.action,
      details: { ...pullDetails(ctx.event.text), ...(safe.unconfirmed ? { unconfirmed: true } : {}), ...(safe.fromChat ? { fromChat: true, meant: to.action } : {}), ...(safe.unconfirmed || safe.fromChat ? accepted : {}) },
      source: "ai",
    };
  }
  let spoke = false;
  handedOff.add(ctx.event);
  await other.handle({
    ...ctx,
    intent,
    state: null,
    say: (...bubbles: (string | Bubble)[]) => {
      spoke = true;
      return ctx.say(...bubbles);
    },
  });
  // A flow that opened a step of its own has taken the message, even if it said nothing yet.
  return spoke || getFlowState(ctx.db, ctx.user.id)?.flow === to.flow;
}

const HIS_OFFER = /\b(?:want me to|should i|i can|i could|want it)\b[^?]*\b(?:pass|send|report|tell|flag|file|loop|get (?:it|this|that) (?:in front of|to|over to))\b[^?]*\?/;

/** Their message is a plain yes, and the last thing troy said was his own offer to send or report something. */
function saidYesToHisOffer(ctx: FlowContext): boolean {
  try {
    if (readYesNo({ event: ctx.event, questionMessageId: null }) !== "yes") return false;
    const his = recentMessages(ctx.db, ctx.event.chatId, { limit: 4, excludeMessageId: ctx.event.messageId }).filter((l) => l.from === "troy" && !l.notice);
    const last = his[his.length - 1];
    return !!last && HIS_OFFER.test(last.text.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * True while a lost and found step is open for this person (or a question is parked for them). The pipeline lets
 * a chat message through at such a step; the reply may chat, but may not sound like the step's result.
 */
export function lockedStepOpen(db: DatabaseSync, userId: number): boolean {
  try {
    const cur = getFlowState(db, userId);
    if (cur && (cur.flow === "lost_found" || isProtected(db, cur))) return true;
    return pendingFor(db, userId).length > 0;
  } catch {
    return false;
  }
}

const READS_AS_QUESTION = /\?\s*$|^(?:(?:so|wait|hey|yo|ok|okay|and|but)[ ,]+)*(?:is|are|was|does|do|did|can|could|will|when|whens|when's|what|whats|what's|where|wheres|where's|who|how|hows|how's|which|any)\b/i;

/**
 * A plain question about one of the programs in the directory (the lax shuttle, the farmers market, club funding).
 * The usg flow answers those with the stored text, word for word: a program's name, dates and link are never
 * the chat model's to phrase ("around breaks" must not become "thanksgiving should be covered").
 */
export function asksAboutProgram(db: DatabaseSync, text: string): boolean {
  const t = (text ?? "").trim();
  if (!t || !READS_AS_QUESTION.test(t) || isConcern(t, "question")) return false;
  try {
    return !!rowMentioned(directoryRows(db, "usg_program"), t, /\busg\b|student government/i.test(t));
  } catch {
    return false;
  }
}

// ---------- quick lookup ----------

export type QuickLookup = (input: { question: string; userId: number; db: DatabaseSync }) => Promise<LookupResult | null>;

let lookupOverride: QuickLookup | null = null;
let lookupAckMs = 1200;

/** Tests only: replace the lookup (and how long it may run before "lemme check" goes out). Pass null to restore. */
export function setQuickLookup(fn: QuickLookup | null, ackAfterMs: number = 1200): void {
  lookupOverride = fn;
  lookupAckMs = ackAfterMs;
}

/** The lookup to use right now, or null when it is off. src/ai.ts owns the real one (quickLookup), behind TROY_LOOKUP. */
function lookupFn(): QuickLookup | null {
  if (lookupOverride) return lookupOverride;
  const real = (ai as unknown as Record<string, unknown>).quickLookup;
  return lookupOn() && typeof real === "function" ? (real as QuickLookup) : null;
}

/** Said only when the lookup is taking more than a moment. */
export const LOOKUP_ACKS = ["lemme check", "one sec, looking that up", "hm, lemme look", "gimme a sec, checking", "hold on, lemme find out"];

/** Things a lookup is never for, whatever the model asked: people, rumors, medicine, troy himself, anything a rule decides. */
const LOOKUP_BLOCKED =
  /\b(?:dos(?:e|es|age)|mg|tylenol|ibuprofen|advil|adderall|xanax|pills?|overdos\w*|suicid\w*|self harm|rumou?rs?|cheat(?:ed|ing)|expelled|arrested|allegations?|pickup code|verif\w*|troy|john|visa status|my (?:visa|aid|scholarship|gpa|grades?|balance|bill))\b/;

/** The model's lookup request as a short generic search, or null when it isn't one (too long, a contact, a blocked topic). */
export function readLookup(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const q = raw.replace(/\s+/g, " ").trim().toLowerCase();
  if (q.length < 6 || q.length > 120 || q.split(" ").length > 16) return null;
  if (/@|https?:|\d{5,}/.test(q) || LOOKUP_BLOCKED.test(q)) return null;
  return q;
}

/** One lookup. If it runs longer than a moment, a short "lemme check" goes out first. Never throws. */
async function runLookup(db: DatabaseSync, userId: number, question: string, ack?: (line: string) => Promise<unknown>): Promise<LookupResult | null> {
  const fn = lookupFn();
  if (!fn) return null;
  let done = false;
  const work: Promise<LookupResult | null> = fn({ question, userId, db })
    .catch(() => null)
    .then((r) => {
      done = true;
      return r && typeof r === "object" && typeof r.answer === "string" && r.answer.trim() ? r : null;
    });
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([work, new Promise((resolve) => (timer = setTimeout(resolve, lookupAckMs)))]);
  clearTimeout(timer);
  if (!done && ack) await ack(pickVariant(db, userId, "chat:lookup_ack", LOOKUP_ACKS)).catch(() => {});
  return work;
}

// ---------- stump me ----------

/** Hand-written versions of the dare, for when the model can't write it. */
export const STUMP_INVITES: string[][] = [
  ["ok try me: name any campus problem and i'll tell u who handles it"],
  ["bet u can't stump me", "name something annoying on campus and i'll say who fixes it"],
  ["here's a game. tell me any campus problem, big or dumb, and i'll tell u whose job it is"],
  ["go ahead, try to stump me. any problem on campus, i'll say who deals with it"],
];

/** They tapped or typed the "stump me" move (the try-me poll hands it over as action "stump" or details.move "stump"). */
function wantsStump(ctx: Pick<FlowContext, "event" | "intent">): boolean {
  if (ctx.intent.action === "stump" || ctx.intent.details.move === "stump") return true;
  return /^(?:ok |okay |fine |lets |let's )?stump (?:me|u|you|troy)\b[.!]*$/i.test((ctx.event.text ?? "").trim());
}

/**
 * The "stump me" move: he dares them to name any campus problem and says who handles it. The dare is in his own
 * words (a rotated hand-written one when the model is down). What they name next is answered by free chat from
 * the looked up rows; the context knows the dare is open.
 */
export async function stumpInvite(ctx: FlowContext): Promise<void> {
  markMove(ctx.db, ctx.user.id, "stump");
  const bubbles = await sayInHisWords(ctx, {
    goal: "dare them, playfully and in one or two short bubbles, to try to stump troy",
    mustCover: ["they can name any problem on campus", "troy will say who handles it"],
    fallback: STUMP_INVITES,
  });
  await ctx.say(...(bubbles.length ? bubbles : STUMP_INVITES[0]!));
}

const SOUNDS_LIKE_STUMP = /\bstump me\b|\bname (?:any|a|some) (?:campus )?(?:problem|issue)\b/;
/** He offered the try-it run in his own words. It counts as offered, so code never offers it again. */
const SOUNDS_LIKE_TOUR = /\bpretend (?:u|you)(?:'ve| have)? lost\b|\breal check on (?:u|you)\b|\bpractice (?:run|round)\b|\btry[- ]it (?:tour|run)\b/;
/** He asked the one question in his own words. The answer then goes somewhere real (src/firstten.ts adjustIntent). */
const SOUNDS_LIKE_QUESTION = /\bwish (?:was|were|felt) (?:easier|simpler|less)\b|\b(?:easier|simpler|less of a hassle) at usc\b|\bat usc (?:u|you)(?:'d| would)? (?:wish|change|fix)\b/;

// ---------- the reply ----------

type ModelReply = { bubbles?: unknown; handoff?: unknown; lookup?: unknown };

function modelPrompt(c: ChatContext, rejected: string | null): string {
  return rejected ? `${c.prompt}\n\nyour last reply was not sent: ${rejected}. write it again.` : c.prompt;
}

const LOOKUP_EMPTY = "u asked for a quick lookup and it found nothing usable. say honestly that u don't know this one and who would, in plain words. no number, date, price or link.";

/**
 * Troy's reply to a free message: the bubbles to send, or a flow to hand the message to.
 * Two tries at most (the second one carries the reason the first was rejected), then the hand-written fallback.
 * When the model asks for a quick lookup (and one is allowed), it runs once and he answers again from the result;
 * `ack` is called with a short "lemme check" if the lookup takes more than a moment.
 */
export async function chatReply(input: {
  db: DatabaseSync;
  ctx: Pick<FlowContext, "user" | "event" | "intent">;
  allowHandoff?: boolean;
  ack?: (line: string) => Promise<unknown>;
  /** Extra lines for the model about this one reply. */
  extra?: string[];
}): Promise<{ bubbles: string[]; handoff: { flow: HandoffFlow; action: string } | null; source: "model" | "fallback" }> {
  const { db } = input;
  const { user, event, intent } = input.ctx;
  const started = Date.now();
  // TROY_CHAT_DEBUG=1 logs one line per free reply: where it came from, how long the model took, why a try was
  // rejected, and the cache token counts. Never the student's text and never a handle.
  const debug = (outcome: string, attempt: number, reason?: string) => {
    if (process.env.TROY_CHAT_DEBUG !== "1") return;
    const cache = lastCacheUsage();
    console.log(`chat reply: ${outcome} model=${chatModel()} tries=${attempt} ms=${Date.now() - started} cacheRead=${cache?.read ?? 0} cacheWritten=${cache?.written ?? 0}${reason ? ` rejected="${reason}"` : ""}`);
  };
  // The pipeline's safety read can say this message is heavy; that sticks for a while (see markHeavy).
  if (intent.details.heavy === true) markHeavy(db, user.id);
  const heavy = intent.details.heavy === true || isHeavy(db, user.id);
  // Two questions in a row already: whatever goes out next, hand-written lines included, is not a third.
  const noQuestion = !heavy && !getFlowState(db, user.id) && questionStreak(db, event.chatId) >= QUESTION_LIMIT;
  const fallback = () => ({ bubbles: fallbackReply(db, user.id, event.text, { heavy, noQuestion }), handoff: null, source: "fallback" as const });
  if (!modelReady()) return fallback();

  const brain = loadBrain();
  const lockedStep = lockedStepOpen(db, user.id);
  // Never a lookup in a heavy or frightening moment, at an open step, or when it is switched off.
  const lookupAvailable = !heavy && !lockedStep && !isDistress(event.text) && !isCrisis(event.text) && !isEmergency(event.text) && lookupFn() !== null;
  // New and untried, with no step open: the brief tells him to close on one concrete next step, and the checks hold him to it.
  const pull = !getFlowState(db, user.id);
  const base = { db, user, chatId: event.chatId, text: event.text, messageId: event.messageId, hasImage: event.images.length > 0, details: intent.details, brain, lockedStep, heavy, pull };
  let c = buildChatContext({ ...base, lookupAvailable, ...(input.extra?.length ? { extra: input.extra } : {}) });
  let lookedUp = false;
  const model = chatModel();
  let rejected: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw: ModelReply | unknown[] | null = await askJson<ModelReply | unknown[]>({
      model,
      system: chatSystem(brain),
      prompt: modelPrompt(c, rejected),
      maxTokens: 500,
      timeoutMs: model === "smart" ? 20_000 : 9000,
      cacheSystem: true,
    });
    // The bubbles alone, without the object around them: still his reply.
    const out: ModelReply | null = Array.isArray(raw) ? (raw.length && raw.every((b) => typeof b === "string") ? { bubbles: raw } : null) : raw && typeof raw === "object" ? raw : null;
    if (!out) {
      // An answer that came back fast but wasn't the shape asked for gets one more try. Down, slow or refused does
      // not: asking again would only double the wait.
      if (attempt === 0 && Date.now() - started < 6000 && (raw !== null || lastAskFailure() === "no json")) {
        debug(`retry(${raw === null ? "no answer" : "wrong shape"})`, 1);
        rejected = "it was not the JSON object asked for. reply with only that JSON object";
        continue;
      }
      debug("fallback(no answer)", attempt + 1);
      return fallback();
    }
    const handoff = input.allowHandoff === false ? null : readHandoff(out.handoff);
    if (handoff) {
      debug(`handoff(${handoff.flow}.${handoff.action})`, attempt + 1);
      return { bubbles: [], handoff, source: "model" };
    }
    // Rows that matched loosely don't rule a lookup out: the model asks for one only when none of them answers it.
    const question = !lookedUp && lookupAvailable ? readLookup(out.lookup) : null;
    if (question) {
      // One lookup per message. He answers again with the result (or the news that there wasn't one) in front of him.
      lookedUp = true;
      const found = await runLookup(db, user.id, question, input.ack);
      debug(found ? "lookup(found)" : "lookup(empty)", attempt + 1);
      c = buildChatContext({ ...base, lookup: found, extra: found ? [] : [LOOKUP_EMPTY] });
      rejected = null;
      attempt = -1;
      continue;
    }
    let check = checkReply(out.bubbles, c);
    if (check.ok && c.onlyLink !== undefined && check.bubbles.length > 2) check = { ok: false, reason: "a looked up answer is at most two bubbles. keep the best guess, where it's from and double check" };
    if (check.ok) {
      debug("model", attempt + 1);
      return { bubbles: check.bubbles, handoff: null, source: "model" };
    }
    rejected = check.reason;
    debug("rejected", attempt + 1, check.reason);
  }
  debug("fallback(rejected twice)", 2);
  noteDoubleReject(db);
  return fallback();
}

const OFFER_STANDS =
  "troy just offered to pass this on (or report it) for them, and that offer is still open. they kept talking instead of answering it. react to what they just said like a friend, in one or two short bubbles. do not ask anything and do not make or repeat the offer: it stands, and they can still say yes to it.";

export const smalltalk: FlowHandler = {
  name: "smalltalk",
  async handle(ctx) {
    // A location share with no words never gets here: the pipeline saves it and answers with a fixed line.
    const again = handedOff.has(ctx.event);
    if (!again && wantsStump(ctx)) return stumpInvite(ctx);
    // A question about a directory program goes to the flow that sends the stored answer.
    if (!again && asksAboutProgram(ctx.db, ctx.event.text) && (await handOff(ctx, { flow: "usg", action: "question" }))) return;
    // New and untried with nothing open: a bare "ok" or "cool" is not a goodbye. He makes the next move himself
    // (the pipeline usually catches this earlier, in firstTenIntercept; this is the same move for any other path here).
    // "maybe later", "nah im good", "gtg" come first: he takes them at their word, one easy line and no next step.
    const calm = !isHeavy(ctx.db, ctx.user.id) && ctx.intent.details.heavy !== true;
    if (!again && calm && !getFlowState(ctx.db, ctx.user.id) && (await doneForNow(ctx))) return;
    const untried = !again && !getFlowState(ctx.db, ctx.user.id) && calm && isUntried(ctx.db, ctx.user.id);
    if (untried && isNeutral(ctx.event.text) && (await nextMove(ctx))) return;
    const ack = (line: string) => ctx.say(line);
    let reply = await chatReply({ db: ctx.db, ctx, allowHandoff: !again, ack });
    // An offer of his is open and they said something that isn't an answer to it (the flow stayed silent and passed
    // the message here). The model's own read says whether they are still on it: a handoff to that same flow means
    // yes. Then he just reacts, asks nothing and does not make the offer again, and the offer stands. Anything else
    // means they moved on, and the offer is dropped before the message is handled as what it is.
    // (A live offer still open at this point means its flow read this message and left it: had it been an answer, the
    // flow would have spoken or cleared the step.)
    const open = again ? null : getFlowState(ctx.db, ctx.user.id);
    if (open && open.step === OFFER_STEP && (open.flow === "usg" || open.flow === "repair") && offerLive(ctx.db, ctx.event.chatId, open)) {
      if (reply.handoff?.flow === open.flow) {
        reply = await chatReply({ db: ctx.db, ctx, allowHandoff: false, ack, extra: [OFFER_STANDS] });
        const said = reply.bubbles.length ? reply.bubbles : fallbackReply(ctx.db, ctx.user.id, ctx.event.text, { heavy: isHeavy(ctx.db, ctx.user.id), noQuestion: true });
        await ctx.say(...said);
        // A question of his own would make their next yes an answer to that, so the offer only stands after a reply that asks nothing.
        if (said.some(asksSomething) || !keepOfferStanding(ctx.db, ctx.user.id, ctx.event.chatId, ctx.event.text)) ctx.setState(null);
        return;
      }
      ctx.setState(null);
    }
    if (reply.handoff) {
      if (await handOff(ctx, reply.handoff)) return;
      // The flow didn't take it (not registered, or it stayed silent): Troy answers it himself after all.
      reply = await chatReply({ db: ctx.db, ctx, allowHandoff: false, ack });
    }
    const heavyNow = isHeavy(ctx.db, ctx.user.id);
    const bubbles = reply.bubbles.length ? reply.bubbles : fallbackReply(ctx.db, ctx.user.id, ctx.event.text, { heavy: heavyNow, noQuestion: !heavyNow && questionStreak(ctx.db, ctx.event.chatId) >= QUESTION_LIMIT });
    await ctx.say(...bubbles);
    // He made the "stump me" dare on his own: it counts as used, and what they name next is their attempt.
    const said = bubbles.join(" ").toLowerCase();
    if (reply.source === "model") {
      if (SOUNDS_LIKE_STUMP.test(said)) markMove(ctx.db, ctx.user.id, "stump");
      if (SOUNDS_LIKE_TOUR.test(said)) markMove(ctx.db, ctx.user.id, "tour");
      if (SOUNDS_LIKE_QUESTION.test(said)) {
        markMove(ctx.db, ctx.user.id, "one_question");
        noteQuestionAsked(ctx.db, ctx.user.id);
      }
      return;
    }
    // The model is down, so the line above came from a pool and can't know to pull. Code may close on a one-line
    // offer (the tour, the one question), but it never launches a whole example run after something they actually said.
    if (untried && isUntried(ctx.db, ctx.user.id)) await nextMove(ctx, { offersOnly: true });
  },
};
