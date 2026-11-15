// Flow 2: free food and items.
// Every reply here is fixed lowercase copy, so the flow works with no API key. Code decides every value:
// counts, claims, hold times, walking times, who gets alerted, bans, and anything read from the directory.
// The only model call is the optional servings count from the photo, and the poster always confirms it.

import type { DatabaseSync } from "node:sqlite";
import type { FlowContext, FlowHandler, FlowState, MessagingAdapter, User } from "../types.ts";
import { getFlowState, getUserById, rowToUser, saveMessage, setFlowState } from "../db/index.ts";
import { findPlace, normalizePlaceText, walkingMinutes } from "../places.ts";
import { getUserLocation, saveUserLocation, shouldReadLiveLocation } from "../location.ts";
import { canAlert } from "../quiet.ts";
import { RELAY_COPY, activeRelayFor, endRelayByContext, startRelay as realStartRelay } from "../relay.ts";
import { registerPendingHooks } from "../pending.ts";
import { countServings as realCountServings } from "./lostfound/vision.ts";
import type { Pools, Voice } from "./reports-shared.ts";
import { makeVoice, unvoiced } from "./reports-shared.ts";

// ---------- settings ----------

export const DEFAULT_HOLD_MINUTES = 15;
const MAX_HOLD_MINUTES = 120;
const MAX_SERVINGS = 500;
/** A drop nobody closes ends by itself after this long. */
export const DROP_TTL_MS = 2 * 60 * 60 * 1000;
/** A half-finished post is dropped after this long. */
const POST_STALE_MS = 30 * 60 * 1000;
/** "me" and "that was fake" keep pointing at an alert for this long. */
const ALERT_STALE_MS = 6 * 60 * 60 * 1000;
export const SWEEP_EVERY_MS = 30_000;
/** How many times one person can let go of a serving from the same drop and still claim it again. */
export const MAX_REGRABS = 2;

// ---------- injected pieces (tests swap them) ----------

type StartRelay = (db: DatabaseSync, a: number, b: number, context: string, labels?: { a?: string; b?: string }) => number;

export type FoodDeps = {
  countServings: typeof realCountServings;
  startRelay: StartRelay;
  now: () => number;
};

const defaults: FoodDeps = { countServings: realCountServings, startRelay: realStartRelay, now: () => Date.now() };
let deps: FoodDeps = { ...defaults };

/** Tests only: replace the photo counter, the relay opener or the clock. Pass null to restore the real ones. */
export function setFoodDeps(over: Partial<FoodDeps> | null): void {
  deps = over ? { ...deps, ...over } : { ...defaults };
}

// ---------- copy ----------

export const FOOD_COPY = {
  banned: ["sorry, posting is turned off for ur account", "if u think that's a mistake, reply HUMAN and a person will look"],
  notVerified: "gotta verify ur usc email before u can post",
  askCount: "how many are there?",
  askCountAgain: "just need a number, like 6",
  askSpot: "where's it at?",
  askSpotAgain: "which building or spot? like leavey or tcc",
  askClub: "who's it from? a club or org name, or reply skip",
  dropped: "no worries, dropped it",
  gone: "all gone, sorry",
  released: "ok, released it",
  alreadyHeld: "u already have one held, go grab it",
  alreadyGot: "u already got one from this drop",
  pickedUp: "nice, enjoy 🙌",
  nothingHeld: "ur not holding anything rn",
  reportThanks: ["thanks for flagging that", "a person on the team will take a look"],
  nothingToReport: "which post was it? i don't see a recent one i sent u",
  notYourCount: "only whoever posted it can change the count. if nothing was there, text 'that was fake'",
  noDropToUpdate: "u don't have a post up rn. send a photo and what it is to post one",
  closed: "got it, closed it out. thanks for sharing",
  nothingLive: "nothing going rn. i'll text u when something pops up",
  claimHow: "reply 'me' if u want one",
  reactHow: "react if u want one",
  relayOffer: "i can connect u two through me, no numbers shared. want me to ask them?",
  relayAsking: ["asking them now", "if they say yes i'll connect u right here"],
  relayAskPoster: "ok if i connect u two through me? no numbers shared. yes or no",
  relayNotAvailable: "they're not taking messages rn, sorry",
  relayBusy: "they're in the middle of something. try again in a few",
  relayDeclinedPoster: "no worries, i'll let them know",
  relayDeclined: "they passed on chatting, sorry",
  relayFailed: "couldn't set that up rn, sorry",
  relayNvm: "ok, no worries",
  tooManyGrabs: "u've grabbed and dropped that one a few times, so i'm leaving it for the others",
  relayOver: "that drop's over, so i closed the chat with them",
  holdExpired: "ur hold ran out so i put it back. reply 'me' if u still want one",
  checkUsg: "i'd check with usg",
  unsure: "not sure i got that. text me what the food is and where, or 'me' to claim one",
  postLater: "no worries, text me again when ur ready to post it",
  confirmCountAgain: "is that count right? reply yes or the real number",
  postedNobody: "posted. nobody's close by rn, but it's up if anyone asks",
  postedHow: "text me how many are left anytime, or 'we're out' when it's done",
  gotItHow: "text 'got it' once u have it",
  askLeft: "how many are left? just the number",
  thriftUnsure: "not sure on that one. i'd check with usg",
  claimFirst: "claim one first and i can connect u",
  movedOn: "looks like they moved on, nvm",
  saidYes: "they said yes",
};

/** Lines with a value in them (a count, a place, a hold time). Code puts the value in; these only hold the words around it. */
const FT = {
  looksLike: (what: string) => `looks like ${what}, right?`,
  posted: (told: string, people: string) => `posted. i texted ${told} ${people} nearby`,
  yours: (minutes: string) => `it's yours, grab it in the next ${minutes} min`,
  talkTo: (who: string) => `lmk if u want to talk to ${who}`,
  ranOut: (what: string, where: string) => `heads up, the ${what} at ${where} just ran out. sorry`,
  updated: (count: string) => `updated, ${count}`,
  updatedHeld: (holds: string, isAre: string, rest: string) => `updated. ${holds} of those ${isAre} already claimed, so ${rest} for everyone else`,
  lastOneAt: (where: string) => `last one at ${where}`,
  allGoneAt: (where: string) => `all gone at ${where} 😔`,
  theOne: (name: string) => `${name} is the one for that`,
  wantsToTalk: (what: string) => `someone who claimed ur ${what} wants to talk`,
  walk: (a: string, minutes: string, where: string) => `it's about ${a} ${minutes} min walk from ${where}`,
};

