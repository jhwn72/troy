// Onboarding, stored in flow_state (flow "onboarding").
// Steps: who -> email (-> email_confirm) -> code -> alerts (-> topic) -> location -> done (state cleared).
//
// Emails are read forgivingly (John's live conversation, Nov 14 7pm): a near miss ("johnwang usc edu", a bare
// "johnwang" while he is waiting for the email, a fragment of the address they used before) gets the did-u-mean
// line with the address built in code, and no code is sent until they confirm it. Any unexpired code he sent to
// the same address verifies, not only the newest one.
//
// Code owns the facts, the checks and the actions: the @usc.edu rule, the code match, attempt limits, which
// topics exist and who follows them, what is saved. Wording varies everywhere (John, "Delivery is Troy's,
// everywhere"): the lines he dictated (the welcome, the save-contact line, the quick check, the student and judge
// replies, the location ask) are the reference, and each has a few hand-written versions that cover the same
// points, rotated per person, so two students see different wording. They are pools, not model calls, so the
// first seconds of a new chat stay fast. Word for word everywhere: the STOP line and the did-u-mean line.
//
// Each step knows what it is waiting for. A message that is that thing is handled here exactly. Anything else
// (a question, "can we start over", small talk) goes to the chat brain with the open step and the real actions
// that fit it; the brain answers like a person and names an action, and this file performs it.
//
// A choice can arrive three ways: a vote on a native poll, a tapback on an option bubble, or typed words.

import { normalizeHandle } from "./config.ts";
import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import type { FlowContext, IncomingEvent, User } from "./types.ts";
import { getFlowState, getSetting, getUserById, saveMessage, setSetting, updateUser } from "./db/index.ts";
import { TEMPLATES } from "./commands.ts";
import { sendVerificationEmail } from "./email.ts";
import type { EmailSendResult } from "./email.ts";
import { fallbackIntent, modelReady } from "./ai.ts";
import { askedWhatHeDoes, askedWhoHeIs, replyAtStep, sayInHisWords } from "./brain.ts";
import { fallbackReply } from "./flows/smalltalk.ts";
import { afterOnboarding } from "./firstten.ts";
import { judgeIntro } from "./judge.ts";
import { locationOptedOut, noteLocationRequestedByUser } from "./location.ts";
import { pickVariant } from "./voice.ts";
import { readYesNo } from "./yes.ts";
import { BUILT_IN_TOPICS, createTopic, findTopic, judgeTopic, listTopics, saveTopicRequest, subscribe, topicsFor, unsubscribe } from "./topics.ts";

const FLOW = "onboarding" as const;

export const CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
/** Stops someone using Troy to spam an inbox. */
const MAX_CODES_PER_HOUR = 5;

// ---------- John's reference lines (the first version in each pool below) ----------

/** Sent as the poll's question: the provider puts it in the chat as a normal text right above the poll. */
export const QUICK_CHECK = "quick check, are u a usc student or a hackathon judge? (pls be honest)";
export const JUDGE_OPTIONS = ["usc student", "hackathon judge"];
export const STUDENT_LINE = "great, what's ur usc email?";
export const JUDGE_LINE = "thanks for checking me out. i'll go ahead and skip verification for u";
export const LOCATION_ASK = "btw, i work best when i know where u are. here's how to share ur location with me (takes 10 seconds, turn it off anytime) 👇";
export const didYouMean = (email: string): string => `did u mean "${email}"? if so i'll send the code now`;
// The request has no bubble in the chat: it shows up inside the Find My app, under People, with no notification.
const LOCATION_REQUESTED = "i sent u a location request. open find my, then people, and accept it";
export const SOMETHING_ELSE = "something else";

/** Always the same words, in every version of the welcome. */
const STOP_LINE = TEMPLATES.welcome[3]!;

/**
 * The dictated lines and their other versions. Each version covers the same points; index 0 is John's own.
 * Welcome: he's troy, he's an ai, he knows a guy for everything, send a photo of anything on campus or just text
 * it, then the STOP line. Location ask: he works best knowing where they are, the GIF below shows how, it takes
 * 10 seconds, and they can turn it off anytime.
 */
export const REFERENCE_LINES = {
  welcome: [
    [...TEMPLATES.welcome],
    ["hey, troy here", "i'm an ai, but i know a guy for pretty much everything", 'send me a pic of anything on campus and i\'ll get it to the right person. or just text it, like "lost my airpods at leavey"', STOP_LINE],
    ["yo, i'm troy", "i'm an ai. whatever it is on campus, i know a guy for it", 'text me a photo of anything on campus and i\'ll get it to whoever handles it. or just say it, like "lost my airpods at leavey"', STOP_LINE],
  ],
  save_contact: [[TEMPLATES.saveContact], ["save my contact if u haven't yet, so u know it's me next time"], ["if u haven't saved my contact yet, do that so u know it's me"]],
  quick_check: [[QUICK_CHECK], ["one quick thing, are u a usc student or a hackathon judge? (be honest pls)"], ["real quick, which one are u: a usc student or a hackathon judge? (honest answers only pls)"]],
  student: [[STUDENT_LINE], ["nice, what's ur usc email?"], ["cool, what's ur usc email?"]],
  judge: [[JUDGE_LINE], ["thanks for checking me out. i'll skip the verification for u"], ["appreciate u checking me out. u can skip verification, i got u"]],
  location_ask: [
    [LOCATION_ASK],
    ["btw, i'm way more useful when i know where u are. here's how to share ur location with me (takes 10 seconds, turn it off anytime) 👇"],
    ["one more thing, i work best when i know where u are. this shows how to share ur location with me (takes 10 seconds, and u can turn it off anytime) 👇"],
  ],
} as const;

export type ReferenceKey = keyof typeof REFERENCE_LINES;

// ---------- variant pools (no-model wording). "|" splits one reply into bubbles. ----------

const POOLS = {
  ask_email_again: ["no prob, what's the right usc email?", "all good. which usc email should i use?", "sure, send me the usc email u want me to use"],
  // Only for something that looks like an attempted email.
  email_hint: ["close, but i need the whole thing. it ends in @usc.edu", "almost. ur usc email ends in @usc.edu", "that one's missing a piece. it should end in @usc.edu"],
  email_not_usc: ["that's not a usc email. i need the one that ends in @usc.edu", "has to be ur usc one, it ends in @usc.edu", "that's a different school or inbox. i need the one ending in @usc.edu"],
  code_limit: ["that's a lot of codes. give it an hour and try again", "i've sent a bunch of codes already. try again in an hour", "gotta slow down on codes for a bit. try again in an hour"],
  code_sent: [
    "sent a 6 digit code to {email}|text it back to me. might be in spam since i'm new 👀",
    "just emailed a 6 digit code to {email}|send it back here when u get it. check spam too, i'm new 👀",
    "a 6 digit code is on its way to {email}|text it to me when it lands. peek at spam if u don't see it 👀",
  ],
  code_hint: ["it's the 6 digits from the email, nothing else", 'i need all 6 digits from the email. reply "resend" if u want a new one', 'that\'s not 6 digits. check the email again, or reply "resend" for a new code'],
  code_wrong: ["that's not the code. {left} left", "hm, that doesn't match what i sent. {left} left", "not that one. u have {left} left"],
  // More than one code is out for this address. Never says how many emails went out.
  code_wrong_recent: [
    "that's not it. go with the code in the most recent email. {left} left",
    "hm, that doesn't match. use the code from the newest email i sent. {left} left",
    "not that one. the code in the most recent email is the safe bet. u have {left} left",
  ],
  code_out: ['that\'s not the code and ur out of tries. reply "resend" for a new one', 'still not it, and that was the last try on this code. reply "resend" and i\'ll send another'],
  code_locked: ['too many wrong tries on that code. reply "resend" for a new one', 'that code is used up after too many misses. reply "resend" and i\'ll send a fresh one'],
  code_expired: ['that code expired. reply "resend" and i\'ll send a new one', 'that one timed out. reply "resend" for a fresh code'],
  verified: ["ur verified. welcome in", "that's the one. ur verified", "verified. welcome in"],
  alerts_question: ["what do u want me to text u about?", "what should i text u about?", "which of these do u want texts about?", "pick what u want me to hit u up about"],
  alerts_many: ["u can pick more than one", "pick as many as u want", "take as many as u like"],
  alerts_none: ["no alerts for now. u can always tell me later", "all good, no alerts. just tell me if that changes", "none for now then. say the word whenever u want some"],
  late_one: ["got that one too", "added that one", "got it, that one's on now"],
  late_many: ["got those too", "added those", "got them, those are on now"],
  late_off_one: ["took that one off", "ok, that one's off", "dropped that one"],
  late_off_many: ["took those off", "ok, those are off", "dropped those"],
  late_other: ["tell me what u have in mind whenever ur ready", "whenever ur free, tell me what u'd want texts about", "got it. just tell me what u have in mind when u get a sec"],
  topic_ask: ["what do u have in mind?", "ooh, what are u thinking?", "what would u want texts about?", "what's the thing? tell me"],
  topic_never_mind: ["all good", "no worries", "ok, moving on"],
  topic_no: ["sorry, can't help with that one", "that one's a no from me, sorry", "sorry, that's not one i can set up"],
  location_plain: ["btw, i work best when i know where u are", "one more thing, i work best when i know where u are"],
  location_by_hand: ["tap the + in this chat, then location, then share", "hit the + next to the text box, then location, then share"],
  location_kept: [
    'i keep the last spot u share so alerts and walking times stay accurate. text "forget my location" anytime and i\'ll erase it',
    'i only hold on to the last spot u share, so alerts and walking times are right. text "forget my location" and it\'s gone',
    'the last spot u share stays with me so alerts and walking times fit. text "forget my location" anytime to erase it',
  ],
  // The alternative is offered as something positive. The word "skip" is never suggested.
  location_alt: [
    'not ready to share? just tell me where u usually are, like "leavey and the village"',
    'rather not share rn? tell me where u usually hang out, like "leavey and the village"',
    'if sharing isn\'t ur thing yet, just tell me ur usual spots, like "leavey and the village"',
  ],
  // After a topic they brought up in the middle of the location ask: the ask is still open, said once and lightly.
  location_back: [
    "and whenever ur ready, share ur location or tell me where u usually are",
    "the location share is still open whenever u want. or just tell me ur usual spots",
    "last thing still stands: share ur location, or tell me the spots ur usually at",
  ],
  location_saved: ["got it, thx", "got it, that helps a lot", "perfect, got ur spot"],
  location_live: ["got it, i can see where u are now", "there it is, i can see u now", "perfect, ur location came through"],
  location_spots: ["saved ur usual spots", "got it, i'll go off those spots", "noted, those are ur spots now"],
  location_declined: ["no worries, i'll just ask where u are when it matters", "all good. i'll ask when it actually matters", "that's fine, i'll check with u when it comes up"],
  location_waiting: [
    'i\'m not seeing it yet. it can take a min after u accept, so text "done" again in a sec|or tap the + in this chat, then location, then share. u can also just tell me where u usually are',
    'nothing on my end yet. give it a min after u accept, then text "done" again|the + in this chat, then location, then share works too. or tell me ur usual spots',
  ],
  location_why: [
    'it\'s so alerts and walking times fit where u actually are. i only keep the last spot u share, and "forget my location" erases it',
    'so i only ping u about stuff that\'s actually near u, with real walking times. just the last spot u share, and "forget my location" wipes it',
  ],
  verify_why: [
    "i'm only for usc students, so i send a code to ur usc email to make sure it's really urs. that's all i use it for",
    "it's how i know ur actually a trojan. a code goes to ur usc email and u text it back, that's the whole check",
  ],
  // When the chat brain can't be reached, or answers with nothing.
  start_over: ["no prob, from the top", "sure, let's run it back", "all good, starting fresh"],
  nudge_who: ["first i just need to know which one u are, a usc student or a hackathon judge", "happy to get into it. first, are u a usc student or a hackathon judge?"],
  nudge_email: ["i'm with u. i just need ur usc email first, the one ending in @usc.edu", "one sec on that. what's ur usc email? it ends in @usc.edu"],
  nudge_email_confirm: ["just need a yes or no on that email first", "is that email right? a yes or no works"],
  nudge_code: ['i just need the 6 digit code from that email first. reply "resend" if it never showed up', 'one thing first, the 6 digits i emailed u. reply "resend" if u need a new one'],
  nudge_alerts: ["happy to get into that. first, which of those do u want texts about?", "i got u. pick what u want texts about first, or tell me u don't want any"],
  nudge_topic: ["what would u want texts about? anything goes", "tell me the thing u'd want texts about, in ur own words"],
  nudge_location: ["no rush on that. share ur location or tell me where u usually are, whichever is easier", "all good. a location share or ur usual spots both work for me"],
} as const;

