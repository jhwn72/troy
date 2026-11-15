// The simulated other side (John, "Judge mode, additions (a)").
//
// When Troy finds nobody real to connect someone with, he says so plainly (no other users are on right now because
// this is a demo, and the flow itself works) and offers to show how it would play out: one tap on "show me". He then
// plays the other person's side in real time, with pauses like a real exchange and with example people that are
// labeled once at the start, and ends on the same texts the real flow sends. Offered to anyone, judge or student.
//
//   lost_found_owner   an example finder turns it in, the REAL blind check runs on what they type (scoreDescription),
//                      the example finder picks meet or DPS, then the real handoff texts (pickup code, or the
//                      group-chat warning described)
//   lost_found_finder  an example owner asks, describes, passes; they pick the handoff like a real finder
//   food               example students claim and the count drops with the real count texts
//   repair             an example technician says "on it" then "done" and the real status texts arrive
//   usg                an example usg member replies and the real status texts arrive
//   rides, topics      example people answer
//
// NOTHING SIMULATED IS SAVED WHERE IT COULD MATCH OR ALERT A REAL USER. No row is written to listings, matches,
// verifications, handoffs, food_drops, claims, reports or topic posts, no group chat is ever created, and nothing is
// sent to anyone but the person watching. Everything lives in their own flow_state (flow "tour") until it ends.
//
// The try-it tour (src/flows/tour.ts) runs its lost-item round on this same engine, with its own example item.
//
// STEPS (flow_state.flow = "tour"; the tour handler passes them here)
// step            | waiting for                              | goes to
// ----------------|------------------------------------------|---------------------------------------------------
// sim_offer       | a tap on "show me", or a typed yes / no  | yes: the simulation plays. no: one easy line, done.
// describe        | their description (data.sim is set)      | pass: handoff or done. miss with a try left: stays.
// handoff         | yes / no to the pretend contact question | either: what would happen, the close, done
// sim_finder_pick | 1 (meet) or 2 (dps)                      | the real handoff texts for that choice, the close, done

import type { DatabaseSync } from "node:sqlite";
import type { FlowContext, FlowName } from "./types.ts";
import { getFlowState, getSetting, saveMessage, setSetting } from "./db/index.ts";
import { modelReady } from "./ai.ts";
import { pickVariant } from "./voice.ts";
import { readYesNo } from "./yes.ts";
import { atStep, inHisWords, isNeutral, relax, saysDone } from "./firstten.ts";
import type { Brief } from "./firstten.ts";
import { CANCEL } from "./flows/reports-shared.ts";
import { othersOnTroy } from "./brain.ts";
import { normalizeCategory } from "./flows/lostfound/types.ts";
import type { ItemProfile } from "./flows/lostfound/types.ts";
import { THRESHOLDS, generatePickupCode, scoreDescription } from "./flows/lostfound/verify.ts";
import { COPY, isDescriptionAttempt, restatesLoss } from "./flows/lostfound/handler.ts";
import { FOOD_COPY, countLine } from "./flows/food.ts";

const TOUR = "tour" as FlowName;

export type SimKind = "lost_found_owner" | "lost_found_finder" | "food" | "repair" | "usg" | "rides" | "topics";
const KINDS: readonly SimKind[] = ["lost_found_owner", "lost_found_finder", "food", "repair", "usg", "rides", "topics"];

export const SIM_OFFER_STEP = "sim_offer";
export const SIM_PICK_STEP = "sim_finder_pick";
export const SHOW_ME = "show me";
/** The poll's second option: a native poll needs two, and a pick-one ask is one tap either way. */
export const NOT_NOW = "not now";

/** How long the example person "takes" before each of their messages. Tests set pause to nothing. */
export const BEATS = { short: 1500, reply: 3500 } as const;

type Deps = { pause: (ms: number) => Promise<void>; pickupCode: () => string };
const realDeps: Deps = { pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), pickupCode: generatePickupCode };
const deps: Deps = { ...realDeps };

/** Tests: no waiting, a known code. Null restores the real ones. */
export function setSimulateDeps(over: Partial<Deps> | null): void {
  Object.assign(deps, over ?? realDeps);
}

// ---------- what a run remembers (all of it in the person's own flow state) ----------

export interface LostSim {
  kind: "lost_found_owner";
  /** What their description is scored against. The tour's fixed example item, or a profile built from their own report. */
  profile: ItemProfile;
  /** True for the tour: only the real pass mark counts. False for a profile built from their own words (see scoreOf). */
  strict: boolean;
  tries: number;
  /** The tour started this run and adds its own "one more?" afterwards. */
  tour: boolean;
  handoff: "meet" | "dps";
  /** The run was offered after a real report of theirs, which is saved and stays open. */
  real?: boolean;
}
type FinderSim = { kind: "lost_found_finder"; summary: string; real?: boolean };
type Sim = LostSim | FinderSim;

export type SimOutcome = "none" | "open" | "finished" | "stopped";

// ---------- wording ----------

/**
 * His own words for a brief. `max` caps the bubbles for lines that sit inside a longer turn (the close, a note about
 * a code): when his own version runs longer, a hand-written one that fits goes out instead.
 */
