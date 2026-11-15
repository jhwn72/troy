// Flow 4: who do i talk to (USG). A question gets the matching directory row's stored text; a concern
// becomes a row in `reports` (kind 'usg_concern') on the dashboard's USG tab. The dashboard's status
// buttons text the reporter and every follower, so this flow never sends status updates itself.
//
// Committee rows are roles, and some are example data: Troy routes a concern to a role on the dashboard.
// It never texts a real person and never hands out anyone's phone number.
//
// Code decides: the program and committee (matched on the directory rows' topics), every name, detail text
// and link (copied from the row exactly as stored), anonymous or named, merging and follower counts.
// The model only picks a topic, and writes the one "best guess" bubble for questions nothing covers.

import type { FlowContext, FlowHandler, FlowState } from "../types.ts";
import { askJson, asksToPassOn, composeReply, fallbackIntent } from "../ai.ts";
import { findPlace } from "../places.ts";
import { openQuestionId, readYesNo } from "../yes.ts";
import { CANCEL, CANCELLED, CANCELLED_POOL, DEMO_NOTE, DEMO_NOTE_POOL, OFFER_STEP, askPoll, claimsDone, pollOf, pollPick, directoryRows, firstFiling, follow, insertReport, isFresh, joinWords, makeVoice, newestOutId, offerLive, openReports, othersPhrase, ownWords, passToOtherFlow, rowForTopic, rowMentioned, sentenceBubbles, similarText, unvoiced, userNotes } from "./reports-shared.ts";
import type { AskPoll, DirectoryRow, Pools, Voice } from "./reports-shared.ts";
import { DECISION, STAFF_STEP, TALK_STEP, aside, handleStaffTurn, notifyStaffOfReport, queueStaffNotice, recordPerson, restoreStaffPointer, simulateIfAlone, simulationTurn, tellerFor } from "../staff.ts";

export const TOPICS = ["dining", "safety", "housing", "academics", "transportation", "club funding", "other"] as const;
export type Topic = (typeof TOPICS)[number];

export const ASK_NAME = "want me to send it with ur name or anonymously?";
/** Asked once after someone is added to a concern others already sent. No answer means they stay a nameless count. */
export const ASK_JOIN_NAME = "want ur name on it too, or should i keep u anonymous?";
const CHECK_WITH_USG = "i'd check with usg";
/** Used only if the directory has no committee rows (an unseeded database). */
const ROUTE_FALLBACK = "USG";
/** Every step this flow (or a usg member's summary) opens. Any other open step under this flow is a simulation's. */
const OWN_STEPS: ReadonlySet<string> = new Set(["ask_name", "ask_join_name", "offer_send", OFFER_STEP, STAFF_STEP, TALK_STEP]);

// ---------- topic ----------

const TOPIC_WORDS: [Topic, RegExp][] = [
  ["club funding", /\b(?:club|clubs|rso|rsos|org|orgs|organization)\b.*\bfund|\bfund(?:ing|s|ed)?\b.*\b(?:club|clubs|rso|org|orgs|event)\b|\bfunding\b/],
  ["dining", /\bdining\b|\bmeals?\b|\bmeal plan\b|\bswipes?\b|\bevk\b|\bfood\b|\bmenu\b|\bvegetarian\b|\bvegan\b|\bhalal\b|\bkosher\b|\bcafe\b|\bseeds\b|\bburger crush\b/],
  ["transportation", /\bshuttles?\b|\bbus(?:es)?\b|\bparking\b|\btransport|\bmetro\b|\blax\b|\bairport\b|\btram\b|\bbike (?:lane|rack)s?\b|\bfryft\b|\blyft\b|\buber\b|\bsafe ride\b/],
  ["safety", /\bsafe(?:ty)?\b|\bunsafe\b|\bdps\b|\btheft\b|\bstolen\b|\bcrime\b|\bstreet ?lights?\b|\bat night\b/],
  ["housing", /\bhousing\b|\bdorms?\b|\brent\b|\broommates?\b|\bapartments?\b|\blease\b|\bresidential\b|\bra\b/],
  ["academics", /\bclass(?:es)?\b|\bprofessors?\b|\bprofs?\b|\bgrad(?:e|es|ing)\b|\bcourses?\b|\bregistration\b|\bsyllabus\b|\bexams?\b|\bfinals\b|\bmidterms?\b|\badvis(?:or|ors|ing)\b|\bcurve\b|\bevals?\b|\bacademic/],
];

export function topicFromWords(text: string): Topic {
  const t = text.toLowerCase();
  return TOPIC_WORDS.find(([, re]) => re.test(t))?.[0] ?? "other";
}

const asTopic = (v: unknown): Topic | null => (typeof v === "string" && (TOPICS as readonly string[]).includes(v.trim().toLowerCase()) ? (v.trim().toLowerCase() as Topic) : null);

const TOPIC_SYSTEM = `Pick the one topic that fits a USC student's message to student government. Reply with JSON only, no other words: {"topic": "..."}
Use exactly one of: dining, safety, housing, academics, transportation, club funding, other.`;

async function pickTopic(ctx: FlowContext, text: string): Promise<Topic> {
  const fromIntent = asTopic(ctx.intent.details.topic) ?? asTopic(ctx.intent.details.category);
  if (fromIntent) return fromIntent;
  // Null right away when there is no key, so the keyword rules answer.
  const out = await askJson<{ topic?: unknown }>({ model: "fast", system: TOPIC_SYSTEM, prompt: `Message: ${JSON.stringify(text.slice(0, 500))}`, maxTokens: 60, timeoutMs: 6000 });
  return asTopic(out && typeof out === "object" ? (out as { topic?: unknown }).topic : null) ?? topicFromWords(text);
}

// ---------- concern or question ----------