type PoolKey = keyof typeof POOLS;

/** One line from a pool, rotated per person, split into bubbles, with {values} filled in by code. */
function vary(ctx: Pick<FlowContext, "db" | "user">, key: PoolKey, values: Record<string, string> = {}): string[] {
  let line = pickVariant(ctx.db, ctx.user.id, `onb:${key}`, [...POOLS[key]]);
  for (const [k, v] of Object.entries(values)) line = line.replaceAll(`{${k}}`, v);
  return line.split("|").map((b) => b.trim()).filter(Boolean);
}

// ---------- what other modules lend onboarding ----------

export type StepSpec = { flow: string; waitingFor: string; canDo: { name: string; when: string }[]; facts?: Record<string, string> };
export type Brief = { goal: string; mustCover: string[]; facts?: Record<string, string>; fallback: string[][] };
type YesNoInput = { event: IncomingEvent; questionMessageId: string | null; allowTapback?: boolean };

/**
 * Everything onboarding calls outside this file. Tests replace any of them with setOnboardingDeps.
 * replyAtStep and sayInHisWords are src/brain.ts, readYesNo is src/yes.ts, afterOnboarding is src/firstten.ts.
 */
export type OnboardingDeps = {
  replyAtStep(ctx: FlowContext, step: StepSpec): Promise<{ bubbles: string[]; action: string | null }>;
  sayInHisWords(ctx: FlowContext, brief: Brief): Promise<string[]>;
  readYesNo(input: YesNoInput): "yes" | "no" | null;
  afterOnboarding(ctx: FlowContext): Promise<void>;
  judgeTopic(text: string): Promise<"ok" | "unsure" | "no">;
  sendEmail(to: string, code: string): Promise<EmailSendResult>;
  pause(ms: number): Promise<void>;
  /** Which version of a dictated line this person gets. Default: rotated per person. Tests pin it to John's own. */
  pickLine(ctx: Pick<FlowContext, "db" | "user">, key: ReferenceKey): string[];
  /** The beat after the contact card, on top of the pipeline's own gap and typing time. */
  cardBeatMs: number;
  /** How long Troy waits for more votes before answering a burst of them. */
  settleMs: number;
  /** The how-to GIF for sharing a location. Missing file: the Find My request is the fallback. */
  gifPath: string;
};

const underTest = !!process.env.NODE_TEST_CONTEXT;
let overrides: Partial<OnboardingDeps> = {};

/** Test hook: replace any dependency. Pass null to go back to the real ones. */
export function setOnboardingDeps(next: Partial<OnboardingDeps> | null): void {
  overrides = next ?? {};
}

async function deps(): Promise<OnboardingDeps> {
  return {
    replyAtStep,
    sayInHisWords,
    readYesNo,
    afterOnboarding,
    judgeTopic,
    sendEmail: sendVerificationEmail,
    pause: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    pickLine: (ctx, key) => {
      const pool = REFERENCE_LINES[key];
      return [...pool[Number(pickVariant(ctx.db, ctx.user.id, `onb:ref:${key}`, pool.map((_, i) => String(i))))]!];
    },
    cardBeatMs: underTest ? 0 : 1500,
    settleMs: 4000,
    gifPath: fileURLToPath(new URL("../bluebubbles/gif/share-location.gif", import.meta.url)),
    ...overrides,
  };
}

/** A brief's own fallback, rotated per person. What sayInHisWords does when there is no model. */
function rotate(ctx: Pick<FlowContext, "db" | "user">, brief: Brief): string[] {
  const picked = pickVariant(ctx.db, ctx.user.id, `onb:say:${brief.goal.slice(0, 40)}`, brief.fallback.map((b) => b.join("\u0001")));
  return picked.split("\u0001").filter(Boolean);
}

/** sayInHisWords, but a throw or an empty answer still gives the brief's fallback. */
async function inHisWords(ctx: FlowContext, brief: Brief): Promise<string[]> {
  try {
    const out = await (await deps()).sayInHisWords(ctx, brief);
    if (Array.isArray(out) && out.some((b) => typeof b === "string" && b.trim())) return out.filter((b) => typeof b === "string" && b.trim());
  } catch {
    // The fallback below still goes out.
  }
  return rotate(ctx, brief);
}

/** What the pipeline lends onboarding: saving a location goes through src/location.ts. */
export type OnboardingExtras = { saveLocation?: (userId: number, loc: { lat: number; lng: number }) => Promise<void> };

type PollRef = { pollId: string | null; optionIds: (string | null)[]; mode: "native" | "tap" | "numbered" };
/** The alerts poll as it is kept after onboarding: which topic each option stands for (-1 is "something else"). */
type AlertPoll = PollRef & { topicIds: number[] };
type Data = Record<string, unknown>;

