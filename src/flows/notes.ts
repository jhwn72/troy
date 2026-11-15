// Personal notes and rules: how a student wants Troy to treat them.
//
// Code decides every setting here. Contact and privacy rules (contactMode, groupChatsAllowed) are read
// with keyword rules, optionally checked by a fast model call, and when the two disagree the MORE private
// answer wins. The model alone can never loosen a privacy setting: that needs the student's yes.
// Every reply is a fixed lowercase template with the exact values put in by code, so this flow works
// with no API key at all.

import type { DatabaseSync } from "node:sqlite";
import type { ContactMode, FlowContext, FlowHandler, FlowState, Intent, User } from "../types.ts";
import { getUserById, updateUser } from "../db/index.ts";
import { askJson } from "../ai.ts";
import { SUBSCRIPTION_LABELS } from "../commands.ts";
import { findPlace } from "../places.ts";
import { BUILT_IN_TOPICS } from "../topics.ts";
import { describeSavedLocation, forgetUserLocation, saveUserLocation } from "../location.ts";
import type { Pools, Voice } from "./reports-shared.ts";
import { makeVoice, unvoiced } from "./reports-shared.ts";

// ---------- limits and defaults ----------

export const ALERT_MIN = 1;
export const ALERT_MAX = 60;
export const ALERT_DEFAULT = 15;
/** Used when a student gives only one end of the window ("after midnight", "at night"). */
export const QUIET_DEFAULT_START = "23:00";
export const QUIET_DEFAULT_END = "08:00";
const MAX_NOTES = 30;
const MAX_NOTE_CHARS = 200;
const MAX_SPOTS = 5;

/** The clock for location ages. Tests swap it with setNotesClock. */
let clock: () => number = () => Date.now();
export function setNotesClock(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}
const TOPICS = ["free_food", "free_stuff", "events", "class_help"] as const;

export type QuietWindow = { start: string; end: string };

// ---------- text helpers ----------