const COMPLAINT = /\bwhy (?:does|doesn'?t|do|don'?t|is|isn'?t|are|aren'?t|can'?t|won'?t|did|didn'?t)\b|\bshould(?:n'?t)?\b|\bneeds? to\b|\bneed more\b|\bnot enough\b|\btoo (?:early|late|long|expensive|crowded|slow|few|many|much|small|loud|dark|cold|hot)\b|\bso (?:early|late|long|expensive|crowded|slow|bad)\b|\b(?:always|never) (?:late|closed|full|broken|empty|out|works?|open|on time|enough|has|have|any)\b|\bsucks?\b|\bterrible\b|\bawful\b|\bannoying\b|\bunfair\b|\bridiculous\b|\bunsafe\b|\boverpriced\b|\bcomplain(?:t|ts|ing)?\b|\bconcern(?:s|ed)?\b|\btired of\b|\bsick of\b|\bwish\b|\bhate\b|\bproblem\b|\bissue\b|\bplease (?:add|fix|extend|bring|make)\b|\bruns? out\b|\bran out\b|\bbooked out\b|\bpetition\b/;
const QUESTION = /\?\s*$|^(?:how|when|where|what|whats|who|which|can|could|is|are|does|do|will|did)\b/;

/** A concern goes to a committee; a plain question just gets an answer. Code decides, the intent label is a tiebreak. */
export function isConcern(text: string, action: string): boolean {
  const t = text.toLowerCase().replace(/[‘’]/g, "'").trim();
  if (COMPLAINT.test(t)) return true;
  if (QUESTION.test(t)) return false;
  return action !== "question";
}

// ---------- directory answers ----------

/**
 * A program row's answer: its details exactly as stored, split at sentence ends, then its url if it has one,
 * or else the row's own contact so "ask usg" has somewhere to go.
 *
 * A row that isn't example data is said plainly and nothing is added on top: USG's own statement that it runs
 * a program is enough to say so (CLAUDE.md, "Trust USG's own statements"). Only a row still marked as example
 * data, or one with no stored text at all, gets the "i'd check with usg" line.
 */
export function programBubbles(row: DirectoryRow): string[] {
  const bubbles = row.details ? sentenceBubbles(row.details) : [UT.runsThis(row.name)];
  if ((row.isExample || !row.details) && !bubbles.join(" ").toLowerCase().includes("check with usg")) bubbles.push(CHECK_WITH_USG);
  if (row.url) bubbles.push(row.url);
  else if (row.contactMethod) bubbles.push(UT.reachAt(row.contactMethod));
  return bubbles;
}

function findProgram(ctx: FlowContext, text: string): DirectoryRow | null {
  return rowMentioned(directoryRows(ctx.db, "usg_program"), text, /\busg\b|student government/i.test(text));
}

function committeeFor(ctx: FlowContext, topic: Topic): DirectoryRow | null {
  const committees = directoryRows(ctx.db, "usg_committee");
  return rowForTopic(committees, topic) ?? rowForTopic(committees, "other");
}

// ---------- where a concern goes ----------
//
// Life in a residence hall (noise, roommates, an RA not acting, hall rules not being enforced) is not a broken
// thing and not a policy question: it goes to USC Housing, or to Campus Support & Intervention when the student
// sounds unsafe or at their limit. A policy-level issue (prices, the rules themselves) goes to the usg committee
// for its topic. Every name is a directory row's, exactly as stored. No office is ever made up here.