// ---------- wording variants (facts locked, wording varied) ----------
//
// Variant 0 of every pool is the line the code writes; the rest say the same thing with the same values.
// NOT in any pool, so always word for word:
// - the alert's first bubble ("yo ... is giving away free ... at ..., about N left") and countLine: that bubble
//   is edited in place as the count changes and found again by its text, so it has one wording.
// - FOOD_COPY.banned (the posting ban and its HUMAN line), relay copy, and anything read from the directory.
export const FOOD_POOLS: Pools = {
  // posting
  notVerified: [FOOD_COPY.notVerified, "u gotta verify ur usc email before u can post", "need u to verify ur usc email first, then u can post"],
  askCount: [FOOD_COPY.askCount, "how many is it?", "how many do u have?", "what's the count?"],
  askCountAgain: [FOOD_COPY.askCountAgain, "i just need a number, like 6", "a number is all i need, like 6"],
  looksLike: (what) => [FT.looksLike(what), `i'm counting ${what}, right?`, `so that's ${what}, right?`],
  confirmCountAgain: [FOOD_COPY.confirmCountAgain, "is that the right count? reply yes or the real number", "did i get the count right? reply yes or the real number"],
  askSpot: [FOOD_COPY.askSpot, "where is it?", "where can people find it?"],
  askSpotAgain: [FOOD_COPY.askSpotAgain, "what building or spot? like leavey or tcc", "which spot is it at? like leavey or tcc"],
  askClub: [FOOD_COPY.askClub, "who's it from? give me a club or org name, or reply skip", "which club or org is it from? or reply skip"],
  postLater: [FOOD_COPY.postLater, "no worries. text me again when ur ready to post it", "all good, just text me again when ur ready to post it"],
  dropped: [FOOD_COPY.dropped, "no worries, i dropped it", "all good, dropped it"],
  posted: (told, people) => [FT.posted(told, people), `it's up. i texted ${told} ${people} nearby`, `posted, and i texted ${told} ${people} nearby`],
  postedNobody: [FOOD_COPY.postedNobody, "posted. nobody's nearby rn, but it's up if anyone asks", "it's up. nobody's close by rn, but it's there if anyone asks"],
  postedHow: [
    FOOD_COPY.postedHow,
    "u can text me how many are left anytime, or 'we're out' when it's done",
    "text me the number left whenever, or 'we're out' when it's done",
  ],

  // the poster's count
  askLeft: [FOOD_COPY.askLeft, "how many are left? just a number", "how many left? just the number"],
  updated: (count) => [FT.updated(count), `ok updated, ${count}`, `updated it, ${count}`],
  updatedHeld: (holds, isAre, rest) => [
    FT.updatedHeld(holds, isAre, rest),
    `updated. ${holds} of those ${isAre} claimed already, so ${rest} for everyone else`,
    `got it. ${holds} of those ${isAre} already claimed, so that's ${rest} for everyone else`,
  ],
  closed: [FOOD_COPY.closed, "got it, closed it out. thanks for sharing with everyone", "ok, it's closed out. thanks for sharing"],
  notYourCount: [
    FOOD_COPY.notYourCount,
    "only the person who posted it can change the count. if nothing was there, text 'that was fake'",
    "the count can only be changed by whoever posted it. if nothing was there, text 'that was fake'",
  ],
  noDropToUpdate: [FOOD_COPY.noDropToUpdate, "u don't have a post up rn. to post one, send a photo and what it is", "nothing of urs is up rn. send a photo and what it is to post one"],

  // the alert's other bubbles
  walk: (a, minutes, where) => [FT.walk(a, minutes, where), `about ${a} ${minutes} min walk from ${where}`, `that's about ${a} ${minutes} min walk from ${where}`],
  reactHow: [FOOD_COPY.reactHow, "react to this if u want one", "want one? react"],
  claimHow: [FOOD_COPY.claimHow, "reply 'me' and one's urs", "want one? reply 'me'"],
  lastOneAt: (where) => [FT.lastOneAt(where), `only one left at ${where}`, `down to the last one at ${where}`],
  allGoneAt: (where) => [FT.allGoneAt(where), `it's all gone at ${where} 😔`, `none left at ${where} 😔`],
  ranOut: (what, where) => [FT.ranOut(what, where), `heads up, the ${what} at ${where} just ran out, sorry`, `sorry, heads up: the ${what} at ${where} just ran out`],
  nothingLive: [FOOD_COPY.nothingLive, "nothing going on rn. i'll text u when something pops up", "nothing's up rn, but i'll text u when something pops up"],

  // claims
  yours: (minutes) => [FT.yours(minutes), `it's yours. u have ${minutes} min to grab it`, `one's yours, grab it within ${minutes} min`],
  gotItHow: [FOOD_COPY.gotItHow, "text 'got it' when u have it", "once u have it, text 'got it'"],
  talkTo: (who) => [FT.talkTo(who), `lmk if u need to talk to ${who}`, `if u want to talk to ${who}, just say so`],
  gone: [FOOD_COPY.gone, "sorry, all gone", "it's all gone, sorry"],
  released: [FOOD_COPY.released, "ok, let it go", "ok, it's back for someone else"],
  alreadyHeld: [FOOD_COPY.alreadyHeld, "u've already got one held, go grab it", "one's already held for u, go grab it"],
  alreadyGot: [FOOD_COPY.alreadyGot, "u already picked one up from this drop", "u got one from this drop already"],
  pickedUp: [FOOD_COPY.pickedUp, "enjoy 🙌", "nice, enjoy it 🙌", "got it. enjoy 🙌"],
  nothingHeld: [FOOD_COPY.nothingHeld, "u aren't holding anything rn", "nothing's held for u rn"],
  tooManyGrabs: [
    FOOD_COPY.tooManyGrabs,
    "u've grabbed and dropped that one a few times, so i'm leaving it for everyone else",
    "u grabbed and dropped that one a few times, so i'm leaving it for the others",
  ],
  holdExpired: [FOOD_COPY.holdExpired, "ur hold ran out, so i put it back. reply 'me' if u still want one", "ur hold timed out so it went back. reply 'me' if u still want one"],
  unsure: [
    FOOD_COPY.unsure,
    "not sure i got that. text me what the food is and where, or 'me' if u want to claim one",
    "didn't catch that. text me what the food is and where, or 'me' to claim one",
  ],

  // reports
  reportThanks: [
    FOOD_COPY.reportThanks,
    ["thanks for flagging it", "someone on the team will take a look"],
    ["appreciate u flagging that", "a person on the team will look into it"],
  ],
  nothingToReport: [FOOD_COPY.nothingToReport, "which post? i don't see a recent one i sent u", "which post do u mean? i don't see a recent one i sent u"],

  // thrift (the program's name, details and link come from the directory and are never reworded)
  theOne: (name) => [FT.theOne(name), `${name} is who u want for that`, `that'd be ${name}`],
  thriftUnsure: [FOOD_COPY.thriftUnsure, "not sure on that one, i'd check with usg", "i'm not sure on that one. i'd check with usg"],
  checkUsg: [FOOD_COPY.checkUsg, "i'd ask usg", "usg is who i'd check with"],

  // talking to the poster
  claimFirst: [FOOD_COPY.claimFirst, "claim one first, then i can connect u", "u gotta claim one first, then i can connect u"],
  relayOffer: [
    FOOD_COPY.relayOffer,
    "i can connect u two through me, with no numbers shared. want me to ask them?",
    "i can put u two in touch through me, no numbers shared. should i ask them?",
  ],
  relayAsking: [
    FOOD_COPY.relayAsking,
    ["asking them rn", "if they say yes, i'll connect u right here"],
    ["ok, asking them now", "i'll connect u right here if they say yes"],
  ],
  wantsToTalk: (what) => [FT.wantsToTalk(what), `someone who claimed ur ${what} would like to talk`, `one of the people who claimed ur ${what} wants to talk`],
  relayAskPoster: [
    FOOD_COPY.relayAskPoster,
    "ok if i connect u two through me? no numbers get shared. yes or no",
    "can i connect u two through me? no numbers shared. yes or no",
  ],
  relayNotAvailable: [FOOD_COPY.relayNotAvailable, "sorry, they're not taking messages rn", "they aren't taking messages rn, sorry"],
  relayBusy: [FOOD_COPY.relayBusy, "they're in the middle of something rn. try again in a few", "they're busy with something. try again in a few"],
  relayDeclinedPoster: [FOOD_COPY.relayDeclinedPoster, "no worries, i'll tell them", "all good, i'll let them know"],
  relayDeclined: [FOOD_COPY.relayDeclined, "sorry, they passed on chatting", "they'd rather not chat, sorry"],
  relayFailed: [FOOD_COPY.relayFailed, "sorry, couldn't set that up rn", "i couldn't set that up rn, sorry"],
  relayNvm: [FOOD_COPY.relayNvm, "ok, all good", "no worries"],
  relayOver: [FOOD_COPY.relayOver, "that drop ended, so i closed the chat with them", "that drop is done, so i closed the chat with them"],
  movedOn: [FOOD_COPY.movedOn, "looks like they've moved on, nvm", "nvm, looks like they moved on"],
  saidYes: [FOOD_COPY.saidYes, "they're in", "they said yes to chatting"],
};

export const FOOD_VOICE: Voice = makeVoice("food", FOOD_POOLS);

/** The line the count bubble ends with. */
export function countLine(left: number, live = true): string {
  if (!live || left <= 0) return "all gone 😔";
  if (left === 1) return "last one";
  return `${left} left`;
}

// ---------- small helpers ----------

type Row = Record<string, unknown>;

interface Drop {
  id: number;
  posterUserId: number;
  clubName: string | null;
  description: string;
  locationText: string;
  lat: number | null;
  lng: number | null;
  servingsTotal: number;
  servingsLeft: number;
  holdMinutes: number;
  alertMessageIds: Record<string, string>;
  status: "live" | "ended" | "removed";
  reports: number;
  expiresAt: number | null;
  createdAt: number;
}

function rowToDrop(r: Row): Drop {
  let ids: Record<string, string> = {};
  try {
    const v = JSON.parse((r.alertMessageIds as string) || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) ids = v as Record<string, string>;
  } catch {
    // A broken column counts as no alerts.
  }
  return {
    id: r.id as number,
    posterUserId: r.posterUserId as number,
    clubName: (r.clubName as string) ?? null,
    description: (r.description as string) || "food",
    locationText: (r.locationText as string) || "campus",
    lat: (r.lat as number) ?? null,
    lng: (r.lng as number) ?? null,
    servingsTotal: r.servingsTotal as number,
    servingsLeft: r.servingsLeft as number,
    holdMinutes: r.holdMinutes as number,
    alertMessageIds: ids,
    status: r.status as Drop["status"],
    reports: r.reports as number,
    expiresAt: (r.expiresAt as number) ?? null,
    createdAt: r.createdAt as number,
  };
}

function getDrop(db: DatabaseSync, id: number): Drop | null {
  const r = db.prepare("SELECT * FROM food_drops WHERE id = ?").get(id) as Row | undefined;
  return r ? rowToDrop(r) : null;
}

const prepared = new WeakSet<DatabaseSync>();

/**
 * Which of Troy's bubbles belong to which alert: 'count' (edited as the count changes), 'walk', and 'claim'
 * (the "react if u want one" bubble, also saved in food_drops.alertMessageIds). A tapback on any of them claims.
 * 'report' rows mark that a user already reported a drop. Only ids, never text or locations.
 */
function ensureTables(db: DatabaseSync): void {
  if (prepared.has(db)) return;
  db.exec(
    "CREATE TABLE IF NOT EXISTS food_alert_bubbles (messageId TEXT PRIMARY KEY, foodDropId INTEGER NOT NULL, userId INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('count','walk','claim','report')));" +
      "CREATE INDEX IF NOT EXISTS food_alert_bubbles_drop ON food_alert_bubbles(foodDropId, userId);" +
      "CREATE TABLE IF NOT EXISTS food_milestones (foodDropId INTEGER NOT NULL, userId INTEGER NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (foodDropId, userId, kind));",
  );
  prepared.add(db);
}