/** Lowercase, no apostrophes, common texting spellings folded together. Commas are kept (lists of places). */
export function normalize(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[‘’'`]/g, "")
    .replace(/\b([ap])\.m\.?/g, "$1m")
    .replace(/[“”"!?;()]/g, " ")
    .replace(/\.(?!\d)/g, " ")
    .replace(/[—–]/g, "-")
    .replace(/\b(?:please|pls|plz)\b/g, " ")
    .replace(/\b(?:you|ya)\b/g, "u")
    .replace(/\byour\b/g, "ur")
    .replace(/\bppls?\b/g, "people")
    .replace(/\bdo not\b/g, "dont")
    .replace(/\b(?:can not|cannot)\b/g, "cant")
    .replace(/\bi am\b/g, "im")
    .replace(/\b(?:no one|noone)\b/g, "nobody")
    .replace(/\bany one\b/g, "anyone")
    .replace(/\b(?:hit me up|hmu)\b/g, "text me")
    .replace(/\bmsg\b/g, "message")
    .replace(/\be-mail\b/g, "email")
    .replace(/\b(?:group ?(?:chats?|messages?|texts?)|gcs?)\b/g, "gc")
    .replace(/\s+/g, " ")
    .trim();
}

const flatten = (t: string) => t.replace(/,/g, " ").replace(/\s+/g, " ").trim();

function quote(text: string, max = 60): string {
  const t = text.toLowerCase().replace(/\s+/g, " ").replace(/["“”]/g, "").replace(/[—–]/g, ",").trim();
  return `"${t.length > max ? `${t.slice(0, max - 3).trim()}...` : t}"`;
}

// ---------- contact and group chat rules (keywords) ----------

const THIRD = "(?:people|anyone|anybody|others|other people|other students|them|they|strangers|randoms|students|someone|somebody|everyone|everybody|folks|finders|owners)";
const VERB = "(?:text|message|contact|dm|call|reach out to|reach|email|imessage)(?:ing)?";
const MYINFO = "my (?:phone number|number|phone|contact info|contact|info|email|digits|cell|#)";
const G = "(?:a |any |more |new |the |random )?gc";

const NO_CONTACT: RegExp[] = [
  /\b(?:dont|never|stop) (?:connect|match|introduc|link|pair)(?:e|ing)? me\b/,
  /\bno contact\b(?! info)/,
  new RegExp(`\\b(?:dont|never) (?:let|allow|want) ${THIRD} (?:to )?${VERB} me (?:at all|ever|period)\\b`),
  /\bleave me out of (?:matches|matching|handoffs|everything)\b/,
  /\bi dont (?:want|wanna) (?:to )?(?:be )?(?:connect|connected|matched|meet|contacted|introduced)(?: to| with| by)? (?:anyone|anybody|people|strangers|others)\b/,
  /\bdont (?:put|get) me in (?:touch|contact) with\b/,
];

const RELAY_OFF = /\b(?:turn off|switch off|disable|stop|no more|end|cancel|drop|get rid of|exit|leave|turn it off) (?:the |my )?(?:relay only|relay mode|relaying|relays|relay|no contact)\b/;

const RELAY_ONLY: RegExp[] = [
  new RegExp(`\\b(?:dont|never|stop) (?:let|letting|allow|allowing|have|having|want) ${THIRD} (?:to )?(?:${VERB} me\\b|(?:have|having|get|getting|see|seeing) ${MYINFO})`),
  new RegExp(`\\b(?:dont|never|stop|not) (?:share|sharing|give|giving|send|sending|show|showing|reveal|revealing|hand|handing|pass|passing|leak|leaking)(?: out| along)? ${MYINFO}`),
  /\brelay only\b|\bonly relay\b|\brelay mode\b|\bjust relay\b|\brelay (?:it|them|their|the|all|every|any|messages|requests|texts)\b/,
  new RegExp(`\\bkeep ${MYINFO} (?:private|hidden|secret|to urself|safe)\\b`),
  new RegExp(`\\b${MYINFO} (?:is|stays|should stay|needs to stay) private\\b`),
  new RegExp(`\\bnobody (?:can|should|gets to|is allowed to|needs to) (?:${VERB} me\\b|(?:have|get|see) ${MYINFO})`),
  /\bno direct (?:texts|messages|contact|dms)\b/,
  new RegExp(`\\bi dont (?:want|wanna have) ${THIRD} (?:to )?(?:${VERB} me\\b|(?:having|have|getting|get|seeing|see) ${MYINFO})`),
  new RegExp(`\\b(?:not|isnt|aint|never) (?:ok|okay|fine|cool|good) (?:to|if|for|with) .*(?:${MYINFO}|${VERB} me)`),
];

/** Looser than the lists above: a "don't" somewhere before other people contacting them, or before their number. */
const RELAY_LOOSE = new RegExp(`\\b(?:dont|never|stop|nobody|not ok|not okay|not cool|rather not)\\b.*(?:${THIRD} (?:\\w+ ){0,3}${VERB} me\\b|${MYINFO})`);

const DIRECT: RegExp[] = [
  new RegExp(`\\b${THIRD} can ${VERB} me\\b`),
  new RegExp(`\\b(?:u|troy) can (?:share|give out|give|send|show|pass along) ${MYINFO}`),
  new RegExp(`(?<!not |isnt |aint |never )\\b(?:ok|okay|fine|cool|good) (?:to|if u|if they|if people|with|for people to|for them to) (?:\\w+ ){0,3}(?:${MYINFO}|${VERB} me)`),
  new RegExp(`(?<!dont |never |not |stop )\\b(?:let|allow) ${THIRD} (?:to )?${VERB} me\\b`),
  /\b(?:connect|match|introduce) me (?:with|to) (?:people|anyone|others|whoever) again\b|\bconnect me again\b|\bu can (?:connect|match|introduce) me\b/,
  /\bdirect (?:contact |texts |messages )?(?:is|are)? ?(?:fine|ok|okay|good)\b|\b(?:back to|go back to|switch to|set me to|make it) direct\b/,
  new RegExp(`\\bshare ${MYINFO} again\\b`),
];

const GROUP_OFF: RegExp[] = [
  new RegExp(`\\b(?:dont|never|stop|quit) (?:add|put|throw|includ|drop|invit|stick)(?:e|ing|ting|ping)? me (?:to|in|into|on) ${G}\\b`),
  new RegExp(`\\bno (?:more )?${G}\\b`),
  new RegExp(`\\b(?:keep|leave) me out of ${G}\\b`),
  new RegExp(`\\bi (?:dont want|hate|dont like|dont do|wont join|dont wanna be in|dont want to be in) (?:to be (?:in|added to) )?${G}\\b`),
  new RegExp(`\\b(?:dont|never|stop|nobody|not)\\b.*\\b(?:or|nor|and) (?:add|put|throw|include|invite)(?:ing)? me (?:to|in|into) ${G}\\b`),
  new RegExp(`\\b(?:turn off|disable) ${G}\\b|\\bgc off\\b`),
];

const GROUP_ON: RegExp[] = [
  new RegExp(`\\bu can (?:add|put|include|invite) me (?:back )?(?:to|in|into) ${G}\\b`),
  new RegExp(`\\b${G} (?:is|are|r) (?:ok|okay|fine|cool|good)\\b`),
  new RegExp(`\\b(?:ok|okay|fine|cool) (?:with|to) (?:be (?:in|added to) |add me to |adding me to |being in )?${G}\\b`),
  new RegExp(`\\b(?:allow|enable|turn on|turn back on) ${G}\\b|\\bgc (?:back )?on\\b`),
  new RegExp(`(?<!dont |never |stop |not |or |nor |and )\\badd me (?:back )?(?:to|in|into) ${G}\\b`),
];

const any = (list: RegExp[], t: string) => list.some((re) => re.test(t));

export function keywordContact(flat: string): ContactMode | null {
  if (any(NO_CONTACT, flat)) return "no_contact";
  if (RELAY_OFF.test(flat)) return "direct";
  if (any(RELAY_ONLY, flat)) return "relay_only";
  if (any(DIRECT, flat)) return "direct";
  if (RELAY_LOOSE.test(flat)) return "relay_only";
  return null;
}

export function keywordGroupChats(flat: string): boolean | null {
  if (any(GROUP_OFF, flat)) return false;
  if (any(GROUP_ON, flat)) return true;
  return null;
}

// ---------- alert distance ----------

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90,
};
const NUM = `(\\d{1,4}|${Object.keys(NUMBER_WORDS).join("|")})`;
const MIN = "(?:min|mins|minute|minutes)";
const ALERT_WITHIN = new RegExp(`\\b(?:within|under|less than|inside|max|at most|up to|closer than|no more than|no further than|no farther than) (?:a |an |like |about |around )?${NUM} ?-?${MIN}\\b`);
const ALERT_WALK = new RegExp(`\\b${NUM} ?-?${MIN} (?:walk|away|max|or less|or closer|radius|range|distance|tops)\\b`);
const ALERT_NAMED = new RegExp(`\\balert (?:distance|radius|range)(?: to| of| is|:| at| should be)? (?:like |about )?${NUM}\\b`);
const ALERT_WORD = /\balert (?:distance|radius|range)\b/;
const ALERT_RESET = /\b(?:reset|default)\b.*\balert (?:distance|radius|range)\b|\balert (?:distance|radius|range)\b.*\b(?:reset|default)\b/;
const ALERT_CONTEXT = /\b(?:alerts?|tell|text|ping|notify|food|stuff|distance|radius|only|walk|away)\b/;

export type AlertOp = { minutes: number } | { error: "range" | "missing" };

const toNumber = (s: string) => (/^\d+$/.test(s) ? Number(s) : (NUMBER_WORDS[s] ?? NaN));

function checkedMinutes(n: number): AlertOp {
  return Number.isInteger(n) && n >= ALERT_MIN && n <= ALERT_MAX ? { minutes: n } : { error: "range" };
}

/** Alert distance asked for in the text. Out of range (below 1 or above 60) is an error, never clamped. */
export function parseAlertMinutes(text: string): AlertOp | null {
  const flat = flatten(normalize(text));
  if (ALERT_RESET.test(flat)) return { minutes: ALERT_DEFAULT };
  const m = ALERT_WITHIN.exec(flat) ?? ALERT_WALK.exec(flat) ?? ALERT_NAMED.exec(flat);
  if (m) return checkedMinutes(toNumber(m[1]!));
  return ALERT_WORD.test(flat) ? { error: "missing" } : null;
}

// ---------- quiet hours ----------

const T = "(?:midnight|noon|midday|\\d{1,2}(?::\\d{2})? ?(?:am|pm)\\b|\\d{1,2}[ap]\\b|\\d{1,2}(?::\\d{2})?(?! ?(?:min|mins|minutes?|hours?|hrs?|days?|%)\\b)(?![\\d:]))";
const QUIET_CONTEXT = /\bquiet\b|\bdont (?:text|message|ping|alert|bother|notify|send)|\bno (?:texts|messages|alerts|pings|notifications|texting)\b|\bstop (?:texting|messaging|pinging|alerting|bothering)|\b(?:do not|dont) disturb\b|\bdnd\b|\bonly (?:text|message|ping|alert|notify|bother) me\b|\bmute\b|\bsilent\b/;
const QUIET_OFF = /\b(?:turn off|disable|remove|clear|cancel|no more|stop|end|delete|drop|get rid of|kill|reset) (?:my |the |ur )?(?:quiet hours?|quiet time|dnd|(?:do not|dont) disturb)\b|\bquiet hours? (?:off|are off)\b|\bno quiet hours?\b|\b(?:text|message|ping|alert) me (?:anytime|any time|whenever|at any hour|24 7|24\/7)\b/;
const QUIET_NIGHT = /\b(?:at night|overnight|late at night|while im (?:asleep|sleeping)|when im (?:asleep|sleeping))\b/;
const QUIET_WORD = /\bquiet (?:hours?|time)\b|\b(?:do not|dont) disturb\b|\bdnd\b/;
const ONLY_ME = /\bonly (?:text|message|ping|alert|notify|bother) me\b/;
const RANGE = new RegExp(`(${T}) ?(?:to|-|until|till|til|thru|through|and) ?(${T})`);
const AFTER_BEFORE = new RegExp(`\\b(?:after|past|from) (${T}).*?\\b(?:before|until|till|til|to) (${T})`);
const BEFORE_AFTER = new RegExp(`\\b(?:before|until|till|til) (${T}).*?\\b(?:or|and) (?:after|past) (${T})`);
const AFTER = new RegExp(`\\b(?:after|past|from|starting at|starting) (${T})`);
const BEFORE = new RegExp(`\\b(?:before|until|till|til) (${T})`);

export type QuietOp = { set: QuietWindow } | { off: true } | { error: "missing" | "same" };

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * One clock time as "HH:MM". With no am or pm, a start time leans evening ("11" is 23:00, "12" is midnight)
 * and an end time leans morning ("8" is 08:00).
 */
export function parseClock(raw: string, role: "start" | "end"): string | null {
  const s = raw.trim();
  if (s === "midnight") return "00:00";
  if (s === "noon" || s === "midday") return "12:00";
  const m = /^(\d{1,2})(?::(\d{2}))? ?(am|pm|a|p)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (min > 59) return null;
  const mer = m[3]?.[0];
  if (mer) {
    if (h < 1 || h > 12) return null;
    h = mer === "a" ? h % 12 : (h % 12) + 12;
  } else if (h === 24) h = 0;
  else if (h > 24) return null;
  else if (h >= 1 && h <= 12 && role === "start") h = h === 12 ? 0 : h >= 6 ? h + 12 : h;
  return `${pad(h)}:${pad(min)}`;
}

function windowOf(start: string | null, end: string | null): QuietOp | null {
  if (!start || !end) return null;
  return start === end ? { error: "same" } : { set: { start, end } };
}

/**
 * Quiet hours asked for in the text. `bare` is for the reply to "what hours?", where "11pm to 8am"
 * on its own is enough. Otherwise the text has to be about not being texted.
 */
export function parseQuietHours(text: string, opts: { bare?: boolean } = {}): QuietOp | null {
  const flat = flatten(normalize(text));
  if (QUIET_OFF.test(flat)) return { off: true };
  if (!opts.bare && !QUIET_CONTEXT.test(flat)) return null;
  // "only text me between 9am and 10pm" names the hours that are fine, so the quiet window is the rest.
  const only = ONLY_ME.test(flat);
  const pair = AFTER_BEFORE.exec(flat) ?? RANGE.exec(flat);
  const flipped = BEFORE_AFTER.exec(flat);
  let op: QuietOp | null = null;
  if (flipped && !pair) op = windowOf(parseClock(flipped[2]!, "start"), parseClock(flipped[1]!, "end"));
  else if (pair) op = only ? windowOf(parseClock(pair[2]!, "start"), parseClock(pair[1]!, "end")) : windowOf(parseClock(pair[1]!, "start"), parseClock(pair[2]!, "end"));
  if (op) return op;
  const after = AFTER.exec(flat);
  const before = BEFORE.exec(flat);
  if (only) {
    if (after) op = windowOf("00:00", parseClock(after[1]!, "end"));
    else if (before) op = windowOf(parseClock(before[1]!, "start"), QUIET_DEFAULT_END);
  } else if (after) op = windowOf(parseClock(after[1]!, "start"), QUIET_DEFAULT_END);
  else if (before) op = windowOf("00:00", parseClock(before[1]!, "end"));
  if (op) return op;
  if (QUIET_NIGHT.test(flat)) return { set: { start: QUIET_DEFAULT_START, end: QUIET_DEFAULT_END } };
  return QUIET_WORD.test(flat) ? { error: "missing" } : null;
}

/** "23:00" as "11pm", "08:30" as "8:30am", "00:00" as "midnight". */
export function formatClock(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h === 0 && min === 0) return "midnight";
  if (h === 12 && min === 0) return "noon";
  return `${h % 12 === 0 ? 12 : h % 12}${min ? `:${pad(min)}` : ""}${h < 12 ? "am" : "pm"}`;
}

// ---------- subscriptions ----------

const TOPIC_RES: [string, RegExp][] = [
  ["free_food", /\b(?:free )?food\b|\bsnacks?\b|\bpizza\b/],
  ["free_stuff", /\bfree (?:stuff|items?|things)\b|\bgiveaways?\b|\bstuff (?:alerts?|texts|notifs?|notifications?)\b/],
  ["events", /\bevents?\b/],
  ["class_help", /\bclass(?:es)? help\b|\btutor(?:ing)?\b|\bhomework help\b|\bstudy help\b|\bhelp(?:ing)? (?:others |people )?with class(?:es)?\b|\bclass(?:es)? (?:alerts?|texts?)\b/],
];
const SUB_OFF = /\b(?:stop|no more|unsubscribe|turn off|dont (?:send|text|tell|alert|ping|notify|message|sign)|take me off|opt(?: me)? out|remove me from|cancel|mute|quit|im done with|i dont want)\b/;
const SUB_ON = /\b(?:sign me (?:back )?up|subscribe|resubscribe|turn on|turn back on|opt(?: me)? (?:back )?in|add me (?:back )?to (?:the )?(?:\w+ ){0,2}(?:alerts?|list|texts)|put me (?:back )?on|start (?:sending|texting)|(?:text|alert|ping|notify) me (?:about|when|for|if)|unmute|i want (?:the )?(?:\w+ ){0,2}alerts?)\b/;
const SUB_CONTEXT = /\b(?:alerts?|texts|notifs?|notifications?|pings?|unsubscribe|subscribe|resubscribe|sign me|opt|texting|sending|alerting|pinging|notifying|messaging|telling|take me off|remove me|mute|unmute|me about)\b/;
const SUB_ONLY = /\bonly (?:text|alert|ping|notify|tell|message) me about (.+)$/;
const SUB_ALL = /\b(?:all|every|everything|any)\b|\b(?:the|my) (?:alerts|notifications|notifs)\b/;

export type SubsOp = { add: string[]; remove: string[] };

export function parseSubscriptions(text: string): SubsOp | null {
  const t = normalize(text);
  if (!SUB_CONTEXT.test(t)) return null;
  const add = new Set<string>();
  const remove = new Set<string>();
  // "only text me about free food" keeps the topics named and drops the rest.
  const only = SUB_ONLY.exec(t);
  if (only) {
    const keep = TOPIC_RES.filter(([, re]) => re.test(only[1]!)).map(([k]) => k);
    return keep.length ? { add: keep, remove: TOPICS.filter((k) => !keep.includes(k)) } : null;
  }
  for (const clause of t.split(/\bbut\b|,|\band (?=sign|stop|sub|unsub|turn|start|no more|dont|opt|add|put)/)) {
    const off = SUB_OFF.test(clause);
    const on = !off && SUB_ON.test(clause);
    if (!off && !on) continue;
    let topics = TOPIC_RES.filter(([, re]) => re.test(clause)).map(([k]) => k);
    if (!topics.length && SUB_ALL.test(clause)) topics = [...TOPICS];
    for (const k of topics) {
      if (off) {
        remove.add(k);
        add.delete(k);
      } else {
        add.add(k);
        remove.delete(k);
      }
    }
  }
  return add.size || remove.size ? { add: [...add], remove: [...remove] } : null;
}

// ---------- usual spots ----------

export type SpotsOp = { set: string[] } | { add: string[] } | { remove: string[] } | { clear: true };

const SPOT_SET = /\b(?:im|i|ill be) (?:usually|mostly|always|normally|typically|often|generally|basically always) (?:at|in|around|near|by|study(?:ing)? (?:at|in)|hang(?:ing)?(?: out)? (?:at|in|around)) (.+)$|\bmy (?:usual )?(?:spots?|places?) (?:are|is|r|:) (.+)$|\busual spots?:? (.+)$/;
const SPOT_ADD = /\badd (.+?) to my (?:usual )?(?:spots?|places?)\b|\bi (?:live|study|work|chill|hang out|hang) (?:at|in|around|near) (.+)$/;
const SPOT_REMOVE = /\b(?:remove|take|drop|delete) (.+?) (?:from|off) my (?:usual )?(?:spots?|places?)\b/;
const SPOT_CLEAR = /\b(?:clear|reset|forget|delete|remove|wipe) (?:all )?(?:of )?my (?:usual )?(?:spots?|places?)\b/;

function spotPieces(raw: string): string[] {
  return raw
    .split(/,|\/|&|\band\b|\bor\b|\+/)
    .map((p) =>
      p
        .replace(/\b(?:mostly|usually|most days|these days|a lot|rn|lol|tbh|too|also|sometimes|or so)\b/g, " ")
        .replace(/^\s*(?:at|in|near|by|around)\s+/, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40),
    )
    .filter((p) => p.length > 1 && p.split(" ").length <= 5)
    .slice(0, MAX_SPOTS);
}

export function parseSpots(text: string): SpotsOp | null {
  const t = normalize(text);
  if (SPOT_CLEAR.test(flatten(t))) return { clear: true };
  const rm = SPOT_REMOVE.exec(t);
  if (rm) {
    const pieces = spotPieces(rm[1]!);
    return pieces.length ? { remove: pieces } : null;
  }
  const set = SPOT_SET.exec(t);
  if (set) {
    const pieces = spotPieces((set[1] ?? set[2] ?? set[3])!);
    return pieces.length ? { set: pieces } : null;
  }
  const add = SPOT_ADD.exec(t);
  if (add) {
    const pieces = spotPieces((add[1] ?? add[2])!);
    return pieces.length ? { add: pieces } : null;
  }
  return null;
}

// ---------- questions, forgetting, soft preferences ----------

export type Command = "recall" | "settings" | "forget_last" | "forget_all" | "forget_one" | "forget_me" | "forget_location" | "mute_hint";

/** "forget my location": erases only the saved location. Checked before every other "forget ...". */
const FORGET_LOCATION =
  /\b(?:forget|delete|erase|clear|remove|wipe|drop|reset) (?:my |ur |the )?(?:saved |last |last known |current )?location\b|\bforget where (?:im|i am|i was|i were)\b|\b(?:stop|dont|quit) (?:saving|keeping|storing|tracking|remembering|save|keep|store|track|remember) (?:my location|where (?:im|i am))\b/;
/** A question about the saved location, answered like one setting. */
const LOCATION_Q =
  /\b(?:do|did|does|have) (?:u|troy) (?:still )?(?:have|know|save|saved|keep|kept|store|stored|got|remember) (?:my (?:saved |last )?location|where (?:im|i am))\b|\bwhat(?:s| is)? (?:my (?:saved |last )?location|location do u have)\b|\bwhere do u (?:think|have) (?:im|i am)\b|\bis my location saved\b/;
/**
 * "i'm at leavey rn": the student saying where they are right now. Group 1 or 2 is the place.
 * "in" needs a time word ("i'm in doheny rn") so "i'm in a rush" is never read as a place.
 */
const AT_NOW =
  /^(?:hey troy |troy |btw |fyi |ok |okay |yo |hey )?(?:im|i m|currently|rn im|rn i m) (?:currently |rn |right now |still )?(?:(?:at|by|near|outside of|outside|inside|in front of|next to) (.+?)(?: (?:rn|right now|now|atm|currently|today|still))?|in (.+?) (?:rn|right now|now|atm|currently))$/;
const NOT_A_PLACE = /^(?:a|an|my|ur|this|that|it|some|peace|ease|risk|home|work|capacity|fault|all)\b/;

/** The place inside "i'm at leavey rn", or null. Text only; whether it is a campus place is checked against the database later. */
export function parseAtNow(text: string): string | null {
  const flat = flatten(normalize(text));
  const m = AT_NOW.exec(flat);
  if (!m) return null;
  const place = (m[1] ?? m[2] ?? "").replace(/^(?:the) /, "").trim();
  if (!place || place.split(" ").length > 5 || NOT_A_PLACE.test(place) || OTHER_FLOW.test(flat)) return null;
  return place.slice(0, 60);
}

const RECALL = /\bwhat (?:do|did|does|have) (?:u|troy) (?:know|remember|have|got|saved?) (?:about|on) me\b|\bwhat(?:s| is| are)? (?:in )?my (?:notes|preferences|rules)\b|\b(?:show|list|see) (?:me )?my (?:notes|rules|preferences)\b|\bwhat did i tell u\b|\bwhat do u have on me\b|\bmy notes\b/;
const SETTINGS = /\bmy settings\b|\bwhat(?:s| is| are) my (?:alert|quiet|contact|subscriptions?|alerts|spots|usual spots)\b|\bwhat am i (?:subscribed|signed up)\b|\bam i (?:on|in|set to) (?:relay|direct|no contact)\b|\b(?:are|is) my quiet hours\b|\bdo i have quiet hours\b|\bwhich alerts\b|\b(?:show|see) (?:me )?my (?:settings|profile)\b|\bcan people (?:text|message|contact) me\b|\bwho can (?:text|message|contact|see my number)\b/;
const FORGET_ME = /\bforget (?:about )?me\b|\bforget i exist\b|\bdelete my (?:account|profile|info)\b|\bforget (?:my|ur) (?:number|name|email)\b/;
const FORGET_ALL = /\bforget (?:everything|all of (?:it|that|them)|it all|all (?:that|of my notes|my notes|the notes)|all)\b|\b(?:clear|wipe|delete|erase|remove|reset) (?:all )?(?:of )?(?:my|the|ur) (?:notes|rules|preferences)\b|\b(?:clear|wipe|erase) everything\b/;
const FORGET_LAST = /\b(?:forget|undo|scratch) (?:that|it|this)(?: one| note| rule| last one)?\b|\bforget (?:the |my )?last (?:one|note|rule|thing)\b|\b(?:delete|remove|drop) (?:that|the last|my last) (?:note|rule)\b|\bforget what i (?:just )?said\b|\btake that back\b/;
const FORGET_ONE = /^(?:ok |nvm |actually |troy |hey troy )?forget (?:the |about (?:the )?|my |that )?(.+)$/;
const MUTE_HINT = /^(?:dont|never|stop) (?:text|message|ping|alert|bother|notify)(?:ing)? me(?: anymore| again| ever| at all)?$/;
const PREFERENCE = /\bfrom now on\b|\bkeep it (?:short|brief|simple)\b|\b(?:no|fewer|less|more) emojis?\b|\b(?:dont|stop|never) (?:use|send|call|say|be)\b|\bcall me [a-z]+|\bremember (?:that|i|my|im)\b|\bi (?:prefer|like it when u|hate it when u)\b|\bim (?:a )?(?:vegetarian|vegan|halal|kosher|gluten free|allergic|pescatarian|lactose)|\bi dont eat\b|\bbe (?:more|less) [a-z]+\b|\b(?:shorter|longer) (?:texts|replies|messages|bubbles)\b|\btalk (?:less|more)\b/;
/** Words that make it worth asking the model whether a privacy rule is hiding in the text. */
const CONTACT_WORDS = /\b(?:number|contact|text me|message me|dm|reach|connect|match|introduce|gc|group|relay|direct|directly|private|privacy|share|people|anyone|anybody|strangers|randoms|nobody)\b/;

const OTHER_FLOW = /\b(?:lost|found|missing|broken|leaking|leftovers?|free (?:food|pizza)|ride|lax)\b/;

export interface Parsed {
  contact: ContactMode | null;
  groupChats: boolean | null;
  alert: AlertOp | null;
  quiet: QuietOp | null;
  subs: SubsOp | null;
  spots: SpotsOp | null;
  command: Command | null;
  /** What "forget the ..." named. */
  forgetWhat?: string;
  /** The place in "i'm at leavey rn". Only set when the text is nothing else. */
  at?: string | null;
  /** Reads like a soft preference ("keep it short"). */
  preference: boolean;
}

/** Everything code can read out of one text. Nothing here touches the database. */
export function parse(text: string): Parsed {
  const t = normalize(text);
  const flat = flatten(t);
  const p: Parsed = { contact: null, groupChats: null, alert: null, quiet: null, subs: null, spots: null, command: null, preference: false };

  p.spots = parseSpots(text);
  if (FORGET_LOCATION.test(flat)) return { ...p, spots: null, command: "forget_location" };
  if (MUTE_HINT.test(flat)) p.command = "mute_hint";
  else if (FORGET_ME.test(flat)) p.command = "forget_me";
  else if (!p.spots && FORGET_ALL.test(flat)) p.command = "forget_all";
  else if (FORGET_LAST.test(flat)) p.command = "forget_last";
  else if (RECALL.test(flat)) p.command = "recall";
  else if (SETTINGS.test(flat) || LOCATION_Q.test(flat)) p.command = "settings";
  else if (!p.spots) {
    const one = FORGET_ONE.exec(flat);
    if (one) {
      p.command = "forget_one";
      p.forgetWhat = one[1]!;
    }
  }
  if (p.command && p.command !== "settings" && p.command !== "recall") return { ...p, spots: p.command === "forget_one" ? null : p.spots };

  p.contact = keywordContact(flat);
  p.groupChats = keywordGroupChats(flat);
  p.quiet = parseQuietHours(text);
  p.alert = parseAlertMinutes(text);
  // "don't text me about food after midnight" is quiet hours, not an unsubscribe.
  if (!p.quiet && !p.alert) p.subs = parseSubscriptions(text);
  p.preference = PREFERENCE.test(flat);
  if (p.command) {
    // "what are my quiet hours" is a question, not a request to set them.
    if (p.alert && "error" in p.alert) p.alert = null;
    if (p.quiet && "error" in p.quiet) p.quiet = null;
    if (hasChange(p)) p.command = null;
  }
  if (!p.command && !hasChange(p) && !p.preference) p.at = parseAtNow(text);
  return p;
}

function hasChange(p: Parsed): boolean {
  return !!(p.contact || p.groupChats !== null || p.alert || p.quiet || p.subs || p.spots);
}

/**
 * Keyword routing for this flow: an Intent when the text is clearly a rule, setting, preference or a
 * question about them, else null. For the pipeline's no-API path (see the note at the bottom of this file).
 */
export function notesIntent(text: string): Intent | null {
  const p = parse(text);
  const flat = flatten(normalize(text));
  const mk = (action: string): Intent => ({ flow: "notes", action, details: {}, source: "fallback" });
  if (p.command === "recall" || p.command === "settings") return mk("recall");
  if (p.command === "forget_last" || p.command === "forget_all" || p.command === "forget_one" || p.command === "forget_me" || p.command === "forget_location") return mk("forget");
  if (p.command === "mute_hint") return mk("add_note");
  if (p.quiet) return mk("set_quiet_hours");
  if (p.alert && ALERT_CONTEXT.test(flat)) return mk("set_alert_distance");
  if (p.contact || p.groupChats !== null || p.subs || p.spots) return mk("add_note");
  // "remember that i lost my keys" belongs to lost and found, not here.
  if (p.preference && !OTHER_FLOW.test(flat)) return mk("add_note");
  // "i'm at leavey rn" updates where walking times are measured from.
  if (p.at) return mk("add_note");
  return null;
}

// ---------- the privacy check by the model ----------

export type RuleGuess = { contact: ContactMode | null; groupChats: boolean | null };
export type RuleClassifier = (text: string) => Promise<RuleGuess | null>;

const RULE_SYSTEM = `A USC student texted Troy, a campus assistant that connects students with each other. Decide only whether the message changes these two privacy settings. Reply with JSON only:
{"contact": "direct" | "relay_only" | "no_contact" | null, "groupChats": true | false | null}

contact:
- "relay_only": they don't want other students texting them directly, or don't want their number or contact info shared. Troy passes messages along instead.
- "no_contact": they don't want to be connected with anyone at all.
- "direct": they clearly say direct contact or sharing their number is fine again.
groupChats:
- false: they don't want to be added to group chats.
- true: they clearly say group chats are fine again.

Use null when the message does not clearly ask for that change. How Troy itself texts them (quiet hours, which alerts, tone, emoji) is not a privacy setting: null.`;

const realClassifier: RuleClassifier = async (text) => {
  const out = await askJson<{ contact?: unknown; groupChats?: unknown }>({
    model: "fast",
    system: RULE_SYSTEM,
    prompt: `Message: ${JSON.stringify(text.slice(0, 500))}`,
    maxTokens: 60,
    timeoutMs: 5000,
  });
  if (!out || typeof out !== "object" || Array.isArray(out)) return null;
  const contact = out.contact === "direct" || out.contact === "relay_only" || out.contact === "no_contact" ? out.contact : null;
  const groupChats = typeof out.groupChats === "boolean" ? out.groupChats : null;
  return { contact, groupChats };
};

let classifier: RuleClassifier = realClassifier;

/** Tests only: replace the model's privacy check. Pass null to restore the real one. */
export function setRuleClassifier(fn: RuleClassifier | null): void {
  classifier = fn ?? realClassifier;
}

const RANK: Record<ContactMode, number> = { direct: 0, relay_only: 1, no_contact: 2 };

/** Of two readings, the more private one. Null means "no opinion". */
export function morePrivateContact(a: ContactMode | null, b: ContactMode | null): ContactMode | null {
  if (!a) return b;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

export function morePrivateGroupChats(a: boolean | null, b: boolean | null): boolean | null {
  if (a === null) return b;
  if (b === null) return a;
  return a && b;
}

// ---------- notes storage ----------

type Undo = { contactMode?: ContactMode; groupChatsAllowed?: 0 | 1 };
type NoteRow = { id: number; kind: "rule" | "preference"; text: string };

const ready = new WeakSet<DatabaseSync>();

/** What a rule note changed, so "forget that" can put it back. Kept out of user_notes so the model never sees it. */
function ensureTable(db: DatabaseSync): void {
  if (ready.has(db)) return;
  db.exec("CREATE TABLE IF NOT EXISTS note_effects (noteId INTEGER PRIMARY KEY, userId INTEGER NOT NULL, undo TEXT NOT NULL)");
  ready.add(db);
}

export function listNotes(db: DatabaseSync, userId: number): NoteRow[] {
  return db.prepare("SELECT id, kind, text FROM user_notes WHERE userId = ? ORDER BY id").all(userId) as NoteRow[];
}

function cleanNote(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS);
}

/** Saves the note. Returns "duplicate" for a preference they already gave, "full" at the cap. */
function addNote(db: DatabaseSync, userId: number, kind: "rule" | "preference", text: string, undo?: Undo): "saved" | "duplicate" | "full" {
  ensureTable(db);
  const clean = cleanNote(text);
  const existing = listNotes(db, userId);
  if (kind === "preference" && existing.some((n) => n.kind === kind && n.text.toLowerCase() === clean.toLowerCase())) return "duplicate";
  if (existing.length >= MAX_NOTES) return "full";
  const res = db.prepare("INSERT INTO user_notes (userId, kind, text, createdAt) VALUES (?, ?, ?, ?)").run(userId, kind, clean, Date.now());
  const id = Number(res.lastInsertRowid);
  // SQLite can hand out an old id again, so a leftover effect row must never attach to a new note.
  db.prepare("DELETE FROM note_effects WHERE noteId = ?").run(id);
  if (undo && Object.keys(undo).length) db.prepare("INSERT INTO note_effects (noteId, userId, undo) VALUES (?, ?, ?)").run(id, userId, JSON.stringify(undo));
  return "saved";
}

function effectOf(db: DatabaseSync, userId: number, noteId: number): Undo | null {
  const row = db.prepare("SELECT undo FROM note_effects WHERE noteId = ? AND userId = ?").get(noteId, userId) as { undo: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.undo) as Undo;
  } catch {
    return null;
  }
}

/**
 * Deletes one note and puts back the setting it changed. If a later note changed the same setting, the
 * current value is that later note's, so it stays, and the later note inherits what to go back to.
 */
function removeNote(db: DatabaseSync, userId: number, note: NoteRow): Undo {
  ensureTable(db);
  const undo = effectOf(db, userId, note.id) ?? {};
  const reverted: Undo = {};
  const later = (db.prepare("SELECT noteId, undo FROM note_effects WHERE userId = ? AND noteId > ? ORDER BY noteId").all(userId, note.id) as { noteId: number; undo: string }[]).map((r) => {
    let u: Undo = {};
    try {
      u = JSON.parse(r.undo) as Undo;
    } catch {
      /* a bad row has nothing to undo */
    }
    return { noteId: r.noteId, undo: u };
  });
  for (const key of ["contactMode", "groupChatsAllowed"] as const) {
    if (undo[key] === undefined) continue;
    const next = later.find((l) => l.undo[key] !== undefined);
    if (next) {
      (next.undo as Record<string, unknown>)[key] = undo[key];
      db.prepare("UPDATE note_effects SET undo = ? WHERE noteId = ?").run(JSON.stringify(next.undo), next.noteId);
    } else {
      updateUser(db, userId, { [key]: undo[key]! });
      (reverted as Record<string, unknown>)[key] = undo[key];
    }
  }
  db.prepare("DELETE FROM note_effects WHERE noteId = ?").run(note.id);
  db.prepare("DELETE FROM user_notes WHERE id = ? AND userId = ?").run(note.id, userId);
  return reverted;
}

function clearNotes(db: DatabaseSync, userId: number): void {
  ensureTable(db);
  db.prepare("DELETE FROM note_effects WHERE userId = ?").run(userId);
  db.prepare("DELETE FROM user_notes WHERE userId = ?").run(userId);
}

// ---------- lines built in code ----------

const CONTACT_LINE: Record<ContactMode, string> = {
  direct: "people i connect u with can text u directly",
  relay_only: "relay only. i pass messages along and nobody gets ur number",
  no_contact: "no contact. i don't connect u with anyone",
};

const RELAY_OFFER = "got it. want me to relay their requests to u instead? they won't get ur number.";
const ASK_QUIET = "what hours should i stay quiet? like 11pm to 8am";
const ASK_ALERT = `how many min away is too far? anything from ${ALERT_MIN} to ${ALERT_MAX}`;

/** RELAY_OFFER when a "got it" bubble was already sent just before it. */
const RELAY_OFFER_BARE = RELAY_OFFER.replace(/^got it\. /, "");

/** How a confirmation opens. The setting it confirms follows, exactly as CONTACT_LINE or the line itself has it. */
const PRE = { done: "done. ", gotIt: "got it. ", ok: "ok. ", and: "and ", unchanged: "ur settings didn't change. contact: " };

const SAY = {
  whatNeed: "ok. what do u need?",
  nothingToChange: "ok, nothing to change",
  nothingChanged: "ok, nothing changed",
  keptAll: "ok, kept everything",
  groupBackOn: "group chats are back on. i'll still ask before adding u to one",
  noGroupChats: "got it. i won't add u to group chats",
  andNoGroupChats: "and i won't add u to group chats",
  handoffRelay: "if a handoff comes up i'll pass messages along instead",
  stillText: 'u can still text me for anything. say "connect me again" to undo',
  noRelays: ["ok, no relays. i won't connect u with anyone", 'say "relay only" if u change ur mind'],
  stillRelay: "ok. ur still on relay only, nobody gets ur number",
  relayOn: "bet. i'll pass their messages along and they won't get ur number",
  checkDirect: "just checking. u want people to be able to text u directly again? reply yes or no",
  checkRelay: "just checking. u want me to start relaying messages to u again? reply yes or no",
  checkGroup: "just checking. ok to add u to group chats again? reply yes or no",
  notesCleared: "done. ur notes are cleared",
  sameTime: "those are the same time. try something like 11pm to 8am",
  alertRange: `it has to be between ${ALERT_MIN} and ${ALERT_MAX} min. what should i set?`,
  alertRangeTry: `alert distance has to be between ${ALERT_MIN} and ${ALERT_MAX} min. try "within 10 min"`,
  quietOff: "quiet hours are off. i'll text u whenever something comes up",
  stillAnswer: "i'll still answer whenever u text me",
  noAlertsNow: "done. ur not getting any alerts now. u can still text me anytime",
  noAlertsSame: "that's already how it's set. ur not getting any alerts now. u can still text me anytime",
  alertsPaused: "heads up, ur alerts are paused. text resume to turn them back on",
  spotsCleared: "cleared ur usual spots",
  noLocation: "i don't have a location saved for u",
  forgotLocation: "done. i forgot ur location",
  walkFromSpots: "walking times will go off ur usual spots until u share again",
  noWalkTimes: "i won't show walking times until u share again or tell me where u are",
  noNotesToClear: "i don't have any notes on u, so there's nothing to clear",
  finishFirst: 'let\'s finish what we were doing first. then say "forget everything" again',
  replyYesClear: "reply yes to clear them",
  nothingToForget: "nothing to forget. i don't have any notes on u",
  forgetHow: 'not sure what to forget. say "forget that" for the last note, or "forget everything"',
  noSuchNote: ["couldn't find a note like that", 'say "what do u know about me" to see them, or "forget that" to drop the last one'],
  unknownSpot: ["i don't know that spot, so i didn't save it", 'try a campus spot, like "i\'m at leavey rn"'],
  useForWalking: 'i\'ll use that for walking times. say "forget my location" anytime',
  remembered: "got it. i'll remember that",
  alreadyGot: "already got that one",
  notesFull: 'ur notes are full. say "forget that" to drop the last one first',
  notSureWhat: ["not sure what to change there", 'try "no texts after midnight", "only food within 5 min" or "what do u know about me"'],
  howQuiet: 'for quiet hours say it like "quiet 11pm to 8am"',
  howAlert: 'for alert distance say it like "only food within 5 min"',
  howLoosen: 'nothing changed. to open things back up say it plainly, like "people can text me directly"',
  tellInWords: 'tell me in words what to change, like "no texts after midnight"',
};

/** Lines with a value in them (minutes, hours, a list). Code puts the value in; these only hold the words around it. */
const NT = {
  alertSet: (minutes: string) => `done. i'll only text u about stuff within a ${minutes} min walk`,
  quietSet: (start: string, end: string) => `done. no alerts from ${start} to ${end}`,
  alertsNow: (list: string) => `done. ur alerts now: ${list}`,
  alertsSame: (list: string) => `that's already how it's set. ur alerts now: ${list}`,
  spotsSaved: (list: string) => `saved. usual spots: ${list}`,
  forgot: (note: string) => `done. forgot ${note}`,
  clearsAll: (count: string) => `that clears all ${count} of ur notes. ur contact settings stay how they are`,
  atPlace: (place: string) => `got it, ur at ${place}`,
};

// ---------- wording variants (facts locked, wording varied) ----------
//
// Variant 0 of every pool is the line the code writes; the rest say the same thing with the same values.
// What each contact setting means is said three ways (CONTACT_SAYS), and each way states the same rule: who can
// text the student, and that nobody gets their number.
// NOT in any pool, so always word for word:
// - the read-backs ("here's what i have", "contact: ...", "alerts: ...", "location: ...", "notes: ..."): they are
//   a list of the student's own settings, label and value, and read the same every time.
// - the two hints that spell out exact commands ("text STOP", 'text "delete my data"').
const CONTACT_SAYS: Record<ContactMode, readonly string[]> = {
  direct: [CONTACT_LINE.direct, "anyone i connect u with can text u directly", "the people i connect u with can text u directly"],
  relay_only: [CONTACT_LINE.relay_only, "relay only. i pass messages along, and no one gets ur number", "relay only. messages go through me and nobody gets ur number"],
  no_contact: [CONTACT_LINE.no_contact, "no contact. i won't connect u with anyone", "no contact. i'm not connecting u with anyone"],
};
const MODES: ContactMode[] = ["direct", "relay_only", "no_contact"];
/** One pool per contact setting for a confirmation that opens a given way ("done. ", "got it. ", ...). */
const contactPools = (name: string, openers: readonly string[]): Pools =>
  Object.fromEntries(MODES.map((m) => [`${name}_${m}`, CONTACT_SAYS[m].map((line, i) => `${openers[i]}${line}`)]));

export const NOTES_POOLS: Pools = {
  // contact and group chat settings
  ...contactPools("contactDone", [PRE.done, "ok, done. ", "all set. "]),
  ...contactPools("contactGotIt", [PRE.gotIt, "ok. ", "noted. "]),
  ...contactPools("contactUnchanged", [PRE.unchanged, "ur settings are the same. contact: ", "nothing changed in ur settings. contact: "]),
  relayOffer: [
    RELAY_OFFER,
    "got it. should i relay their requests to u instead? they won't get ur number.",
    "got it. i can relay their requests to u instead, and they won't get ur number. want that?",
  ],
  relayOfferBare: [
    RELAY_OFFER_BARE,
    "should i relay their requests to u instead? they won't get ur number.",
    "i can relay their requests to u instead, and they won't get ur number. want that?",
  ],
  noRelays: [
    SAY.noRelays,
    ["ok, no relays. i'm not connecting u with anyone", 'if u change ur mind, say "relay only"'],
    ["ok, no relays either. i won't connect u with anyone", 'u can say "relay only" if u change ur mind'],
  ],
  stillRelay: [SAY.stillRelay, "ok. u stay on relay only, nobody gets ur number", "ok, ur still on relay only. nobody gets ur number"],
  relayOn: [SAY.relayOn, "bet. i'll pass their messages to u and they won't get ur number", "ok. i'll pass their messages along, and they won't get ur number"],
  stillText: [SAY.stillText, 'u can still text me for anything. to undo it, say "connect me again"', 'u can text me for anything still. say "connect me again" to undo'],
  noGroupChats: [SAY.noGroupChats, "got it. no group chats for u", "ok. i won't add u to group chats"],
  andNoGroupChats: [SAY.andNoGroupChats, "and no group chats for u", "and i won't put u in group chats"],
  handoffRelay: [SAY.handoffRelay, "if a handoff comes up, i'll pass messages along instead", "for a handoff i'll pass messages along instead"],
  groupBackDone: [`${PRE.done}${SAY.groupBackOn}`, "done. group chats are on again. i'll still ask before adding u to one", "ok, done. group chats are back on, and i'll still ask before adding u to one"],
  groupBackOk: [`${PRE.ok}${SAY.groupBackOn}`, "ok. group chats are on again. i'll still ask before adding u to one", "ok, group chats are back on. i'll still ask before adding u to one"],
  groupBackAnd: [`${PRE.and}${SAY.groupBackOn}`, "and group chats are on again. i'll still ask before adding u to one", "and group chats are back on too. i'll still ask before adding u to one"],
  checkDirect: [
    SAY.checkDirect,
    "just checking. should people be able to text u directly again? reply yes or no",
    "just making sure. u want people to be able to text u directly again? reply yes or no",
  ],
  checkRelay: [
    SAY.checkRelay,
    "just checking. should i start relaying messages to u again? reply yes or no",
    "just making sure. u want me to start relaying messages to u again? reply yes or no",
  ],
  checkGroup: [
    SAY.checkGroup,
    "just checking. is it ok to add u to group chats again? reply yes or no",
    "just making sure. ok to add u to group chats again? reply yes or no",
  ],
  howLoosen: [
    SAY.howLoosen,
    'nothing changed. to open things back up, say it plainly, like "people can text me directly"',
    'nothing changed. if u want to open things back up, say it plainly, like "people can text me directly"',
  ],

  // quiet hours and alert distance
  askQuiet: [ASK_QUIET, "what hours do u want me quiet? like 11pm to 8am", "which hours should i stay quiet? like 11pm to 8am"],
  askAlert: [ASK_ALERT, `how many min away is too far for u? anything from ${ALERT_MIN} to ${ALERT_MAX}`, `how far is too far, in min? anything from ${ALERT_MIN} to ${ALERT_MAX}`],
  sameTime: [SAY.sameTime, "those two are the same time. try something like 11pm to 8am", "that's the same time twice. try something like 11pm to 8am"],
  alertRange: [SAY.alertRange, `it's gotta be between ${ALERT_MIN} and ${ALERT_MAX} min. what should i set?`, `needs to be between ${ALERT_MIN} and ${ALERT_MAX} min. what should i set?`],
  alertRangeTry: [
    SAY.alertRangeTry,
    `alert distance needs to be between ${ALERT_MIN} and ${ALERT_MAX} min. try "within 10 min"`,
    `alert distance can be anything between ${ALERT_MIN} and ${ALERT_MAX} min. try "within 10 min"`,
  ],
  alertSet: (minutes) => [NT.alertSet(minutes), `done. u'll only hear about stuff within a ${minutes} min walk`, `ok, done. i'll only text u about stuff within a ${minutes} min walk`],
  quietOff: [SAY.quietOff, "quiet hours are off now. i'll text u whenever something comes up", "ok, quiet hours are off. i'll text u whenever something comes up"],
  quietSet: (start, end) => [NT.quietSet(start, end), `done. i'll hold alerts from ${start} to ${end}`, `ok, done. no alerts from ${start} to ${end}`],
  stillAnswer: [SAY.stillAnswer, "i'll still answer anytime u text me", "if u text me i'll still answer"],
  howQuiet: [SAY.howQuiet, 'for quiet hours, say something like "quiet 11pm to 8am"', 'to set quiet hours say it like "quiet 11pm to 8am"'],
  howAlert: [SAY.howAlert, 'for alert distance, say something like "only food within 5 min"', 'to set alert distance say it like "only food within 5 min"'],

  // alerts and spots
  alertsNow: (list) => [NT.alertsNow(list), `ok, done. ur alerts now: ${list}`, `done. ur alerts are now: ${list}`],
  alertsSame: (list) => [NT.alertsSame(list), `it's already set that way. ur alerts now: ${list}`, `that's how it's set already. ur alerts now: ${list}`],
  noAlertsNow: [SAY.noAlertsNow, "done. no alerts for u now. u can still text me anytime", "ok, done. ur not getting any alerts now, but u can still text me anytime"],
  noAlertsSame: [
    SAY.noAlertsSame,
    "it's already set that way. ur not getting any alerts now. u can still text me anytime",
    "that's how it's set already. ur not getting any alerts now, but u can still text me anytime",
  ],
  alertsPaused: [SAY.alertsPaused, "heads up, ur alerts are paused rn. text resume to turn them back on", "one thing, ur alerts are paused. text resume to turn them back on"],
  spotsSaved: (list) => [NT.spotsSaved(list), `saved. ur usual spots: ${list}`, `got it, saved. usual spots: ${list}`],
  spotsCleared: [SAY.spotsCleared, "ur usual spots are cleared", "ok, cleared ur usual spots"],

  // location
  atPlace: (place) => [NT.atPlace(place), `ok, ur at ${place}`, `got it. ur at ${place}`],
  useForWalking: [SAY.useForWalking, 'i\'ll use it for walking times. say "forget my location" anytime', 'walking times will use that. say "forget my location" anytime'],
  unknownSpot: [
    SAY.unknownSpot,
    ["i don't know that spot, so it's not saved", 'try a campus spot, something like "i\'m at leavey rn"'],
    ["that spot's not one i know, so i didn't save it", 'a campus spot works, like "i\'m at leavey rn"'],
  ],
  noLocation: [SAY.noLocation, "i don't have a location saved for u rn", "there's no location saved for u"],
  forgotLocation: [SAY.forgotLocation, "done. ur location's forgotten", "ok, done. i forgot ur location"],
  walkFromSpots: [SAY.walkFromSpots, "walking times will use ur usual spots until u share again", "until u share again, walking times go off ur usual spots"],
  noWalkTimes: [SAY.noWalkTimes, "i can't show walking times until u share again or tell me where u are", "no walking times until u share again or tell me where u are"],

  // notes
  remembered: [SAY.remembered, "got it. i'll remember", "noted. i'll remember that"],
  alreadyGot: [SAY.alreadyGot, "i already have that one", "got that one already"],
  notesFull: [SAY.notesFull, 'ur notes are full. to make room, say "forget that" to drop the last one first', 'ur notes are full rn. say "forget that" to drop the last one first'],
  forgot: (note) => [NT.forgot(note), `ok, done. forgot ${note}`, `done. i forgot ${note}`],
  clearsAll: (count) => [
    NT.clearsAll(count),
    `that clears all ${count} of ur notes. ur contact settings stay the way they are`,
    `that wipes all ${count} of ur notes. ur contact settings stay how they are`,
  ],
  replyYesClear: [SAY.replyYesClear, "reply yes and i'll clear them", "reply yes if u want them cleared"],
  notesCleared: [SAY.notesCleared, "done. ur notes are all cleared", "ok, done. ur notes are cleared"],
  keptAll: [SAY.keptAll, "ok, i kept everything", "ok, everything's still there"],
  noNotesToClear: [SAY.noNotesToClear, "i don't have any notes on u, so nothing to clear", "there's nothing to clear. i don't have any notes on u"],
  nothingToForget: [SAY.nothingToForget, "nothing to forget, i don't have any notes on u", "there's nothing to forget. i don't have any notes on u"],
  noSuchNote: [
    SAY.noSuchNote,
    ["i couldn't find a note like that", 'say "what do u know about me" to see them all, or "forget that" to drop the last one'],
    ["couldn't find a note like that one", 'u can say "what do u know about me" to see them, or "forget that" to drop the last one'],
  ],
  finishFirst: [
    SAY.finishFirst,
    'let\'s finish what we were doing first, then say "forget everything" again',
    'let\'s wrap up what we were doing first. then say "forget everything" again',
  ],

  // small replies
  whatNeed: [SAY.whatNeed, "ok, what do u need?", "ok. what's up?"],
  nothingToChange: [SAY.nothingToChange, "ok, there's nothing to change", "ok, nothing needs changing"],
  nothingChanged: [SAY.nothingChanged, "ok, i didn't change anything", "ok, left it how it was"],
  notSureWhat: [
    SAY.notSureWhat,
    ["not sure what u want changed there", 'try something like "no texts after midnight", "only food within 5 min" or "what do u know about me"'],
    ["i'm not sure what to change there", 'u can try "no texts after midnight", "only food within 5 min" or "what do u know about me"'],
  ],
  tellInWords: [SAY.tellInWords, 'tell me in words what u want changed, like "no texts after midnight"', 'i need it in words. tell me what to change, like "no texts after midnight"'],
};

export const NOTES_VOICE: Voice = makeVoice("notes", NOTES_POOLS);

/** A followed topic in plain words: the poll text without its emoji for the built-in ones, a created topic's own name otherwise. Never a raw key. */
function topicWords(key: string): string {
  if (SUBSCRIPTION_LABELS[key]) return SUBSCRIPTION_LABELS[key]!;
  const builtIn = BUILT_IN_TOPICS.find((t) => t.key === key);
  const text = builtIn ? builtIn.label.replace(/[^\p{L}\p{N}\s'-]/gu, "") : key.replace(/[_-]+/g, " ");
  return text.replace(/\s+/g, " ").trim();
}
const topicList = (subs: string[]) => subs.map(topicWords).join(", ");
const quietLine = (u: User) => (u.quietHours ? `${formatClock(u.quietHours.start)} to ${formatClock(u.quietHours.end)}` : "off");

function settingsBubbles(u: User): string[] {
  const out = [
    `contact: ${CONTACT_LINE[u.contactMode]}. group chats: ${u.groupChatsAllowed ? "ok" : "off"}`,
    `alerts: ${u.paused ? "paused" : "on"}. topics: ${topicList(u.subscriptions) || "none"}. within a ${u.alertMinutes} min walk. quiet hours: ${quietLine(u)}`,
  ];
  if (u.usualSpots.length) out.push(`usual spots: ${u.usualSpots.map((s) => s.toLowerCase()).join(", ")}`);
  return out;
}

/**
 * Whether a location is saved and how old it is. A place name only, never coordinates:
 * the nearest campus place within 150 m, else "a spot off campus". Only ever said to the student it belongs to.
 */
function locationLine(db: DatabaseSync, u: User): string {
  const loc = describeSavedLocation(db, u.id, clock());
  if (!loc) return "location: none saved";
  const how = loc.source === "asked" ? "u told me" : "u shared it";
  return `location: ${loc.place}. ${how} ${loc.age}. say "forget my location" to erase it`;
}

function recallBubbles(db: DatabaseSync, u: User): string[] {
  const out: string[] = [];
  const who = [u.name ? `ur ${u.name.toLowerCase()}` : "", u.uscEmail ? `usc email ${u.uscEmail.toLowerCase()}` : ""].filter(Boolean).join(", ");
  out.push(who ? `here's what i have. ${who}` : "here's what i have");
  out.push(...settingsBubbles(u));
  out.push(locationLine(db, u));
  const notes = listNotes(db, u.id);
  if (!notes.length) out.push('no notes yet. tell me stuff like "keep it short" and i\'ll remember it');
  else {
    const shown = notes.slice(-5);
    const more = notes.length - shown.length;
    out.push(`notes: ${shown.map((n, i) => `${i + 1}. ${quote(n.text)}`).join(" ")}${more > 0 ? ` and ${more} older` : ""}`);
    out.push('say "forget that" to drop the last one');
  }
  return out;
}

/** One line for a question about one setting, or null for the whole list. */
function oneSetting(db: DatabaseSync, flat: string, u: User): string | null {
  if (LOCATION_Q.test(flat)) return locationLine(db, u);
  if (/\bquiet\b/.test(flat)) return u.quietHours ? `quiet hours: ${quietLine(u)}` : "quiet hours are off";
  if (/\balert (?:distance|radius|range)\b/.test(flat)) return `alert distance: a ${u.alertMinutes} min walk`;
  if (/\bsubscri|signed up|which alerts|my alerts\b/.test(flat)) return u.subscriptions.length ? `ur alerts: ${topicList(u.subscriptions)}${u.paused ? ". they're paused rn" : ""}` : "ur not signed up for any alerts";
  if (/\bspots\b/.test(flat)) return u.usualSpots.length ? `usual spots: ${u.usualSpots.map((s) => s.toLowerCase()).join(", ")}` : "no usual spots saved";
  if (/\bcontact\b|\brelay\b|\bdirect\b|\bcan people\b|\bwho can\b/.test(flat)) return `contact: ${CONTACT_LINE[u.contactMode]}. group chats: ${u.groupChatsAllowed ? "ok" : "off"}`;
  return null;
}

// ---------- conversation steps ----------

const YES = /^(?:y|yes|yea|yeah|yep|yup|ya|sure|ok|okay|k|kk|bet|do it|go ahead|go for it|sounds good|for sure|fs|mhm|that works|works|perfect|cool|confirm|absolutely|def|definitely|yes pls|pls do|please do)\b/;
const NO = /^(?:n|no|nah|nope|naw|no thanks|no thx|not really|dont|im good|pass)\b/;
const CANCEL = /^(?:nvm|never ?mind|cancel|stop|forget it|actually no|actually nvm|wait no|wait nvm)\b/;

type Step = "relay_offer" | "confirm_forget_all" | "confirm_loosen" | "ask_quiet" | "ask_alert";

function setStep(ctx: FlowContext, step: Step, data: Record<string, unknown> = {}): void {
  ctx.setState({ flow: "notes", step, data });
}

const fresh = (ctx: FlowContext): User => getUserById(ctx.db, ctx.user.id) ?? ctx.user;

/** A question needs an open step, and a user has one open step. Never take over another flow's conversation. */
const canAsk = (ctx: FlowContext): boolean => !ctx.state || ctx.state.flow === "notes";

/** The message isn't an answer to our question. Close the step and give the text to whoever should have it. */
async function passAlong(ctx: FlowContext, text: string): Promise<void> {
  ctx.setState(null);
  const p = parse(text);
  const next: FlowContext = { ...ctx, state: null };
  if (hasChange(p) || p.command || p.preference) return handleRequest(next, text);
  const aiNote = ctx.intent.flow === "notes" && ctx.intent.source === "ai" && ctx.intent.action !== "answer";
  if (aiNote) return handleRequest(next, text);
  // Loaded here, not at the top: the registry imports this file.
  const { getFlow } = await import("./index.ts");
  const other = ctx.intent.flow !== "notes" ? getFlow(ctx.intent.flow) : null;
  // Another flow speaks in its own words, so it gets the plain context back.
  if (other) return other.handle(unvoiced(next));
  const smalltalk = getFlow("smalltalk");
  if (smalltalk) return smalltalk.handle({ ...unvoiced(next), intent: { flow: "smalltalk", action: "chat", details: {}, source: ctx.intent.source } });
  await ctx.say(SAY.whatNeed);
}

async function applyLoosen(ctx: FlowContext, data: Record<string, unknown>): Promise<void> {
  const before = fresh(ctx);
  const fields: Record<string, string | number> = {};
  const undo: Undo = {};
  const contact = data.contact as ContactMode | undefined;
  if (contact && contact in RANK && contact !== before.contactMode) {
    fields.contactMode = contact;
    undo.contactMode = before.contactMode;
  }
  if (data.groupChats === true && !before.groupChatsAllowed) {
    fields.groupChatsAllowed = 1;
    undo.groupChatsAllowed = 0;
  }
  ctx.setState(null);
  if (!Object.keys(fields).length) {
    await ctx.say(SAY.nothingToChange);
    return;
  }
  updateUser(ctx.db, before.id, fields);
  addNote(ctx.db, before.id, "rule", String(data.text ?? ""), undo);
  const after = fresh(ctx);
  const out: string[] = [];
  if (fields.contactMode) out.push(`${PRE.done}${CONTACT_LINE[after.contactMode]}`);
  if (fields.groupChatsAllowed) out.push(`${out.length ? PRE.and : PRE.done}${SAY.groupBackOn}`);
  await ctx.say(...out);
}

/** Returns true when the open step used this event. */
async function handleStep(ctx: FlowContext, state: FlowState, text: string): Promise<boolean> {
  const flat = flatten(normalize(text));
  const r = ctx.event.reaction;
  // "no emoji" or "stop the food alerts" is a new request, not an answer to the question.
  const p = parse(text);
  const request = hasChange(p) || p.preference || !!p.at || (!!p.command && !/^forget it\b/.test(flat));
  let yes = !request && YES.test(flat);
  let no = !request && NO.test(flat);
  if (r) {
    // A tapback only answers when it's on the bubble that asked.
    if (r.removed || !state.data.askId || r.targetMessageId !== state.data.askId) return true;
    yes = r.type === "like" || r.type === "love" || r.type === "emphasize";
    no = r.type === "dislike";
    if (!yes && !no) return true;
  } else if (ctx.event.pollVote) return true;
  const cancel = !r && !request && CANCEL.test(flat);

  switch (state.step as Step) {
    case "relay_offer": {
      // The rule is already saved as relay only. This only settles what happens with their requests.
      if (!r && !yes && !no && !cancel) return false;
      ctx.setState(null);
      if (cancel && /^(?:forget it)\b/.test(flat)) return false;
      if (no) {
        if (fresh(ctx).contactMode === "relay_only") updateUser(ctx.db, ctx.user.id, { contactMode: "no_contact" });
        await ctx.say(...SAY.noRelays);
      } else if (cancel) await ctx.say(SAY.stillRelay);
      else await ctx.say(SAY.relayOn);
      return true;
    }
    case "confirm_forget_all": {
      if (!yes && !no && !cancel) return false;
      ctx.setState(null);
      if (yes && !cancel) {
        clearNotes(ctx.db, ctx.user.id);
        const u = fresh(ctx);
        await ctx.say(SAY.notesCleared, `${PRE.unchanged}${CONTACT_LINE[u.contactMode]}`);
      } else await ctx.say(SAY.keptAll);
      return true;
    }
    case "confirm_loosen": {
      if (!yes && !no && !cancel) return false;
      if (yes && !cancel) await applyLoosen(ctx, state.data);
      else {
        ctx.setState(null);
        await ctx.say(SAY.nothingChanged);
      }
      return true;
    }
    case "ask_quiet": {
      if (r) return true;
      if (cancel || no) {
        ctx.setState(null);
        await ctx.say(SAY.nothingChanged);
        return true;
      }
      const op = parseQuietHours(text, { bare: true });
      if (!op || "error" in op) {
        if (op && "error" in op && op.error === "same") {
          await ctx.say(SAY.sameTime);
          return true;
        }
        return false;
      }
      ctx.setState(null);
      await ctx.say(...applyQuiet(ctx, op));
      return true;
    }
    case "ask_alert": {
      if (r) return true;
      if (cancel || no) {
        ctx.setState(null);
        await ctx.say(SAY.nothingChanged);
        return true;
      }
      const m = new RegExp(`^(?:like |about |around |within |maybe )?${NUM}(?: ?${MIN})?(?: walk)?$`).exec(flat);
      const op = m ? checkedMinutes(toNumber(m[1]!)) : parseAlertMinutes(text);
      if (!op || ("error" in op && op.error === "missing")) return false;
      if ("error" in op) {
        await ctx.say(SAY.alertRange);
        return true;
      }
      ctx.setState(null);
      await ctx.say(...applyAlert(ctx, op));
      return true;
    }
    default:
      return false;
  }
}

// ---------- applying changes ----------

function applyAlert(ctx: FlowContext, op: AlertOp): string[] {
  if ("error" in op) return [SAY.alertRangeTry];
  updateUser(ctx.db, ctx.user.id, { alertMinutes: op.minutes });
  return [NT.alertSet(String(op.minutes))];
}

function applyQuiet(ctx: FlowContext, op: QuietOp): string[] {
  if ("error" in op) return [SAY.sameTime];
  if ("off" in op) {
    updateUser(ctx.db, ctx.user.id, { quietHours: null });
    return [SAY.quietOff];
  }
  updateUser(ctx.db, ctx.user.id, { quietHours: JSON.stringify({ start: op.set.start, end: op.set.end }) });
  return [NT.quietSet(formatClock(op.set.start), formatClock(op.set.end)), SAY.stillAnswer];
}

function applySubs(ctx: FlowContext, op: SubsOp): string[] {
  const u = fresh(ctx);
  const set = new Set(u.subscriptions);
  for (const k of op.remove) set.delete(k);
  for (const k of op.add) set.add(k);
  const known = TOPICS.filter((k) => set.has(k));
  const next = [...known, ...[...set].filter((k) => !(TOPICS as readonly string[]).includes(k))];
  const same = next.length === u.subscriptions.length && next.every((k) => u.subscriptions.includes(k));
  if (!same) updateUser(ctx.db, u.id, { subscriptions: JSON.stringify(next) });
  const out = [next.length ? (same ? NT.alertsSame(topicList(next)) : NT.alertsNow(topicList(next))) : same ? SAY.noAlertsSame : SAY.noAlertsNow];
  if (op.add.length && u.paused) out.push(SAY.alertsPaused);
  return out;
}

function applySpots(ctx: FlowContext, op: SpotsOp): string[] {
  const u = fresh(ctx);
  const key = (s: string) => s.toLowerCase().replace(/^the /, "").trim();
  let next = u.usualSpots;
  if ("clear" in op) next = [];
  else if ("set" in op) next = op.set;
  else if ("add" in op) next = [...u.usualSpots, ...op.add.filter((s) => !u.usualSpots.some((x) => key(x) === key(s)))];
  else next = u.usualSpots.filter((x) => !op.remove.some((s) => key(x) === key(s) || key(x).includes(key(s))));
  next = next.slice(0, MAX_SPOTS);
  updateUser(ctx.db, u.id, { usualSpots: JSON.stringify(next) });
  return [next.length ? NT.spotsSaved(next.map((s) => s.toLowerCase()).join(", ")) : SAY.spotsCleared];
}

async function forgetNote(ctx: FlowContext, note: NoteRow): Promise<void> {
  const reverted = removeNote(ctx.db, ctx.user.id, note);
  const u = fresh(ctx);
  const out = [NT.forgot(quote(note.text))];
  const back: string[] = [];
  if (reverted.contactMode !== undefined) back.push(`contact is back to: ${CONTACT_LINE[u.contactMode]}`);
  if (reverted.groupChatsAllowed !== undefined) back.push(`group chats: ${u.groupChatsAllowed ? "ok again" : "off again"}`);
  if (back.length) out.push(back.join(". "));
  await ctx.say(...out);
}

const STOP_WORDS = new Set(["that", "this", "thing", "note", "rule", "stuff", "about", "what", "said", "told", "from", "with", "part", "just", "like", "your", "have", "want", "dont", "when"]);

function findNote(notes: NoteRow[], what: string): NoteRow | null {
  const words = flatten(normalize(what)).split(" ").filter((w) => w.length >= 4 && !STOP_WORDS.has(w)).map((w) => w.replace(/s$/, ""));
  if (!words.length) return null;
  let best: { note: NoteRow; hits: number } | null = null;
  for (const note of notes) {
    const hay = flatten(normalize(note.text));
    const hits = words.filter((w) => hay.includes(w)).length;
    if (hits && (!best || hits >= best.hits)) best = { note, hits };
  }
  return best?.note ?? null;
}

async function handleCommand(ctx: FlowContext, p: Parsed, text: string): Promise<void> {
  const u = fresh(ctx);
  const notes = listNotes(ctx.db, u.id);
  switch (p.command) {
    case "mute_hint":
      await ctx.say("to mute alerts text pause. to stop every text from me text STOP", 'or give me hours, like "no texts after midnight"');
      return;
    case "forget_location": {
      const had = describeSavedLocation(ctx.db, u.id, clock());
      forgetUserLocation(ctx.db, u.id);
      if (!had) await ctx.say(SAY.noLocation);
      else if (u.usualSpots.length) await ctx.say(SAY.forgotLocation, SAY.walkFromSpots);
      else await ctx.say(SAY.forgotLocation, SAY.noWalkTimes);
      return;
    }
    case "forget_me":
      await ctx.say('to wipe everything i have on u, text "delete my data"', 'to drop just the last note, say "forget that"');
      return;
    case "forget_all": {
      if (!notes.length) {
        await ctx.say(SAY.noNotesToClear);
        return;
      }
      if (!canAsk(ctx)) {
        await ctx.say(SAY.finishFirst);
        return;
      }
      const ids = await ctx.say(NT.clearsAll(String(notes.length)), SAY.replyYesClear);
      setStep(ctx, "confirm_forget_all", { askId: ids[ids.length - 1] ?? null });
      return;
    }
    case "forget_last": {
      const last = notes[notes.length - 1];
      if (!last) await ctx.say(SAY.nothingToForget);
      else await forgetNote(ctx, last);
      return;
    }
    case "forget_one": {
      const note = findNote(notes, p.forgetWhat ?? "");
      if (note) await forgetNote(ctx, note);
      else if (!notes.length) await ctx.say(SAY.nothingToForget);
      else await ctx.say(...SAY.noSuchNote);
      return;
    }
    case "settings": {
      const one = oneSetting(ctx.db, flatten(normalize(text)), u);
      await ctx.say(...(one ? [one] : settingsBubbles(u)));
      return;
    }
    default:
      await ctx.say(...recallBubbles(ctx.db, u));
  }
}

/** "i'm at leavey rn": matched to campus_places and saved as the student's location (source "asked"). */
async function handleAtNow(ctx: FlowContext, where: string): Promise<void> {
  const place = findPlace(ctx.db, where);
  if (!place) {
    await ctx.say(...SAY.unknownSpot);
  } else {
    saveUserLocation(ctx.db, ctx.user.id, { lat: place.lat, lng: place.lng }, "asked", clock());
    await ctx.say(NT.atPlace(place.name.toLowerCase()), SAY.useForWalking);
  }
  if (ctx.state?.flow === "notes") ctx.setState(null);
}

async function handleRequest(ctx: FlowContext, text: string): Promise<void> {
  const p = parse(text);
  const flat = flatten(normalize(text));
  const action = ctx.intent.flow === "notes" ? ctx.intent.action : "";

  if (p.command) return handleCommand(ctx, p, text);
  if (p.at) return handleAtNow(ctx, p.at);
  if (!hasChange(p) && !p.preference) {
    if (action === "recall") return handleCommand(ctx, { ...p, command: "recall" }, text);
    // A "forget" label from the model alone deletes nothing and puts no setting back: forgetting a note can undo a
    // contact rule, and that only happens on the student's own words ("forget that"), read by parse() above.
    if (action === "forget") {
      await ctx.say(SAY.forgetHow);
      if (ctx.state?.flow === "notes") ctx.setState(null);
      return;
    }
  }

  // The model double-checks privacy only when keywords saw a rule or the text could be hiding one.
  const profileOnly = !!(p.alert || p.quiet || p.subs || p.spots) && !p.contact && p.groupChats === null;
  let guess: RuleGuess | null = null;
  if (!profileOnly && (p.contact || p.groupChats !== null || CONTACT_WORDS.test(flat))) {
    try {
      guess = await classifier(text);
    } catch {
      guess = null;
    }
  }

  const before = fresh(ctx);
  const contact = morePrivateContact(p.contact, guess?.contact ?? null);
  const group = morePrivateGroupChats(p.groupChats, guess?.groupChats ?? null);
  const fields: Record<string, string | number> = {};
  const undo: Undo = {};
  const pending: Record<string, unknown> = {};
  let touched = false;

  if (contact) {
    touched = true;
    const loosens = RANK[contact] < RANK[before.contactMode];
    // The model on its own never loosens a privacy setting. The student confirms first.
    if (loosens && !p.contact) pending.contact = contact;
    else if (contact !== before.contactMode) {
      fields.contactMode = contact;
      undo.contactMode = before.contactMode;
    }
  }
  if (group !== null) {
    touched = true;
    if (group && !before.groupChatsAllowed && p.groupChats === null) pending.groupChats = true;
    else if (group !== before.groupChatsAllowed) {
      fields.groupChatsAllowed = group ? 1 : 0;
      undo.groupChatsAllowed = before.groupChatsAllowed ? 1 : 0;
    }
  }

  const bubbles: string[] = [];
  /** The one bubble that asks something. Always sent last, and its id is kept for tapback answers. */
  let question: { text: string; step: Step; data?: Record<string, unknown> } | null = null;
  const asking = canAsk(ctx);

  if (Object.keys(fields).length) {
    updateUser(ctx.db, before.id, fields);
    addNote(ctx.db, before.id, "rule", text, undo);
    const after = fresh(ctx);
    const groupOff = fields.groupChatsAllowed === 0;
    const groupOn = fields.groupChatsAllowed === 1;
    if (fields.contactMode === "relay_only" && before.contactMode === "direct" && asking) {
      if (groupOff) bubbles.push(SAY.noGroupChats);
      question = { text: groupOff ? RELAY_OFFER_BARE : RELAY_OFFER, step: "relay_offer" };
    } else if (fields.contactMode) {
      bubbles.push(`${PRE.gotIt}${CONTACT_LINE[after.contactMode]}`);
      if (fields.contactMode === "no_contact") bubbles.push(SAY.stillText);
      if (groupOff) bubbles.push(SAY.andNoGroupChats);
    } else if (groupOff) bubbles.push(SAY.noGroupChats, SAY.handoffRelay);
    if (groupOn) bubbles.push(`${fields.contactMode ? PRE.and : PRE.ok}${SAY.groupBackOn}`);
  } else if (touched && !Object.keys(pending).length) {
    bubbles.push(`that's already how i have it. contact: ${CONTACT_LINE[before.contactMode]}. group chats: ${before.groupChatsAllowed ? "ok" : "off"}`);
  }

  if (p.alert) {
    if ("error" in p.alert && p.alert.error === "missing") question = { text: ASK_ALERT, step: "ask_alert" };
    else bubbles.push(...applyAlert(ctx, p.alert));
  }
  if (p.quiet) {
    if ("error" in p.quiet && p.quiet.error === "missing") question = { text: ASK_QUIET, step: "ask_quiet" };
    else bubbles.push(...applyQuiet(ctx, p.quiet));
  }
  if (p.subs) bubbles.push(...applySubs(ctx, p.subs));
  if (p.spots) bubbles.push(...applySpots(ctx, p.spots));

  if (!touched && !hasChange(p)) {
    if (action === "set_quiet_hours") question = { text: ASK_QUIET, step: "ask_quiet" };
    else if (action === "set_alert_distance") question = { text: ASK_ALERT, step: "ask_alert" };
    else if (p.preference || action === "add_note") {
      const saved = addNote(ctx.db, before.id, "preference", text);
      bubbles.push(saved === "saved" ? SAY.remembered : saved === "duplicate" ? SAY.alreadyGot : SAY.notesFull);
    } else {
      bubbles.push(...SAY.notSureWhat);
    }
  }

  if (Object.keys(pending).length) {
    const q =
      pending.contact === "direct"
        ? SAY.checkDirect
        : pending.contact === "relay_only"
          ? SAY.checkRelay
          : SAY.checkGroup;
    question = { text: q, step: "confirm_loosen", data: { ...pending, text: cleanNote(text) } };
  }

  if (question && !asking) {
    // Another flow's conversation is open, so say how to ask instead of opening a step of our own.
    bubbles.push(
      question.step === "ask_quiet"
        ? SAY.howQuiet
        : question.step === "ask_alert"
          ? SAY.howAlert
          : SAY.howLoosen,
    );
    question = null;
  }

  const all = [...bubbles.slice(0, 4), ...(question ? [question.text] : [])];
  const ids = await ctx.say(...all);
  if (question) setStep(ctx, question.step, { ...(question.data ?? {}), askId: ids[ids.length - 1] ?? null });
  else if (ctx.state?.flow === "notes") ctx.setState(null);
}

export const notes: FlowHandler = {
  name: "notes",
  async handle(plain) {
    // Everything this flow says goes out through NOTES_VOICE: facts as written, wording from the pools.
    const ctx = NOTES_VOICE.wrap(plain);
    ensureTable(ctx.db);
    const state = ctx.state?.flow === "notes" ? ctx.state : null;
    const tap = !!(ctx.event.reaction || ctx.event.pollVote);
    if (tap && !state) return;
    const text = (ctx.event.text ?? "").trim();
    if (state) {
      if (await handleStep(ctx, state, text)) return;
      if (tap) return;
      await passAlong(ctx, text);
      return;
    }
    if (!text) {
      await ctx.say(SAY.tellInWords);
      return;
    }
    await handleRequest(ctx, text);
  },
};

// Routing note for the integrator: the keyword fallback in src/ai.ts only sends a few of these phrases to
// this flow. notesIntent(text) covers the rest ("don't share my number", "stop the food alerts",
// "i'm usually at leavey"). Call it wherever the fallback intent is built, before the other keyword rules.