const RESIDENT_PEOPLE = /\b(?:room ?mates?|roomies?|dorm ?mates?|suite ?mates?|floor ?mates?|hall ?mates?|house ?mates?|neighbou?rs?|ra|ras|r\.a\.|resident (?:assistant|advisor|adviser)s?|rd|res(?:idential)? ?(?:ed|life|staff)|hall (?:staff|director))\b/;
const NOISE = /\bnois[ey]\b|\bloud\b|\bpart(?:y|ies|ying)\b|\bblasting\b|\bmusic\b|\byelling\b|\bscreaming\b/;
const RES_CONTEXT = /\bdorms?\b|\bmy (?:room|floor|hall|suite|apartment|apt|building)\b|\bresiden\w+|\bhousing\b|\bnext door\b|\bupstairs\b|\bdownstairs\b|\bsleep(?:ing)?\b|\bat night\b/;
const HALL_RULES = /\bquiet hours\b|\b(?:dorm|hall|residence hall|housing|floor) rules?\b/;
/** The rule or the price itself is the problem, for everyone: that is student government's to take up. */
const POLICY_LEVEL = /\bpolic(?:y|ies)\b|\brent\b|\bprices?\b|\bcosts?\b|\bexpensive\b|\boverpriced\b|\bfees?\b|\bhousing (?:lottery|selection|assignments?|application)\b|\b(?:usc|housing|the school) should\b|\bshould(?:n'?t)? (?:be allowed|allow|change)\b/;
const NEEDS_SUPPORT = /\bunsafe\b|\b(?:don'?t|do not|dont) feel safe\b|\bnot safe\b|\bscared\b|\bafraid\b|\bthreaten\w*|\bharass\w*|\bbull(?:y|ied|ying)\b|\bstalk\w*|\bneed to move out\b|\bcan'?t live (?:here|there|with)\b|\bat my limit\b|\boverwhelmed\b/;

/** Noise, roommates or dormmates, an RA or hall staff not acting, residence hall rules: life in housing, not a broken thing. */
export function isHousingLife(text: string): boolean {
  const t = (text ?? "").toLowerCase().replace(/[‘’]/g, "'");
  return RESIDENT_PEOPLE.test(t) || HALL_RULES.test(t) || (NOISE.test(t) && RES_CONTEXT.test(t));
}

/** How an office is named to a student: the stored name without its bracketed short form or the word "maintenance", lowercase. */
function officeWords(row: DirectoryRow): string {
  return row.name.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+maintenance$/i, "").trim().toLowerCase();
}

/**
 * Where a concern is routed: `routedTo` is the directory row's name exactly as stored. `office` is set (the words
 * a student is told) when it goes to a campus office instead of a usg committee.
 */
export function concernRoute(ctx: FlowContext, text: string, topic: Topic): { routedTo: string; office?: string } {
  if (isHousingLife(text) && !POLICY_LEVEL.test(text.toLowerCase())) {
    const offices = directoryRows(ctx.db, "office");
    const housing = rowForTopic(offices, "residence hall") ?? rowForTopic(offices, "dorm");
    const support = rowForTopic(offices, "trojans care") ?? rowForTopic(offices, "personal emergency");
    const row = (NEEDS_SUPPORT.test(text.toLowerCase()) ? support : null) ?? housing ?? support;
    if (row) return { routedTo: row.name, office: officeWords(row) };
  }
  const committee = committeeFor(ctx, isHousingLife(text) && topic === "other" ? "housing" : topic);
  return { routedTo: committee?.name ?? ROUTE_FALLBACK };
}

// ---------- concerns ----------

interface Pending {
  description: string;
  topic: Topic;
  routedTo: string;
  /** Set when it goes to a campus office, not a usg committee: the words a student is told ("usc housing"). */
  office?: string;
  /** A residence hall they named, by its stored name. Never a building that isn't one. */
  locationText?: string;
}

function pendingFrom(data: Record<string, unknown>): Pending | null {
  if (typeof data.description !== "string" || typeof data.routedTo !== "string") return null;
  return {
    description: data.description,
    topic: asTopic(data.topic) ?? "other",
    routedTo: data.routedTo,
    ...(typeof data.office === "string" && data.office ? { office: data.office } : {}),
    ...(typeof data.locationText === "string" && data.locationText ? { locationText: data.locationText } : {}),
  };
}

// One-tap answers (John, second live test (5)): the offer and the name question go out as polls when the provider
// has them. Typed answers keep working exactly as before.
export const OFFER_OPTIONS = ["send it with my name", "send it anonymously", "not now"];
export const NAME_OPTIONS = ["with my name", "anonymously"];
export const JOIN_OPTIONS = ["add my name", "keep me anonymous"];

/**
 * `lead` in words, then `question` as a poll of `options` when the provider has polls, else in words. Returns the
 * poll (null when it was asked in words) and the id of the last bubble that went out as text.
 */
async function askOneTap(ctx: FlowContext, lead: string[], question: string, options: string[], key: string): Promise<{ poll: AskPoll | null; lastId: string | null }> {
  const last = (ids: (string | null)[]) => [...ids].reverse().find((id) => !!id) ?? null;
  const pollsOn = (() => {
    try {
      return typeof ctx.adapter?.capabilities === "function" && ctx.adapter.capabilities().polls && typeof ctx.adapter.sendPoll === "function";
    } catch {
      return false;
    }
  })();
  if (!pollsOn) return { poll: null, lastId: last(await ctx.say(...lead, question)) };
  const before = lead.length ? last(await ctx.say(...lead)) : null;
  const poll = await askPoll(unvoiced(ctx), question, options, key);
  if (poll) return { poll, lastId: poll.pollId ?? before };
  return { poll: null, lastId: last(await ctx.say(question)) ?? before };
}

/** Who a concern would go to, as a student is told it. Code puts this in: the model never names an office. */
const toWords = (p: Pending): string => p.office ?? `the ${p.routedTo}`;

/**
 * A concern that began in a chat is offered, never started: he says what he could do and for whom, and waits.
 * The offer is this flow's open step, holding what he understood and their own words, so a yes never asks again.
 */
async function offer(ctx: FlowContext, p: Pending, lead: string[] = []): Promise<void> {
  const to = toWords(p);
  const fallback = [
    [`want me to pass this to ${to}? i can send it with ur name or anonymously`],
    [`i could get this in front of ${to} for u, with ur name or anonymous. want me to?`],
    [`this sounds like one for ${to}. ur name or anonymous, either works. want me to send it over?`],
  ];
  let bubbles: string[] = [];
  try {
    // Loaded here: the chat brain imports this folder's shared file.
    const { sayInHisWords } = await import("../brain.ts");
    bubbles = await sayInHisWords(unvoiced(ctx), {
      goal: "they have been telling troy about a problem. react to it like a friend in a few words, then offer to pass it on for them and ask if they want that. nothing has been sent, and nothing will be unless they say yes. do not ask them for any more details",
      mustCover: [`troy could pass this on to ${to} for them, if they want`, "it can go with their name or anonymously"],
      facts: { "who it would go to": to },
      fallback,
    });
  } catch {
    bubbles = [];
  }
  // It has to be a question they can answer with a yes: that is the whole point of it.
  // And about something that has not happened: wording that says it was sent never goes out.
  if (!bubbles.length || !bubbles[bubbles.length - 1]!.includes("?") || claimsDone(bubbles)) bubbles = fallback[0]!;
  // The question is the last bubble. With polls it goes out as one: name, anonymous or not now, in one tap.
  const { poll, lastId: qid } = await askOneTap(ctx, [...lead, ...bubbles.slice(0, -1)], bubbles[bubbles.length - 1]!, OFFER_OPTIONS, "usg:offer");
  ctx.setState({ flow: "usg", step: OFFER_STEP, data: { ...p, qid, lastOut: newestOutId(ctx.db, ctx.event.chatId), ...(poll ? { poll } : {}) } });
}

/** An open concern that says the same thing, which this one would join instead of being filed again. */
function sameConcern(ctx: FlowContext, p: Pending) {
  // A campus-wide concern joins one that says the same thing. One about someone's own hall (their roommates, their
  // ra) only joins one from the same named hall: two students with loud roommates are two situations, not one.
  const sameHall = (r: { locationText: string | null }) => !p.office || (!!p.locationText && r.locationText === p.locationText);
  return openReports(ctx.db, "usg_concern").find((r) => r.routedTo === p.routedTo && sameHall(r) && similarText(p.description, r.description ?? "")) ?? null;
}

/** Joins an open concern that says the same thing, or asks the one question (name or anonymous). */
async function raise(ctx: FlowContext, p: Pending, lead: string[] = [], choice: "name" | "anonymous" | null = null): Promise<void> {
  const dup = sameConcern(ctx, p);
  if (dup) {
    ctx.setState(null);
    const { result, others } = follow(ctx.db, dup, ctx.user.id);
    if (result === "already") {
      await ctx.say(...lead, SAY.alreadySent, SAY.whenPickedUp);
      return;
    }
    // They are in either way, as a count with no name. One optional question: a name only matters if the committee's
    // member wants to talk to the students behind it (they are asked again before anyone is connected).
    recordPerson(ctx.db, dup.id, ctx.user.id, false);
    // The member's updated summary waits a little for this answer, and goes out anyway if it never comes.
    queueStaffNotice(ctx.db, dup.id);
    ctx.setState({ flow: "usg", step: "ask_join_name", data: { ...p, reportId: dup.id } });
    const join = await askOneTap(ctx, [...lead, p.office ? UT.joinedOffice(othersPhrase(others), p.office) : UT.joined(othersPhrase(others), p.routedTo), SAY.whenPickedUp], ASK_JOIN_NAME, JOIN_OPTIONS, "usg:join");
    if (join.poll) ctx.setState({ flow: "usg", step: "ask_join_name", data: { ...p, reportId: dup.id, poll: join.poll } });
    await aside(ctx, {
      step: "usg_joined",
      behind: { did: "found the same concern already open and added u to it instead of filing a second one. {studentsSharingIt} students share it now, with the {committee}", numbers: { studentsSharingIt: others + 1, committee: p.routedTo } },
      decision: DECISION.troyTextsFirst,
    });
    return;
  }
  // They already said which, in the same breath as their yes: nothing to ask.
  if (choice) {
    await send(ctx, p, choice === "anonymous", undefined, lead);
    return;
  }
  ctx.setState({ flow: "usg", step: "ask_name", data: { ...p } });
  const asked = await askOneTap(ctx, lead, ASK_NAME, NAME_OPTIONS, "usg:name");
  if (asked.poll) ctx.setState({ flow: "usg", step: "ask_name", data: { ...p, poll: asked.poll } });
}

async function send(ctx: FlowContext, p: Pending, anonymous: boolean, note?: string, lead: string[] = []): Promise<void> {
  ctx.setState(null);
  const reportId = insertReport(ctx.db, { userId: ctx.user.id, kind: "usg_concern", anonymous, category: p.topic, description: p.description, locationText: p.locationText ?? null, routedTo: p.routedTo });
  recordPerson(ctx.db, reportId, ctx.user.id, !anonymous);
  const bubbles = [...lead, p.office ? UT.sentOffice(p.office) : UT.sent(p.routedTo)];
  if (note) bubbles.push(note);
  else if (anonymous) bubbles.push(SAY.sentAnon);
  // The committee's assigned member gets a summary: counts only, never who. Said plainly when that person is a stand-in.
  const texted = await tellStaff(ctx, reportId);
  if (texted) bubbles.push(SAY.exampleMember);
  // Otherwise one short line about the demo, the first time this person files anything, and never again.
  else if (firstFiling(ctx.db, ctx.user.id)) bubbles.push(DEMO_NOTE);
  await ctx.say(...bubbles);
  if (p.office) {
    // An office, not a committee: there is no usg member's side to play out.
    await aside(ctx, {
      step: "usg_sent",
      behind: { did: "read this as a problem with people or rules, not a broken thing, so it went to {office} as a concern instead of a work order", numbers: { office: p.routedTo } },
      decision: DECISION.officesStayInCharge,
    });
    return;
  }
  // Nobody is assigned to this committee, so nothing would happen next. A judge (or a student with nobody else on
  // here) is offered the usg member's side played out; a student in a live pilot waits for the real update.
  if (!texted && (await simulateIfAlone(ctx, "usg", { what: p.description, topic: p.topic, committee: p.routedTo, anonymous: anonymous ? "yes" : "no", reportId: String(reportId) }))) return;
  await aside(ctx, {
    step: "usg_sent",
    behind: {
      did: "worked out the topic, {topic}, picked the committee that covers it, the {committee}, and put it on their list. students sharing this concern so far: {studentsSharingIt}",
      numbers: { committee: p.routedTo, topic: p.topic, studentsSharingIt: 1 },
    },
    decision: DECISION.officesStayInCharge,
  });
}

/** Texts the committee's assigned member (an example contact for now). Never allowed to cost the student their reply. */
async function tellStaff(ctx: FlowContext, reportId: number): Promise<boolean> {
  try {
    return (await notifyStaffOfReport({ db: ctx.db, notify: tellerFor(ctx) }, reportId)).sentTo !== null;
  } catch {
    return false;
  }
}

/** A question about the choice ("will they see my name?") is not the choice. */
const ASKS_ABOUT_IT = /\?|^(?:(?:wait|so|but|um|uh|hmm|ok|okay|and|lol|well)[ ,]+)*(?:will|would|who|what|whats|which|when|where|why|how|is|are|does|do|did|can|could|should|if)\b/;

/**
 * "name" only on a plain statement that picks it ("with my name", "name is fine", "use my name").
 * Anything that asks a question never picks: sending a concern with someone's name on it needs their clear say.
 */
export function parseChoice(text: string): "name" | "anonymous" | null {
  const t = text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  if (ASKS_ABOUT_IT.test(t)) return null;
  if (/\bnot anon|don'?t (?:need|have) to be anon|no need (?:to be|for) anon/.test(t)) return "name";
  if (/\banon|\bno name\b|without (?:my |a |the )?name|(?:don'?t|do not|dont) (?:use|include|share|put|add|want) (?:my )?name|\bnot (?:with )?my name\b|\bnameless\b|\bprivate(?:ly)?\b/.test(t)) return "anonymous";
  // Negations were caught above, so a short statement with "name" in it picks the name ("put my name on it, i'm gabe").
  if (/\bname\b/.test(t) && t.split(" ").length <= 12) return "name";
  if (/^(?:me|mine|as me)$/.test(t)) return "name";
  return null;
}

/** True when the text is a question about names or anonymity, which gets an explanation instead of a send. */
export function asksAboutName(text: string): boolean {
  const t = text.toLowerCase().replace(/[‘’]/g, "'").trim();
  return ASKS_ABOUT_IT.test(t) && /\bname|\banon|\bsee\b|\bknow\b|\bwho\b|\bprivate|\bidentif/.test(t);
}

/** The same question about the optional name on a concern they joined. */
const EXPLAIN_JOIN_NAME = ["with ur name on it, usg can ask to talk to u about it, and i'd check with u first", "anonymous means ur just counted. which one?"];

export const EXPLAIN_NAME = ["with ur name, the committee sees ur first name next to it", "anonymous means no name at all. which one?"];
/** The same answer when it is headed to a campus office, not a committee. */
const EXPLAIN_NAME_OFFICE = ["with ur name, the office sees ur first name next to it", "anonymous means no name on it at all. which one?"];

const SAY = {
  alreadySent: "u already sent that one and it's still open",
  whenPickedUp: "i'll text u when they pick it up",
  sentAnon: "sent anonymously, ur name isn't on it",
  sentWithoutName: "wasn't sure which u meant, so i sent it without ur name",
  askWhat: "what's the question or concern?",
  offerSend: "want me to send them ur question?",
  unsure: "honestly not sure on that one, and i don't wanna make something up",
  doubleCheck: "i'd double check with usg",
  heldOff: "ok, i held off on sending that one. tell me again whenever u want it sent",
  allGood: "all good",
  leftIt: "all good, i'll leave it",
  nameAdded: "bet, ur name's on it. if usg wants to talk i'll ask u first",
  keptAnon: "all good, ur counted without ur name",
  joinUnsure: "wasn't sure which u meant, so i left ur name off",
  /** Said right after a concern when an example usg member was texted: nobody on the other end is a real member yet. */
  exampleMember: "(heads up: the usg member i looped in is a stand-in for the hackathon. no real usg members are on here yet)",
};

/** Lines with a value in them (a committee, a link, how many others). Code puts the value in; these only hold the words around it. */
const UT = {
  runsThis: (name: string) => `usg runs this one: ${name}`,
  reachAt: (contact: string) => `u can reach them at ${contact}`,
  joined: (others: string, committee: string) => `${others} already sent that to the ${committee}, so i added u to it`,
  sent: (committee: string) => `sent to the ${committee}. i'll text u when they pick it up.`,
  sentOffice: (office: string) => `passed it to ${office}. i'll text u when they pick it up.`,
  joinedOffice: (others: string, office: string) => `${others} already raised that with ${office}, so i added u to it`,
  goesTo: (office: string) => `that one goes to ${office}`,
  guessCommittee: (name: string) => `not 100% sure, but my best guess is the ${name} covers that. i'd double check`,
  guessCommitteeUrl: (name: string, url: string) => `not 100% sure, but my best guess is the ${name} covers that. i'd double check: ${url}`,
  guessOffice: (name: string) => `not 100% sure, but my best guess is ${name} handles that. i'd double check with them`,
  doubleCheckUrl: (url: string) => `i'd double check with usg: ${url}`,
};

// ---------- wording variants (facts locked, wording varied) ----------
//
// Variant 0 of every pool is the line the code writes; the rest say the same thing with the same values.
// NOT in any pool, so always word for word: everything read from the directory (a program's stored text, its
// link, a committee's or office's contact). Names, links and counts in the lines below are put in by code.
// Every "best guess" variant still says it is a guess and to double check.
export const USG_POOLS: Pools = {
  askName: [ASK_NAME, "should i send it with ur name or anonymously?", "do u want ur name on it, or should i send it anonymously?"],
  explainName: [
    EXPLAIN_NAME,
    ["if u use ur name, the committee sees ur first name next to it", "anonymous means there's no name on it at all. which one?"],
    ["with ur name on it, the committee sees ur first name next to it", "anonymous means no name at all. which do u want?"],
  ],
  explainNameOffice: [
    EXPLAIN_NAME_OFFICE,
    ["if u use ur name, the office sees ur first name next to it", "anonymous means there's no name on it. which one?"],
    ["with ur name on it, the office sees ur first name next to it", "anonymous means no name on it at all. which do u want?"],
  ],
  askWhat: [SAY.askWhat, "what's ur question or concern?", "what do u want to ask or raise?"],
  alreadySent: [SAY.alreadySent, "u sent that one already and it's still open", "that one's already sent by u, and it's still open"],
  whenPickedUp: [SAY.whenPickedUp, "i'll text u once they pick it up", "when they pick it up, i'll text u"],
  joined: (others, committee) => [
    UT.joined(others, committee),
    `${others} already sent that to the ${committee}, so i put u on it too`,
    `${others} sent that to the ${committee} already, so i added u to it`,
  ],
  sent: (committee) => [
    UT.sent(committee),
    `it's sent to the ${committee}. i'll text u when they pick it up.`,
    `sent to the ${committee}, and i'll text u when they pick it up.`,
  ],
  sentAnon: [SAY.sentAnon, "it went anonymously, ur name isn't on it", "sent it anonymously. ur name isn't on it"],
  sentWithoutName: [
    SAY.sentWithoutName,
    "i wasn't sure which u meant, so i sent it without ur name",
    "couldn't tell which u meant, so i sent it without ur name",
  ],
  heldOff: [
    SAY.heldOff,
    "ok, i didn't send that one. tell me again whenever u want it sent",
    "ok, holding off on that one. whenever u want it sent, tell me again",
  ],
  allGood: [SAY.allGood, "no worries", "all good, no worries"],
  leftIt: [SAY.leftIt, "no worries, i won't send it", "ok, leaving that one alone"],
  sentOffice: (office) => [
    UT.sentOffice(office),
    `it's with ${office} now. i'll text u when they pick it up.`,
    `passed it along to ${office}, and i'll text u when they pick it up.`,
  ],
  joinedOffice: (others, office) => [
    UT.joinedOffice(others, office),
    `${others} already raised that with ${office}, so i put u on it too`,
    `${others} raised that with ${office} already, so i added u to it`,
  ],
  goesTo: (office) => [UT.goesTo(office), `this is one for ${office}`, `that's ${office}'s to handle`],
  demoNote: DEMO_NOTE_POOL,
  askJoinName: [ASK_JOIN_NAME, "do u want ur name on it too, or should i keep u anonymous?", "should i add ur name to it too, or keep u anonymous?"],
  explainJoinName: [
    EXPLAIN_JOIN_NAME,
    ["if ur name's on it, usg can ask to talk to u about it, and i'd check with u first", "anonymous means ur only counted. which one?"],
    ["with ur name on it, usg could ask to talk to u, and i'd ask u before connecting anyone", "anonymous means ur just a count. which do u want?"],
  ],
  nameAdded: [SAY.nameAdded, "got it, ur name's on it. if usg wants to talk, i'll ask u first", "ur name's on it now. i'll check with u first if usg wants to talk"],
  keptAnon: [SAY.keptAnon, "no worries, ur counted with no name on it", "all good, i left ur name off. u still count"],
  joinUnsure: [SAY.joinUnsure, "i wasn't sure which u meant, so i left ur name off", "couldn't tell which u meant, so ur name's not on it"],
  exampleMember: [
    SAY.exampleMember,
    "(heads up: i looped in a stand-in usg member for the hackathon. no real usg members are on here yet)",
    "(note: the usg member i texted is an example for the hackathon, not a real member yet)",
  ],
  cancelled: CANCELLED_POOL,
  offerSend: [SAY.offerSend, "want me to send ur question to them?", "should i send them ur question?"],
  guessCommittee: (name) => [
    UT.guessCommittee(name),
    `i'm not 100% sure, but my best guess is the ${name} covers that. i'd double check`,
    `not 100% sure on this, but my best guess is that the ${name} covers it. i'd double check`,
  ],
  guessCommitteeUrl: (name, url) => [
    UT.guessCommitteeUrl(name, url),
    `i'm not 100% sure, but my best guess is the ${name} covers that. i'd double check: ${url}`,
    `not 100% sure on this, but my best guess is that the ${name} covers it. i'd double check: ${url}`,
  ],
  guessOffice: (name) => [
    UT.guessOffice(name),
    `i'm not 100% sure, but my best guess is ${name} handles that. i'd double check with them`,
    `not 100% sure on this, but my best guess is that ${name} handles it. i'd double check with them`,
  ],
  unsure: [SAY.unsure, "honestly i'm not sure on that one, and i don't wanna make something up", "not sure on that one tbh, and i don't wanna make something up"],
  doubleCheck: [SAY.doubleCheck, "i'd double check that with usg", "double check with usg on that"],
  doubleCheckUrl: (url) => [UT.doubleCheckUrl(url), `i'd double check that with usg: ${url}`, `double check with usg on that: ${url}`],
  checkWithUsg: [CHECK_WITH_USG, "i'd check with usg on that", "i'd check with usg to be sure"],
  runsThis: (name) => [UT.runsThis(name), `this one's run by usg: ${name}`, `usg runs that: ${name}`],
  reachAt: (contact) => [UT.reachAt(contact), `u can reach them here: ${contact}`, `to reach them: ${contact}`],
};

export const USG_VOICE: Voice = makeVoice("usg", USG_POOLS);

const YES = /^(?:yes|yea|yeah|yep|yup|ya|sure|ok|okay|k|pls|please|do it|send it|go ahead|go for it|bet|ye)\b/i;
const NO = /^(?:no|nah|nope|i'?m good|im good|all good|not rn|no need)\b/i;

/** The concern itself, without the "tell usg that" in front of it: this text is shown to a committee member. */
function concernWords(text: string): string {
  const cut = text.replace(/^(?:(?:hey|yo|ok|so)[ ,]+)?(?:i (?:have|got) a (?:complaint|concern|suggestion)(?: (?:for|about) (?:usg|student government))?|(?:(?:can|could) (?:u|you) )?(?:pls |please )?(?:tell|let) (?:usg|student government)(?: know)?(?: that)?|(?:complaint|concern|suggestion) for (?:usg|student government))\s*[:,.-]*\s*/i, "").trim();
  return cut.length >= 12 ? cut : text;
}

// ---------- the first message ----------

async function start(ctx: FlowContext): Promise<void> {
  const text = ctx.event.text.trim().replace(/\s+/g, " ");
  if (!text) {
    ctx.setState(null);
    await ctx.say(SAY.askWhat);
    return;
  }
  const d = ctx.intent.details;
  // Where this came from. `fromChat`: the chat brain handed it over and the student never asked for it to be sent.
  // `fromFirstTen`: their answer to "what's one thing u wish was easier". Either way it began as talk, so it is
  // offered first. `words`: the repair flow's guard passed it here with what they said.
  const fromChat = d.fromChat === true;
  const handed = Array.isArray(d.words) ? d.words.filter((w): w is string => typeof w === "string" && !!w.trim()) : [];
  // Only the router model read this as usg's: the keyword rules don't, and they never asked for it to go anywhere.
  // That is talk too, wherever the model's read came from.
  const modelOnly = ctx.intent.source === "ai" && !handed.length && !asksToPassOn(text) && fallbackIntent({ text, hasImage: false, state: null }).flow !== "usg";
  const began = fromChat || d.fromFirstTen === true || modelOnly;
  // Talk builds over a few messages ("my ra doesn't enforce it", then "i told them but they didn't do anything"):
  // what he understood is their own recent words, not only the last text, whichever model read it as a concern.
  const thread = handed.length ? handed : fromChat || modelOnly ? ownWords(ctx.db, ctx.event.chatId, text) : [text];
  // Their own words so far, as one line: what the concern is filled in with, so a yes never asks for it again.
  const subject = joinWords(thread.length ? thread : [text]) || text;
  // "can u report my ra" is worded as a question and is still them asking for it to go somewhere.
  const concern = ((fromChat || modelOnly) && (d.meant === "concern" || isHousingLife(subject))) || handed.length > 0 || (asksToPassOn(text) && isHousingLife(text)) || isConcern(text, ctx.intent.action);
  const program = findProgram(ctx, text);

  // A plain question a program covers: the stored answer and nothing else. No model call needed.
  if (program && !concern) {
    ctx.setState(null);
    await ctx.say(...programBubbles(program));
    return;
  }

  const topic = await pickTopic(ctx, concern ? subject : text);
  const committee = committeeFor(ctx, topic);

  if (concern) {
    // The program comes first only when they also asked something a program answers ("is there a shuttle to lax?
    // ubers are insane"). A plain complaint that happens to share a word with a program (late village shuttles
    // and the lax shuttle) is just the complaint: reciting the program at them would be ignoring what they said.
    const asked = /\?|\b(?:is there|are there|does usg|do they|do u know|how do i|how can i|when is|when does|where (?:is|do|can))\b/i.test(text);
    // Or when they named the program itself ("the rso funding deadlines are ridiculous"), not just one shared word.
    const low = text.toLowerCase();
    const named = !!program && [program.name.replace(/^usg\s+/i, ""), ...program.topics].some((p) => p.trim().includes(" ") && low.includes(p.trim().toLowerCase()));
    const route = concernRoute(ctx, subject, topic);
    // A hall they named goes along. A building that is not a residence hall (annenberg) is never treated as one.
    const hall = route.office ? findPlace(ctx.db, subject) : null;
    const p: Pending = {
      description: concernWords(subject).slice(0, 300),
      topic: route.office ? "housing" : topic,
      routedTo: route.routedTo,
      ...(route.office ? { office: route.office } : {}),
      ...(hall?.kind === "dorm" ? { locationText: hall.name } : {}),
    };
    const lead = program && (asked || named) ? programBubbles(program) : [];
    // They said yes to something troy offered in his own words a moment ago. Code can't know what that offer named,
    // so it says where this goes and asks the one question itself; a yes to that is the yes that counts. It never
    // adds them to someone else's concern on the model's word: that case gets the full offer.
    if (d.accepted === true && !sameConcern(ctx, p)) await raise(ctx, p, [...lead, UT.goesTo(toWords(p))]);
    // It began as talk, or it is headed to an office they never named: say what he could do and wait for a yes.
    else if (began || (p.office && !asksToPassOn(text))) await offer(ctx, p, lead);
    else await raise(ctx, p, p.office ? [...lead, UT.goesTo(p.office)] : lead);
    return;
  }

  // A question no program covers: an honest best guess in one or two bubbles, a link only from the directory.
  const others = directoryRows(ctx.db).filter((r) => r.kind !== "usg_program");
  const fit = rowMentioned(others, text) ?? (topic !== "other" ? committee : null);
  if (fit?.kind === "usg_committee") {
    ctx.setState({ flow: "usg", step: "offer_send", data: { description: text.slice(0, 300), topic, routedTo: fit.name } });
    await ctx.say(fit.url ? UT.guessCommitteeUrl(fit.name, fit.url) : UT.guessCommittee(fit.name), SAY.offerSend);
    return;
  }
  ctx.setState(null);
  if (fit) {
    const reach = fit.url ?? fit.contactMethod;
    await ctx.say(UT.guessOffice(fit.name), ...(reach ? [reach] : []));
    return;
  }
  const general = rowForTopic(directoryRows(ctx.db, "usg_committee"), "other");
  const unsure = SAY.unsure;
  const guess = await composeReply({
    goal:
      `a student asked: ${JSON.stringify(text.slice(0, 300))}. give your honest best guess in one short bubble. ` +
      "say plainly that you're not sure and that they should double check. no links, no numbers, no names of offices or people.",
    facts: {},
    notes: userNotes(ctx.db, ctx.user.id),
    fallback: [unsure],
  });
  await ctx.say(guess[0] ?? unsure, general?.url ? UT.doubleCheckUrl(general.url) : SAY.doubleCheck);
}

// ---------- handler ----------

/** True when a text that didn't answer the open question reads like a new usg message of its own. */
function looksLikeNewAsk(ctx: FlowContext, text: string): boolean {
  if (text.split(/\s+/).length < 4) return false;
  return !!findProgram(ctx, text) || topicFromWords(text) !== "other" || QUESTION.test(text.toLowerCase());
}

export const usg: FlowHandler = {
  name: "usg",
  async handle(plain) {
    // Everything this flow says goes out through USG_VOICE: facts as written, wording from the pools.
    const ctx = USG_VOICE.wrap(plain);
    // An open simulation (the usg member's side, played out) gets the message first, taps included.
    if (await simulationTurn(plain, OWN_STEPS)) return;
    // A usg member's answer to a summary, or a student's answer about joining a group chat with them, comes first.
    if (await handleStaffTurn(plain)) return;
    // A thumbs up or down on troy's offer answers it, and so does a pick on its poll or on the name poll. Any other
    // tapback or poll vote means nothing here.
    if (ctx.event.reaction || ctx.event.pollVote) {
      if (ctx.state?.flow === "usg" && ctx.state.step === OFFER_STEP) await answerOffer(ctx, ctx.state);
      else if (ctx.state?.flow === "usg" && (ctx.state.step === "ask_name" || ctx.state.step === "ask_join_name") && isFresh(ctx.state) && pollPick(ctx.event, pollOf(ctx.state.data.poll)) >= 0) await converse(ctx);
      return;
    }
    try {
      await converse(ctx);
    } finally {
      // A member who raised something of their own still holds their summary afterwards.
      restoreStaffPointer(ctx.db, ctx.user.id);
    }
  },
};

/**
 * Their answer to an offer. Only a yes (typed, or a thumbs up on that bubble) starts anything, filled in with what
 * they already said. A no drops it with one easy line. Anything else drops it too: a new request goes where it
 * belongs, and plain chat is left for the chat brain (this flow stays silent, so the pipeline passes it on).
 */
async function answerOffer(ctx: FlowContext, state: FlowState): Promise<void> {
  const tap = !!(ctx.event.reaction || ctx.event.pollVote);
  const pending = pendingFrom(state.data);
  const text = ctx.event.text.trim();
  if (!pending || !offerLive(ctx.db, ctx.event.chatId, state)) {
    // Lapsed, or he has said something else since: a "yes" now is not a yes to this.
    ctx.setState(null);
    if (!tap) await movedOn(ctx, text);
    return;
  }
  // A pick on the offer's poll: with their name, anonymously, or not now.
  const picked = pollPick(ctx.event, pollOf(state.data.poll));
  if (picked === 0 || picked === 1) {
    await raise(ctx, pending, [], picked === 0 ? "name" : "anonymous");
    return;
  }
  if (picked === 2) {
    ctx.setState(null);
    await ctx.say(SAY.leftIt);
    return;
  }
  const answer = readYesNo({ event: ctx.event, questionMessageId: openQuestionId(ctx.db, ctx.user.id, state) });
  // The offer has been standing through a reply or two of his: the yes gets where it goes said back before the question.
  const lead = state.data.standing === true ? [UT.goesTo(toWords(pending))] : [];
  if (tap) {
    if (answer === "yes") await raise(ctx, pending, lead);
    else if (answer === "no") {
      ctx.setState(null);
      await ctx.say(SAY.leftIt);
    }
    return;
  }
  const choice = parseChoice(text);
  if (CANCEL.test(text) || (answer === "no" && !choice)) {
    ctx.setState(null);
    await ctx.say(SAY.leftIt);
    return;
  }
  // "anonymously" or "with my name" is a yes that also answers the next question.
  if (choice) {
    await raise(ctx, pending, [], choice);
    return;
  }
  if (answer === "yes") {
    await raise(ctx, pending, lead);
    return;
  }
  // A question about the choice gets a plain answer, and the offer stays open.
  if (asksAboutName(text)) {
    const ids = await ctx.say(...(pending.office ? EXPLAIN_NAME_OFFICE : EXPLAIN_NAME));
    ctx.setState({ flow: "usg", step: OFFER_STEP, data: { ...state.data, qid: [...ids].reverse().find((id) => !!id) ?? null, lastOut: newestOutId(ctx.db, ctx.event.chatId) } });
    return;
  }
  // Not an answer. A request for another flow goes there, and a new ask of this flow starts fresh: the offer is gone.
  if (await passToOtherFlow(ctx, "usg")) return;
  if (startsNewAsk(ctx, text)) {
    ctx.setState(null);
    await start({ ...ctx, state: null });
    return;
  }
  // Otherwise they are talking. He stays silent here with the offer still open, and the pipeline passes the message
  // to the chat brain, which keeps the offer standing only while they are still on this (src/flows/smalltalk.ts)
  // and drops it the moment they have moved on. He never makes the same offer again message after message.
}

/** A dropped offer's message: another flow's request goes there, a new ask of this flow starts fresh, and chat is left alone. */
async function movedOn(ctx: FlowContext, text: string): Promise<void> {
  if (await passToOtherFlow(ctx, "usg")) return;
  if (startsNewAsk(ctx, text)) await start({ ...ctx, state: null });
}

/** A message that is a new ask of this flow in its own right: they want something passed on, or ask about a program or a topic. */
function startsNewAsk(ctx: FlowContext, text: string): boolean {
  const asks = QUESTION.test(text.toLowerCase());
  return text.split(/\s+/).length >= 4 && (asksToPassOn(text) || !!findProgram(ctx, text) || (asks && topicFromWords(text) !== "other"));
}

async function converse(ctx: FlowContext): Promise<void> {
  {
    const state = ctx.state?.flow === "usg" ? ctx.state : null;
    const pending = state ? pendingFrom(state.data) : null;
    const text = ctx.event.text.trim();

    if (state?.step === OFFER_STEP) {
      await answerOffer(ctx, state);
      return;
    }

    const joinId = state?.step === "ask_join_name" && typeof state.data.reportId === "number" ? state.data.reportId : null;

    if (!state || !pending || !isFresh(state)) {
      if (state) ctx.setState(null);
      if (joinId !== null) await tellStaff(ctx, joinId);
      await start({ ...ctx, state: null });
      return;
    }

    // The optional name on a concern they joined. They are already counted, so nothing here can lose their concern.
    // A pick on the name poll is the choice, the same as typing it.
    const pickedIndex = pollPick(ctx.event, pollOf(state.data.poll));
    const picked: "name" | "anonymous" | null = pickedIndex === 0 ? "name" : pickedIndex === 1 ? "anonymous" : null;
    if (state.step === "ask_join_name" && joinId !== null) {
      const choice = picked ?? parseChoice(text);
      if (!choice && asksAboutName(text)) {
        ctx.setState({ flow: "usg", step: "ask_join_name", data: { ...state.data } });
        await ctx.say(...EXPLAIN_JOIN_NAME);
        return;
      }
      ctx.setState(null);
      if (choice === "name") recordPerson(ctx.db, joinId, ctx.user.id, true);
      // Now the member's summary can go out with the right counts.
      await tellStaff(ctx, joinId);
      if (choice) await ctx.say(choice === "name" ? SAY.nameAdded : SAY.keptAnon);
      else if (CANCEL.test(text) || NO.test(text)) await ctx.say(SAY.keptAnon);
      else if (await passToOtherFlow(ctx, "usg")) return;
      else if (YES.test(text)) await ctx.say(SAY.joinUnsure);
      else if (looksLikeNewAsk(ctx, text)) await start({ ...ctx, state: null });
      return;
    }

    if (CANCEL.test(text)) {
      ctx.setState(null);
      await ctx.say(CANCELLED);
      return;
    }

    if (state.step === "ask_name") {
      const choice = picked ?? parseChoice(text);
      if (choice) {
        await send(ctx, pending, choice === "anonymous");
        return;
      }
      // A question about the choice gets a plain answer and the same question again. Nothing is sent on it.
      if (asksAboutName(text)) {
        ctx.setState({ flow: "usg", step: "ask_name", data: { ...state.data } });
        await ctx.say(...(pending.office ? EXPLAIN_NAME_OFFICE : EXPLAIN_NAME));
        return;
      }
      // Not an answer. Something for another flow goes there; nothing is sent without their say.
      if (await passToOtherFlow(ctx, "usg")) return;
      if (YES.test(text)) {
        // They want it sent but didn't pick. Asked once already, so take the choice that shares less.
        await send(ctx, pending, true, SAY.sentWithoutName);
        return;
      }
      ctx.setState(null);
      if (NO.test(text)) await ctx.say(CANCELLED);
      else if (looksLikeNewAsk(ctx, text)) await start({ ...ctx, state: null });
      else await ctx.say(SAY.heldOff);
      return;
    }

    if (state.step === "offer_send") {
      if (YES.test(text)) {
        await raise(ctx, pending);
        return;
      }
      if (await passToOtherFlow(ctx, "usg")) return;
      ctx.setState(null);
      if (NO.test(text)) await ctx.say(SAY.allGood);
      else await start({ ...ctx, state: null });
      return;
    }

    await start({ ...ctx, state: null });
  }
}