function word(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[‘’'`]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const YES = /^(?:y|yes|yea|yeah|yep|yup|ya|yessir|sure|ok|okay|k|kk|bet|correct|right|thats right|sounds good|do it|go ahead|yes please|yes pls|please|pls|for sure)$/;
const NO = /^(?:n|no|nah|nope|not really|wrong|incorrect|no thanks|no thank you|pass|dont)$/;
const CANCEL = /^(?:nvm|nevermind|never mind|cancel|cancel it|cancel that|forget it|forget that|nah nvm|nvm thanks|scratch that)$/;
/**
 * While a post is being drafted, backing out can be said many ways ("actually nvm", "wait no dont post it").
 * Missing one publishes the drop and texts everyone nearby, so this is checked before every post_ step.
 */
const CANCEL_POST =
  /^(?:(?:actually|wait|oh|ah|uh|um|sorry|lol|hmm|ok|okay|nah|no|pls|please|yeah|ya)[ ,]+)*(?:nvm|nevermind|never mind|cancel|forget it|forget that|scratch that|dont post|do not post)\b|\bnvm\b|\bnever ?mind\b|\b(?:dont|do not|not gonna|wont) (?:post|send|share)\b|\bcancel (?:it|that|this|the post|pls|please)\b|^(?:actually|wait)[ ,]+no+$/;
/** Words that mean "not this", never part of a club name. */
const NOT_A_NAME = /\b(?:nvm|nevermind|never mind|cancel|dont|do not|wait|actually|sorry|stop|forget)\b/;
const SKIP = /^(?:skip|none|no one|noone|nobody|just me|me|idk|na|n a|no club|not a club|nah|no|nope|its just me|myself)$/;
const ME = /^(?:me|mee+|me pls|me please|me me|i want one|i want it|ill take one|ill take it|mine|dibs|yes|yes pls|yes please|save me one|claim|im coming|omw)$/;
const GOT_IT = /^(?:got it|got mine|got one|grabbed it|grabbed one|grabbed mine|picked it up|picked up|have it|i got it|i have it|got it thanks|got it ty)$/;
const FAKE = /\bfake\b|\bscam\b|nothing (?:was |is )?(?:there|here)|no food (?:here|there)|(?:wasnt|isnt|werent) (?:any|anything|real|there)|there (?:was|is|were) (?:no|nothing)\b/;
const TALK = /\b(?:talk|chat|speak|message|text|connect|reach|contact|ask|dm)\b.*\b(?:them|they|poster|club|org|whoever|someone|person|host)\b|\bconnect (?:me|us)\b|\b(?:talk|chat|speak) (?:to|with)\b/;
const THRIFT_TOPIC = /\b(?:thrift|thrifting|secondhand|second hand|free clothes|free clothing|free stuff|used clothes)\b/;
const ASKING = /\?|^(?:where|is there|are there|any|anywhere|how|when|what|who|does|do|can i|could i)\b|\b(?:looking for|need|want|know (?:where|of|any)|where (?:can|do|to|is|are))\b/;
const OFFERING = /\b(?:giving away|i have|we have|ive got|weve got|we got|i got|up for grabs|come (?:get|grab)|left ?over|extra)\b/;
const STUFF = /\b(?:clothes|clothing|hoodies?|shirts?|tees?|jackets?|sweaters?|shoes|sneakers|jeans|pants|dress(?:es)?|hats?|books?|textbooks?|furniture|couch|chairs?|desk|lamps?|fridge|microwave|mirror|rug|stuff|items?|posters?|tickets?|merch|totes?|stickers?|plants?|supplies|decor)\b/;
const EDIBLE = /\b(?:food|pizzas?|sandwich(?:es)?|donuts?|bagels?|cookies?|tacos?|burritos?|boba|snacks?|chipotle|cava|panda|sushi|wings|bowls?|burgers?|pasta|salads?|wraps?|dumplings?|noodles|rice|fruit|chips|drinks?|coffee|cake|brownies|subs|plates|trays?|boxes|slices|lunch|dinner|breakfast)\b/;
const COUNT_UPDATE = /\b(?:\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a few|couple) (?:left|remaining|more left)\b(?! ?overs?)|\b(?:were|we are|its|it is|all) (?:all )?out\b|\ball gone\b|\bran out\b|\bnone left\b|\bno more(?: left)?\b|\blast one\b|\bits gone\b/;
const OUT = /\b(?:were|we are|its|it is|all) (?:all )?out\b|\ball gone\b|\bran out\b|\bnone left\b|\bno more(?: left)?\b|\bits gone\b/;

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, eighteen: 18, twenty: 20, thirty: 30, forty: 40, fifty: 50, dozen: 12, couple: 2,
};
const NUM = `\\d{1,3}|${Object.keys(NUMBER_WORDS).join("|")}`;

function toNumber(s: string | undefined): number | null {
  if (!s) return null;
  const n = /^\d+$/.test(s) ? Number(s) : NUMBER_WORDS[s];
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(n)));

/** The first plain number in a text, skipping clock times. Null when there is none. */
function parseNumber(text: string): number | null {
  const w = word(text.replace(/\b\d{1,2}(?::\d\d)? ?(?:am|pm)\b|\b\d{1,2}:\d\d\b/gi, " "));
  if (/\b(?:a|half a|one) dozen\b/.test(w)) return 12;
  const m = w.match(new RegExp(`\\b(${NUM})\\b`));
  return toNumber(m?.[1]);
}

// ---------- reading a post ----------

interface Draft {
  what: string | null;
  unit: string | null;
  count: number | null;
  needConfirm: boolean;
  spot: string | null;
  lat: number | null;
  lng: number | null;
  hold: number;
  club: string | null;
  askedClub: boolean;
  photo: string | null;
  kind: "food" | "stuff";
  asks: number;
  confirmId?: string | null;
}

const HOLD_RE = /\bhold(?:ing)?(?: (?:each(?: one)?|them|it|one|claims?))?(?: for)? (\d{1,3}) ?(?:min|mins|minute|minutes)\b/;
const NOT_A_CLUB = /^(?:we|i|they|there|someone|somebody|it|this|that|our|my|a|an|the|some|lunch|dinner|breakfast|today|yesterday|earlier|last|free|extra)\b/;
const LEAD_WORDS =
  /\b(?:hey|yo|hi|troy|we|i|there|theres|there is|is|are|have|has|got|ive|weve|some|a few|a bunch of|a ton of|a lot of|lots of|bunch of|about|around|like|free|extra|left ?overs?|giving away|up for grabs|come (?:get|grab|thru|through)(?: some| it| them)?|still|just|also|pls|please|if (?:anyone|anybody) wants?(?: some| it| any| them)?|(?:anyone|anybody) wants?(?: some| it| any)?|left|here|rn|right now|for (?:anyone|whoever|everyone|grabs)|servings?|to share|of|a|an|the|its|it is|u|you|guys|yall|everyone)\b/g;

