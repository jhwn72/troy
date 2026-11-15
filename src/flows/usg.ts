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

import type { FlowContext, FlowHandler } from "../types.ts";
import { askJson, composeReply } from "../ai.ts";
import { CANCEL, CANCELLED, CANCELLED_POOL, directoryRows, follow, insertReport, isFresh, makeVoice, openReports, othersPhrase, passToOtherFlow, rowForTopic, rowMentioned, sentenceBubbles, similarText, userNotes } from "./reports-shared.ts";
import type { DirectoryRow, Pools, Voice } from "./reports-shared.ts";

export const TOPICS = ["dining", "safety", "housing", "academics", "transportation", "club funding", "other"] as const;
export type Topic = (typeof TOPICS)[number];

export const ASK_NAME = "want me to send it with ur name or anonymously?";
const CHECK_WITH_USG = "i'd check with usg";
/** Used only if the directory has no committee rows (an unseeded database). */
const ROUTE_FALLBACK = "USG";

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

// ---------- concerns ----------

interface Pending {
  description: string;
  topic: Topic;
  routedTo: string;
}

function pendingFrom(data: Record<string, unknown>): Pending | null {
  if (typeof data.description !== "string" || typeof data.routedTo !== "string") return null;
  return { description: data.description, topic: asTopic(data.topic) ?? "other", routedTo: data.routedTo };
}

/** Joins an open concern that says the same thing, or asks the one question (name or anonymous). */
async function raise(ctx: FlowContext, p: Pending, lead: string[] = []): Promise<void> {
  const dup = openReports(ctx.db, "usg_concern").find((r) => r.routedTo === p.routedTo && similarText(p.description, r.description ?? ""));
  if (dup) {
    ctx.setState(null);
    const { result, others } = follow(ctx.db, dup, ctx.user.id);
    if (result === "already") await ctx.say(...lead, SAY.alreadySent, SAY.whenPickedUp);
    // Followers are never shown by name on the dashboard (only a count), so there is nothing to ask here.
    else await ctx.say(...lead, UT.joined(othersPhrase(others), p.routedTo), SAY.whenPickedUp);
    return;
  }
  ctx.setState({ flow: "usg", step: "ask_name", data: { ...p } });
  await ctx.say(...lead, ASK_NAME);
}

async function send(ctx: FlowContext, p: Pending, anonymous: boolean, note?: string): Promise<void> {
  ctx.setState(null);
  insertReport(ctx.db, { userId: ctx.user.id, kind: "usg_concern", anonymous, category: p.topic, description: p.description, routedTo: p.routedTo });
  const bubbles = [UT.sent(p.routedTo)];
  if (note) bubbles.push(note);
  else if (anonymous) bubbles.push(SAY.sentAnon);
  await ctx.say(...bubbles);
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
  if (/\bname\b/.test(t) && t.split(" ").length <= 6) return "name";
  if (/^(?:me|mine|as me)$/.test(t)) return "name";
  return null;
}

/** True when the text is a question about names or anonymity, which gets an explanation instead of a send. */
export function asksAboutName(text: string): boolean {
  const t = text.toLowerCase().replace(/[‘’]/g, "'").trim();
  return ASKS_ABOUT_IT.test(t) && /\bname|\banon|\bsee\b|\bknow\b|\bwho\b|\bprivate|\bidentif/.test(t);
}

export const EXPLAIN_NAME = ["with ur name, the committee sees ur first name next to it", "anonymous means no name at all. which one?"];

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
};

/** Lines with a value in them (a committee, a link, how many others). Code puts the value in; these only hold the words around it. */
const UT = {
  runsThis: (name: string) => `usg runs this one: ${name}`,
  reachAt: (contact: string) => `u can reach them at ${contact}`,
  joined: (others: string, committee: string) => `${others} already sent that to the ${committee}, so i added u to it`,
  sent: (committee: string) => `sent to the ${committee}. i'll text u when they pick it up.`,
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

// ---------- the first message ----------

async function start(ctx: FlowContext): Promise<void> {
  const text = ctx.event.text.trim().replace(/\s+/g, " ");
  if (!text) {
    ctx.setState(null);
    await ctx.say(SAY.askWhat);
    return;
  }
  const concern = isConcern(text, ctx.intent.action);
  const program = findProgram(ctx, text);

  // A plain question a program covers: the stored answer and nothing else. No model call needed.
  if (program && !concern) {
    ctx.setState(null);
    await ctx.say(...programBubbles(program));
    return;
  }

  const topic = await pickTopic(ctx, text);
  const committee = committeeFor(ctx, topic);

  if (concern) {
    // The program comes first when one fits, then the concern still goes to a committee.
    await raise(ctx, { description: text.slice(0, 300), topic, routedTo: committee?.name ?? ROUTE_FALLBACK }, program ? programBubbles(program) : []);
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
    // Tapbacks and poll votes mean nothing here.
    if (ctx.event.reaction || ctx.event.pollVote) return;
    const state = ctx.state?.flow === "usg" ? ctx.state : null;
    const pending = state ? pendingFrom(state.data) : null;
    const text = ctx.event.text.trim();

    if (!state || !pending || !isFresh(state)) {
      if (state) ctx.setState(null);
      await start({ ...ctx, state: null });
      return;
    }
    if (CANCEL.test(text)) {
      ctx.setState(null);
      await ctx.say(CANCELLED);
      return;
    }

    if (state.step === "ask_name") {
      const choice = parseChoice(text);
      if (choice) {
        await send(ctx, pending, choice === "anonymous");
        return;
      }
      // A question about the choice gets a plain answer and the same question again. Nothing is sent on it.
      if (asksAboutName(text)) {
        ctx.setState({ flow: "usg", step: "ask_name", data: { ...state.data } });
        await ctx.say(...EXPLAIN_NAME);
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
  },
};