const say = async (ctx: FlowContext, key: string, brief: Brief, max = 3): Promise<(string | null)[]> => {
  let bubbles = await inHisWords(ctx, `sim:${key}`, brief);
  if (bubbles.length > max) {
    const short = brief.fallback.filter((v) => v.length && v.length <= max);
    if (short.length) bubbles = short[Number(pickVariant(ctx.db, ctx.user.id, `sim:${key}:short`, short.map((_, i) => String(i)))) || 0] ?? short[0]!;
  }
  return ctx.say(...bubbles);
};
const lastId = (sent: (string | null)[]): string | null => [...sent].reverse().find((id): id is string => typeof id === "string" && !!id) ?? null;
const pick = (ctx: FlowContext, key: string, variants: string[]): string => pickVariant(ctx.db, ctx.user.id, `sim:${key}`, variants);
const clean = (v: unknown, fallback: string, max = 60): string => {
  const t = typeof v === "string" ? v.replace(/["“”\n\r]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase().slice(0, max) : "";
  return t || fallback;
};

const PEOPLE: Record<SimKind, string> = {
  lost_found_owner: "example finder",
  lost_found_finder: "example owner",
  food: "example students",
  repair: "example technician",
  usg: "example usg member",
  rides: "example riders",
  topics: "example students",
};

const WHAT: Record<SimKind, string> = {
  lost_found_owner: "someone turning it in and the check and handoff that follow",
  lost_found_finder: "the owner turning up and claiming it",
  food: "students nearby claiming it",
  repair: "a technician picking it up and fixing it",
  usg: "someone from student government answering",
  rides: "other riders answering",
  topics: "other students answering",
};

/**
 * What is actually true about the other side right now, when other people ARE on troy: the caller found nobody for
 * this one (John, second live test: status lines are true to the moment, and "nobody else is on me" only when it
 * literally is).
 */
const NONE_FOR: Record<SimKind, string> = {
  lost_found_owner: "nothing like it has been turned in yet",
  lost_found_finder: "nobody has reported losing anything like it yet",
  food: "no students who get food texts are close enough right now",
  repair: "no technician for that is on here yet",
  usg: "no student government member is on here yet",
  rides: "no open rides match yet",
  topics: "nobody who follows that is close by right now",
};

/**
 * The honest line before the offer. The same for a judge and a student. `others` is the real count of other people
 * on troy: only at 0 does he say nobody else is on here.
 */
function offerBrief(kind: SimKind, others: number): Brief {
  if (others > 0) {
    const none = NONE_FOR[kind];
    return {
      goal: `be straight with them: ${none}, so there is no real ${PEOPLE[kind].replace(/^example /, "")} to connect them with yet. it's a hackathon demo. the flow itself works. offer to show how it would play out (${WHAT[kind]}). one or two short texts, and don't ask a question: a poll follows. other people are on troy, so never say nobody else is on here`,
      mustCover: [none, "this is a demo", "the flow itself works", "he can show them how it would play out"],
      facts: { "what is true right now": none },
      fallback: [
        [`real talk: ${none}. it's a demo, so that's normal`, "the flow itself works tho. i can show u how it would play out"],
        [`gotta be honest, ${none}. this is a hackathon demo`, "everything behind it works. i can play the other side so u see how it goes"],
        [`straight up: ${none}, it's a demo`, "the flow is real tho, and i can show u exactly how it plays out"],
      ],
    };
  }
  return {
    goal: `be straight with them: there's nobody else on troy right now because this is a hackathon demo, so there is no real ${PEOPLE[kind].replace(/^example /, "")} to connect them with yet. the flow itself works. offer to show how it would play out (${WHAT[kind]}). one or two short texts, and don't ask a question: a poll follows`,
    mustCover: ["nobody else is on here right now because this is a demo", "the flow itself works", "he can show them how it would play out"],
    fallback: [
      ["real talk: nobody else is on here rn because this is a demo, so there's no one real on the other end yet", "the flow itself works tho. i can show u how it would play out"],
      ["gotta be honest, this is a demo and no other users are on right now", "everything behind it works. i can play the other side so u see how it goes"],
      ["straight up: it's a demo, so nobody else is on here to connect u with yet", "the flow is real tho, and i can show u exactly how it plays out"],
    ],
  };
}

// One tap instruction at most per message: the question itself names no way to tap (a native poll needs none),
// and only the tap fallback adds one hint.
const OFFER_QUESTION = ["want to see it play out?", "wanna watch how it goes?", "want to see it in action?"];
const OFFER_TAP_HINT = ["heart the one u want", "heart or thumbs up one of those"];
const OFFER_NUMBER_HINT = ['reply "show me" and i\'ll run it', 'text "show me" to start'];

const OFFER_NO: Brief = {
  goal: "they passed on seeing the simulation. one short easy line. what they actually asked for is still saved and still open",
  mustCover: ["no problem", "what they asked for is still open"],
  fallback: [["all good. what u sent me is still open on my end"], ["no worries, ur request stays open either way"], ["fair. the real one's still open, i'll text u if someone turns up"]],
};

/** Each example person is labeled once, at the start. */
function labelBrief(kind: SimKind): Brief {
  const who = PEOPLE[kind];
  return {
    goal: `one short text before the simulation starts: he is playing the other side, and the "${who}" in the next texts ${who.endsWith("s") ? "are" : "is"} not real`,
    mustCover: ["he is playing the other side", `the ${who} ${who.endsWith("s") ? "are" : "is"} made up, not real`],
    facts: { who },
    fallback: [
      [`ok, i'm playing the other side. the ${who} in these texts ${who.endsWith("s") ? "are" : "is"} made up, not real`],
      [`here we go. the ${who} below ${who.endsWith("s") ? "are" : "is"} me playing the other side, nobody real`],
      [`simulation on. everything from the ${who} is me, not a real person`],
    ],
  };
}

const CLOSE: Brief = {
  goal: "the simulation is over. in exactly ONE short bubble: that was a simulation and nothing was saved or sent to anyone, and with real trojans on here this is exactly what happens",
  mustCover: ["that was a simulation, nothing was saved", "with real trojans on here this is exactly what happens"],
  fallback: [
    ["that was a simulation, nothing got saved. with real trojans on here that's exactly what happens"],
    ["and that's the simulation, nothing was kept or sent to anyone. with real trojans on here it goes exactly like that"],
    ["simulation over, nothing saved. put real trojans on here and this is exactly what happens"],
  ],
};

// The offer came after something real of theirs (a report, a post, a drop). That one was kept, and the close says so.
const CLOSE_REAL: Brief = {
  goal: "the simulation is over. say the simulation part was made up and went to nobody, that what they actually sent him is saved and still open, and that with real trojans on here this is exactly what happens. one or two short texts",
  mustCover: ["that was a simulation, none of it went to anyone", "what they really sent him is saved and still open", "with real trojans on here this is exactly what happens"],
  fallback: [
    ["that was the simulation part, none of it went to anyone", "the real one u sent me is saved and still open. with real trojans on here that's exactly how it goes"],
    ["simulation over, nobody real got any of that", "what u actually sent me is still open on my end, and with real trojans on here it plays out just like this"],
    ["ok that's the simulated side, made up and sent to no one", "ur real one stays saved and open. put real trojans on here and this is exactly what happens"],
  ],
};

/** True when the simulation was offered after a real request: the context carries the row it was saved as. */
const fromRealRequest = (context: Record<string, string>): boolean => ["listingId", "reportId", "dropId", "postId", "rideId", "requestId"].some((k) => typeof context[k] === "string" && !!context[k]!.trim());

// "ok" or a thumbs up where a description was asked for: a nudge in new words each time, never the confused line.
const DESCRIBE_NUDGE: Brief = {
  goal: "they replied with just an ok but haven't described the item yet. one short friendly nudge: ask them to describe it in their own words",
  mustCover: ["describe it in their own words"],
  fallback: [["go ahead, describe it for me in ur own words"], ["whenever ur ready: what does it look like, in ur own words?"], ["so what does it look like? describe it in ur own words"], ["ur turn. tell me what it looks like in ur own words"]],
};

const STOPPED: Brief = {
  goal: "they backed out of the simulation. one short easy line",
  mustCover: ["no problem, the simulation is over"],
  fallback: [["all good, simulation's over"], ["no worries, we can stop there"], ["bet, done with that one"], ["easy, dropping it"]],
};

// With the model down the real flow never passes anyone on the rule score alone: the finder reads the description and decides.
const PASSED_BY_FINDER: Brief = {
  goal: "the ai check is down right now, so explain what really happens then: the finder reads their description and decides, and the example finder said it sounds right",
  mustCover: ["the ai check is down right now", "then the finder reads the description and decides", "the example finder said it sounds right"],
  fallback: [
    ["my ai check is down rn, so for real i'd show the finder ur description and let them decide", "the example finder says it sounds right"],
    ["the ai check is down rn. when that happens the finder reads what u wrote and makes the call", "the example finder says that sounds like it"],
  ],
};

// The pretend version of the contact warning. The real one (COPY.consent) is fixed and only ever sent for a real handoff.
const HANDOFF_ASK: Brief = {
  goal: "explain that before any group chat he warns both people that it shares their contact info, and asks. ask them the pretend version: ok to share their contact with the finder, yes or no",
  mustCover: ["before a group chat he warns both people it shares their contact info", "pretend question: ok to share theirs with the finder", "yes or no"],
  // Exact words to type go in double quotes, his wording or not.
  facts: { "words they can answer with": '"yes" or "no"' },
  fallback: [
    ["before i put two people in a group chat i warn them both that it shares their contact info", 'so, pretend version: ok to share urs with the finder? "yes" or "no"'],
    ["a group chat shares ur contact info, so i always ask both people first", 'pretend i\'m asking u now: ok to share urs with the finder? "yes" or "no"'],
    ["i never open a group chat without warning both sides that it shares contact info", 'so for the example: ok to share urs with the finder? "yes" or "no"'],
  ],
};

const HANDOFF_YES: Brief = {
  goal: 'they said yes. in ONE short bubble, explain what happens for real: once both say yes he opens a group chat with the two of them and steps back, and the owner texts "got it" when it\'s back. no group chat is opened here because the finder is an example',
  mustCover: ["once both say yes he opens a group chat with the two of them and steps back", 'they text "got it" when the item is back'],
  facts: { word: '"got it"' },
  fallback: [
    ['for real, once u both say yes i open a group chat with the two of u and step back. u text "got it" when it\'s back with u'],
    ['that\'s when i\'d start a group chat for u two and get out of the way. u\'d text me "got it" once u have it'],
    ['with both yeses i put u two in a group chat and step back. when it\'s in ur hands u text "got it"'],
  ],
};

const HANDOFF_NO: Brief = {
  goal: 'they said no. in ONE short bubble, explain what happens for real: no group chat, he passes messages between the two so nobody\'s number is shared, and the owner texts "got it" when it\'s back',
  mustCover: ["no group chat then", "he passes messages between them so nobody's number is shared", 'they text "got it" when the item is back'],
  facts: { word: '"got it"' },
  fallback: [
    ['then no group chat. for real i\'d pass messages between u two so nobody\'s number is shared, and u\'d text "got it" when it\'s back'],
    ['all good, a no means i relay messages between u instead and nobody sees a number. u text "got it" once u have it'],
    ['no works too. i\'d carry messages back and forth so no contact info moves, then u text "got it" when it\'s urs again'],
  ],
};

const FAILED: Brief = {
  goal: "their description still did not line up. say that for real this is where he stops and the finder decides what happens, so nobody gets an item by guessing. no hint about what was wrong",
  mustCover: ["for real this is where he stops and the finder decides", "nobody gets an item by guessing"],
  fallback: [
    ["for real this is where i stop and the finder decides what happens", "that's the point: nobody gets someone's stuff by guessing"],
    ["in the real thing i'd stop here and leave it to the finder", "so guessing never gets anyone an item"],
    ["a real claim ends here and the finder makes the call", "nobody talks their way into someone else's stuff"],
  ],
};

const CODE_NOTE: Brief = {
  goal: "one short text about the pickup code he just sent: it's an example code, so dps doesn't have it. for real they show that code at dps lost and found to pick the item up",
  mustCover: ["that code is an example, dps doesn't have it", "for real they show the code at dps lost and found to pick it up"],
  fallback: [
    ["that code's an example, so dps doesn't have it. for real u show it at dps lost and found and they hand it over"],
    ["example code, so don't take it to dps. in the real thing that code is how dps lost and found knows it's u"],
  ],
};

function groupBrief(who: string): Brief {
  return {
    goal: `explain what happens next for real, in one or two short texts: before any group chat he warns everyone that it shares their contact info and each person has to ok it, then he opens the chat and steps back. there is no group chat here, because the ${who} ${who.endsWith("s") ? "are" : "is"} made up`,
    mustCover: ["before a group chat he warns everyone it shares their contact info and each person oks it", "then he opens the group chat and steps back", "no group chat here because the other side is an example"],
    fallback: [
      ["for real, next i'd warn everyone that a group chat shares contact info and wait for each ok", `then i open the chat and step back. no chat here tho, the ${who} ${who.endsWith("s") ? "aren't" : "isn't"} real`],
      ["next step in the real thing: everyone gets a heads up that a group chat shares their contact info, and has to ok it", `once they do i start it and get out of the way. not opening one with ${who.endsWith("s") ? "made up people" : "a made up person"}`],
    ],
  };
}

// ---------- once per person and kind ----------

const seenKey = (userId: number, kind: SimKind): string => `sim:${userId}:${kind}`;

function alreadyOffered(db: DatabaseSync, userId: number, kind: SimKind): boolean {
  try {
    return getSetting(db, seenKey(userId, kind)) !== null;
  } catch {
    return false;
  }
}

/** A judge-only aside after a step (src/judge.ts, written by another builder). Nothing happens without it. */
async function aside(ctx: FlowContext, note: { step: string; behind?: { did: string; numbers?: Record<string, number | string> }; decision?: string }): Promise<void> {
  try {
    const file = "./judge.ts";
    const mod = (await import(file)) as { judgeAside?: (c: FlowContext, n: typeof note) => Promise<void> };
    if (typeof mod.judgeAside === "function") await mod.judgeAside(ctx, note);
  } catch {
    // No judge module, or it failed: the step already said everything it had to.
  }
}

// ---------- the offer ----------

/**
 * Troy found nobody real to connect this person with. He says so plainly, and offers the simulation with a one-tap
 * poll ("show me"). Returns true when the offer went out, and the person's state is then this offer. Returns false
 * (and says nothing) for an unknown kind, someone who stopped, or someone who was already offered this kind: the
 * caller then says what it normally says.
 */
export async function offerSimulation(ctx: FlowContext, kind: SimKind, context: Record<string, string>): Promise<boolean> {
  const { db, user } = ctx;
  if (!KINDS.includes(kind) || user.stopped || alreadyOffered(db, user.id, kind)) return false;
  try {
    setSetting(db, seenKey(user.id, kind), String(Date.now()));
  } catch {
    // The offer still goes out.
  }
  const lines = await say(ctx, `offer:${kind}`, offerBrief(kind, othersOnTroy(db, user.id)));
  const question = pick(ctx, "offer:question", OFFER_QUESTION);
  const options = [SHOW_ME, NOT_NOW];
  const none = { optionMessageIds: options.map(() => null) as (string | null)[], mode: "numbered" as const };
  const poll = await ctx.adapter.sendPoll(user.chatId, question, options).catch(() => none);
  const save = (providerMessageId: string | null, text: string) => saveMessage(db, { userId: user.id, chatId: user.chatId, direction: "out", providerMessageId, text });
  let pollId: string | null = null;
  let optionId: string | null = null;
  let noId: string | null = null;
  let qid: string | null = lastId(lines);
  if (poll.mode === "native") {
    pollId = poll.optionMessageIds.find((id) => !!id) ?? null;
    save(pollId, `[poll] ${question}: ${options.join(" / ")}`);
  } else {
    optionId = poll.optionMessageIds[0] ?? null;
    noId = poll.optionMessageIds[1] ?? null;
    save(null, question);
    save(optionId, SHOW_ME);
    save(noId, NOT_NOW);
    qid = lastId(await ctx.say(pick(ctx, `offer:${poll.mode}`, poll.mode === "tap" ? OFFER_TAP_HINT : OFFER_NUMBER_HINT))) ?? qid;
  }
  const safe: Record<string, string> = {};
  for (const [k, v] of Object.entries(context ?? {})) if (typeof v === "string" && v.trim()) safe[k] = v.trim().slice(0, 200);
  ctx.setState({ flow: TOUR, step: SIM_OFFER_STEP, data: { kind, context: safe, pollId, optionId, noId, qid } });
  return true;
}

// ---------- the scripts ----------

/** The count bubble changes the way a real drop's does: edited in place when the provider can, a short new text when it can't. */
export async function dropCount(ctx: FlowContext, countId: string | null, left: number): Promise<void> {
  const edited = countId ? await ctx.adapter.editMessage(ctx.event.chatId, countId, countLine(left)).catch(() => false) : false;
  if (!edited) await ctx.say(countLine(left));
}

/** What an example person "texts". Always under their label, never as troy's own words. */
const from = (who: string, words: string): string => `${who}: "${words}"`;

async function close(ctx: FlowContext, real = false): Promise<void> {
  ctx.setState(null);
  if (real) await say(ctx, "close:real", CLOSE_REAL, 2);
  else await say(ctx, "close", CLOSE, 1);
}

/**
 * A profile built from what this person told the real flow about their own item: its kind, color and brand, plus
 * marks only when the flow collected real marks. The report sentence itself ("i lost my black wallet at leavey
 * today") is never a mark: it would become the answer key, and an honest description of the same item would miss.
 */
function profileFrom(context: Record<string, string>): ItemProfile {
  const what = clean(context.what ?? context.item ?? context.summary, "item", 80);
  const marks = [context.marks]
    .filter((v): v is string => typeof v === "string" && !!v.trim())
    .flatMap((v) => v.split(/[,;\n]+/))
    .map((v) => v.trim().toLowerCase().slice(0, 80))
    .filter(Boolean)
    .slice(0, 6);
  return {
    category: normalizeCategory(context.category ?? what),
    title: what,
    brand: context.brand?.trim() || null,
    color: context.color?.trim().toLowerCase() || null,
    publicSummary: what,
    distinguishing: marks,
    nameOnItem: null,
    isValuable: false,
    isDangerous: false,
  };
}

/**
 * Start the lost-item round: the person is the owner, an example finder has the item. `opening` sends the first
 * bubbles (the tour has its own) and returns their ids; the default labels the example finder and then sends the
 * real texts a real owner gets.
 */
export async function startLostOwner(
  ctx: FlowContext,
  opts: { profile: ItemProfile; strict: boolean; tour?: boolean; handoff?: "meet" | "dps"; place?: string; real?: boolean; opening?: () => Promise<(string | null)[]> },
): Promise<void> {
  let sent: (string | null)[];
  if (opts.opening) sent = await opts.opening();
  else {
    await say(ctx, "label:lost_found_owner", labelBrief("lost_found_owner"), 1);
    await deps.pause(BEATS.reply);
    const where = opts.place ? ` at ${opts.place}` : "";
    await ctx.say(from("example finder", pick(ctx, "finder:found", [`found this${where}, sending u a pic`, `just picked this up${where}. here's a photo`, `someone left this${where}, pic attached`])));
    await deps.pause(BEATS.short);
    // From here on these are the texts a real owner gets.
    sent = await ctx.say(COPY.turnedUp, COPY.quickCheck, COPY.describe);
  }
  const handoff = opts.handoff ?? (pick(ctx, "handoff", ["meet", "dps"]) as "meet" | "dps");
  const sim: LostSim = { kind: "lost_found_owner", profile: opts.profile, strict: opts.strict, tries: 0, tour: !!opts.tour, handoff, real: !!opts.real };
  relax(ctx.db, ctx.user.id);
  ctx.setState({ flow: TOUR, step: "describe", data: { sim, tries: 0, qid: lastId(sent) } });
}

/**
 * The real scoring (the model when it's up, the rule score when it isn't). For the tour's fixed item only the real
 * pass mark counts. A profile built from the person's own report can have nothing distinctive on file (they never
 * told the real flow any marks), and then there is nothing to pass against: an attempt that names the right kind of
 * item (or its color or brand) and contradicts nothing passes, and one that names a different color or brand misses.
 * That call is made by the rule score, so it reads the same with the model up or down.
 */
async function scoreOf(sim: LostSim, text: string): Promise<{ passed: boolean; source: "ai" | "fallback" }> {
  const thin = !sim.strict && !sim.profile.distinguishing.length && !sim.profile.nameOnItem;
  if (thin) {
    const rules = await scoreDescription(sim.profile, text, { useAi: false });
    const contradicts = rules.reasons.some((r) => /contradict|different|doesn'?t match|instead of describing|list of guesses/i.test(r));
    const said = ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ")} `;
    const kindWords = `${sim.profile.title} ${sim.profile.category.replace(/_/g, " ")}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && w !== "item" && w !== "other");
    const namesIt = kindWords.some((w) => said.includes(` ${w}`)) || rules.reasons.some((r) => /color matches|brand matches/.test(r));
    // An example item with no details has no real owner to protect: anything that doesn't contradict it passes
    // ("my photo is on it" for an ID). Only a clear contradiction or a non-answer fails.
    void namesIt;
    return { passed: !contradicts, source: modelReady() ? "ai" : "fallback" };
  }
  const result = await scoreDescription(sim.profile, text, { useAi: modelReady() });
  return { passed: result.score >= THRESHOLDS.descriptionPass, source: result.source };
}

async function midStep(ctx: FlowContext, waitingFor: string): Promise<"stop" | "answered" | "silent"> {
  const out = await atStep(ctx, { flow: "tour", waitingFor, canDo: [{ name: "stop", when: "they want to stop the example" }] });
  if (!out) return "silent";
  if (out.bubbles.length) await ctx.say(...out.bubbles);
  if (out.action === "stop") return "stop";
  return out.bubbles.length ? "answered" : "silent";
}

async function stop(ctx: FlowContext): Promise<SimOutcome> {
  ctx.setState(null);
  await say(ctx, "stopped", STOPPED);
  return "stopped";
}

async function onDescribe(ctx: FlowContext, sim: LostSim, data: Record<string, unknown>): Promise<SimOutcome> {
  if (ctx.event.reaction || ctx.event.pollVote) return "open";
  const text = ctx.event.text.trim();
  if (!text) {
    if (ctx.event.images.length) await ctx.say(COPY.describeWords);
    return "open";
  }
  // "nah", "i'm good", "idk": they are backing out, not describing. One easy line, no try used, nothing offered after.
  const few = text.split(/\s+/).length <= 4;
  if (readYesNo({ event: ctx.event, questionMessageId: null }) === "no" || saysDone(text) || (few && /^(?:idk|i don'?t know|dunno|no idea|not sure|pass|skip|rather not|i'?d rather not|no thanks)\b/i.test(text))) return stop(ctx);
  // A bare "ok" is not a description and not confusion either: a short nudge in new words, and the step stays open.
  if (isNeutral(text)) {
    await say(ctx, "describe:nudge", DESCRIBE_NUDGE);
    return "open";
  }
  // "i lost my hydro flask at leavey": the loss told again, nothing to check. A nudge, no try used.
  if (restatesLoss(text, sim.profile, ctx.db)) {
    await ctx.say(COPY.describeAgain);
    return "open";
  }
  // "wait what" or a question is not a description: he answers it, no try is used and the step stays open.
  if (!isDescriptionAttempt(text)) {
    const r = await midStep(ctx, "ur description of it, in ur own words");
    if (r === "stop") return stop(ctx);
    if (r === "silent") await say(ctx, "describe:nudge", DESCRIBE_NUDGE);
    return "open";
  }
  const { passed, source } = await scoreOf(sim, text);
  const tries = sim.tries + 1;
  if (passed) {
    if (source === "ai") await ctx.say(COPY.passed);
    else await say(ctx, "passed:finder", PASSED_BY_FINDER);
    // The finder always chooses the handoff. The example finder's own line says which, so nothing repeats it.
    await deps.pause(BEATS.reply);
    if (sim.handoff === "dps") {
      await ctx.say(from("example finder", pick(ctx, "finder:dps", ["i'll drop it at dps", "gonna leave it with dps lost and found", "dropping it at dps on my way to class"])));
      await deps.pause(BEATS.short);
      // From here on, the real texts an owner gets when the finder picks dps.
      await ctx.say(COPY.finderDropping, `ur pickup code is ${deps.pickupCode()}`, COPY.gotItHint);
      await say(ctx, "code:note", CODE_NOTE, 1);
      // The run closes on this turn, so this is where a judge's one aside goes (never on a turn that ends on a question).
      await aside(ctx, { step: "sim_check", decision: "9" });
      await close(ctx, !!sim.real);
      return "finished";
    }
    await ctx.say(from("example finder", pick(ctx, "finder:meet", ["i can meet them", "happy to meet up and hand it back", "i'll hold it and meet them"])));
    await deps.pause(BEATS.short);
    const sent = await say(ctx, "handoff:ask", HANDOFF_ASK);
    ctx.setState({ flow: TOUR, step: "handoff", data: { sim: { ...sim, tries }, qid: lastId(sent) } });
    return "open";
  }
  if (tries < THRESHOLDS.maxAttempts) {
    const sent = await ctx.say(...COPY.retry);
    ctx.setState({ flow: TOUR, step: "describe", data: { ...data, sim: { ...sim, tries }, tries, qid: lastId(sent) } });
    return "open";
  }
  await ctx.say(COPY.cantConfirmDescription);
  await say(ctx, "failed", FAILED);
  await close(ctx, !!sim.real);
  return "finished";
}

async function onHandoff(ctx: FlowContext, data: Record<string, unknown>): Promise<SimOutcome> {
  // Like the real contact warning: a thumbs up only counts on that exact bubble.
  const answer = readYesNo({ event: ctx.event, questionMessageId: typeof data.qid === "string" ? data.qid : null });
  if (ctx.event.pollVote || (ctx.event.reaction && !answer)) return "open";
  if (!answer) {
    const r = await midStep(ctx, 'a "yes" or "no" on sharing ur contact with the example finder (the pretend version)');
    if (r === "stop") return stop(ctx);
    if (r === "silent") await say(ctx, "handoff:ask", HANDOFF_ASK);
    return "open";
  }
  await say(ctx, answer === "yes" ? "handoff:yes" : "handoff:no", answer === "yes" ? HANDOFF_YES : HANDOFF_NO, 1);
  // The closing turn: a judge's one aside for this run goes here, after the last thing that needed an answer.
  await aside(ctx, { step: "sim_check", decision: "9" });
  await close(ctx, !!((data.sim as LostSim | undefined)?.real));
  return "finished";
}

async function startFinder(ctx: FlowContext, context: Record<string, string>): Promise<void> {
  const summary = clean(context.what ?? context.item ?? context.summary, "item");
  const where = context.where ? ` around ${clean(context.where, "")}` : "";
  await say(ctx, "label:lost_found_finder", labelBrief("lost_found_finder"));
  await deps.pause(BEATS.reply);
  await ctx.say(from("example owner", pick(ctx, "owner:lost", [`i lost my ${summary}${where}`, `help, my ${summary} is gone. i think i left it${where || " on campus"}`, `lost a ${summary}${where} today`])));
  await deps.pause(BEATS.short);
  // The texts a real finder gets, in order.
  await ctx.say(`someone's trying to claim the ${summary} u found`);
  await deps.pause(BEATS.reply);
  // Troy's own note, not the example owner speaking: what is happening on the other side while the finder waits.
  await ctx.say(pick(ctx, "owner:describes", ["(they're describing it to me now. they haven't seen ur photo or a single detail)", "(they're typing out what it looks like, without seeing anything u sent me)"]));
  await deps.pause(BEATS.reply);
  // No aside here: this turn ends on a question. The judge's aside goes on the turn that closes the run.
  const sent = await ctx.say(`the owner of the ${summary} u found just checked out`, COPY.handoffAsk);
  const sim: FinderSim = { kind: "lost_found_finder", summary, real: fromRealRequest(context) };
  ctx.setState({ flow: TOUR, step: SIM_PICK_STEP, data: { sim, qid: lastId(sent) } });
}

async function onFinderPick(ctx: FlowContext, sim: FinderSim): Promise<SimOutcome> {
  if (ctx.event.reaction || ctx.event.pollVote) return "open";
  const t = ctx.event.text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return "open";
  const meet = /^(?:1|one|option 1)$|\b(?:meet|hold)\b/.test(t);
  const dps = /^(?:2|two|option 2)$|\b(?:dps|drop)\b/.test(t);
  if (meet === dps) {
    const r = await midStep(ctx, '"1" to meet the owner or "2" to drop it at dps');
    if (r === "stop") return stop(ctx);
    if (r === "silent") await ctx.say(COPY.reply12);
    return "open";
  }
  if (dps) {
    await ctx.say(COPY.dropAtDpsOk, `tell them it's for pickup code ${deps.pickupCode()}`);
    await say(ctx, "code:note:finder", {
      goal: "one short text: that pickup code is an example, so there's nothing to drop off. for real the owner gets the same code and shows it at dps lost and found",
      mustCover: ["that code is an example, nothing to drop off", "for real the owner gets the same code and shows it at dps"],
      fallback: [["example code, so don't actually drop anything off. for real the owner gets that same code and shows it at dps"], ["that code's made up for this run. in the real thing the owner has the same one, and dps matches them"]],
    });
  } else {
    await ctx.say(COPY.meetBusy);
    await say(ctx, "group:owner", groupBrief("example owner"));
  }
  await aside(ctx, { step: "sim_handoff", decision: "5" });
  await close(ctx, !!sim.real);
  return "finished";
}

async function playFood(ctx: FlowContext, context: Record<string, string>): Promise<void> {
  const where = context.where ? clean(context.where, "", 60) : "";
  const start = Math.max(2, Math.min(60, Math.round(Number(context.count)) || 12));
  const claims = Math.min(3, start);
  await say(ctx, "label:food", labelBrief("food"));
  await deps.pause(BEATS.short);
  await ctx.say(`posted. i texted ${claims} example students nearby`);
  const [countId] = await ctx.say(countLine(start));
  let left = start;
  for (let i = 1; i <= claims; i++) {
    await deps.pause(BEATS.reply);
    await ctx.say(from(`example student ${i}`, pick(ctx, `food:claim:${i}`, ["me", "me pls", "omw, save me one"])));
    left -= 1;
    // The real count text: the same bubble edited in place, or a short new one.
    await dropCount(ctx, countId ?? null, left);
  }
  if (left <= 0 && where) await ctx.say(`all gone at ${where} 😔`);
  else await ctx.say(FOOD_COPY.postedHow);
  await aside(ctx, { step: "sim_food", decision: "4" });
  await close(ctx, fromRealRequest(context));
}

async function playRepair(ctx: FlowContext, context: Record<string, string>): Promise<void> {
  const what = clean(context.what, "something broken", 80);
  const where = clean(context.where, "campus");
  const office = clean(context.office, "facilities", 40);
  await say(ctx, "label:repair", labelBrief("repair"));
  await deps.pause(BEATS.short);
  await say(ctx, "repair:asked", {
    goal: "one short text: he just texted the example technician the report and asked if they can take it",
    mustCover: ["he texted the example technician what was reported and where", "he asked if they can take it"],
    facts: { what, where },
    fallback: [[`texted the example technician: someone reported ${what} at ${where}, can u take it?`], [`sent it to the example technician: ${what} at ${where}. asked if they can take it`]],
  });
  await deps.pause(BEATS.reply);
  await ctx.say(from("example technician", "on it"));
  // The status texts a real student gets (src/staff.ts).
  await ctx.say(`${office} is on it 🔧`);
  await deps.pause(BEATS.reply);
  await ctx.say(from("example technician", "done"));
  await ctx.say("fixed ✅");
  await aside(ctx, { step: "sim_repair", decision: "6" });
  await close(ctx, fromRealRequest(context));
}

async function playUsg(ctx: FlowContext, context: Record<string, string>): Promise<void> {
  const about = clean(context.what ?? context.summary ?? context.topic, "ur concern", 80);
  const committee = context.committee ? clean(context.committee, "", 40) : "";
  await say(ctx, "label:usg", labelBrief("usg"));
  await deps.pause(BEATS.short);
  await say(ctx, "usg:asked", {
    goal: "one short text: he just sent the example usg member a summary of their concern" + (committee ? " (the committee is given)" : "") + ", with no name on it unless they chose to share it",
    mustCover: ["he sent the example usg member a summary of the concern", "no name unless they chose to share it"],
    facts: committee ? { about, committee } : { about },
    fallback: committee
      ? [[`sent the example usg member on ${committee} a summary: ${about}. no name on it unless u said to add urs`], [`the example usg member on ${committee} just got it from me: ${about}. ur name only goes if u chose that`]]
      : [[`sent the example usg member a summary: ${about}. no name on it unless u said to add urs`], [`the example usg member just got it from me: ${about}. ur name only goes if u chose that`]],
  });
  await deps.pause(BEATS.reply);
  await ctx.say(from("example usg member", "on the agenda"));
  // The status texts a real student gets (src/staff.ts).
  await ctx.say("it's on the agenda");
  await deps.pause(BEATS.reply);
  await ctx.say(from("example usg member", "acted on"));
  await ctx.say("usg acted on it ✅");
  await aside(ctx, { step: "sim_usg", decision: "6" });
  await close(ctx, fromRealRequest(context));
}

async function playRides(ctx: FlowContext, context: Record<string, string>): Promise<void> {
  const dest = clean(context.dest ?? context.destination ?? context.where, "lax", 40);
  const when = [context.day, context.time].filter((v): v is string => typeof v === "string" && !!v.trim()).map((v) => clean(v, "", 30)).join(" around ");
  await say(ctx, "label:rides", labelBrief("rides"));
  await deps.pause(BEATS.short);
  await say(ctx, "rides:asked", {
    goal: "one short text: he just asked two example riders headed the same way if they want to split a ride",
    mustCover: ["he asked two example riders headed the same way", "if they want to split a ride"],
    facts: when ? { dest, when } : { dest },
    fallback: when
      ? [[`asked 2 example riders headed to ${dest} ${when} if they wanna split a ride`], [`2 example riders are going to ${dest} ${when}. just asked if they're down to split`]]
      : [[`asked 2 example riders headed to ${dest} if they wanna split a ride`], [`2 example riders are going to ${dest} too. just asked if they're down to split`]],
  });
  await deps.pause(BEATS.reply);
  await ctx.say(from("example rider 1", pick(ctx, "rider:1", ["yes, down to split", "yeah i'm in", "sure, let's split it"])));
  await deps.pause(BEATS.short);
  await ctx.say(from("example rider 2", pick(ctx, "rider:2", ["same, i'm in", "down", "yes pls"])));
  await say(ctx, "group:riders", groupBrief("example riders"));
  await aside(ctx, { step: "sim_rides", decision: "10" });
  await close(ctx, fromRealRequest(context));
}

async function playTopics(ctx: FlowContext, context: Record<string, string>): Promise<void> {
  const topic = clean(context.topic, "that", 40);
  const noun = clean(context.post ?? context.what, "post", 80);
  await say(ctx, "label:topics", labelBrief("topics"));
  await deps.pause(BEATS.short);
  await say(ctx, "topics:sent", {
    goal: "one short text: he just sent their post to a few example students who follow that topic and are close by",
    mustCover: ["he sent their post to example students who follow that topic", "only the ones close by"],
    facts: { topic },
    fallback: [[`sent ur post to 4 example students who follow ${topic} and are close by`], [`4 example students nearby follow ${topic}. they all just got ur post`]],
  });
  await deps.pause(BEATS.reply);
  await ctx.say(from("example student", "i'm in"));
  // The texts a real poster gets when someone joins (src/flows/topics.ts).
  await ctx.say(`a trojan wants in on ur ${noun}`, "should i connect u two right here? no numbers shared");
  await say(ctx, "topics:relay", {
    goal: "one short text: for real a yes connects the two of them through him, no numbers shared. nothing to connect here because that student is made up",
    mustCover: ["for real a yes connects them through him with no numbers shared", "nobody to connect here, the student is an example"],
    fallback: [["for real a yes connects u two through me, no numbers shared. nobody to connect this time, that student's an example"], ["in the real thing u say yes and i pass messages between u two. this one's made up, so there's no one on the other end"]],
  });
  await aside(ctx, { step: "sim_topics", decision: "10" });
  await close(ctx, fromRealRequest(context));
}

/** Play one kind from the top. Lost and found leaves a step open for their answer; the others run to the end. */
async function play(ctx: FlowContext, kind: SimKind, context: Record<string, string>): Promise<void> {
  relax(ctx.db, ctx.user.id);
  ctx.setState(null);
  switch (kind) {
    case "lost_found_owner":
      return startLostOwner(ctx, { profile: profileFrom(context), strict: false, real: fromRealRequest(context), handoff: context.handoff === "dps" || context.handoff === "meet" ? context.handoff : undefined, place: context.where ? clean(context.where, "") : undefined });
    case "lost_found_finder":
      return startFinder(ctx, context);
    case "food":
      return playFood(ctx, context);
    case "repair":
      return playRepair(ctx, context);
    case "usg":
      return playUsg(ctx, context);
    case "rides":
      return playRides(ctx, context);
    case "topics":
      return playTopics(ctx, context);
  }
}

// ---------- their turn ----------

async function onOffer(ctx: FlowContext, data: Record<string, unknown>): Promise<SimOutcome> {
  const kind = data.kind as SimKind;
  if (!KINDS.includes(kind)) return "none";
  const context = (data.context && typeof data.context === "object" ? data.context : {}) as Record<string, string>;
  const { event } = ctx;
  let go = false;
  let no = false;
  if (event.pollVote) {
    if (data.pollId && event.pollVote.pollMessageId && event.pollVote.pollMessageId !== data.pollId) return "none";
    go = event.pollVote.optionIndex === 0;
    no = event.pollVote.optionIndex === 1;
    if (!go && !no) return "open";
  } else if (event.reaction) {
    const r = event.reaction;
    // A heart or thumbs up on "not now" is a no, the same as a thumbs down on "show me".
    const onNo = !!data.noId && r.targetMessageId === data.noId;
    const ours = onNo || r.targetMessageId === data.optionId || r.targetMessageId === data.qid;
    if (!ours || r.removed) return "open";
    const positive = r.type === "love" || r.type === "like";
    go = positive && !onNo;
    no = r.type === "dislike" || (positive && onNo);
    if (!go && !no) return "open";
  } else {
    const t = event.text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    const answer = readYesNo({ event, questionMessageId: null });
    go = answer === "yes" || /^(?:ok |okay |yes |sure |bet )*(?:show me|1|run it|play it|do it|lets see(?: it)?|go)$/.test(t);
    no = !go && (answer === "no" || CANCEL.test(event.text) || /^(?:not now|not rn|maybe later|later)$/.test(t));
  }
  if (go) {
    await play(ctx, kind, context);
    return getFlowState(ctx.db, ctx.user.id) ? "open" : "finished";
  }
  if (no) {
    ctx.setState(null);
    await say(ctx, "offer:no", OFFER_NO);
    return "stopped";
  }
  // Not an answer to the offer: it lapses, and the message goes where it belongs.
  ctx.setState(null);
  return "none";
}

/**
 * One turn of whatever simulation step is open for this person. "none": nothing of ours was open (or the message
 * wasn't for it). "open": handled, a step is still waiting. "finished": it ran to its close. "stopped": they backed out.
 */
export async function stepSimulation(ctx: FlowContext): Promise<SimOutcome> {
  const state = ctx.state?.flow === TOUR ? ctx.state : null;
  if (!state) return "none";
  const data = state.data ?? {};
  if (state.step === SIM_OFFER_STEP) return onOffer(ctx, data);
  const sim = (data.sim && typeof data.sim === "object" ? data.sim : null) as Sim | null;
  if (!sim) return "none";
  if (sim.kind === "lost_found_owner" && state.step === "describe") return onDescribe(ctx, sim, data);
  if (sim.kind === "lost_found_owner" && state.step === "handoff") return onHandoff(ctx, data);
  if (sim.kind === "lost_found_finder" && state.step === SIM_PICK_STEP) return onFinderPick(ctx, sim);
  return "none";
}

/**
 * Handles the tap on "show me" (or a typed yes) and every later step of a simulation. True when it consumed the
 * message. The tour flow calls this for its own state, so nothing else has to route to it.
 */
export async function runSimulation(ctx: FlowContext): Promise<boolean> {
  return (await stepSimulation(ctx)) !== "none";
}