function cleanClub(raw: string): string | null {
  const s = raw
    .toLowerCase()
    .replace(/https?:\/\/\S+|www\.\S+/g, " ")
    .replace(/[^a-z0-9&' .-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^(?:its |it's |it is )?(?:from |by )?(?:the )?/, "")
    .trim()
    .slice(0, 40)
    .trim();
  if (s.length < 2 || NOT_A_CLUB.test(s) || NOT_A_NAME.test(s.replace(/'/g, "")) || s.split(" ").length > 6) return null;
  return s;
}

const UNITS = /^(?:bowls?|boxes|box|slices?|plates?|trays?|bags?|pieces?|cups?|cans?|bottles?|packs?|orders?|containers?|racks?|piles?|pairs?|dozen)$/;
const PREP = "(?:at|in|inside|outside of|outside|near|by|behind|in front of|next to)";

interface Spot {
  spot: string;
  lat: number;
  lng: number;
  /** The exact stretch of the (normalized) text that named the place, for cutting it out of the rest. */
  span: string;
}

/**
 * The campus place named in a text, shown the way the poster said it ("leavey", "outside tcc", "tcc 2nd floor")
 * rather than by its long official name. Coordinates always come from campus_places.
 */
function resolveSpot(db: DatabaseSync, text: string): Spot | null {
  const place = findPlace(db, text);
  if (!place) return null;
  const hay = ` ${normalizePlaceText(text)} `;
  const row = db.prepare("SELECT name, nicknames FROM campus_places WHERE id = ?").get(place.id) as { name: string; nicknames: string } | undefined;
  let nicknames: unknown = [];
  try {
    nicknames = JSON.parse(row?.nicknames || "[]");
  } catch {
    // Just the name then.
  }
  const labels = [place.name, ...(Array.isArray(nicknames) ? nicknames.filter((n): n is string => typeof n === "string") : [])]
    .map(normalizePlaceText)
    .filter(Boolean)
    .sort((x, y) => y.length - x.length);
  const label = labels.find((l) => hay.includes(` ${l} `));
  if (!label) return { spot: normalizePlaceText(place.name), lat: place.lat, lng: place.lng, span: "" };
  const at = hay.indexOf(` ${label} `);
  const extra = hay.slice(at + label.length + 1).match(/^ (?:(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|ground|top) floor|lobby|steps|entrance|patio|courtyard|basement|lawn)\b/)?.[0] ?? "";
  const lead = hay.slice(0, at + 1).match(new RegExp(`\\b(${PREP}) (?:the )?$`));
  const side = lead && /^(?:outside|behind|in front of|next to)/.test(lead[1]) ? `${lead[1].replace(" of", "")} ` : "";
  return { spot: `${side}${label}${extra}`, lat: place.lat, lng: place.lng, span: `${lead ? lead[0] : ""}${label}${extra}` };
}

function setSpot(draft: Draft, place: Spot): void {
  draft.spot = place.spot;
  draft.lat = place.lat;
  draft.lng = place.lng;
}

function parsePost(db: DatabaseSync, text: string, details: Record<string, unknown>): Draft {
  let w = normalizePlaceText(text);
  const draft: Draft = { what: null, unit: null, count: null, needConfirm: false, spot: null, lat: null, lng: null, hold: DEFAULT_HOLD_MINUTES, club: null, askedClub: false, photo: null, kind: "food", asks: 0 };

  const hold = w.match(HOLD_RE);
  if (hold) {
    draft.hold = clamp(Number(hold[1]), 1, MAX_HOLD_MINUTES);
    w = w.replace(HOLD_RE, " ");
  }

  const place = resolveSpot(db, w);
  if (place) {
    setSpot(draft, place);
    if (place.span) w = ` ${w} `.replace(` ${place.span.trim()} `, " | ").trim();
  }

  const giving = w.match(/^(?:hey |yo )?([a-z0-9 ]{2,40}?) (?:is|are) giving away\b/);
  const from = w.match(/\bfrom (?:the )?([a-z0-9 ]{2,40}?)(?= (?:at|in|outside|near|by|is|are|hold|come|\|) | ?\||$)/);
  if (giving && cleanClub(giving[1])) {
    draft.club = cleanClub(giving[1]);
    w = w.replace(giving[1], " ");
  } else if (from) {
    draft.club = cleanClub(from[1]);
    w = w.replace(from[0], " ");
  }

  const tokens = w.replace(/\|/g, " ").replace(LEAD_WORDS, " ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const at = tokens.findIndex((t) => toNumber(t) !== null);
  if (at !== -1) {
    draft.count = toNumber(tokens[at]);
    tokens.splice(at, 1);
    if (tokens[at] && UNITS.test(tokens[at]) && tokens.length > 1) draft.unit = tokens.splice(at, 1)[0];
  }
  const rest = tokens.filter((t) => toNumber(t) === null).join(" ");
  if (rest && rest.length <= 40 && tokens.length <= 5) draft.what = rest;
  else if (typeof details.category === "string" && /^[a-z ]{2,30}$/i.test(details.category)) draft.what = details.category.toLowerCase();

  if (draft.count === null && typeof details.count === "number" && details.count > 0) draft.count = details.count;
  if (draft.count !== null) draft.count = draft.count > 0 ? clamp(draft.count, 1, MAX_SERVINGS) : null;
  const all = word(text);
  draft.kind = STUFF.test(all) && !EDIBLE.test(all) ? "stuff" : "food";
  return draft;
}

// ---------- the pool: claims and counts (all in SQL transactions) ----------

type ClaimResult = { result: "claimed"; claimId: number; left: number; hold: number } | { result: "gone" | "already_held" | "already_got" };

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** Claim one serving. The decrement only succeeds while servingsLeft > 0, so two claims can never share the last one. */
export function claimServing(db: DatabaseSync, dropId: number, userId: number, now: number): ClaimResult {
  return inTransaction(db, () => {
    const mine = db.prepare("SELECT status FROM claims WHERE foodDropId = ? AND userId = ? AND status IN ('held','picked_up') ORDER BY id DESC LIMIT 1").get(dropId, userId) as { status: string } | undefined;
    if (mine) return { result: mine.status === "held" ? "already_held" : "already_got" } as ClaimResult;
    const took = db.prepare("UPDATE food_drops SET servingsLeft = servingsLeft - 1 WHERE id = ? AND status = 'live' AND servingsLeft > 0").run(dropId);
    if (!took.changes) return { result: "gone" } as ClaimResult;
    const drop = db.prepare("SELECT servingsLeft, holdMinutes FROM food_drops WHERE id = ?").get(dropId) as { servingsLeft: number; holdMinutes: number };
    const res = db.prepare("INSERT INTO claims (foodDropId, userId, status, heldUntil, createdAt) VALUES (?, ?, 'held', ?, ?)").run(dropId, userId, now + drop.holdMinutes * 60_000, now);
    return { result: "claimed", claimId: Number(res.lastInsertRowid), left: drop.servingsLeft, hold: drop.holdMinutes } as ClaimResult;
  });
}

/** Give a held serving back. Returns true when a claim was actually released. */
export function releaseClaim(db: DatabaseSync, claimId: number): boolean {
  return inTransaction(db, () => {
    const claim = db.prepare("SELECT foodDropId FROM claims WHERE id = ? AND status = 'held'").get(claimId) as { foodDropId: number } | undefined;
    if (!claim) return false;
    db.prepare("UPDATE claims SET status = 'released' WHERE id = ?").run(claimId);
    // Never above what the poster says is there: their own count already left room for the servings being held.
    db.prepare("UPDATE food_drops SET servingsLeft = MIN(servingsTotal, servingsLeft + 1) WHERE id = ? AND status = 'live'").run(claim.foodDropId);
    return true;
  });
}

function heldClaim(db: DatabaseSync, dropId: number, userId: number): number | null {
  const r = db.prepare("SELECT id FROM claims WHERE foodDropId = ? AND userId = ? AND status = 'held' ORDER BY id DESC LIMIT 1").get(dropId, userId) as { id: number } | undefined;
  return r?.id ?? null;
}

function latestHeldClaim(db: DatabaseSync, userId: number): { id: number; foodDropId: number } | null {
  return (db.prepare("SELECT id, foodDropId FROM claims WHERE userId = ? AND status = 'held' ORDER BY id DESC LIMIT 1").get(userId) as { id: number; foodDropId: number } | undefined) ?? null;
}

/** Nothing left and nobody still on their way: the drop is over. */
function endIfFinished(db: DatabaseSync, dropId: number): void {
  db.prepare("UPDATE food_drops SET status = 'ended' WHERE id = ? AND status = 'live' AND servingsLeft <= 0 AND NOT EXISTS (SELECT 1 FROM claims WHERE foodDropId = ? AND status = 'held')").run(dropId, dropId);
}

// ---------- the alert and its live count ----------

function alertLead(d: { clubName: string | null; description: string; locationText: string }): string {
  return d.clubName ? `yo ${d.clubName} is giving away free ${d.description} at ${d.locationText}` : `yo there's free ${d.description} at ${d.locationText}`;
}

function firstTail(count: number, unit: string | null): string {
  if (count === 1) return "just 1 left";
  return `about ${count}${unit ? ` ${unit}` : ""} left`;
}

/** Where a walking time was measured from: a recent fix, a fix older than 3 hours, or a usual spot (named as the student wrote it). */
export type WalkFrom = { kind: "fresh" } | { kind: "stale" } | { kind: "spot"; name: string };

export function walkLine(minutes: number, from: WalkFrom = { kind: "fresh" }): string {
  const an = minutes === 8 || minutes === 11 || minutes === 18 || (minutes >= 80 && minutes <= 89);
  const where = from.kind === "stale" ? "where u last shared" : from.kind === "spot" && from.name ? from.name : "u";
  return FT.walk(an ? "an" : "a", String(minutes), where);
}

/** How the count reaches people: a silent edit, and a new text only when the edit didn't happen. */
interface Out {
  edit(chatId: string, messageId: string, text: string): Promise<boolean>;
  text(user: User, text: string): Promise<void>;
}

function flowOut(ctx: FlowContext): Out {
  return {
    edit: (chatId, messageId, text) => ctx.adapter.editMessage(chatId, messageId, text).catch(() => false),
    text: async (user, text) => {
      await ctx.sayTo(user.id, text);
    },
  };
}

function directOut(db: DatabaseSync, adapter: MessagingAdapter): Out {
  return {
    edit: async (chatId, messageId, text) => {
      const row = db.prepare("SELECT stopped FROM users WHERE chatId = ? LIMIT 1").get(chatId) as { stopped: number } | undefined;
      if (row?.stopped) return false;
      return adapter.editMessage(chatId, messageId, text).catch(() => false);
    },
    text: async (user, text) => {
      const fresh = getUserById(db, user.id);
      if (!fresh || fresh.stopped) return;
      const worded = FOOD_VOICE.line(db, fresh.id, text);
      const sent = await adapter.sendMessage(fresh.chatId, worded).catch(() => null);
      if (sent) saveMessage(db, { userId: fresh.id, chatId: fresh.chatId, direction: "out", providerMessageId: sent.messageId, text: worded, notice: true });
    },
  };
}

/**
 * After any change to a drop: edit every alerted user's count bubble. Where the edit doesn't happen
 * (edits off, or it failed), send one short text, and only when the count just dropped to "last one" or "all gone".
 * Each person gets each of those two texts at most once per drop (food_milestones), and a count going back up
 * (someone let theirs go) is never texted, so one person toggling a claim can't make everyone's phone buzz.
 * `skipText` are users who should not get that text (the person whose own action caused the change).
 */
async function pushCount(db: DatabaseSync, out: Out, dropId: number, before: { left: number; live: boolean }, skipText: number[] = []): Promise<void> {
  const drop = getDrop(db, dropId);
  if (!drop) return;
  const live = drop.status === "live";
  const left = live ? drop.servingsLeft : 0;
  const wasLeft = before.live ? before.left : 0;
  if (left === wasLeft) return;
  const line = countLine(left, live);
  const bubbles = db.prepare("SELECT messageId, userId FROM food_alert_bubbles WHERE foodDropId = ? AND role = 'count'").all(dropId) as { messageId: string; userId: number }[];
  const milestone = left <= 1 && left < wasLeft;
  const kind = left === 1 ? "last_one" : "all_gone";
  const now = new Date(deps.now());
  await Promise.all(
    bubbles.map(async (b) => {
      const user = getUserById(db, b.userId);
      if (!user || user.stopped) return;
      const edited = await out.edit(user.chatId, b.messageId, `${alertLead(drop)}, ${line}`);
      if (edited || !milestone || skipText.includes(user.id) || !canAlert(user, now)) return;
      // People who already have theirs don't need to hear that it ran out.
      const has = db.prepare("SELECT 1 FROM claims WHERE foodDropId = ? AND userId = ? AND status IN ('held','picked_up') LIMIT 1").get(dropId, user.id);
      if (has) return;
      const first = db.prepare("INSERT OR IGNORE INTO food_milestones (foodDropId, userId, kind) VALUES (?, ?, ?)").run(dropId, user.id, kind);
      if (!first.changes) return;
      await out.text(user, left === 1 ? FT.lastOneAt(drop.locationText) : FT.allGoneAt(drop.locationText));
    }),
  );
}

const snapshot = (d: Drop) => ({ left: d.servingsLeft, live: d.status === "live" });

// ---------- who to alert ----------

/**
 * The best location Troy has for this user: a live Find My fix when the provider has one (saved as their
 * last known location), else the saved fix (worded as "where u last shared" once it is over 3 hours old),
 * else their first usual spot. Only ever used for this user's own walking time.
 */
async function whereIs(db: DatabaseSync, adapter: MessagingAdapter, user: User, now: number): Promise<{ lat: number; lng: number; from: WalkFrom } | null> {
  // Never look someone up after "forget my location" or STOP until they share again themselves.
  const live = shouldReadLiveLocation(db, user.id) ? await adapter.getLiveLocation(user.handle).catch(() => null) : null;
  if (live && Number.isFinite(live.lat) && Number.isFinite(live.lng)) {
    const at = Number.isFinite(live.at) ? Math.min(live.at, now) : now;
    const saved = getUserLocation(db, user, now);
    // An older Find My fix never replaces something newer (a pin, or "i'm at leavey rn").
    if (!saved || saved.at === null || at >= saved.at) saveUserLocation(db, user.id, { lat: live.lat, lng: live.lng }, "find_my", at);
  }
  const loc = getUserLocation(db, user, now);
  if (!loc) return null;
  const from: WalkFrom = loc.source === "usual_spot" ? { kind: "spot", name: loc.spot ?? "" } : loc.stale ? { kind: "stale" } : { kind: "fresh" };
  return { lat: loc.lat, lng: loc.lng, from };
}

interface Recipient {
  user: User;
  minutes: number | null;
  /** Where `minutes` was measured from. Null when there is no walking time. */
  from: WalkFrom | null;
}

/** Subscribed, verified, not stopped or paused, not in their own quiet hours, not the poster, and within their own alert distance. */
export async function findRecipients(db: DatabaseSync, adapter: MessagingAdapter, drop: { posterUserId: number; lat: number | null; lng: number | null }, kind: "food" | "stuff", now: number): Promise<Recipient[]> {
  const key = kind === "stuff" ? "free_stuff" : "free_food";
  // Example users exist only as demo data and can never be texted, so they are never alert recipients.
  const rows = db.prepare("SELECT * FROM users WHERE verifiedAt IS NOT NULL AND stopped = 0 AND paused = 0 AND isExample = 0 AND id != ? ORDER BY id").all(drop.posterUserId) as Row[];
  const out: Recipient[] = [];
  await Promise.all(
    rows.map(async (r) => {
      const user = rowToUser(r);
      if (!user.subscriptions.includes(key) || !canAlert(user, new Date(now))) return;
      let minutes: number | null = null;
      let from: WalkFrom | null = null;
      // Asked even when the drop has no coordinates, so a live fix still refreshes what's saved.
      const at = await whereIs(db, adapter, user, now);
      if (at && drop.lat !== null && drop.lng !== null) {
        minutes = walkingMinutes(at, { lat: drop.lat, lng: drop.lng });
        from = at.from;
      }
      // Outside their own alert distance by the best location we have: skipped. No location at all: still alerted.
      if (minutes !== null && minutes > user.alertMinutes) return;
      out.push({ user, minutes, from });
    }),
  );
  return out.sort((a, b) => a.user.id - b.user.id);
}

// ---------- posting ----------

function saveDraft(ctx: FlowContext, step: string, draft: Draft): void {
  ctx.setState({ flow: "food", step, data: { draft } });
}

/** Ask for whatever is still missing, one question at a time, then publish. */
async function advance(ctx: FlowContext, draft: Draft): Promise<void> {
  if (draft.count === null) {
    saveDraft(ctx, "post_count", draft);
    await ctx.say(draft.asks ? FOOD_COPY.askCountAgain : FOOD_COPY.askCount);
    return;
  }
  if (draft.needConfirm) {
    const label = draft.unit ?? draft.what ?? "";
    const ids = await ctx.say(FT.looksLike(`${draft.count}${label ? ` ${label}` : ""}`));
    saveDraft(ctx, "post_confirm", { ...draft, confirmId: ids[0] ?? null });
    return;
  }
  if (!draft.spot) {
    saveDraft(ctx, "post_spot", draft);
    await ctx.say(draft.asks ? FOOD_COPY.askSpotAgain : FOOD_COPY.askSpot);
    return;
  }
  if (!draft.club && !draft.askedClub) {
    saveDraft(ctx, "post_club", { ...draft, askedClub: true });
    await ctx.say(FOOD_COPY.askClub);
    return;
  }
  await publish(ctx, draft);
}

async function startPost(ctx: FlowContext): Promise<void> {
  if (!ctx.user.verifiedAt) {
    await ctx.say(FOOD_COPY.notVerified);
    return;
  }
  // Posting bans are decided here, never by the model.
  if (ctx.user.bannedFromPosting) {
    ctx.setState(null);
    await ctx.say(...FOOD_COPY.banned);
    return;
  }
  const draft = parsePost(ctx.db, ctx.event.text, ctx.intent.details);
  const image = ctx.event.images[0];
  if (image) {
    draft.photo = image.path;
    const guess = await deps.countServings(image, ctx.event.text).catch(() => null);
    if (guess) {
      // The poster's own number wins over the photo. Either way they confirm it.
      if (draft.count === null && guess.count > 0) {
        draft.count = clamp(guess.count, 1, MAX_SERVINGS);
        // The photo's word for one serving only goes with the photo's own count.
        if (!draft.unit && guess.item && guess.item !== "servings" && guess.item !== draft.what) draft.unit = guess.item;
      }
      draft.needConfirm = draft.count !== null;
    }
  }
  if (!draft.what) draft.what = draft.kind === "stuff" ? "stuff" : "food";
  await advance(ctx, draft);
}

/** True when the message is clearly a new request for another flow, not an answer to our question. */
function startsSomethingElse(ctx: FlowContext): boolean {
  return ctx.intent.flow !== "food" && ctx.intent.flow !== "smalltalk" && ctx.intent.flow !== "onboarding";
}

async function retryOrDrop(ctx: FlowContext, draft: Draft, step: string, again: string): Promise<void> {
  if (startsSomethingElse(ctx)) {
    await passOn(ctx, true);
    return;
  }
  if (draft.asks >= 1) {
    ctx.setState(null);
    await ctx.say(FOOD_COPY.postLater);
    return;
  }
  saveDraft(ctx, step, { ...draft, asks: draft.asks + 1 });
  await ctx.say(again);
}

async function handlePostStep(ctx: FlowContext, state: FlowState, tapAnswer: "yes" | "no" | null): Promise<void> {
  const draft = { ...(state.data.draft as Draft) };
  const text = ctx.event.text ?? "";
  const w = word(text);
  const hold = w.match(HOLD_RE);
  if (hold) draft.hold = clamp(Number(hold[1]), 1, MAX_HOLD_MINUTES);
  const numberText = w.replace(HOLD_RE, " ");

  if (state.step === "post_count") {
    const n = parseNumber(numberText);
    if (n === null || n <= 0) return retryOrDrop(ctx, draft, "post_count", FOOD_COPY.askCountAgain);
    draft.count = clamp(n, 1, MAX_SERVINGS);
    draft.needConfirm = false;
    draft.asks = 0;
    return advance(ctx, draft);
  }

  if (state.step === "post_confirm") {
    const n = parseNumber(numberText);
    if (n !== null && n > 0) draft.count = clamp(n, 1, MAX_SERVINGS);
    else if (tapAnswer === "no" || NO.test(w) || /^(?:no|nah|nope)\b/.test(w)) {
      draft.count = null;
    } else if (!(tapAnswer === "yes" || YES.test(w) || /^(?:yes|yea|yeah|yep|yup|correct|right)\b/.test(w) || hold)) {
      return retryOrDrop(ctx, draft, "post_confirm", FOOD_COPY.confirmCountAgain);
    }
    draft.needConfirm = false;
    draft.asks = 0;
    // "yep, at leavey" answers the next question too.
    if (!draft.spot) {
      const place = resolveSpot(ctx.db, text);
      if (place) setSpot(draft, place);
    }
    return advance(ctx, draft);
  }

  if (state.step === "post_spot") {
    const place = resolveSpot(ctx.db, text);
    if (place) setSpot(draft, place);
    else {
      // A spot we don't have coordinates for still works: people just don't get a walking time.
      const phrase = w.replace(/^(?:its |it is |were |we are )?(?:at |in |outside |inside |near |by )?(?:the )?/, "").trim();
      const usable = phrase.length >= 2 && phrase.length <= 40 && !/^(?:idk|not sure|dunno|what|huh)$/.test(phrase) && !ASKING.test(text.toLowerCase()) && !startsSomethingElse(ctx) && !hold;
      if (!usable) return retryOrDrop(ctx, draft, "post_spot", FOOD_COPY.askSpotAgain);
      draft.spot = phrase;
      draft.lat = null;
      draft.lng = null;
    }
    draft.asks = 0;
    return advance(ctx, draft);
  }

  if (state.step === "post_club") {
    // The club is optional, so the post goes out no matter what comes back.
    const other = startsSomethingElse(ctx);
    if (!other && !SKIP.test(w) && !hold) draft.club = cleanClub(text);
    await publish(ctx, draft);
    if (other) await passOn(ctx, false);
    return;
  }
}

async function publish(ctx: FlowContext, draft: Draft): Promise<void> {
  const { db } = ctx;
  const now = deps.now();
  const count = clamp(draft.count ?? 1, 1, MAX_SERVINGS);
  const what = draft.what ?? (draft.kind === "stuff" ? "stuff" : "food");
  const spot = draft.spot ?? "campus";
  const res = db
    .prepare("INSERT INTO food_drops (posterUserId, clubName, description, photoUrl, locationText, lat, lng, servingsTotal, servingsLeft, holdMinutes, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(ctx.user.id, draft.club, what, draft.photo, spot, draft.lat, draft.lng, count, count, draft.hold, now + DROP_TTL_MS, now);
  const dropId = Number(res.lastInsertRowid);
  ctx.setState(null);

  const recipients = await findRecipients(db, ctx.adapter, { posterUserId: ctx.user.id, lat: draft.lat, lng: draft.lng }, draft.kind, now);
  const tapbacks = ctx.adapter.capabilities().tapbacks;
  const lead = alertLead({ clubName: draft.club, description: what, locationText: spot });
  const addBubble = db.prepare("INSERT OR REPLACE INTO food_alert_bubbles (messageId, foodDropId, userId, role) VALUES (?, ?, ?, ?)");
  const claimable: Record<string, string> = {};
  const sendStart = Date.now();

  await Promise.all(
    recipients.map(async ({ user, minutes, from }) => {
      const bubbles: { role: string; text: string }[] = [{ role: "count", text: `${lead}, ${firstTail(count, draft.unit)}` }];
      if (minutes !== null) bubbles.push({ role: "walk", text: walkLine(minutes, from ?? undefined) });
      bubbles.push({ role: "claim", text: tapbacks ? FOOD_COPY.reactHow : FOOD_COPY.claimHow });
      const ids = await ctx.sayTo(user.id, ...bubbles.map((b) => b.text));
      if (!ids.some((id) => id !== null)) {
        // Sent but the provider gave no ids: they can still reply "me". Not sent at all: nothing to track.
        const got = db.prepare("SELECT 1 FROM messages WHERE userId = ? AND direction = 'out' AND text = ? AND createdAt >= ? LIMIT 1").get(user.id, bubbles[0].text, sendStart);
        if (!got) return;
      }
      ids.forEach((id, i) => {
        if (id) addBubble.run(id, dropId, user.id, bubbles[i].role);
      });
      const claimId = ids[ids.length - 1] ?? ids.find((id) => id !== null) ?? null;
      claimable[String(user.id)] = claimId ?? "";
      // So a plain "me" finds this alert. Never on top of a conversation they're already in.
      if (!getFlowState(db, user.id)) ctx.setStateFor(user.id, { flow: "food", step: "alerted", data: { dropId } });
    }),
  );
  db.prepare("UPDATE food_drops SET alertMessageIds = ? WHERE id = ?").run(JSON.stringify(claimable), dropId);

  const told = Object.keys(claimable).length;
  await ctx.say(
    told ? FT.posted(String(told), told === 1 ? "person" : "people") : FOOD_COPY.postedNobody,
    FOOD_COPY.postedHow,
  );
}

// ---------- claims ----------

function alertedDrop(db: DatabaseSync, userId: number, now: number): Drop | null {
  const r = db
    .prepare("SELECT d.* FROM food_drops d WHERE d.createdAt >= ? AND d.status != 'removed' AND EXISTS (SELECT 1 FROM food_alert_bubbles b WHERE b.foodDropId = d.id AND b.userId = ? AND b.role != 'report') ORDER BY d.id DESC LIMIT 1")
    .get(now - ALERT_STALE_MS, userId) as Row | undefined;
  if (r) return rowToDrop(r);
  // Alerts whose bubbles came back without ids are still listed on the drop itself.
  const rows = db.prepare("SELECT * FROM food_drops WHERE createdAt >= ? AND status != 'removed' ORDER BY id DESC LIMIT 20").all(now - ALERT_STALE_MS) as Row[];
  return rows.map(rowToDrop).find((d) => String(userId) in d.alertMessageIds) ?? null;
}

function stateDrop(ctx: FlowContext, state: FlowState | null): Drop | null {
  const id = state && typeof state.data.dropId === "number" ? state.data.dropId : null;
  return (id !== null ? getDrop(ctx.db, id) : null) ?? alertedDrop(ctx.db, ctx.user.id, deps.now());
}

async function doClaim(ctx: FlowContext, drop: Drop, viaTap: boolean): Promise<void> {
  const before = snapshot(drop);
  // Grab, drop, grab, drop: after a few rounds on one drop this person's claims on it stop counting.
  const dropped = (ctx.db.prepare("SELECT COUNT(*) AS n FROM claims WHERE foodDropId = ? AND userId = ? AND status = 'released'").get(drop.id, ctx.user.id) as { n: number }).n;
  if (dropped >= MAX_REGRABS && heldClaim(ctx.db, drop.id, ctx.user.id) === null) {
    if (!viaTap) await ctx.say(FOOD_COPY.tooManyGrabs);
    return;
  }
  const res = claimServing(ctx.db, drop.id, ctx.user.id, deps.now());
  if (res.result === "gone") {
    await ctx.say(FOOD_COPY.gone);
    return;
  }
  if (res.result === "already_held") {
    // A switched tapback (love to like) lands here. They already have their confirmation.
    if (!viaTap) await ctx.say(FOOD_COPY.alreadyHeld);
    return;
  }
  if (res.result === "already_got") {
    await ctx.say(FOOD_COPY.alreadyGot);
    return;
  }
  if (res.result !== "claimed") return;
  // A tapback can arrive while they are mid conversation in another flow. That conversation keeps its place.
  if (!ctx.state || ctx.state.flow === "food") ctx.setState({ flow: "food", step: "claimed", data: { dropId: drop.id, claimId: res.claimId } });
  await ctx.say(FT.yours(String(res.hold)), FOOD_COPY.gotItHow, FT.talkTo(drop.clubName ?? "whoever posted it"));
  await pushCount(ctx.db, flowOut(ctx), drop.id, before, [ctx.user.id]);
}

async function doRelease(ctx: FlowContext, drop: Drop, claimId: number): Promise<void> {
  const before = snapshot(drop);
  if (!releaseClaim(ctx.db, claimId)) return;
  if (!ctx.state || ctx.state.flow === "food") ctx.setState(drop.status === "live" ? { flow: "food", step: "alerted", data: { dropId: drop.id } } : null);
  await ctx.say(FOOD_COPY.released);
  await pushCount(ctx.db, flowOut(ctx), drop.id, before, [ctx.user.id]);
}

async function handleReaction(ctx: FlowContext, state: FlowState | null): Promise<void> {
  const r = ctx.event.reaction!;
  const positive = !r.removed && (r.type === "love" || r.type === "like");

  // A tapback on one of Troy's questions is a yes or no.
  if (state?.step === "post_confirm" && (state.data.draft as Draft | undefined)?.confirmId === r.targetMessageId) {
    if (r.removed) return;
    if (positive || r.type === "dislike") await handlePostStep(ctx, state, positive ? "yes" : "no");
    return;
  }
  if (state?.step === "relay_ask" && state.data.askId === r.targetMessageId) {
    if (r.removed) return;
    if (positive || r.type === "dislike") await answerRelayAsk(ctx, state, positive);
    return;
  }

  const bubble = ctx.db.prepare("SELECT foodDropId FROM food_alert_bubbles WHERE messageId = ? AND userId = ? AND role != 'report'").get(r.targetMessageId, ctx.user.id) as { foodDropId: number } | undefined;
  const drop = bubble ? getDrop(ctx.db, bubble.foodDropId) : null;
  if (!drop) return;

  if (positive) {
    await doClaim(ctx, drop, true);
    return;
  }
  // Taking the tapback off, or switching it to something else, gives the serving back.
  const held = heldClaim(ctx.db, drop.id, ctx.user.id);
  if (held !== null) await doRelease(ctx, drop, held);
}

// ---------- the poster's side ----------

function posterDrop(db: DatabaseSync, userId: number): Drop | null {
  const r = db.prepare("SELECT * FROM food_drops WHERE posterUserId = ? AND status = 'live' ORDER BY id DESC LIMIT 1").get(userId) as Row | undefined;
  return r ? rowToDrop(r) : null;
}

async function posterUpdate(ctx: FlowContext, drop: Drop): Promise<void> {
  const { db } = ctx;
  const w = word(ctx.event.text);
  const before = snapshot(drop);
  let n: number | null = OUT.test(w) ? 0 : /\blast one\b/.test(w) ? 1 : /\b(?:a few|couple)\b/.test(w) ? null : parseNumber(ctx.event.text);
  if (n === null && typeof ctx.intent.details.count === "number") n = ctx.intent.details.count;
  if (n === null || n < 0) {
    await ctx.say(FOOD_COPY.askLeft);
    return;
  }

  if (n === 0) {
    // Out means out: people still on their way are told so they don't walk over for nothing.
    const held = db.prepare("SELECT id, userId FROM claims WHERE foodDropId = ? AND status = 'held'").all(drop.id) as { id: number; userId: number }[];
    inTransaction(db, () => {
      db.prepare("UPDATE food_drops SET status = 'ended', servingsLeft = 0 WHERE id = ?").run(drop.id);
      db.prepare("UPDATE claims SET status = 'released' WHERE foodDropId = ? AND status = 'held'").run(drop.id);
    });
    await ctx.say(FOOD_COPY.closed);
    await endDropRelays(ctx, drop.id);
    for (const c of held) {
      const s = getFlowState(db, c.userId);
      if (s?.flow === "food" && s.data.dropId === drop.id) ctx.setStateFor(c.userId, null);
      await ctx.sayTo(c.userId, FT.ranOut(drop.description, drop.locationText));
    }
    await pushCount(db, flowOut(ctx), drop.id, before, held.map((c) => c.userId));
    return;
  }

  // The poster counts what is on the table. Servings people are on their way for are still on it,
  // so they come off the number before anyone else is offered one.
  const onTable = clamp(n, 1, MAX_SERVINGS);
  const holds = (db.prepare("SELECT COUNT(*) AS c FROM claims WHERE foodDropId = ? AND status = 'held'").get(drop.id) as { c: number }).c;
  const left = Math.max(0, onTable - holds);
  db.prepare("UPDATE food_drops SET servingsLeft = ?, servingsTotal = MAX(servingsTotal, ?) WHERE id = ? AND status = 'live'").run(left, onTable, drop.id);
  if (!holds) await ctx.say(FT.updated(countLine(left)));
  else await ctx.say(FT.updatedHeld(String(holds), holds === 1 ? "is" : "are", left > 0 ? countLine(left) : "none left"));
  await pushCount(db, flowOut(ctx), drop.id, before);
}

/** A food relay is only for the pickup. When the drop ends, so does the chat, and both people are told. */
async function endDropRelays(ctx: FlowContext, dropId: number): Promise<void> {
  const rows = ctx.db.prepare("SELECT userA, userB FROM relays WHERE context = ? AND status = 'active'").all(`food:${dropId}`) as { userA: number; userB: number }[];
  if (!rows.length) return;
  endRelayByContext(ctx.db, `food:${dropId}`);
  for (const r of rows) {
    for (const id of [r.userA, r.userB]) {
      if (id === ctx.user.id) await ctx.say(FOOD_COPY.relayOver);
      else await ctx.sayTo(id, FOOD_COPY.relayOver);
    }
  }
}

// ---------- reports, pickups, status, thrift ----------

async function reportFake(ctx: FlowContext, state: FlowState | null): Promise<void> {
  const drop = stateDrop(ctx, state);
  const wasAlerted =
    drop &&
    (String(ctx.user.id) in drop.alertMessageIds ||
      !!ctx.db.prepare("SELECT 1 FROM food_alert_bubbles WHERE foodDropId = ? AND userId = ? AND role != 'report' LIMIT 1").get(drop.id, ctx.user.id));
  if (!drop || !wasAlerted) {
    await ctx.say(FOOD_COPY.nothingToReport);
    return;
  }
  // One report per person per drop. Nothing else happens here: staff decide in the dashboard.
  const added = ctx.db.prepare("INSERT OR IGNORE INTO food_alert_bubbles (messageId, foodDropId, userId, role) VALUES (?, ?, ?, 'report')").run(`report:${drop.id}:${ctx.user.id}`, drop.id, ctx.user.id);
  if (added.changes) ctx.db.prepare("UPDATE food_drops SET reports = reports + 1 WHERE id = ?").run(drop.id);
  const held = heldClaim(ctx.db, drop.id, ctx.user.id);
  if (held !== null) {
    const before = snapshot(drop);
    releaseClaim(ctx.db, held);
    await pushCount(ctx.db, flowOut(ctx), drop.id, before, [ctx.user.id]);
  }
  if (state) ctx.setState(null);
  await ctx.say(...FOOD_COPY.reportThanks);
}

async function gotIt(ctx: FlowContext, state: FlowState | null): Promise<boolean> {
  const fromState = state && typeof state.data.dropId === "number" ? heldClaim(ctx.db, state.data.dropId, ctx.user.id) : null;
  const claim = fromState !== null ? { id: fromState, foodDropId: state!.data.dropId as number } : latestHeldClaim(ctx.db, ctx.user.id);
  if (!claim) return false;
  const drop = getDrop(ctx.db, claim.foodDropId);
  ctx.db.prepare("UPDATE claims SET status = 'picked_up' WHERE id = ? AND status = 'held'").run(claim.id);
  ctx.setState(drop && drop.status === "live" ? { flow: "food", step: "alerted", data: { dropId: drop.id } } : null);
  await ctx.say(FOOD_COPY.pickedUp);
  // They have it, so there is nothing left to coordinate with the poster.
  const relay = activeRelayFor(ctx.db, ctx.user.id);
  if (relay && relay.context === `food:${claim.foodDropId}`) {
    endRelayByContext(ctx.db, relay.context);
    await ctx.sayTo(relay.otherUserId, FOOD_COPY.relayOver);
  }
  if (drop) {
    const before = snapshot(drop);
    endIfFinished(ctx.db, drop.id);
    await pushCount(ctx.db, flowOut(ctx), drop.id, before);
  }
  return true;
}

async function status(ctx: FlowContext): Promise<void> {
  const rows = ctx.db.prepare("SELECT * FROM food_drops WHERE status = 'live' AND servingsLeft > 0 AND posterUserId != ? AND isExample = 0 ORDER BY id DESC LIMIT 1").all(ctx.user.id) as Row[];
  const drop = rows.length ? rowToDrop(rows[0]) : null;
  if (!drop) {
    await ctx.say(FOOD_COPY.nothingLive);
    return;
  }
  if (!ctx.state || ctx.state.flow === "food") ctx.setState({ flow: "food", step: "alerted", data: { dropId: drop.id } });
  await ctx.say(`${alertLead(drop).replace(/^yo /, "")}, ${countLine(drop.servingsLeft)}`, FOOD_COPY.claimHow);
}

/** Someone asking where to get free clothes: only what the directory row says. No link or date is ever made up. */
async function thrift(ctx: FlowContext): Promise<void> {
  const row = ctx.db
    .prepare("SELECT name, details, url, contactMethod, isExample FROM directory WHERE kind = 'usg_program' AND (lower(name) LIKE '%thrift%' OR lower(topics) LIKE '%thrift%') ORDER BY id LIMIT 1")
    .get() as { name: string; details: string | null; url: string | null; contactMethod: string | null; isExample: number } | undefined;
  if (!row) {
    await ctx.say(FOOD_COPY.thriftUnsure);
    return;
  }
  const bubbles: string[] = [FT.theOne(row.name.replace(/^USG\b/, "usg"))];
  if (row.details) bubbles.push(row.details);
  else if (!row.url) bubbles.push(FOOD_COPY.checkUsg);
  if (row.url) bubbles.push(row.url);
  else if (row.contactMethod) bubbles.push(`u can reach them at ${row.contactMethod}`);
  await ctx.say(...bubbles.slice(0, 3));
}

// ---------- talking to the poster (both sides say yes, then relay mode) ----------

async function offerRelay(ctx: FlowContext, drop: Drop): Promise<void> {
  const mine = ctx.db.prepare("SELECT 1 FROM claims WHERE foodDropId = ? AND userId = ? AND status IN ('held','picked_up') LIMIT 1").get(drop.id, ctx.user.id);
  if (!mine) {
    await ctx.say(FOOD_COPY.claimFirst);
    return;
  }
  ctx.setState({ flow: "food", step: "relay_offer", data: { dropId: drop.id } });
  await ctx.say(FOOD_COPY.relayOffer);
}

async function askPoster(ctx: FlowContext, drop: Drop): Promise<void> {
  const back: Omit<FlowState, "updatedAt"> | null = heldClaim(ctx.db, drop.id, ctx.user.id) !== null ? { flow: "food", step: "claimed", data: { dropId: drop.id } } : null;
  const poster = getUserById(ctx.db, drop.posterUserId);
  // Contact rules are checked in code before anything is sent.
  if (!poster || poster.stopped || poster.contactMode === "no_contact") {
    ctx.setState(back);
    await ctx.say(FOOD_COPY.relayNotAvailable);
    return;
  }
  const theirs = getFlowState(ctx.db, poster.id);
  if (theirs && !(theirs.flow === "food" && theirs.step === "alerted")) {
    ctx.setState(back);
    await ctx.say(FOOD_COPY.relayBusy);
    return;
  }
  // Worded here so the check below looks for the words that were actually sent. (A bubble object goes out untouched.)
  const askLine = FOOD_VOICE.line(ctx.db, poster.id, FOOD_COPY.relayAskPoster);
  const ids = await ctx.sayTo(poster.id, FT.wantsToTalk(drop.description), { text: askLine });
  const sent = ctx.db.prepare("SELECT 1 FROM messages WHERE userId = ? AND direction = 'out' AND text = ? AND createdAt >= ? LIMIT 1").get(poster.id, askLine, Date.now() - 60_000);
  if (!ids.some((id) => id !== null) && !sent) {
    ctx.setState(back);
    await ctx.say(FOOD_COPY.relayNotAvailable);
    return;
  }
  ctx.setStateFor(poster.id, { flow: "food", step: "relay_ask", data: { dropId: drop.id, claimerId: ctx.user.id, askId: ids[ids.length - 1] ?? null } });
  ctx.setState({ flow: "food", step: "relay_wait", data: { dropId: drop.id } });
  await ctx.say(...FOOD_COPY.relayAsking);
}

async function answerRelayAsk(ctx: FlowContext, state: FlowState, yes: boolean): Promise<void> {
  const { db } = ctx;
  const claimerId = state.data.claimerId as number;
  const dropId = state.data.dropId as number;
  const claimer = getUserById(db, claimerId);
  const claimerState = getFlowState(db, claimerId);
  const waiting = claimerState?.flow === "food" && claimerState.step === "relay_wait" && claimerState.data.dropId === dropId;
  ctx.setState(null);
  if (waiting) ctx.setStateFor(claimerId, heldClaim(db, dropId, claimerId) !== null ? { flow: "food", step: "claimed", data: { dropId } } : null);

  if (!yes) {
    await ctx.say(FOOD_COPY.relayDeclinedPoster);
    if (waiting) await ctx.sayTo(claimerId, FOOD_COPY.relayDeclined);
    return;
  }
  // The claimer has to still be waiting on this exact ask, or their yes is stale.
  if (!claimer || claimer.stopped || !waiting) {
    await ctx.say(FOOD_COPY.movedOn);
    return;
  }
  try {
    // Relay mode takes over both chats from here, so neither side keeps a food state.
    ctx.setStateFor(claimerId, null);
    deps.startRelay(db, claimerId, ctx.user.id, `food:${dropId}`, { a: "the person who claimed one", b: "the poster" });
  } catch {
    await ctx.say(FOOD_COPY.relayFailed);
    await ctx.sayTo(claimerId, FOOD_COPY.relayFailed);
    return;
  }
  await ctx.say(...RELAY_COPY.start);
  await ctx.sayTo(claimerId, FOOD_COPY.saidYes, ...RELAY_COPY.start);
}

// ---------- handing a message to another flow ----------

/**
 * This text isn't ours. Give it to the flow the intent names, or to smalltalk. `clear` drops our open state first.
 * The registry is loaded here, at call time, so this file and flows/index.ts never import each other at load.
 */
async function passOn(ctx: FlowContext, clear: boolean): Promise<void> {
  if (clear) ctx.setState(null);
  const { getFlow } = await import("./index.ts");
  const named = ctx.intent.flow !== "food" ? getFlow(ctx.intent.flow) : null;
  const target = named ?? getFlow("smalltalk");
  if (!target || target.name === "food") {
    await ctx.say(FOOD_COPY.unsure);
    return;
  }
  const intent = named ? ctx.intent : { flow: "smalltalk" as const, action: "chat", details: {}, source: ctx.intent.source };
  // The other flow speaks in its own words, so it gets the plain context back.
  await target.handle({ ...unvoiced(ctx), intent, state: ctx.state && ctx.state.flow !== "food" ? ctx.state : null });
}

// ---------- the handler ----------

function freshState(ctx: FlowContext, now: number): FlowState | null {
  const s = ctx.state?.flow === "food" ? ctx.state : null;
  if (!s) return null;
  const limit = s.step.startsWith("post_") || s.step.startsWith("relay_") ? POST_STALE_MS : ALERT_STALE_MS;
  if (now - s.updatedAt > limit) {
    ctx.setState(null);
    return null;
  }
  return s;
}

async function handleCancel(ctx: FlowContext, state: FlowState): Promise<void> {
  if (state.step === "relay_ask") {
    await answerRelayAsk(ctx, state, false);
    return;
  }
  if (state.step === "claimed") {
    const drop = stateDrop(ctx, state);
    const held = drop ? heldClaim(ctx.db, drop.id, ctx.user.id) : null;
    if (drop && held !== null) {
      await doRelease(ctx, drop, held);
      return;
    }
  }
  if (state.step === "relay_offer" || state.step === "relay_wait") {
    const dropId = state.data.dropId as number;
    if (state.step === "relay_wait") {
      // Take the question back so the poster's late yes doesn't open anything.
      const row = ctx.db.prepare("SELECT userId FROM flow_state WHERE flow = 'food' AND step = 'relay_ask'").all() as { userId: number }[];
      for (const p of row) {
        const s = getFlowState(ctx.db, p.userId);
        if (s && s.data.claimerId === ctx.user.id && s.data.dropId === dropId) ctx.setStateFor(p.userId, null);
      }
    }
    ctx.setState(heldClaim(ctx.db, dropId, ctx.user.id) !== null ? { flow: "food", step: "claimed", data: { dropId } } : null);
    await ctx.say(FOOD_COPY.relayNvm);
    return;
  }
  ctx.setState(null);
  await ctx.say(state.step.startsWith("post_") ? FOOD_COPY.dropped : FOOD_COPY.relayNvm);
}

export const food: FlowHandler = {
  name: "food",
  async handle(plain) {
    // Everything this flow says goes out through FOOD_VOICE: facts as written, wording from the pools.
    const ctx = FOOD_VOICE.wrap(plain);
    ensureTables(ctx.db);
    const now = deps.now();
    const state = freshState(ctx, now);

    if (ctx.event.pollVote) return;
    if (ctx.event.reaction) {
      await handleReaction(ctx, state);
      return;
    }

    const text = (ctx.event.text ?? "").trim();
    const w = word(text);
    const action = ctx.intent.flow === "food" ? ctx.intent.action : "";
    const hasImage = ctx.event.images.length > 0;

    if (state && (CANCEL.test(w) || (state.step.startsWith("post_") && CANCEL_POST.test(w)))) {
      await handleCancel(ctx, state);
      return;
    }
    if (state?.step.startsWith("post_")) {
      await handlePostStep(ctx, state, null);
      return;
    }
    if (state?.step === "relay_ask" && (YES.test(w) || NO.test(w))) {
      await answerRelayAsk(ctx, state, YES.test(w));
      return;
    }
    if (state?.step === "relay_offer" && (YES.test(w) || NO.test(w))) {
      const drop = stateDrop(ctx, state);
      if (YES.test(w) && drop) await askPoster(ctx, drop);
      else {
        ctx.setState(drop && heldClaim(ctx.db, drop.id, ctx.user.id) !== null ? { flow: "food", step: "claimed", data: { dropId: drop.id } } : null);
        await ctx.say(FOOD_COPY.relayNvm);
      }
      return;
    }
    // A message that clearly belongs to another flow goes there. Our open state stays for a later "me".
    if (startsSomethingElse(ctx)) {
      await passOn(ctx, false);
      return;
    }

    // The poster correcting the count or ending the drop.
    const mine = posterDrop(ctx.db, ctx.user.id);
    const looksLikeCount = COUNT_UPDATE.test(w) || (action === "update_count" && !hasImage);
    if (mine && looksLikeCount && action !== "post_food") {
      await posterUpdate(ctx, mine);
      return;
    }
    if (mine && !state && /^\d{1,3}$/.test(w)) {
      await posterUpdate(ctx, mine);
      return;
    }

    if (action === "post_food" || (hasImage && action !== "claim" && action !== "report_fake" && !state?.step.startsWith("relay"))) {
      await startPost(ctx);
      return;
    }

    if (THRIFT_TOPIC.test(w) && ASKING.test(text.toLowerCase()) && !OFFERING.test(w)) {
      await thrift(ctx);
      return;
    }
    if (action === "report_fake" || FAKE.test(w)) {
      await reportFake(ctx, state);
      return;
    }
    if (GOT_IT.test(w) && (await gotIt(ctx, state))) return;

    const drop = stateDrop(ctx, state);
    if (drop && TALK.test(w) && !ME.test(w)) {
      await offerRelay(ctx, drop);
      return;
    }
    if (action === "claim" || ME.test(w)) {
      // "yes" only counts as a claim right after an alert.
      const plainYes = YES.test(w) && w !== "me";
      if (drop && (!plainYes || state?.step === "alerted")) {
        await doClaim(ctx, drop, false);
        return;
      }
      if (action === "claim") {
        await status(ctx);
        return;
      }
    }
    if (looksLikeCount) {
      await ctx.say(drop ? FOOD_COPY.notYourCount : FOOD_COPY.noDropToUpdate);
      return;
    }
    if (action === "status") {
      await status(ctx);
      return;
    }
    await passOn(ctx, false);
  },
};

// ---------- timers ----------

export type FoodTimerDeps = { db: DatabaseSync; getAdapter: () => MessagingAdapter };

/**
 * One pass: holds past heldUntil go back to the pool (the claimer is told once), drops past expiresAt end,
 * and every changed drop gets its count pushed out again. Safe to call as often as you like.
 */
export async function sweepFood(d: FoodTimerDeps, now: number = deps.now()): Promise<{ released: number; ended: number }> {
  const { db } = d;
  ensureTables(db);
  const out = directOut(db, d.getAdapter());
  const before = new Map<number, { left: number; live: boolean }>();
  const remember = (dropId: number) => {
    const drop = getDrop(db, dropId);
    if (drop && !before.has(dropId)) before.set(dropId, snapshot(drop));
  };

  const expired = db.prepare("SELECT id, foodDropId, userId FROM claims WHERE status = 'held' AND heldUntil <= ? ORDER BY id").all(now) as { id: number; foodDropId: number; userId: number }[];
  let released = 0;
  for (const c of expired) {
    remember(c.foodDropId);
    if (!releaseClaim(db, c.id)) continue;
    released++;
    const drop = getDrop(db, c.foodDropId);
    const s = getFlowState(db, c.userId);
    const live = drop?.status === "live";
    if (s?.flow === "food" && s.step === "claimed" && s.data.dropId === c.foodDropId) setFlowState(db, c.userId, live ? { flow: "food", step: "alerted", data: { dropId: c.foodDropId } } : null);
    const user = getUserById(db, c.userId);
    if (user && live && canAlert(user, new Date(now))) await out.text(user, FOOD_COPY.holdExpired);
  }

  const old = db.prepare("SELECT id FROM food_drops WHERE status = 'live' AND expiresAt IS NOT NULL AND expiresAt <= ? AND isExample = 0").all(now) as { id: number }[];
  for (const o of old) {
    remember(o.id);
    inTransaction(db, () => {
      db.prepare("UPDATE food_drops SET status = 'ended' WHERE id = ?").run(o.id);
      db.prepare("UPDATE claims SET status = 'released' WHERE foodDropId = ? AND status = 'held'").run(o.id);
    });
    endRelayByContext(db, `food:${o.id}`);
  }

  for (const [dropId, was] of before) {
    const expiredHere = expired.filter((c) => c.foodDropId === dropId).map((c) => c.userId);
    await pushCount(db, out, dropId, was, expiredHere);
  }
  // Alert pointers nobody used go away, so they never catch an unrelated text days later.
  db.prepare("DELETE FROM flow_state WHERE flow = 'food' AND step IN ('alerted','claimed') AND updatedAt < ?").run(now - ALERT_STALE_MS);
  return { released, ended: old.length };
}

/** Run the sweep every 30 seconds. Returns a function that stops it. */
export function startFoodTimers(d: FoodTimerDeps): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await sweepFood(d);
    } catch (err) {
      console.error("food sweep failed:", err instanceof Error ? err.name : "unknown");
    } finally {
      running = false;
    }
  }, SWEEP_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// While a food relay is on, these still belong to the food flow instead of being passed to the other person:
// the poster's count update ("3 left", "we're out"), a yes/no to "want to talk to them?", a claimer's
// "got it", and a clear new report for another flow ("found a wallet at tcc").
const NEW_REPORT = /^(?:i |ive |i just |just |hey |yo |troy )*(?:found (?:a|an|some|someones|somebodys|this|these)\b|lost my\b|i lost\b|cant find my\b)/;
registerPendingHooks("food", {
  keepsFromRelay: (db, user, state, event, relayContext) => {
    if (event.images.length) return false;
    const w = word(event.text ?? "");
    if (state?.flow === "food" && state.step === "relay_ask" && (YES.test(w) || NO.test(w))) return true;
    if (!relayContext.startsWith("food:")) return false;
    if (posterDrop(db, user.id) && COUNT_UPDATE.test(w)) return true;
    if (GOT_IT.test(w) && latestHeldClaim(db, user.id)) return true;
    return NEW_REPORT.test(w);
  },
});