function word(text: string): string {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}
const plainWords = (text: string): string => word((text ?? "").replace(/[‘’'`]/g, ""));
const looksLikeQuestion = (text: string): boolean => /\?/.test(text) || /^(?:why|what|whats|how|who|when|where|is|are|do|does|can|could|will|would|wait|which)\b/.test(plainWords(text));

// ---------- reading an email ----------

export type EmailRead = { kind: "ok" | "typo" | "not_usc"; email: string } | { kind: "attempt" } | null;

/** What "usc.edu" looks like after a slip, letters only: "usc,edu", "usc.eud", "uscedu", "usc.com", "usc". */
const USC_SLIPS = new Set(["uscedu", "usceud", "uscued", "uscdeu", "usced", "uscedi", "uscedy", "uscedv", "uscdu", "usceu", "usceduu", "usccom", "uscorg", "uscnet", "uscco", "usc"]);
const LOCAL_PART = /^[a-z0-9][a-z0-9._%+-]{0,63}$/;
/** Words in front of an address that are not part of it ("my email is ..."). */
const PROSE = new Set("its it is my email mine sure ok okay yeah yes yep here heres hi hey this use try and or to send at for with the usc address".split(" "));

/**
 * The email in a message, read forgivingly:
 * - "ok": a usc address. Case, spaces around it and a trailing period are fixed without a word.
 * - "typo": almost certainly a usc address with a slip in it; `email` is the fixed one, to be confirmed first.
 * - "not_usc": a real address somewhere else. "attempt": they tried to type an email but it can't be read.
 * - null: not an email at all (a question, "can we start over"). The caller never answers that with a format hint.
 */
export function readEmail(text: string): EmailRead {
  const t = (text ?? "").toLowerCase().replace(/[‘’'"`<>()]/g, "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const exact = t.match(/([a-z0-9][a-z0-9._%+-]*)@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/);
  if (exact) {
    const [, local, domain] = exact as unknown as [string, string, string];
    if (domain === "usc.edu") {
      // "tommy trojan@usc.edu": a space in the middle of the name.
      const tokens = t.replace(/[.!?,]+$/, "").split(" ");
      const lead = tokens.length === 2 && tokens[1] === `${local}@${domain}` ? tokens[0]! : "";
      if (lead && !PROSE.has(lead) && LOCAL_PART.test(lead + local)) return { kind: "typo", email: `${lead}${local}@usc.edu` };
      return { kind: "ok", email: `${local}@usc.edu` };
    }
    if (USC_SLIPS.has(domain.replace(/[^a-z0-9]/g, ""))) return { kind: "typo", email: `${local}@usc.edu` };
    return { kind: "not_usc", email: `${local}@${domain}` };
  }
  if (t.includes("@")) {
    // "name @usc.edu", "name@ usc.edu", "name@usc,edu", "name@uscedu", "name@usc. edu"
    const loose = t.match(/([a-z0-9][a-z0-9._%+-]*) ?@ ?([a-z0-9][a-z0-9., -]*)$/);
    if (loose && LOCAL_PART.test(loose[1]!)) {
      const letters = loose[2]!.replace(/[^a-z0-9]/g, "");
      if (USC_SLIPS.has(letters)) return { kind: "typo", email: `${loose[1]}@usc.edu` };
    }
    return { kind: "attempt" };
  }
  // No "@" at all, but plainly an address: "ttrojan usc.edu", "ttrojan usc edu", "ttrojan at usc dot edu".
  // The address is built here and confirmed first, like any other slip.
  if (!looksLikeQuestion(t) && t.split(" ").length <= 7) {
    const spoken = t.replace(/[.!?,]+$/, "").match(/^(.*?) ?\b(?:at )?usc(?: ?[.,] ?| dot | )edu$/);
    const head = spoken ? spoken[1]!.split(" ").filter(Boolean) : [];
    const last = head[head.length - 1] ?? "";
    const lead = head.slice(0, -1);
    if (localPart(last)) {
      if (lead.every((w) => PROSE.has(w))) return { kind: "typo", email: `${last}@usc.edu` };
      // "tommy trojan usc edu": a space in the middle of the name.
      const two = lead[lead.length - 1]! + last;
      if (lead.slice(0, -1).every((w) => PROSE.has(w)) && /^[a-z]+$/.test(lead[lead.length - 1]!) && localPart(two)) return { kind: "typo", email: `${two}@usc.edu` };
    }
  }
  if (t.split(" ").length <= 6 && /\busc ?(?:[.,]|dot) ?edu\b|\b[a-z0-9._-]+ at usc\b/.test(t) && !looksLikeQuestion(t)) return { kind: "attempt" };
  return null;
}

/**
 * Words people text that are never the front half of an email. A bare word is only offered back as
 * "<word>@usc.edu" when it is not one of these (and not a yes or a no).
 */
const CHAT_WORDS = new Set(
  (
    "ok okay kk yes yess yep yup yeah yea ya sure bet no nah nope idk dunno what whats why how who when where which huh wait help skip judge student " +
    "hey hello hii heyy sup yoo thanks thank thx pls please sorry lol lmao haha hahaha omg wtf bruh bro dude man hmm hmmm umm uhh " +
    "resend again retry stop start restart cancel quit exit back next later maybe never nvm nevermind nothing none done cool nice good great fine bad " +
    "true false test testing email gmail mail usc troy trojan code codes spam inbox this that here there mine same other another different wrong right " +
    "really seriously whatever anything something everything forgot unsure confused lost found broken info more menu continue understood gotcha word alright"
  ).split(" "),
);

/**
 * The text as the front half of an email, or null: only letters, digits, dots, underscores and hyphens, 3 to 30
 * characters, starting with a letter or digit and carrying at least one letter, and not a common chat word.
 */
export function localPart(text: string): string | null {
  const raw = (text ?? "").trim();
  if (!raw || raw.includes("?")) return null;
  const t = raw.toLowerCase().replace(/[‘’'"`<>()]/g, "").replace(/[.!,]+$/, "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(t) || !/[a-z]/.test(t) || /[._-]{2}/.test(t)) return null;
  if (CHAT_WORDS.has(t) || PROSE.has(t)) return null;
  return t;
}

/**
 * The usc address a message without one most likely means, built in code and always confirmed before use.
 * A bare word that reads as the front half of an email gives "<word>@usc.edu". When they gave a usc address
 * earlier in this onboarding (`previous`), that address again if the message is its front half or a piece of it.
 */
export function suggestEmail(text: string, previous: string | null = null): string | null {
  const prev = previous && previous.endsWith("@usc.edu") ? previous : null;
  const prevLocal = prev ? prev.split("@")[0]! : "";
  const local = localPart(text);
  if (local) return prev && prevLocal.includes(local) ? prev : `${local}@usc.edu`;
  if (!prev || (text ?? "").includes("?")) return null;
  // "john wang" after john.wang@usc.edu: the same name with the punctuation typed differently.
  const squeeze = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
  const words = (text ?? "").trim().split(/\s+/);
  return words.length <= 3 && squeeze(text).length >= 3 && squeeze(text) === squeeze(prevLocal) ? prev : null;
}

/** "tommy.trojan" becomes "Tommy Trojan". Anything that doesn't look like first.last gives null. */
export function guessName(email: string): string | null {
  const m = email.split("@")[0].match(/^([a-z]{2,})[._-]([a-z]{2,})$/);
  if (!m) return null;
  return [m[1], m[2]].map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
}

// ---------- polls ----------

/**
 * Sends a poll and remembers its ids. Native: every option id is the poll's own id and a vote arrives as
 * event.pollVote. Tap: one bubble per option. Numbered: a list, answered in text. The provider sends the
 * question itself (as a text above a native poll, or as the first line of the list).
 */
async function sendPoll(ctx: FlowContext, question: string, options: string[]): Promise<PollRef> {
  const chatId = ctx.event.chatId;
  const none = { optionMessageIds: options.map(() => null as string | null), mode: "numbered" as const };
  const poll = await ctx.adapter.sendPoll(chatId, question, options).catch(() => none);
  const save = (providerMessageId: string | null, text: string) => saveMessage(ctx.db, { userId: ctx.user.id, chatId, direction: "out", providerMessageId, text });
  if (poll.mode === "native") {
    const pollId = poll.optionMessageIds.find((id) => !!id) ?? null;
    save(pollId, `[poll] ${question}: ${options.join(" / ")}`);
    return { pollId, optionIds: poll.optionMessageIds, mode: "native" };
  }
  save(null, question);
  options.forEach((text, i) => save(poll.optionMessageIds[i] ?? null, text));
  return { pollId: null, optionIds: poll.optionMessageIds, mode: poll.mode };
}

/**
 * Which option of a poll this event picks, or -1. `positive` is false for a removed vote or a negative tapback.
 * A vote or tapback aimed at a different poll or bubble is -1. `strict`: a native vote must name this exact poll
 * (used once onboarding is over, when other polls can be open in the same chat).
 */
function pollChoice(event: IncomingEvent, ref: PollRef | null | undefined, strict = false): { index: number; positive: boolean } {
  if (!ref) return { index: -1, positive: false };
  if (event.pollVote) {
    const voted = event.pollVote.pollMessageId;
    const ours = strict ? !!ref.pollId && voted === ref.pollId : !ref.pollId || !voted || voted === ref.pollId;
    const i = event.pollVote.optionIndex;
    // The shared event type has no "removed" field yet. When a provider adds one, a taken-back vote is dropped.
    const removed = (event.pollVote as { removed?: unknown }).removed === true;
    return { index: ours && Number.isInteger(i) && i >= 0 && i < ref.optionIds.length ? i : -1, positive: !removed };
  }
  if (event.reaction && ref.mode !== "native") {
    const r = event.reaction;
    return { index: ref.optionIds.indexOf(r.targetMessageId), positive: !r.removed && (r.type === "love" || r.type === "like" || r.type === "emphasize") };
  }
  return { index: -1, positive: false };
}

// ---------- the chat brain at a step ----------

type Step = "who" | "email" | "email_confirm" | "code" | "alerts" | "topic" | "location";

const CAN = {
  start_over: { name: "start_over", when: "they want to start over from the top" },
  back: { name: "back_to_student_or_judge", when: "they picked the wrong one, say they are a judge or a student after all, or want to go back to that question" },
  why: { name: "why_do_u_ask", when: "they ask why troy needs this or what he does with it. the answer goes in bubbles, from the facts (code says nothing for this one, so bubbles can't be empty)" },
  resend: { name: "resend_code", when: "they want the code sent again to the same address, or say it never arrived" },
  change_email: { name: "change_email", when: "they want to use a different email, or say the address is wrong" },
  skip: { name: "skip_optional_step", when: "they don't want to do this step, or want to move on. it is optional, never push" },
  topic: { name: "suggest_topic", when: "they name something they want texts about that isn't in the poll" },
  go_on: { name: "continue", when: "anything else: answer what they said, and the step stays open" },
};

function stepSpec(step: Step, data: Data, db: DatabaseSync): StepSpec {
  const verifyWhy = "troy is only for usc students. a 6 digit code goes to the usc email to check the address is really theirs. hackathon judges skip this for the demo";
  switch (step) {
    case "who":
      return { flow: FLOW, waitingFor: "whether ur a usc student or a hackathon judge", canDo: [CAN.why, CAN.start_over, CAN.go_on], facts: { why: verifyWhy, how: "they can tap the poll or just say which one" } };
    case "email": {
      const failed = data.failed as { email?: string } | undefined;
      return {
        flow: FLOW,
        waitingFor: "ur usc email, the one ending in @usc.edu",
        canDo: [...(failed?.email ? [{ name: "resend_code", when: "they want troy to try sending the code again to the same address as before" }] : []), CAN.back, CAN.start_over, CAN.why, CAN.go_on],
        facts: { why: verifyWhy, ...(failed?.email ? { note: "the last code email did not go out. never ask them to type the same email again" } : {}) },
      };
    }
    case "email_confirm":
      return { flow: FLOW, waitingFor: `a yes or no on whether "${String(data.suggested ?? "")}" is ur email`, canDo: [CAN.change_email, CAN.back, CAN.start_over, CAN.why, CAN.go_on], facts: { why: verifyWhy } };
    case "code":
      return {
        flow: FLOW,
        waitingFor: "the 6 digit code i emailed u",
        canDo: [CAN.resend, CAN.change_email, CAN.back, CAN.start_over, CAN.why, CAN.go_on],
        facts: { email: String(data.email ?? ""), why: verifyWhy, tip: "the email can land in spam. the code works for 15 minutes" },
      };
    case "alerts":
      return {
        flow: FLOW,
        waitingFor: "which texts u want, if any",
        canDo: [CAN.topic, CAN.skip, CAN.go_on],
        facts: { "he can text them": listTopics(db).filter((t) => t.builtIn).map((t) => t.plain).join("; "), how: "they can vote in the poll, more than one is fine, or just say it. this step is optional", later: "they can add or drop alerts any time" },
      };
    case "topic":
      return { flow: FLOW, waitingFor: "what u'd want texts about", canDo: [CAN.topic, CAN.skip, CAN.go_on] };
    case "location":
      return {
        flow: FLOW,
        waitingFor: "ur location or ur usual spots, only if u want",
        canDo: [CAN.why, CAN.skip, CAN.go_on],
        facts: { why: "alerts and walking times fit where they actually are", kept: "troy keeps only the last spot they share and never shows it to anyone", erase: 'texting "forget my location" erases it' },
      };
  }
}

/**
 * A message that isn't what the step is waiting for: the chat brain answers it knowing which step is open, and
 * code performs the action it names. Returns false only when onboarding ended without using this message.
 */
async function chat(ctx: FlowContext, step: Step, data: Data): Promise<boolean> {
  const d = await deps();
  let reply: { bubbles: string[]; action: string | null } = { bubbles: [], action: null };
  try {
    if (overrides.replyAtStep || modelReady()) reply = await d.replyAtStep(ctx, stepSpec(step, data, ctx.db));
    else reply = withoutModel(ctx, step);
  } catch {
    // Never throws by contract. If it does, the nudge below still goes out.
  }
  const spec = stepSpec(step, data, ctx.db);
  const action = reply.action && spec.canDo.some((c) => c.name === reply.action) ? reply.action : null;
  const bubbles = (reply.bubbles ?? []).filter((b) => typeof b === "string" && b.trim());
  const acts = !!action && action !== "continue" && action !== "why_do_u_ask";
  if (bubbles.length) await ctx.say(...bubbles);
  // "why" was picked with nothing said: the question still gets its answer, never the step's nudge alone.
  else if (action === "why_do_u_ask") await ctx.say(...vary(ctx, step === "location" ? "location_why" : "verify_why"));
  else if (!acts) await ctx.say(...vary(ctx, `nudge_${step}` as PoolKey));

  const judge = data.judge ?? null;
  switch (action) {
    case "start_over":
    case "back_to_student_or_judge":
      ctx.db.prepare("UPDATE verification_codes SET expiresAt = 0 WHERE userId = ?").run(ctx.user.id);
      if (!bubbles.length) await ctx.say(...vary(ctx, "start_over"));
      await askWho(ctx);
      return true;
    case "resend_code": {
      const email = step === "code" ? String(data.email ?? "") : String((data.failed as { email?: string } | undefined)?.email ?? "");
      if (email) await sendCode(ctx, email, data);
      return true;
    }
    case "change_email":
      // The address they had is remembered, so a piece of it typed next is understood.
      ctx.setState({ flow: FLOW, step: "email", data: { ...carry(data), judge } });
      if (!bubbles.length) await ctx.say(...vary(ctx, "ask_email_again"));
      return true;
    case "suggest_topic":
      await topicOutcome(ctx, ctx.event.text, !!data.late);
      return true;
    case "skip_optional_step":
      if (step === "alerts") await closeAlerts(ctx, bubbles.length ? [] : vary(ctx, "alerts_none"));
      else if (step === "topic") await afterTopic(ctx, !!data.late, bubbles.length ? [] : vary(ctx, "topic_never_mind"));
      else if (step === "location") await finish(ctx, bubbles.length ? [] : vary(ctx, "location_declined"));
      return true;
  }
  if (step === "location") {
    // Optional and last: after a few messages that aren't an answer, onboarding quietly ends.
    const chats = Number(data.chats ?? 0) + 1;
    if (chats >= 3) await finish(ctx, []);
    else ctx.setState({ flow: FLOW, step: "location", data: { ...data, chats } });
  }
  return true;
}

/**
 * No model to understand the message with. The few things plain rules can read are still honored (starting over,
 * what he does, why he asks where they are); everything else gets the step's own gentle nudge from the caller.
 */
function withoutModel(ctx: FlowContext, step: Step): { bubbles: string[]; action: string | null } {
  const text = ctx.event.text ?? "";
  const w = plainWords(text);
  const before = (BEFORE as string[]).includes(step);
  if (before && /\b(?:start over|restart|start again|from the (?:top|start|beginning)|go back|wrong one)\b/.test(w)) return { bubbles: [], action: "start_over" };
  if (step === "location" && looksLikeQuestion(text) && /\b(?:why|what for|whats? (?:that|this|it) for|track|tracking|need (?:that|this|it|my location))\b/.test(w)) return { bubbles: vary(ctx, "location_why"), action: "why_do_u_ask" };
  // A question about him is answered first; the step's nudge follows.
  if (askedWhatHeDoes(text) || askedWhoHeIs(text)) return { bubbles: [...fallbackReply(ctx.db, ctx.user.id, text), ...vary(ctx, `nudge_${step}` as PoolKey)], action: null };
  return { bubbles: [], action: null };
}

/** A plain request for one of Troy's jobs ("i lost my wallet at leavey"), by the keyword rules. No model. */
function realRequest(event: IncomingEvent): boolean {
  if (event.images.length) return true;
  try {
    const flow = fallbackIntent({ text: event.text ?? "", hasImage: false, state: null }).flow;
    return flow !== "smalltalk" && flow !== "onboarding";
  } catch {
    return false;
  }
}

// ---------- who, email, code ----------

async function askWho(ctx: FlowContext): Promise<void> {
  ctx.setState({ flow: FLOW, step: "who", data: {} });
  const ref = await sendPoll(ctx, (await deps()).pickLine(ctx, "quick_check")[0]!, JUDGE_OPTIONS);
  ctx.setState({ flow: FLOW, step: "who", data: { judge: ref } });
}

type CodeRow = { id: number; email: string; code: string; attempts: number; expiresAt: number };

/** Every code sent to this address for this person that still works, newest first. */
function liveCodes(db: DatabaseSync, userId: number, email: string): CodeRow[] {
  return db.prepare("SELECT * FROM verification_codes WHERE userId = ? AND email = ? AND expiresAt >= ? ORDER BY id DESC").all(userId, email, Date.now()) as CodeRow[];
}

/** What a step before verification hands on to the next one: the open poll, and what the email reading needs. */
function carry(data: Data, previous: string | null = previousEmail(data)): Data {
  const misses = Number(data.misses ?? 0);
  return { judge: data.judge ?? null, ...(previous ? { prev: previous } : {}), ...(misses > 0 ? { misses } : {}) };
}

/** The usc address a code last went to (or was meant to go to) in this onboarding, if any. */
function previousEmail(data: Data): string | null {
  const failed = data.failed as { email?: string } | undefined;
  const email = data.email ?? data.prev ?? failed?.email;
  return typeof email === "string" && email ? email : null;
}

/** What Troy says when the code email did not go out: honest about it, with real ways forward. Never "send it again". */
function sendFailedBrief(reason: EmailSendResult): Brief {
  const judge = "if ur a judge just say so and i'll skip this part";
  if (reason === "no_key") {
    return {
      goal: "the verification email could not be sent because troy's email isn't set up right now. say so honestly and offer ways forward",
      mustCover: ["the code email did not go out", "it is a problem on troy's side, not theirs", "they can ask him to try again later", "a hackathon judge can say so and skip this step"],
      fallback: [
        ["that email didn't go out. my email isn't hooked up right now, so that's on me, not u", `text "try again" in a bit and i'll give it another shot. ${judge}`],
        ["i couldn't send that code. my email side is down rn, nothing u did", `tell me "try again" a little later. or ${judge}`],
      ],
    };
  }
  if (reason === "rejected") {
    return {
      goal: "the verification email was turned down by troy's mail service before it left. say so honestly and offer ways forward",
      mustCover: ["the code email did not go out", "they can ask him to try again in a minute", "they can give a different usc email if that one has a typo", "a hackathon judge can say so and skip this step"],
      fallback: [
        ["that email didn't go out, my mail service turned it down", `text "try again" in a min, or send me a different usc email if that one had a typo. ${judge}`],
        ["i couldn't get that code out, the email got bounced on my end", `tell me "try again" in a minute, or give me another usc email. ${judge}`],
      ],
    };
  }
  return {
    goal: "the verification email failed to send because something broke on troy's side. say so honestly and offer ways forward",
    mustCover: ["the code email did not go out", "they can ask him to try again in a minute", "they can give a different usc email instead", "a hackathon judge can say so and skip this step"],
    fallback: [
      ["that email didn't go out, something broke on my end", `give it a min and text "try again", or send me a different usc email. ${judge}`],
      ["i couldn't send that code just now, that's on me", `text "try again" in a minute, or use another usc email. ${judge}`],
    ],
  };
}

async function sendCode(ctx: FlowContext, email: string, data: Data): Promise<void> {
  const { db, user } = ctx;
  const d = await deps();
  // The student / judge poll stays answerable after an email is typed.
  const judge = data.judge ?? null;
  const recent = db.prepare("SELECT COUNT(*) AS n FROM verification_codes WHERE userId = ? AND createdAt > ?").get(user.id, Date.now() - 60 * 60 * 1000) as { n: number };
  if (recent.n >= MAX_CODES_PER_HOUR) {
    await ctx.say(...vary(ctx, "code_limit"));
    return;
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const now = Date.now();
  // Codes for a different address stop working the moment this one goes out. Earlier codes for the same address
  // keep working until they expire: someone with two emails from Troy can use either (rows stay for the hourly count).
  db.prepare("UPDATE verification_codes SET expiresAt = 0 WHERE userId = ? AND email != ?").run(user.id, email);
  const made = db.prepare("INSERT INTO verification_codes (userId, email, code, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?)").run(user.id, email, code, now + CODE_TTL_MS, now);
  let result: EmailSendResult = "error";
  try {
    result = await d.sendEmail(email, code);
  } catch {
    result = "error";
  }
  if (result !== "sent") {
    // A code nobody received can't be used. The address is remembered so "try again" never needs it retyped.
    db.prepare("UPDATE verification_codes SET expiresAt = 0 WHERE id = ?").run(Number(made.lastInsertRowid));
    ctx.setState({ flow: FLOW, step: "email", data: { judge, failed: { email, reason: result } } });
    await ctx.say(...(await inHisWords(ctx, sendFailedBrief(result))));
    return;
  }
  ctx.setState({ flow: FLOW, step: "code", data: { email, judge } });
  await ctx.say(...vary(ctx, "code_sent", { email }));
}

/** An email (or an attempt at one) typed at any step before verification. */
async function handleEmailRead(ctx: FlowContext, read: NonNullable<EmailRead>, data: Data): Promise<void> {
  if (read.kind === "ok") {
    await sendCode(ctx, read.email, data);
    return;
  }
  if (read.kind === "typo") {
    await offerEmail(ctx, read.email, data, []);
    return;
  }
  // Something that was meant as an email and can't be used. At the code step the code is still what is open.
  const atCode = ctx.state?.step === "code";
  const misses = atCode ? 0 : Number(data.misses ?? 0) + 1;
  const stay = { ...carry(data), ...(misses ? { misses } : {}), ...(data.failed ? { failed: data.failed } : {}) };
  if (misses >= 2) {
    // Twice in a row: the format has been explained. What helps now is the real ways forward.
    ctx.setState({ flow: FLOW, step: "email", data: stay });
    await ctx.say(...(await inHisWords(ctx, WAYS_FORWARD)));
    return;
  }
  // A gmail or another school's address: one line that it has to be the usc one, and the usc address it most
  // likely stands for in the same reply. Nothing is sent to it until they say yes.
  const guess = read.kind === "not_usc" ? localPart(read.email.split("@")[0]!) : null;
  if (guess) {
    await offerEmail(ctx, `${guess}@usc.edu`, { ...data, misses }, vary(ctx, "email_not_usc"));
    return;
  }
  if (!atCode) ctx.setState({ flow: FLOW, step: "email", data: stay });
  await ctx.say(...vary(ctx, read.kind === "not_usc" ? "email_not_usc" : "email_hint"));
}

/** Two tries at an email that didn't work. He doesn't explain the format a third time. */
const WAYS_FORWARD: Brief = {
  goal: "they tried twice to give their usc email and neither try worked. do not explain the email format again. be easy about it and offer the two real ways forward",
  mustCover: ["they can send their usc email one more time", 'if they are a hackathon judge they can text "judge" and skip this step'],
  fallback: [
    ["no stress, we keep missing each other on this", 'send ur usc email one more time and i\'ll take it from there. or if ur a judge, text "judge" and u skip this part'],
    ["ok this isn't landing, that's fine", 'give me ur usc email once more, or if ur a hackathon judge just text "judge" and we skip it'],
    ["all good, two ways from here", 'try ur usc email one more time. or text "judge" if ur judging the hackathon and i\'ll skip the check'],
  ],
};

/** True while the bubble with this id is still the last thing Troy sent in this chat. Unknown ids count as still last. */
function stillLastWord(ctx: FlowContext, askId: string | null): boolean {
  if (!askId) return true;
  try {
    const row = ctx.db.prepare("SELECT providerMessageId FROM messages WHERE chatId = ? AND direction = 'out' ORDER BY id DESC LIMIT 1").get(ctx.event.chatId) as { providerMessageId: string | null } | undefined;
    return !row?.providerMessageId || row.providerMessageId === askId;
  } catch {
    return true;
  }
}

/**
 * The did-u-mean question for an address built in code. Nothing is sent to it until they say yes (typed, or a
 * thumbs up on that bubble). `lead` goes out first, in the same reply.
 */
async function offerEmail(ctx: FlowContext, email: string, data: Data, lead: string[]): Promise<void> {
  const ids = await ctx.say(...lead, didYouMean(email));
  ctx.setState({ flow: FLOW, step: "email_confirm", data: { ...carry(data), suggested: email, askId: ids[ids.length - 1] ?? null } });
}

/**
 * A six digit guess. Any unexpired code sent to this address counts, not only the newest (John typed the code
 * from the first of two emails). A wrong guess counts against every code that is out, so no code is ever guessed
 * at more than MAX_ATTEMPTS times: one that used up its tries stays dead when a newer email goes out, and the
 * tries left are the newest code's.
 */
async function handleCodeGuess(ctx: FlowContext, guess: string, email: string): Promise<void> {
  const { db, user } = ctx;
  const live = liveCodes(db, user.id, email);
  const newest = live[0];
  if (!newest) {
    await ctx.say(...vary(ctx, "code_expired"));
    return;
  }
  if (newest.attempts >= MAX_ATTEMPTS) {
    await ctx.say(...vary(ctx, "code_locked"));
    return;
  }
  const usable = live.filter((row) => row.attempts < MAX_ATTEMPTS);
  const hit = usable.find((row) => row.code === guess);
  if (!hit) {
    for (const row of usable) db.prepare("UPDATE verification_codes SET attempts = ? WHERE id = ?").run(row.attempts + 1, row.id);
    const left = MAX_ATTEMPTS - (newest.attempts + 1);
    const tries = { left: `${left} ${left === 1 ? "try" : "tries"}` };
    await ctx.say(...(left > 0 ? vary(ctx, live.length >= 2 ? "code_wrong_recent" : "code_wrong", tries) : vary(ctx, "code_out")));
    return;
  }
  await verified(ctx, { uscEmail: hit.email, verifiedVia: "usc_email", name: user.name ?? guessName(hit.email) }, vary(ctx, "verified"));
}

async function verified(ctx: FlowContext, fields: Record<string, string | number | null>, lead: string[]): Promise<void> {
  updateUser(ctx.db, ctx.user.id, { verifiedAt: Date.now(), ...fields });
  ctx.db.prepare("DELETE FROM verification_codes WHERE userId = ?").run(ctx.user.id);
  await askAlerts(ctx, lead);
}

/**
 * Testers John pre-approved (TROY_GUEST_STUDENTS, comma-separated handles) get the full student path without the
 * USC email step: picking "usc student" verifies them. For the hackathon only; nobody else can reach this.
 */
function isGuestStudent(handle: string): boolean {
  const list = (process.env.TROY_GUEST_STUDENTS || "").split(",").map((h) => normalizeHandle(h)).filter(Boolean);
  return list.includes(handle);
}

async function guestStudent(ctx: FlowContext): Promise<boolean> {
  if (!isGuestStudent(ctx.user.handle)) return false;
  await verified(ctx, { verifiedVia: "usc_email" }, ["ur on john's tester list, so no email check for u"]);
  return true;
}

/**
 * The judge skip. After the thanks line he tells them once what is different for a judge (faster typing, the casual
 * student voice, that they can ask for anything straight) and offers the one-tap tone switch; then the alerts poll
 * and the rest, as for anyone. The intro lives in src/judge.ts and is worded through this file's own composer.
 */
async function judgeSkip(ctx: FlowContext): Promise<void> {
  updateUser(ctx.db, ctx.user.id, { verifiedAt: Date.now(), verifiedVia: "judge_skip" });
  ctx.db.prepare("DELETE FROM verification_codes WHERE userId = ?").run(ctx.user.id);
  ctx.setState({ flow: FLOW, step: "alerts", data: {} });
  await ctx.say(...(await deps()).pickLine(ctx, "judge"));
  try {
    await judgeIntro(ctx, inHisWords);
  } catch {
    // The intro is context, never a gate: the alerts poll still goes out.
  }
  await askAlerts(ctx, []);
}

const SAYS_JUDGE = /^(?:im |i am |i m )?(?:a |the |an? )?(?:hackathon )?judge(?: here)?$/;
const SAYS_STUDENT = /^(?:im |i am |i m )?(?:a |an? )?(?:usc )?student(?: here)?$/;
const TRY_AGAIN = /^(?:pls |please )?(?:try (?:it |that )?again|retry|again|resend|resend (?:it|code|the code)|send (?:it|that) again|one more time)(?: pls| please)?$/;

async function beforeVerified(ctx: FlowContext, step: Step, data: Data, extras: OnboardingExtras): Promise<boolean> {
  const { event } = ctx;
  const d = await deps();
  const text = event.text ?? "";
  const w = plainWords(text);
  const judge = data.judge as PollRef | null | undefined;

  if (event.reaction || event.pollVote) {
    const { index, positive } = pollChoice(event, judge);
    if (index === 1 && positive) await judgeSkip(ctx);
    else if (index === 0 && positive) {
      if (await guestStudent(ctx)) return true;
      if (step === "who") ctx.setState({ flow: FLOW, step: "email", data: { judge } });
      if (step === "who" || step === "email") await ctx.say(...(await deps()).pickLine(ctx, "student"));
    } else if (index === -1 && step === "email_confirm") {
      // A thumbs up on the did-u-mean bubble itself is a yes. On any other bubble it is just an acknowledgment.
      const answer = d.readYesNo({ event, questionMessageId: (data.askId as string | null) ?? null, allowTapback: true });
      if (answer === "yes") await sendCode(ctx, String(data.suggested), data);
      else if (answer === "no") {
        ctx.setState({ flow: FLOW, step: "email", data: carry(data) });
        await ctx.say(...vary(ctx, "ask_email_again"));
      }
    }
    return true;
  }

  // A judge can say so at any point before verification.
  if (SAYS_JUDGE.test(w) || (step === "who" && w === "2")) {
    await judgeSkip(ctx);
    return true;
  }
  const read = readEmail(text);

  if (step === "email_confirm" && !read) {
    const answer = d.readYesNo({ event, questionMessageId: (data.askId as string | null) ?? null, allowTapback: true });
    if (answer === "yes") {
      // He has said something else since asking (they asked a question and he answered): this yes may be to that.
      // No code goes to an address on it. The question is asked again, and a yes to that sends it.
      if (!stillLastWord(ctx, (data.askId as string | null) ?? null)) await offerEmail(ctx, String(data.suggested), data, []);
      else await sendCode(ctx, String(data.suggested), data);
      return true;
    }
    if (answer === "no") {
      ctx.setState({ flow: FLOW, step: "email", data: carry(data) });
      await ctx.say(...vary(ctx, "ask_email_again"));
      return true;
    }
  }

  if (step === "code" && !read) {
    if (TRY_AGAIN.test(w)) {
      await sendCode(ctx, String(data.email), data);
      return true;
    }
    // Spaces or dashes inside the six digits are fine.
    const squeezed = text.replace(/[\s-]/g, "");
    const guess = squeezed.match(/^\D*(\d{6})\D*$/)?.[1];
    if (guess) {
      await handleCodeGuess(ctx, guess, String(data.email ?? ""));
      return true;
    }
    // Digits, but not six of them: that was an attempt at the code.
    if (/^\d{2,12}$/.test(squeezed)) {
      await ctx.say(...vary(ctx, "code_hint"));
      return true;
    }
  }

  if (read) {
    await handleEmailRead(ctx, read, data);
    return true;
  }

  if ((step === "who" || step === "email") && (SAYS_STUDENT.test(w) || (step === "who" && w === "1"))) {
    if (await guestStudent(ctx)) return true;
    ctx.setState({ flow: FLOW, step: "email", data: { judge, ...(data.failed ? { failed: data.failed } : {}) } });
    await ctx.say(...(await deps()).pickLine(ctx, "student"));
    return true;
  }
  // After a failed send, "try again" goes to the same address. They never type it twice.
  const failed = data.failed as { email?: string } | undefined;
  if (step === "email" && failed?.email && (TRY_AGAIN.test(w) || d.readYesNo({ event, questionMessageId: null }) === "yes")) {
    await sendCode(ctx, failed.email, data);
    return true;
  }
  // He is waiting for an email and got a word that reads as the front half of one ("johnwang"), or a piece of
  // the address they gave before: the address is built here and confirmed, never guessed at with format hints.
  if ((step === "email" || step === "email_confirm") && !event.images.length && !realRequest(event) && d.readYesNo({ event, questionMessageId: null }) === null) {
    const offer = suggestEmail(text, previousEmail(data));
    if (offer) {
      await offerEmail(ctx, offer, data, []);
      return true;
    }
  }
  return chat(ctx, step, data);
}

// ---------- alerts ----------

const pollKey = (userId: number): string => `alertpoll:${userId}`;

function loadAlertPoll(db: DatabaseSync, userId: number): AlertPoll | null {
  try {
    const raw = getSetting(db, pollKey(userId));
    const p = raw ? (JSON.parse(raw) as Partial<AlertPoll>) : null;
    if (!p || !Array.isArray(p.optionIds) || !Array.isArray(p.topicIds)) return null;
    return { pollId: p.pollId ?? null, optionIds: p.optionIds, mode: p.mode ?? "tap", topicIds: p.topicIds };
  } catch {
    return null;
  }
}

async function askAlerts(ctx: FlowContext, lead: string[]): Promise<void> {
  const { db, user } = ctx;
  const all = listTopics(db);
  const offered = BUILT_IN_TOPICS.map((b) => all.find((t) => t.key === b.key)).filter((t): t is (typeof all)[number] => !!t);
  ctx.setState({ flow: FLOW, step: "alerts", data: {} });
  if (lead.length) await ctx.say(...lead);
  const ref = await sendPoll(ctx, vary(ctx, "alerts_question").join(" "), [...offered.map((t) => t.label), SOMETHING_ELSE]);
  // Kept outside flow_state: the poll stays live long after onboarding, and across restarts.
  setSetting(db, pollKey(user.id), JSON.stringify({ ...ref, topicIds: [...offered.map((t) => t.id), -1] } satisfies AlertPoll));
  // The provider's own hint for a list or tap poll says "ur pick". Several are fine here.
  if (ref.mode !== "native") await ctx.say(...vary(ctx, "alerts_many"));
}

function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** What he got, said as what will actually happen (each topic's plain description, never the poll label). */
async function confirmLines(ctx: FlowContext, mine: { plain: string }[], addMore: boolean): Promise<string[]> {
  const plains = mine.map((t) => t.plain);
  const more = ["u can add more anytime", "want more later? just tell me", "add or drop any of them whenever"];
  const leads = ["bet, i'll text u", "got it. u'll hear from me", "locked in. i'll hit u up"];
  // Two to a bubble, so a long list reads as a few short texts instead of one that gets cut mid-thought.
  const rest: string[] = [];
  for (let i = 2; i < plains.length; i += 2) rest.push(`${i + 2 >= plains.length && i > 2 ? "and" : "also"} ${joinList(plains.slice(i, i + 2))}`);
  const first = leads.map((lead) => [`${lead} ${joinList(plains.slice(0, 2))}`, ...rest]);
  return inHisWords(ctx, {
    goal: "confirm the alerts they just picked, saying what will actually happen in natural words. never quote the poll options and never repeat instructions",
    mustCover: [...mine.map((t) => `he'll text them ${t.plain}`), ...(addMore ? ["they can add more later"] : [])],
    fallback: first.map((lines, i) => (addMore ? [...lines, more[i % more.length]!] : lines)),
  });
}

/** The alerts step is answered: on to the location ask. */
async function closeAlerts(ctx: FlowContext, lead: string[]): Promise<void> {
  if (lead.length) await ctx.say(...lead);
  await askLocation(ctx);
}

async function askTopic(ctx: FlowContext, lead: string[], late: boolean): Promise<void> {
  ctx.setState({ flow: FLOW, step: "topic", data: { late } });
  await ctx.say(...lead, ...vary(ctx, "topic_ask"));
}

/** What comes after the "something else" exchange: the location ask during onboarding, nothing when it happened later. */
async function afterTopic(ctx: FlowContext, late: boolean, lead: string[]): Promise<void> {
  // "something else" was tapped while the location ask was open: back to that ask, without sending it all again.
  if (ctx.state?.flow === FLOW && ctx.state.step === "topic" && ctx.state.data.back === "location") {
    ctx.setState({ flow: FLOW, step: "location", data: {} });
    await ctx.say(...lead, ...vary(ctx, "location_back"));
    return;
  }
  if (lead.length) await ctx.say(...lead);
  if (late) ctx.setState(null);
  else await askLocation(ctx);
}

/** The topic inside "can u text me about pickup soccer pls". */
function topicName(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/^(?:(?:hmm+|um+|uh+|ok|okay|oh|yeah|yes|sure|maybe|idk maybe|like|how about|what about|i guess)[ ,]+)*/, "")
    .replace(/^(?:(?:can|could|would) (?:u|you) |pls |please )?(?:text|alert|ping|tell|notify|hit) me (?:up )?(?:about|when|for|if|whenever) (?:there(?:'s| is| are) |someone (?:has|is|wants) )?/, "")
    .replace(/^(?:i(?:'d| would) (?:like|love|want)|i want|i wanna (?:know|hear) about|i'm looking for|im looking for|looking for|something (?:like|about|for)|anything (?:about|for|like))[ ,]+(?:texts? (?:about|for) |alerts? (?:about|for) |to (?:know|hear) about )?/, "")
    .replace(/[.!?,\s]+(?:pls|please|thx|thanks)?[.!?,\s]*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/**
 * A topic the student named. Code decides which of the outcomes it is; the wording is his own each time.
 * Exists already: they are added. New and clearly fine: created, they are added, and he makes them feel good
 * about it. Hard to judge right now: nothing is created, the request is saved for a person to review.
 * Inappropriate: one easy line, nothing created.
 */
async function topicOutcome(ctx: FlowContext, raw: string, late: boolean): Promise<void> {
  const { db, user } = ctx;
  const d = await deps();
  const name = topicName(raw) || (raw ?? "").trim().slice(0, 60);
  const existing = findTopic(db, name);
  if (existing) {
    subscribe(db, user.id, existing.id);
    const lines = await inHisWords(ctx, {
      goal: "they asked for alerts about something troy already has a topic for. tell them they are on it, in natural words",
      mustCover: [`he'll text them ${existing.plain}`],
      fallback: [[`bet, i'll text u ${existing.plain}`], [`already a thing. i'll hit u up ${existing.plain}`], [`got u. u'll hear from me ${existing.plain}`]],
    });
    await afterTopic(ctx, late, lines);
    return;
  }
  let verdict: "ok" | "unsure" | "no" = "unsure";
  try {
    verdict = await d.judgeTopic(name);
  } catch {
    verdict = "unsure";
  }
  if (verdict === "no") {
    await afterTopic(ctx, late, vary(ctx, "topic_no"));
    return;
  }
  if (verdict === "ok") {
    const made = createTopic(db, name, user.id);
    subscribe(db, user.id, made.id);
    const lines = await inHisWords(ctx, {
      goal: "they suggested a brand new alert topic and troy just created it. make them feel good about it, in his own words",
      mustCover: ["that topic didn't exist before", "it's a great idea", "it is now an option for everyone", `he'll text them ${made.plain}`],
      fallback: [
        ["that wasn't a thing yet, and honestly it should've been. great idea", `i just added it for everyone. i'll text u ${made.plain}`],
        ["love that. nobody had asked for it before u", `it's a real option for everyone now, and ur the first one on it. i'll text u ${made.plain}`],
        ["ok that's a good one, it didn't exist until right now", `now anyone can pick it, thanks to u. i'll hit u up ${made.plain}`],
      ],
    });
    await afterTopic(ctx, late, lines);
    return;
  }
  saveTopicRequest(db, name, user.id);
  const lines = await inHisWords(ctx, {
    goal: "they suggested an alert topic troy can't set up on the spot. it was not created. he noted it and will text them when something comes up for it",
    mustCover: ["he noted what they asked for", "he'll text them when something comes up for it"],
    fallback: [["noted. i'll text u when something comes up for that"], ["got it written down. i'll hit u up when there's something for it"], ["i hear u. when something comes up for that, u'll get a text from me"]],
  });
  await afterTopic(ctx, late, lines);
}

// ----- votes: saved the moment they arrive, answered once per burst -----

type Burst = { ctx: FlowContext; before: Set<number>; other: boolean; timer: ReturnType<typeof setTimeout> | null };
const bursts = new Map<number, Burst>();
const settling = new Set<Promise<void>>();

/**
 * One vote or tapback on the alerts poll. Saved at once; the reply waits for the burst to settle.
 * Returns false when the event isn't about this person's alerts poll.
 */
async function alertVote(ctx: FlowContext, strict: boolean): Promise<boolean> {
  const { db, user, event } = ctx;
  const poll = loadAlertPoll(db, user.id);
  const { index, positive } = pollChoice(event, poll, strict);
  if (!poll || index < 0) return false;
  const topicId = poll.topicIds[index];
  if (topicId === undefined) return false;
  const d = await deps();
  const burst: Burst = bursts.get(user.id) ?? { ctx, before: new Set(topicsFor(db, user.id).map((t) => t.id)), other: false, timer: null };
  burst.ctx = ctx;
  if (topicId === -1) burst.other = positive;
  else if (positive) subscribe(db, user.id, topicId);
  else unsubscribe(db, user.id, topicId);
  if (burst.timer) clearTimeout(burst.timer);
  burst.timer = setTimeout(() => void settle(user.id), Math.max(0, d.settleMs));
  burst.timer.unref?.();
  bursts.set(user.id, burst);
  return true;
}

/** Drops a waiting burst without a reply (the student typed something, and that reply covers the votes too). */
function dropBurst(userId: number): Burst | null {
  const burst = bursts.get(userId) ?? null;
  if (burst?.timer) clearTimeout(burst.timer);
  bursts.delete(userId);
  return burst;
}

function settle(userId: number): Promise<void> {
  const burst = dropBurst(userId);
  if (!burst) return Promise.resolve();
  const run = answerBurst(burst).catch((err: unknown) => console.error("onboarding error:", err instanceof Error ? err.name : "unknown"));
  settling.add(run);
  return run.finally(() => settling.delete(run));
}

/**
 * Answers every burst of votes that is still waiting, now, and waits for those replies to be sent.
 * For tests, and for a clean shutdown.
 */
export async function settleAlertVotes(): Promise<void> {
  await Promise.all([...bursts.keys()].map((id) => settle(id)));
  await Promise.all([...settling]);
}

async function answerBurst(burst: Burst): Promise<void> {
  const { ctx } = burst;
  const { db } = ctx;
  const user = getUserById(db, ctx.user.id);
  if (!user || user.stopped) return;
  const state = getFlowState(db, user.id);
  const mine = topicsFor(db, user.id);
  const now = new Set(mine.map((t) => t.id));

  if (state?.flow === FLOW && state.step === "alerts") {
    // The first votes: confirm what he got, say they can add more later, move on.
    if (burst.other) await askTopic(ctx, mine.length ? await confirmLines(ctx, mine, false) : [], false);
    else if (mine.length) await closeAlerts(ctx, await confirmLines(ctx, mine, true));
    return;
  }
  // Any time after that, even long after onboarding: a short word, one per burst.
  const added = [...now].filter((id) => !burst.before.has(id)).length;
  const removed = [...burst.before].filter((id) => !now.has(id)).length;
  if (added) await ctx.say(...vary(ctx, added === 1 ? "late_one" : "late_many"));
  else if (removed) await ctx.say(...vary(ctx, removed === 1 ? "late_off_one" : "late_off_many"));
  if (burst.other) {
    // Nothing else open: he asks right away. Mid something else: he doesn't take the conversation over.
    if (!state) await askTopic(ctx, [], true);
    else if (state.flow === FLOW && state.step === "location") {
      // Still in onboarding, at the optional location ask: the next thing they type is the topic, not a usual spot.
      ctx.setState({ flow: FLOW, step: "topic", data: { late: false, back: "location" } });
      await ctx.say(...vary(ctx, "topic_ask"));
    } else await ctx.say(...vary(ctx, "late_other"));
  }
}

/**
 * A vote or tapback on the alerts poll that arrives after onboarding, at any time. The pipeline calls this for
 * pollVote and reaction events from a verified user before handing the event to a flow. True means it was a
 * vote on this person's alerts poll and is handled (saved now, acknowledged once the burst settles).
 */
export async function handleAlertPollVote(ctx: FlowContext): Promise<boolean> {
  if (!ctx.event.pollVote && !ctx.event.reaction) return false;
  if (!ctx.user.verifiedAt) return false;
  try {
    return await alertVote(ctx, true);
  } catch {
    return false;
  }
}

const NONE = /^(?:skip|none|no|nah|nope|nothing|no thanks|no thank u|no alerts|none of (?:them|those|these)|im good|not rn|not now|pass)$/;
const DONE = /^(?:done|im done|thats it|thats all|all set|ok|okay|finished|thats everything)$/;
const ALL = /^(?:all|everything|all of them|all of those|all of these|all (?:5|five)|every one|all of it)$/;

/** Topics picked in words or numbers ("1 and 3", "food and rides", "all"), or null when the text isn't a pick. */
function readPicks(db: DatabaseSync, poll: AlertPoll | null, text: string): { ids: number[]; other: boolean } | null {
  const w = plainWords(text);
  if (!w || looksLikeQuestion(text)) return null;
  const builtIn = listTopics(db).filter((t) => t.builtIn);
  if (ALL.test(w)) return { ids: builtIn.map((t) => t.id), other: false };
  if (/^(?:something else|other|another one|something different)$/.test(w)) return { ids: [], other: true };
  const topicIds = poll?.topicIds ?? [...builtIn.map((t) => t.id), -1];
  if (/^\d(?: ?(?:and|n|,)? ?\d)*$/.test(w)) {
    const picks = (w.match(/\d/g) ?? []).map((n) => topicIds[Number(n) - 1]);
    if (picks.some((id) => id === undefined)) return null;
    return { ids: picks.filter((id): id is number => id !== undefined && id !== -1), other: picks.includes(-1) };
  }
  const pieces = text.split(/,|\n|;|\band\b|&|\+/i).map((s) => s.trim()).filter(Boolean);
  if (!pieces.length || pieces.length > 6 || text.length > 80) return null;
  const ids: number[] = [];
  for (const piece of pieces) {
    if (piece.split(/\s+/).length > 5) return null;
    const hit = findTopic(db, piece);
    if (!hit) return null;
    ids.push(hit.id);
  }
  return { ids: [...new Set(ids)], other: false };
}

async function handleAlerts(ctx: FlowContext, data: Data, extras: OnboardingExtras): Promise<boolean> {
  const { db, user, event } = ctx;
  const text = event.text ?? "";
  const w = plainWords(text);
  const poll = loadAlertPoll(db, user.id);
  const picks = readPicks(db, poll, text);
  const closing = NONE.test(w) || DONE.test(w);

  if (picks || closing) {
    // Votes still waiting for their reply are covered by this one.
    const waiting = dropBurst(user.id);
    for (const id of picks?.ids ?? []) subscribe(db, user.id, id);
    const mine = topicsFor(db, user.id);
    if (picks?.other || (closing && waiting?.other)) await askTopic(ctx, mine.length ? await confirmLines(ctx, mine, false) : [], false);
    else await closeAlerts(ctx, mine.length ? await confirmLines(ctx, mine, true) : vary(ctx, "alerts_none"));
    return true;
  }
  // A real request ("i lost my wallet at leavey") isn't made to wait behind an optional step.
  if (realRequest(event)) {
    dropBurst(user.id);
    ctx.setState(null);
    return false;
  }
  return chat(ctx, "alerts", data);
}

async function handleTopic(ctx: FlowContext, data: Data, extras: OnboardingExtras): Promise<boolean> {
  const text = ctx.event.text ?? "";
  const w = plainWords(text);
  const late = !!data.late;
  if (NONE.test(w) || /^(?:nvm|never ?mind|idk|not sure|forget it|nothing really|no idea|actually no|actually nvm)$/.test(w)) {
    await afterTopic(ctx, late, vary(ctx, "topic_never_mind"));
    return true;
  }
  // A few plain words that aren't a question: that is the topic.
  if (w && !looksLikeQuestion(text) && w.split(" ").length <= 10 && !ctx.event.images.length) {
    await topicOutcome(ctx, text, late);
    return true;
  }
  if (realRequest(ctx.event)) {
    ctx.setState(null);
    return false;
  }
  return chat(ctx, "topic", data);
}

// ---------- location ----------

async function askLocation(ctx: FlowContext): Promise<void> {
  const d = await deps();
  const chatId = ctx.event.chatId;
  ctx.setState({ flow: FLOW, step: "location", data: {} });
  let hasGif = false;
  try {
    hasGif = !!d.gifPath && existsSync(d.gifPath);
  } catch {
    hasGif = false;
  }
  if (hasGif) {
    await ctx.say(...d.pickLine(ctx, "location_ask"));
    const sent = await ctx.adapter.sendImage(chatId, d.gifPath).catch(() => null);
    if (sent) saveMessage(ctx.db, { userId: ctx.user.id, chatId, direction: "out", providerMessageId: sent.messageId, text: "[gif] how to share ur location" });
    // The GIF didn't go out: the same steps in words, so "here's how" still has something under it.
    else await ctx.say(...vary(ctx, "location_by_hand"));
  } else {
    // No GIF on this machine: a Find My request when the provider can send one, else the steps in words.
    await ctx.say(...vary(ctx, "location_plain"));
    const requested = await ctx.adapter.requestLocation(chatId).catch(() => false);
    await ctx.say(...(requested ? [LOCATION_REQUESTED] : vary(ctx, "location_by_hand")));
  }
  await ctx.say(...vary(ctx, "location_kept"), ...vary(ctx, "location_alt"));
}

/** Onboarding is over: the state is cleared and the first ten minutes begin. */
async function finish(ctx: FlowContext, lead: string[]): Promise<void> {
  ctx.setState(null);
  if (lead.length) await ctx.say(...lead);
  try {
    await (await deps()).afterOnboarding(ctx);
  } catch (err) {
    console.error("onboarding error:", err instanceof Error ? err.name : "unknown");
  }
}

const DECLINE = /^(?:skip|no|nah|nope|not now|not rn|later|maybe later|im good|i am good|im ok|im okay|idk|pass|never ?mind|nvm|dont want|i dont want|id rather not|rather not)\b/;
// Words that mean the text is a request or a sentence, not a list of places.
const NOT_A_PLACE = /\b(?:i|im|ive|my|me|u|ur|you|your|lost|found|find|need|want|help|pls|please|broken|free|food|who|what|why|how|when|can|could|is|are|was|dont|cant|not|hey|hi|hello|thanks|thank|lol|ok|okay)\b/;

function knownPlace(db: DatabaseSync, piece: string): boolean {
  const p = word(piece);
  if (!p) return false;
  const rows = db.prepare("SELECT name, nicknames FROM campus_places").all() as { name: string; nicknames: string }[];
  return rows.some((r) => {
    let nick: unknown = [];
    try {
      nick = JSON.parse(r.nicknames || "[]");
    } catch {
      /* a bad row just has no nicknames */
    }
    const names = [r.name, ...(Array.isArray(nick) ? nick : [])].map((n) => word(String(n))).filter(Boolean);
    return names.some((n) => p === n || p.includes(n));
  });
}

/** The spots in a reply like "leavey, the village and parkside", or null when it doesn't read as a list of places. */
function parseSpots(db: DatabaseSync, text: string): string[] | null {
  const pieces = text
    .split(/,|\n|;|\band\b|&/i)
    .map((s) => s.trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 6);
  if (!pieces.length || looksLikeQuestion(text)) return null;
  if (pieces.some((p) => knownPlace(db, p))) return pieces;
  const plain = pieces.every((p) => {
    const w = word(p);
    return !!w && w.split(" ").length <= 4 && !NOT_A_PLACE.test(w);
  });
  return plain ? pieces : null;
}

/** Returns false when onboarding ended without using this text, so the pipeline treats it as a normal request. */
async function handleLocation(ctx: FlowContext, data: Data, extras: OnboardingExtras): Promise<boolean> {
  const { event } = ctx;
  const w = plainWords(event.text ?? "");
  // The pipeline has already saved the share as their last known location.
  if (event.location) {
    await finish(ctx, vary(ctx, "location_saved"));
    return true;
  }
  if (DECLINE.test(w)) {
    await finish(ctx, vary(ctx, "location_declined"));
    return true;
  }
  if ((!w && !event.images.length) || /^(?:done|shared|sharing|sent|ok|okay|did it|there|yes|yeah|yep|sure|accepted)$/.test(w)) {
    // After "forget my location" a plain "ok" is not a share: nothing is looked up and the opt-out stays.
    const live = locationOptedOut(ctx.db, ctx.user.id) ? null : await ctx.adapter.getLiveLocation(ctx.user.handle).catch(() => null);
    if (live && Number.isFinite(live.lat) && Number.isFinite(live.lng)) {
      await extras.saveLocation?.(ctx.user.id, { lat: live.lat, lng: live.lng });
      await finish(ctx, vary(ctx, "location_live"));
    } else {
      // After "forget my location" nothing is read on their word alone: the background refresh now watches for
      // a fix taken after this moment (src/location.ts). For everyone else this does nothing.
      noteLocationRequestedByUser(ctx.db, ctx.user.id);
      await ctx.say(...vary(ctx, "location_waiting"));
    }
    return true;
  }
  const spots = event.images.length ? null : parseSpots(ctx.db, event.text ?? "");
  if (spots) {
    updateUser(ctx.db, ctx.user.id, { usualSpots: JSON.stringify(spots) });
    await finish(ctx, vary(ctx, "location_spots"));
    return true;
  }
  // A real request ends onboarding and is handled as a request. Nothing is saved as a spot.
  if (realRequest(event)) {
    ctx.setState(null);
    return false;
  }
  return chat(ctx, "location", data);
}

// ---------- entry ----------

/** True when this user's next message belongs to onboarding. */
export function needsOnboarding(user: User, state: FlowContext["state"]): boolean {
  return !user.verifiedAt || state?.flow === "onboarding";
}

const BEFORE: Step[] = ["who", "email", "email_confirm", "code"];

/**
 * Returns true when onboarding handled the event. False means onboarding ended without using this text (the
 * student typed a real request at an optional step), so the caller should handle it normally.
 */
export async function handleOnboarding(ctx: FlowContext, extras: OnboardingExtras = {}): Promise<boolean> {
  const { user, event, adapter } = ctx;
  const state = ctx.state?.flow === FLOW ? ctx.state : null;
  const tap = !!(event.reaction || event.pollVote);

  if (!user.verifiedAt) {
    const step = state && (BEFORE as string[]).includes(state.step) ? (state.step as Step) : null;
    if (step) return beforeVerified(ctx, step, state!.data, extras);
    // A tap before the welcome means nothing.
    if (tap) return true;
    // First contact (or state lost): welcome first, even if the first text already asked for something.
    const d = await deps();
    await adapter.onAllowed?.(event.chatId)?.catch(() => {});
    await ctx.say(...d.pickLine(ctx, "welcome"), ...d.pickLine(ctx, "save_contact"));
    const card = await adapter.sendContactCard(event.chatId).catch(() => null);
    if (card) saveMessage(ctx.db, { userId: user.id, chatId: event.chatId, direction: "out", providerMessageId: card.messageId, text: "[contact card]" });
    // A slightly longer beat after the card before the next bubble.
    if (d.cardBeatMs > 0) await d.pause(d.cardBeatMs).catch(() => {});
    // A judge can say so from any point before verification (for example after STOP then START wiped the state).
    if (SAYS_JUDGE.test(plainWords(event.text ?? ""))) await judgeSkip(ctx);
    else await askWho(ctx);
    return true;
  }

  if (tap) {
    // During the alerts step any vote that could be this poll's counts; later it must name the poll exactly.
    await alertVote(ctx, state?.step !== "alerts").catch(() => false);
    return true;
  }
  if (state?.step === "alerts") return handleAlerts(ctx, state.data, extras);
  if (state?.step === "topic") return handleTopic(ctx, state.data, extras);
  if (state?.step === "location") return handleLocation(ctx, state.data, extras);
  // Verified with a stale onboarding state: nothing left to ask, and the message is handled normally.
  ctx.setState(null);
  return false;
}
