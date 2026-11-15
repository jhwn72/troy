// Alert topics as a conversation: follow, unfollow, suggest a new one, post to one, and "i'm in" on someone's post.
//
// Code decides every fact and action here: which topic a text means, whether a topic may exist, who is verified
// or banned, who is near enough and awake, how many people were texted, whether two people may be connected.
// The words Troy uses come from the chat brain (sayInHisWords in src/brain.ts) with rotated fallback lines for
// when the model is down. Nothing in this file is a fixed reply except the posting ban, which belongs to the
// food flow's copy, and the relay lines, which belong to src/relay.ts.
//
// Open steps (flow "topics"):
//   post_place     asked where the thing they posted is happening      data: { draft }
//   post_topic     asked which topic a post is for                     data: { text }
//   suggest_ask    asked what topic they have in mind                  data: {}
//   unfollow_which asked which texts to stop                           data: {}
//   alerted        got someone's post; "i'm in" or a tapback joins     data: { postId }
//   join_ask       the poster is asked if Troy may connect them        data: { postId, joinerId, askId }

import type { DatabaseSync } from "node:sqlite";
import type { FlowContext, FlowHandler, FlowName, FlowState } from "../types.ts";
import * as brain from "../brain.ts";
import { getFlowState, getUserById, setFlowState } from "../db/index.ts";
import { pickVariant } from "../voice.ts";
import { QUIET_TIME_ZONE, laMinutes } from "../quiet.ts";
import { RELAY_COPY, activeRelayFor, endRelayByContext, startRelay as realStartRelay } from "../relay.ts";
import { isBusy, onSweep, onUserGone, parkAsk, registerPendingHooks } from "../pending.ts";
import { FOOD_COPY, FOOD_VOICE, countFollowers, findSubscribers, saysFake, spotIn, walkLine, yesOrNo } from "./food.ts";
import { DECISION, aside, simulateIfAlone, simulationTurn } from "../staff.ts";
import { unvoiced } from "./reports-shared.ts";
import type { Topic } from "../topics.ts";
import {
  cleanTopicName,
  createTopic,
  findTopic,
  getTopic,
  isSubscribed,
  judgeTopic as realJudgeTopic,
  listTopics,
  saveTopicRequest,
  screenedOut,
  subscribe,
  subscriptionKeys,
  topicByKey,
  topicNoun,
  topicsFor,
  unsubscribe,
} from "../topics.ts";

export const TOPICS: FlowName = "topics";

/** A post with no time in it stays up this long. */
export const POST_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_POST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A game "at 6" is still worth a text for this long after it starts. */
const AFTER_START_MS = 60 * 60 * 1000;
/** Rate limits: what one person may post, and how many topic alerts one person may get, per hour. */
export const MAX_POSTS_PER_HOUR = 3;
export const MAX_ALERTS_PER_HOUR = 4;
/** This many different people reporting a post takes it down until staff look. */
export const REPORTS_TO_HIDE = 3;
const STEP_STALE_MS = 30 * 60 * 1000;
/** Every step this flow opens. Any other open step under this flow is a simulation's. */
const OWN_STEPS: ReadonlySet<string> = new Set(["alerted", "join_ask", "post_place", "post_topic", "suggest_ask", "unfollow_which"]);
const ALERT_STALE_MS = 6 * 60 * 60 * 1000;

// ---------- wording ----------

/** What sayInHisWords in src/brain.ts takes. */
export interface Brief {
  goal: string;
  mustCover: string[];
  /** Values that must appear exactly as written (a place, a count, a topic's name). */
  facts?: Record<string, string>;
  /** Whole replies, one to three bubbles each. One is used, rotated per person, when the model is down or its reply fails a check. */
  fallback: string[][];
}
export type SayInHisWords = (ctx: FlowContext, brief: Brief) => Promise<string[]>;
export type ReplyAtStep = (
  ctx: FlowContext,
  step: { flow: string; waitingFor: string; canDo: { name: string; when: string }[]; facts?: Record<string, string> },
) => Promise<{ bubbles: string[]; action: string | null }>;

type StartRelay = (db: DatabaseSync, a: number, b: number, context: string, labels?: { a?: string; b?: string }) => number;

export type TopicsDeps = {
  sayInHisWords: SayInHisWords;
  /** Null when the chat brain doesn't have it; the step then answers from its own fallback lines. */
  replyAtStep: ReplyAtStep | null;
  judgeTopic: typeof realJudgeTopic;
  startRelay: StartRelay;
  now: () => number;
};

const brainFn = <T>(name: string): T | null => {
  const fn = (brain as unknown as Record<string, unknown>)[name];
  return typeof fn === "function" ? (fn as T) : null;
};

const defaults: TopicsDeps = {
  // The chat brain's own function when it is there. An empty answer makes inHisWords use the brief's fallback.
  sayInHisWords: async (ctx, brief) => (await brainFn<SayInHisWords>("sayInHisWords")?.(ctx, brief)) ?? [],
  replyAtStep: null,
  judgeTopic: realJudgeTopic,
  startRelay: realStartRelay,
  now: () => Date.now(),
};
let deps: TopicsDeps = { ...defaults };

/** Tests only: replace the wording call, the topic judge, the relay opener or the clock. Null restores the real ones. */
export function setTopicsDeps(over: Partial<TopicsDeps> | null): void {
  deps = over ? { ...deps, ...over } : { ...defaults };
}

/** One whole fallback reply, rotated per person and key so nobody gets the same wording twice in a row. */
export function rotate(db: DatabaseSync, userId: number, key: string, variants: string[][]): string[] {
  const joined = variants.map((v) => v.join("\n"));
  return pickVariant(db, userId, `say.${key}`, joined).split("\n").filter(Boolean);
}

/**
 * A reply in Troy's own words for the person in `ctx`. The chat brain writes it; this only makes sure the result
 * is usable and that every fact is in it exactly, and otherwise uses one of the brief's fallback replies.
 */
export async function inHisWords(ctx: FlowContext, key: string, brief: Brief): Promise<string[]> {
  try {
    const out = await deps.sayInHisWords(ctx, brief);
    const bubbles = Array.isArray(out) ? out.filter((b): b is string => typeof b === "string" && !!b.trim()) : [];
    const all = bubbles.join("\n");
    if (bubbles.length && bubbles.length <= 3 && Object.values(brief.facts ?? {}).every((v) => !v || all.includes(v))) return bubbles;
  } catch {
    // The fallback below is the answer.
  }
  return rotate(ctx.db, ctx.user.id, key, brief.fallback);
}

async function say(ctx: FlowContext, key: string, brief: Brief): Promise<(string | null)[]> {
  return ctx.say(...(await inHisWords(ctx, key, brief)));
}

/**
 * A yes or a no, read the way people text them: "yes", "yeah for sure", "nah i'm good", "no thanks".
 * A question ("ok but why?") is never an answer, and neither is a long message that happens to start with "ok".
 */
export function readsYesNo(text: string): "yes" | "no" | null {
  const exact = yesOrNo(text);
  if (exact) return exact;
  const w = flat(text);
  if (!w || /\?/.test(text ?? "") || w.split(" ").length > 6) return null;
  if (/\b(?:but|wait|why|what|how|who|when|where)\b/.test(w)) return null;
  if (/^(?:no|nah|nope|naw|pass|not rn|not now|not really|im good|i am good|ill pass|no thanks|no thx|rather not|dont)\b/.test(w)) return "no";
  if (/^(?:yes|yeah|yea|yep|yup|ya|yessir|sure|ok|okay|bet|down|im down|lets do it|do it|go for it|please do|pls do|sounds good|for sure|absolutely|def|definitely|why not)\b/.test(w) && !/\b(?:no|not|dont|nah|nvm)\b/.test(w)) return "yes";
  return null;
}

const EMOJI = /\p{Extended_Pictographic}[\u{FE0F}\u{200D}\p{Extended_Pictographic}]*/gu;
/** A topic's name for a sentence or a list: the poll text without its emoji. */
export const nameOf = (t: { label: string }): string => t.label.replace(EMOJI, "").replace(/\s+/g, " ").trim();

function flat(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[‘’'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;
const atSpot = (spot: string) => (/^(?:outside|behind|in front of|next to|near|by|inside)\b/.test(spot) ? spot : `at ${spot}`);

const BRIEFS = {
  followed: (plain: string): Brief => ({
    goal: "they just asked to get texts for a topic and code signed them up. confirm it in one short bubble",
    mustCover: [`what will actually happen from now on, said naturally: troy will text them ${plain}. never quote a poll label or a topic name word for word`],
    fallback: [[`bet, i'll text u ${plain}`], [`done. i'll hit u up ${plain}`], [`got u, i'll lmk ${plain}`], [`ur in. i'll text u ${plain}`]],
  }),
  alreadyFollowing: (plain: string): Brief => ({
    goal: "they asked for texts they are already signed up for. tell them so, easy and short",
    mustCover: [`they're already set: troy texts them ${plain}`],
    fallback: [[`ur already on that one, i'll text u ${plain}`], [`already got u down for that. i'll hit u up ${plain}`], [`u were already in, so ur good. i'll lmk ${plain}`]],
  }),
  unfollowed: (plain: string): Brief => ({
    goal: "they asked to stop one kind of text and code turned only that one off. confirm it in one short bubble",
    mustCover: [`troy won't text them ${plain} anymore`, "everything else stays as it was", "they can ask for it back whenever (describe it, don't give a command)"],
    fallback: [
      [`done, i won't text u ${plain} anymore. lmk if u ever want it back`],
      [`got it, no more texts ${plain}. everything else stays the same`],
      [`ok, that one's off. u won't hear from me ${plain} unless u ask for it back`],
    ],
  }),
  notFollowing: (plain: string): Brief => ({
    goal: "they asked to stop texts they were never signed up for. reassure them in one short bubble",
    mustCover: [`they weren't getting texts ${plain}, so there's nothing to turn off`],
    fallback: [[`u weren't getting those, so ur all good`], [`that one was never on for u, nothing to turn off`], [`ur not signed up for that one, so no texts coming`]],
  }),
  unfollowWhich: (names: string): Brief => ({
    goal: "they want some texts to stop but didn't say which. ask which one, one short question",
    mustCover: ["which texts they want stopped", `what they get right now: ${names}`],
    facts: { names },
    fallback: [[`which ones? rn u get: ${names}`], [`sure, which texts should i stop? ur on: ${names}`], [`can do. which one do u want off? u have: ${names}`]],
  }),
  nothingToStop: (): Brief => ({
    goal: "they asked to stop topic texts but they follow no topics. say so in one short bubble",
    mustCover: ["they aren't signed up for any topic texts right now"],
    fallback: [[`ur not signed up for any topic texts rn, so nothing's coming`], [`nothing to turn off, u don't follow any topics rn`], [`u aren't on any of them rn, ur good`]],
  }),
  suggestAsk: (): Brief => ({
    goal: "they want texts about something that isn't one of the listed topics, but haven't said what. ask what they have in mind, open and curious, one short question",
    mustCover: ["what they'd want texts about"],
    fallback: [[`ooh what do u have in mind?`], [`i'm listening. what would u want texts about?`], [`tell me. what's the thing u wish u got a heads up for?`], [`what are u thinking?`]],
  }),
  created: (name: string): Brief => ({
    goal: "they suggested a new alert topic. it was a good one, so code created it and signed them up. make them feel good about it",
    mustCover: ["that topic didn't exist before they said it", "it's a great idea", "it's now an option every trojan can sign up for", "they're signed up and will get a text when someone posts for it"],
    facts: { name },
    fallback: [
      [`ok ${name} didn't exist until just now. love that`, `i made it a real one, so any trojan can sign up for it. ur the first one in`],
      [`wait that's a good one, nobody had asked for ${name} yet`, `it's live now for everyone, and ur on it. i'll text u when someone posts`],
      [`${name} wasn't a thing before u said it. now it is`, `great call. anyone can follow it now, and i'll hit u up when something comes in`],
    ],
  }),
  existing: (plain: string): Brief => ({
    goal: "they suggested a topic and one like it already exists, so code signed them up for that one. tell them, short",
    mustCover: ["a topic like that already exists", `they're on it now: troy will text them ${plain}`],
    fallback: [[`someone beat u to that one, it already exists. added u, i'll text u ${plain}`], [`that's already a thing on here. ur in, i'll hit u up ${plain}`], [`good news, that one exists already. signed u up, i'll lmk ${plain}`]],
  }),
  unsure: (): Brief => ({
    goal: "they suggested an alert topic troy can't set up on his own right now. no topic was created; the request was saved for a person on the team to look at. be warm, not a rejection",
    mustCover: ["he doesn't have that one set up yet", "he passed the idea along to the team", "he'll text them when something comes up for it"],
    fallback: [
      [`i don't have that one set up yet, so i passed it to the team`, `i'll text u when something comes up for it`],
      [`not one i can spin up on my own rn, but i sent the idea along`, `if something comes up for it i'll text u`],
      [`hmm that one's not set up yet. i flagged it for the team to look at`, `i'll hit u up when there's something for it`],
    ],
  }),
  declined: (): Brief => ({
    goal: "they asked for an alert topic or a post that troy can't help with. decline in one easy line. no lecture, no reason, no emoji",
    mustCover: ["a short, kind no"],
    fallback: [[`sorry, can't help with that one`], [`that's not one i can do, sorry`], [`gonna pass on that one, sorry`], [`can't set that one up, sorry`]],
  }),
  list: (names: string): Brief => ({
    goal: "they asked which topics they can get texts about. list them and invite them to pick or suggest a new one",
    mustCover: [`the topics that exist: ${names}`, "they can ask for any of them, or pitch a new one"],
    facts: { names },
    fallback: [
      [`rn there's: ${names}`, `tell me which ones u want, or pitch me a new one`],
      [`here's what people follow: ${names}`, `say the word on any of them. or tell me one that's missing`],
      [`the list rn: ${names}`, `want any of those? u can also suggest something new`],
    ],
  }),
  mine: (names: string): Brief => ({
    goal: "they asked what they're signed up for. tell them",
    mustCover: [`what they follow: ${names}`],
    facts: { names },
    fallback: [[`ur on: ${names}`], [`rn u get texts for: ${names}`], [`u follow: ${names}`]],
  }),
  mineNone: (): Brief => ({
    goal: "they asked what they're signed up for and it's nothing. say so and offer to change that",
    mustCover: ["they don't follow any topics right now", "they can tell him what they'd want texts about"],
    fallback: [[`ur not following anything rn. tell me what u'd want a heads up about`], [`nothing yet. what would u want texts about?`], [`no topics on ur list rn. lmk what u want to hear about`]],
  }),
  askPlace: (noun: string): Brief => ({
    goal: `they want to post a ${noun} to other trojans but didn't say where it is. ask where, one short question`,
    mustCover: ["where it's happening, so people know where to go"],
    fallback: [[`where at?`], [`which spot? so people know where to go`], [`where's it happening?`], [`nice. where should people show up?`]],
  }),
  whyPlace: (): Brief => ({
    goal: "they asked something instead of saying where their post is happening. answer briefly, then ask where again",
    mustCover: ["the place is so people nearby know where to go", "where it's happening"],
    fallback: [[`just so the people close by know where to go. where's it at?`], [`i only text the ones who are near it, so i need the spot. where is it?`], [`so nobody shows up at the wrong place. which spot?`]],
  }),
  askTopic: (names: string): Brief => ({
    goal: "they want to post something to other trojans but it isn't clear which topic it belongs to. ask which, one short question",
    mustCover: ["which topic it's for", `the topics: ${names}`],
    facts: { names },
    fallback: [[`who should i send that to? the lists rn: ${names}`], [`which crowd is that for? i've got: ${names}`], [`which topic should that go under? there's: ${names}`]],
  }),
  posted: (f: { noun: string; where: string | null; when: string | null; told: number }): Brief => {
    const where = f.where ? ` ${atSpot(f.where)}` : "";
    const when = f.when ? ` ${f.when}` : "";
    const facts: Record<string, string> = { told: people(f.told) };
    if (f.where) facts.where = f.where;
    if (f.when) facts.when = f.when;
    return {
      goal: "they posted something to a topic and code texted the people who follow it and are near enough. confirm it back in troy's own words",
      mustCover: [`what they posted, in a few words (${f.noun})`, f.where ? "where" : "", f.when ? "when" : "", "how many people were texted", "he'll connect anyone who's in, through him"].filter(Boolean),
      facts,
      fallback: [
        [`got it, ur ${f.noun}${where}${when} is out`, `i texted ${people(f.told)} who follow that. i'll connect u when someone's in`],
        [`posted ur ${f.noun}${where}${when}`, `${people(f.told)} just got it. if anyone's in i'll link u up through me`],
        [`ur ${f.noun}${where}${when} is up`, `sent it to ${people(f.told)} nearby. i'll lmk the second someone bites`],
      ],
    };
  },
  postedNobody: (f: { noun: string; where: string | null; when: string | null }): Brief => {
    const where = f.where ? ` ${atSpot(f.where)}` : "";
    const when = f.when ? ` ${f.when}` : "";
    const facts: Record<string, string> = {};
    if (f.where) facts.where = f.where;
    if (f.when) facts.when = f.when;
    return {
      goal: "they posted something to a topic, but nobody who follows it is close by and free right now. be honest about that; the post stays up",
      mustCover: [`what they posted, in a few words (${f.noun})`, f.where ? "where" : "", f.when ? "when" : "", "nobody who follows that is close by right now", "it's still up in case someone asks"].filter(Boolean),
      facts,
      fallback: [
        [`got it, ur ${f.noun}${where}${when} is up`, `nobody who follows that is close by rn, but it's there if anyone asks`],
        [`posted ur ${f.noun}${where}${when}`, `no one on that list is nearby rn. i'll connect u if someone turns up`],
        [`ur ${f.noun}${where}${when} is saved`, `nobody close follows that rn, so no texts went out yet`],
      ],
    };
  },
  postedNobodyNext: (): Brief => ({
    goal: "their post is up but nobody who follows that topic was close by to text. in one short bubble say what happens next and one thing they can do meanwhile. never end on 'nobody's around'",
    mustCover: ["if someone's in, he connects them right here through him", "they can post it again later, when more people who follow it are around"],
    fallback: [
      [`if someone's in i'll connect u two right here. u can also post it again later when more people are around`],
      [`the second someone bites i'll link u up through me. worth posting again in a bit too, when more of them are nearby`],
      [`i'll connect u here as soon as anyone's in. and u can send it again later, once more people who follow it are around`],
    ],
  }),
  tooMany: (): Brief => ({
    goal: "they've posted several things in the last hour and code is holding this one back so people's phones don't blow up. say so kindly",
    mustCover: ["they've posted a few in the last hour", "to try again in a bit"],
    fallback: [[`u've sent out a few in the last hour, so i'm holding this one. try me again in a bit`], [`gonna hold that one, u've posted a few this hour. hit me again later`], [`that's a lot for one hour, so this one's waiting. send it again in a bit`]],
  }),
  postDropped: (): Brief => ({
    goal: "they backed out of posting. acknowledge it, short",
    mustCover: ["nothing was sent"],
    fallback: [[`no worries, didn't send anything`], [`all good, dropped it`], [`ok, nothing went out`]],
  }),
  postEnded: (noun: string): Brief => ({
    goal: "they asked to take their post down and code closed it. confirm, short",
    mustCover: [`their ${noun} is closed and nobody else will be texted about it`],
    fallback: [[`done, closed ur ${noun}`], [`got it, ur ${noun} is down`], [`ok, took ur ${noun} down. nobody else gets it`]],
  }),
  noPost: (): Brief => ({
    goal: "they asked to take a post down but they have none up. say so, short",
    mustCover: ["they don't have a post up right now"],
    fallback: [[`u don't have anything up rn`], [`nothing of urs is posted rn, ur good`], [`there's no post of urs out there rn`]],
  }),
  joinAsking: (): Brief => ({
    goal: "they said they're in on someone's post. code is asking the person who posted it whether troy may connect the two of them through him",
    mustCover: ["he's asking the person who posted it now", "if they say yes he connects the two of them right here, through him, with no numbers shared"],
    fallback: [
      [`bet, asking them now`, `if they're good with it i'll connect u two right here, no numbers shared`],
      [`on it 👀 checking with them`, `if they say yes u two can talk through me, no numbers shared`],
      [`nice, lemme ask them`, `once they say yes i'll pass messages between u here, no numbers shared`],
    ],
  }),
  joinAlready: (): Brief => ({
    goal: "they said they're in again on a post troy already asked the poster about. reassure them, short",
    mustCover: ["he already asked the person who posted it", "he'll text them as soon as there's an answer"],
    fallback: [[`already asked them for u. i'll text u the second they answer`], [`ur already in line on that one, waiting on them`], [`i've got u down, just waiting to hear back`]],
  }),
  joinToldPoster: (): Brief => ({
    goal: "they said they're in on someone's post, and the poster is already talking with someone else about it. code told the poster one more person is in",
    mustCover: ["the person who posted it is already talking with someone about it", "he let them know they're in too"],
    fallback: [[`they're already talking to someone about it, so i let them know ur in too`], [`someone got there a sec before u. i told them u want in as well`], [`they're mid chat with another person on that, but i passed along that ur in`]],
  }),
  joinOver: (): Brief => ({
    goal: "they said they're in on a post that is already over. say so kindly, short, no emoji",
    mustCover: ["that one's over"],
    fallback: [[`that one's over, sorry`], [`ah that one already wrapped up, sorry`], [`u just missed it, that one's done`]],
  }),
  joinNotAvailable: (): Brief => ({
    goal: "they said they're in on someone's post but that person can't be reached through troy right now. say so, short, no emoji",
    mustCover: ["the person who posted it isn't taking messages right now"],
    fallback: [[`they're not taking messages rn, sorry`], [`can't reach them rn, sorry`], [`they've gone quiet on me, sorry`]],
  }),
  joinNoContact: (): Brief => ({
    goal: "they said they're in on someone's post, but they told troy earlier not to connect them with anyone, and code honors that. say so and how to change it",
    mustCover: ["he's not connecting them with anyone because they asked him not to", "they can tell him if they want that changed"],
    fallback: [[`u asked me not to connect u with anyone, so i'm holding off. tell me if u want that changed`], [`i've got u set to no contact, so i can't link u up. lmk if u want to switch that`], [`ur on no contact, so i'm not connecting u. say so if u want it back on`]],
  }),
  ownPost: (): Brief => ({
    goal: "they reacted to their own post. keep it light, short",
    mustCover: ["that's their own post", "he'll text them when someone else is in"],
    fallback: [[`that one's urs lol. i'll text u when someone's in`], [`ur already in, u posted it. i'll lmk when someone bites`], [`that's ur own post. waiting on the others`]],
  }),
  joinDeclinedPoster: (): Brief => ({
    goal: "they said no to being connected with someone who's in on their post. acknowledge, short",
    mustCover: ["no problem", "he'll let the other person know"],
    fallback: [[`no worries, i'll let them know`], [`all good, i'll tell them`], [`ok, i'll pass that along`]],
  }),
  joinMovedOn: (): Brief => ({
    goal: "they said yes to being connected, but the other person is no longer around or the post is over. say so, short",
    mustCover: ["the other person moved on, so there's nothing to connect"],
    fallback: [[`looks like they moved on, nvm`], [`ah they're not around anymore, nvm`], [`that one fell through on their end, nvm`]],
  }),
  relayFailed: (): Brief => ({
    goal: "connecting two people failed on troy's side. say so honestly, short, no emoji",
    mustCover: ["he couldn't set that up right now"],
    fallback: [[`couldn't set that up rn, sorry`], [`that didn't go through on my end, sorry`], [`something broke on my side connecting u two, sorry`]],
  }),
};

/** Lines for someone other than the person texting (an alert, a question for the poster). Code only, rotated per person. */
const OTHER = {
  alertLead: (text: string) => [[`yo, a trojan just posted: "${text}"`], [`heads up, someone just put this out: "${text}"`], [`this just came in from a trojan: "${text}"`], [`one for u. a trojan says: "${text}"`]],
  joinTap: [[`react if ur in`], [`ur in? react to this`], [`react to this and i'll connect u`]],
  joinText: [[`reply "i'm in" if u want in`], [`want in? reply "i'm in"`], [`text "i'm in" and i'll connect u`]],
  joinAsk: (noun: string) => [
    [`someone's in for ur ${noun}`, `want me to connect u two through me? no numbers shared`],
    [`got one for ur ${noun}`, `ok if i connect u two through me? no numbers shared`],
    [`a trojan wants in on ur ${noun}`, `should i connect u two right here? no numbers shared`],
  ],
  oneMore: (noun: string) => [[`one more person is in for ur ${noun}`], [`heads up, someone else wants in on ur ${noun} too`], [`another trojan is in for ur ${noun}`]],
  saidYes: [[`they said yes`], [`they're in`], [`they're good with it`]],
  declined: [[`they passed on chatting, sorry`], [`they'd rather not chat rn, sorry`], [`they said not this time, sorry`]],
  failed: BRIEFS.relayFailed().fallback,
  postOver: (noun: string) => [[`that ${noun} is over, so i closed the chat with them`], [`the ${noun} wrapped up, so i closed that chat`], [`closed the chat with them, that ${noun} is done`]],
};

// ---------- posts ----------

type Row = Record<string, unknown>;

export interface Post {
  id: number;
  topicId: number;
  posterUserId: number;
  text: string;
  locationText: string | null;
  lat: number | null;
  lng: number | null;
  whenText: string | null;
  status: "live" | "ended" | "removed";
  reports: number;
  expiresAt: number;
  createdAt: number;
}

const toPost = (r: Row): Post => ({
  id: r.id as number,
  topicId: r.topicId as number,
  posterUserId: r.posterUserId as number,
  text: r.text as string,
  locationText: (r.locationText as string) ?? null,
  lat: (r.lat as number) ?? null,
  lng: (r.lng as number) ?? null,
  whenText: (r.whenText as string) ?? null,
  status: r.status as Post["status"],
  reports: r.reports as number,
  expiresAt: r.expiresAt as number,
  createdAt: r.createdAt as number,
});

export function getPost(db: DatabaseSync, id: number): Post | null {
  const r = db.prepare("SELECT * FROM topic_posts WHERE id = ?").get(id) as Row | undefined;
  return r ? toPost(r) : null;
}

const isLive = (p: Post | null, now: number): p is Post => !!p && p.status === "live" && p.expiresAt > now;

function nounFor(db: DatabaseSync, post: Post): string {
  const row = db.prepare("SELECT key, label FROM topics WHERE id = ?").get(post.topicId) as { key: string; label: string } | undefined;
  return row ? topicNoun({ key: row.key, label: nameOf(row) }) : "post";
}

/** Phone numbers, emails, links and @handles never go out in a post: people are connected through Troy instead. */
export function redactContacts(text: string): string {
  return (text ?? "")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/\S+@\S+\.\S+/g, " ")
    .replace(/(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g, " ")
    .replace(/(?:^|\s)@[A-Za-z0-9_.]{2,}/g, " ")
    .replace(/\b(?:text|call|dm|message|hmu|hit me up|reach me|contact me|find me|add me|my (?:number|cell|insta|ig|snap|sc)(?: is)?)(?: me)?(?: at| on)?\s*[:,]?\s*(?=[,.!?]|\bor\b|\band\b|$)/gi, " ")
    .replace(/[\s,]*(?:\b(?:or|and|at|on)\b[\s,]*)+$/i, "")
    .replace(/["“”]/g, "'")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .trim()
    .slice(0, 160)
    .trim();
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_NAME = new Intl.DateTimeFormat("en-US", { timeZone: QUIET_TIME_ZONE, weekday: "long" });
const DAY_SHORT: Record<string, string> = { sun: "sunday", mon: "monday", tue: "tuesday", tues: "tuesday", wed: "wednesday", thu: "thursday", thur: "thursday", thurs: "thursday", fri: "friday", sat: "saturday" };

/**
 * The time a post names, as Troy says it back ("at 6", "tomorrow at 6", "on saturday"), and when the post should
 * expire: an hour after a clock time, the end of a named day, otherwise three hours from now. Never past a week.
 */
export function whenIn(text: string, now: number): { whenText: string | null; expiresAt: number } {
  const t = (text ?? "").toLowerCase().replace(/[‘’]/g, "'");
  const cur = laMinutes(new Date(now));
  const today = DAYS.indexOf(DAY_NAME.format(new Date(now)).toLowerCase());

  let dayText: string | null = null;
  let daysAhead: number | null = null;
  const day = t.match(/\b(tonight|today|tomorrow|tmrw|tmr|rn|right now|(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?s?)\b/);
  if (day) {
    const said = day[1]!;
    if (said === "tonight" || said === "today") {
      dayText = said;
      daysAhead = 0;
    } else if (said === "rn" || said === "right now") {
      dayText = "rn";
    } else if (/^t(?:omorrow|mrw|mr)$/.test(said)) {
      dayText = "tomorrow";
      daysAhead = 1;
    } else {
      const plural = said.endsWith("s") && !/^(?:tues|thurs)$/.test(said);
      const base = said.replace(/s$/, "").replace(/day$/, "");
      const name = DAY_SHORT[base] ?? DAYS.find((d) => d.startsWith(base)) ?? null;
      if (name && today !== -1) {
        dayText = `on ${name}${plural ? "s" : ""}`;
        daysAhead = (DAYS.indexOf(name) - today + 7) % 7;
      }
    }
  }

  let clockText: string | null = null;
  let clock: number | null = null;
  const m = t.match(/\b(?:at|around|by|@) ?(\d{1,2})(?::(\d\d))? ?(am|pm)?\b|\b(\d{1,2})(?::(\d\d))? ?(am|pm)\b|\b(\d{1,2}):(\d\d)\b|\b(noon|midnight)\b/);
  if (m) {
    if (m[9]) {
      clock = m[9] === "noon" ? 720 : 0;
      clockText = `at ${m[9]}`;
    } else {
      const h = Number(m[1] ?? m[4] ?? m[7]);
      const min = Number(m[2] ?? m[5] ?? m[8] ?? 0);
      const half = m[3] ?? m[6] ?? null;
      if (h >= 0 && h <= 23 && min <= 59) {
        const shown = `${h}${min ? `:${String(min).padStart(2, "0")}` : ""}${half ?? ""}`;
        clockText = `at ${shown}`;
        if (half) clock = ((h % 12) + (half === "pm" ? 12 : 0)) * 60 + min;
        else if (h > 12 || h === 0) clock = h * 60 + min;
        else {
          // "at 6" with no am or pm: whichever comes next.
          const am = (h % 12) * 60 + min;
          const pm = am + 720;
          const until = (x: number) => (x - cur + 1440) % 1440;
          clock = daysAhead ? (h >= 7 && h <= 11 ? am : pm) : until(am) <= until(pm) ? am : pm;
        }
      }
    }
  }

  const whenText = [dayText, clockText].filter(Boolean).join(" ") || null;
  let ms = POST_TTL_MS;
  if (clock !== null) {
    let mins = clock - cur + (daysAhead ?? 0) * 1440;
    // A time that already went by today, with no day named, means the next one.
    if (mins < -30 && daysAhead === null) mins += 1440;
    if (mins < -30 && daysAhead === 0 && dayText?.startsWith("on ")) mins += 7 * 1440;
    ms = Math.max(mins, 0) * 60_000 + AFTER_START_MS;
  } else if (daysAhead !== null) {
    ms = (daysAhead * 1440 + (1440 - cur)) * 60_000;
  }
  return { whenText, expiresAt: now + Math.min(Math.max(ms, 15 * 60_000), MAX_POST_TTL_MS) };
}

interface Draft {
  topicId: number;
  text: string;
  whenText: string | null;
  expiresAt: number;
}

/** Topics where a post means "come here": Troy asks for the spot once when it's missing. */
const needsPlace = (topic: { key: string }) => topic.key === "pickup";

function recentPosts(db: DatabaseSync, userId: number, now: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM topic_posts WHERE posterUserId = ? AND createdAt > ?").get(userId, now - 60 * 60 * 1000) as { n: number }).n;
}

function recentAlerts(db: DatabaseSync, userId: number, now: number): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM topic_alert_bubbles WHERE userId = ? AND role = 'alert' AND createdAt > ?").get(userId, now - 60 * 60 * 1000) as { n: number }).n;
}

async function startPost(ctx: FlowContext, text: string, known: Topic | null): Promise<void> {
  const { db, user } = ctx;
  const now = deps.now();
  if (!user.verifiedAt) {
    await ctx.say(FOOD_VOICE.line(db, user.id, FOOD_COPY.notVerified));
    return;
  }
  // Posting bans are decided here, never by the model. The ban line is the food flow's fixed one.
  if (user.bannedFromPosting) {
    ctx.setState(null);
    await ctx.say(...FOOD_COPY.banned);
    return;
  }
  // Contact details come out first (people are connected through Troy), then what is left is screened.
  if (screenedOut(redactContacts(text))) {
    ctx.setState(null);
    await say(ctx, "declined", BRIEFS.declined());
    return;
  }
  const hint = typeof ctx.intent.details.topic === "string" ? ctx.intent.details.topic : "";
  const topic = known ?? findTopic(db, text) ?? (hint ? findTopic(db, hint) : null);
  if (!topic) {
    ctx.setState({ flow: TOPICS, step: "post_topic", data: { text } });
    await say(ctx, "askTopic", BRIEFS.askTopic(listTopics(db).map(nameOf).join(", ")));
    return;
  }
  // Free food and stuff has its own flow (counts, claims, holds), and so do rides.
  if (topic.key === "free_nearby" || topic.key === "rides") {
    const to: FlowName = topic.key === "rides" ? "rides" : "food";
    if (await handTo(ctx, to, topic.key === "rides" ? "find" : "post_food")) return;
  }
  if (recentPosts(db, user.id, now) >= MAX_POSTS_PER_HOUR) {
    ctx.setState(null);
    await say(ctx, "tooMany", BRIEFS.tooMany());
    return;
  }
  const clean = redactContacts(text);
  const when = whenIn(text, now);
  const draft: Draft = { topicId: topic.id, text: clean, whenText: when.whenText, expiresAt: when.expiresAt };
  const place = spotIn(db, text);
  if (!place && needsPlace(topic)) {
    ctx.setState({ flow: TOPICS, step: "post_place", data: { draft } });
    await say(ctx, "askPlace", BRIEFS.askPlace(topicNoun({ key: topic.key, label: nameOf(topic) })));
    return;
  }
  await publish(ctx, draft, topic, place);
}

async function publish(ctx: FlowContext, draft: Draft, topic: Topic, place: { spot: string; lat: number | null; lng: number | null } | null): Promise<void> {
  const { db, user } = ctx;
  const now = deps.now();
  const res = db
    .prepare("INSERT INTO topic_posts (topicId, posterUserId, text, locationText, lat, lng, whenText, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(topic.id, user.id, draft.text, place?.spot ?? null, place?.lat ?? null, place?.lng ?? null, draft.whenText, Math.max(draft.expiresAt, now + 15 * 60_000), now);
  const postId = Number(res.lastInsertRowid);
  ctx.setState(null);

  // The food flow's alert engine: followers of this topic who are verified, awake, not paused or stopped,
  // and within their own alert distance. On top of it, nobody gets more than a few topic texts an hour.
  const recipients = await findSubscribers(db, ctx.adapter, { posterUserId: user.id, lat: place?.lat ?? null, lng: place?.lng ?? null }, subscriptionKeys(topic.key), now, {
    skip: (u) => recentAlerts(db, u.id, now) >= MAX_ALERTS_PER_HOUR,
  });
  const tapbacks = ctx.adapter.capabilities().tapbacks;
  const addBubble = db.prepare("INSERT OR REPLACE INTO topic_alert_bubbles (messageId, postId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)");
  let told = 0;
  await Promise.all(
    recipients.map(async ({ user: to, minutes, from }) => {
      const bubbles: { role: string; text: string }[] = [{ role: "alert", text: rotate(db, to.id, "topics.alertLead", OTHER.alertLead(draft.text))[0]! }];
      if (minutes !== null) bubbles.push({ role: "walk", text: FOOD_VOICE.line(db, to.id, walkLine(minutes, from ?? undefined)) });
      bubbles.push({ role: "join", text: rotate(db, to.id, tapbacks ? "topics.joinTap" : "topics.joinText", tapbacks ? OTHER.joinTap : OTHER.joinText)[0]! });
      const ids = await ctx.sayTo(to.id, ...bubbles.map((b) => ({ text: b.text })));
      if (!ids.some((id) => id !== null)) return;
      told++;
      ids.forEach((id, i) => {
        if (id) addBubble.run(id, postId, to.id, bubbles[i]!.role, now);
      });
      // So a plain "i'm in" finds this post. Never on top of a conversation they're already in.
      if (!getFlowState(db, to.id)) ctx.setStateFor(to.id, { flow: TOPICS, step: "alerted", data: { postId } });
    }),
  );

  const f = { noun: topicNoun({ key: topic.key, label: nameOf(topic) }), where: place?.spot ?? null, when: draft.whenText };
  if (told) {
    await say(ctx, "posted", BRIEFS.posted({ ...f, told }));
  } else {
    await say(ctx, "postedNobody", BRIEFS.postedNobody(f));
    // Nobody to text, so nothing would happen next. A judge (or a student with nobody else on here) is offered the
    // other side played out (a follower saying they're in); a student in a live pilot keeps the post up for real people.
    if (await simulateIfAlone(ctx, "topics", { topic: nameOf(topic), post: draft.text, where: place?.spot ?? "", when: draft.whenText ?? "", postId: String(postId) })) return;
    // Otherwise what happens next and one thing they can do, so the post never ends on "nobody's around".
    await say(ctx, "postedNobodyNext", BRIEFS.postedNobodyNext());
  }
  await aside(ctx, {
    step: "topic_post",
    behind: {
      did: "sent it only to followers of that topic who are close enough and not in quiet hours: {inRange} of {following} got the text",
      numbers: { inRange: told, following: countFollowers(db, user.id, subscriptionKeys(topic.key)) },
    },
    decision: DECISION.locationDecides,
  });
}

function livePostOf(db: DatabaseSync, userId: number, now: number): Post | null {
  const r = db.prepare("SELECT * FROM topic_posts WHERE posterUserId = ? AND status = 'live' AND expiresAt > ? ORDER BY id DESC LIMIT 1").get(userId, now) as Row | undefined;
  return r ? toPost(r) : null;
}

/** Close a post: nobody else is asked, open questions about it go away, and a chat opened for it is closed. */
async function closePost(db: DatabaseSync, post: Post, status: "ended" | "removed", tell: (userId: number, bubbles: string[]) => Promise<unknown>): Promise<void> {
  db.prepare("UPDATE topic_posts SET status = ? WHERE id = ? AND status = 'live'").run(status, post.id);
  const open = db.prepare("SELECT userId, data FROM flow_state WHERE flow = ? AND step IN ('alerted','join_ask')").all(TOPICS) as { userId: number; data: string }[];
  for (const s of open) {
    try {
      if ((JSON.parse(s.data) as { postId?: number }).postId === post.id) setFlowState(db, s.userId, null);
    } catch {
      // An unreadable step is left for its own staleness check.
    }
  }
  const relays = db.prepare("SELECT userA, userB FROM relays WHERE context = ? AND status = 'active'").all(`topic:${post.id}`) as { userA: number; userB: number }[];
  if (!relays.length) return;
  endRelayByContext(db, `topic:${post.id}`);
  const noun = nounFor(db, post);
  for (const r of relays) for (const id of [r.userA, r.userB]) await tell(id, rotate(db, id, "topics.postOver", OTHER.postOver(noun)));
}

// ---------- "i'm in" ----------

function alertedPost(db: DatabaseSync, userId: number, now: number): Post | null {
  const r = db
    .prepare("SELECT p.* FROM topic_posts p JOIN topic_alert_bubbles b ON b.postId = p.id WHERE b.userId = ? AND b.role != 'report' AND b.createdAt > ? ORDER BY b.createdAt DESC, p.id DESC LIMIT 1")
    .get(userId, now - ALERT_STALE_MS) as Row | undefined;
  return r ? toPost(r) : null;
}

async function join(ctx: FlowContext, post: Post | null): Promise<void> {
  const { db, user } = ctx;
  const now = deps.now();
  if (!isLive(post, now)) {
    if (ctx.state?.flow === TOPICS && ctx.state.step === "alerted") ctx.setState(null);
    await say(ctx, "joinOver", BRIEFS.joinOver());
    return;
  }
  if (post.posterUserId === user.id) {
    await say(ctx, "ownPost", BRIEFS.ownPost());
    return;
  }
  // Contact rules are checked in code, on both sides, before anyone is asked anything.
  const me = getUserById(db, user.id);
  if (me?.contactMode === "no_contact") {
    await say(ctx, "joinNoContact", BRIEFS.joinNoContact());
    return;
  }
  const poster = getUserById(db, post.posterUserId);
  if (!poster || poster.stopped || poster.contactMode === "no_contact") {
    await say(ctx, "joinNotAvailable", BRIEFS.joinNotAvailable());
    return;
  }
  const mine = db.prepare("SELECT status FROM topic_joins WHERE postId = ? AND userId = ?").get(post.id, user.id) as { status: string } | undefined;
  if (mine && mine.status !== "declined") {
    await say(ctx, "joinAlready", BRIEFS.joinAlready());
    return;
  }
  const noun = nounFor(db, post);
  const mark = (status: string) => db.prepare("INSERT INTO topic_joins (postId, userId, status, createdAt) VALUES (?, ?, ?, ?) ON CONFLICT(postId, userId) DO UPDATE SET status = excluded.status").run(post.id, user.id, status, now);

  // A person is in one relay at a time. Someone already chatting about this post just hears that one more is in.
  const theirRelay = activeRelayFor(db, poster.id);
  if (theirRelay?.context === `topic:${post.id}`) {
    mark("told");
    await ctx.sayToOwed(poster.id, ...rotate(db, poster.id, "topics.oneMore", OTHER.oneMore(noun)).map((text) => ({ text })));
    await say(ctx, "joinToldPoster", BRIEFS.joinToldPoster());
    return;
  }

  const ask = rotate(db, poster.id, "topics.joinAsk", OTHER.joinAsk(noun));
  const step = { flow: TOPICS, step: "join_ask", data: { postId: post.id, joinerId: user.id } as Record<string, unknown> };
  const theirs = getFlowState(db, poster.id);
  const pointer = theirs && theirs.step === "alerted" && (theirs.flow === TOPICS || theirs.flow === "food");
  if (theirs && !pointer && isBusy(db, poster.id, now)) {
    // They're in the middle of something: the question waits its turn and is asked when they're free.
    parkAsk(db, poster.id, step, ask);
  } else {
    // Owed: it answers their own post, so their quiet hours don't hold it back.
    const ids = await ctx.sayToOwed(poster.id, ...ask.map((text) => ({ text })));
    if (!ids.some((id) => id !== null)) {
      await say(ctx, "joinNotAvailable", BRIEFS.joinNotAvailable());
      return;
    }
    ctx.setStateFor(poster.id, { ...step, data: { ...step.data, askId: ids[ids.length - 1] ?? null } });
  }
  mark("asked");
  await say(ctx, "joinAsking", BRIEFS.joinAsking());
}

async function answerJoin(ctx: FlowContext, state: FlowState, yes: boolean): Promise<void> {
  const { db, user } = ctx;
  const now = deps.now();
  const postId = state.data.postId as number;
  const joinerId = state.data.joinerId as number;
  const post = getPost(db, postId);
  const joiner = getUserById(db, joinerId);
  const asked = db.prepare("SELECT status FROM topic_joins WHERE postId = ? AND userId = ?").get(postId, joinerId) as { status: string } | undefined;
  ctx.setState(null);
  const mark = (status: string) => db.prepare("UPDATE topic_joins SET status = ? WHERE postId = ? AND userId = ?").run(status, postId, joinerId);
  const tellJoiner = (key: string, variants: string[][], more: string[] = []) => ctx.sayToOwed(joinerId, ...[...rotate(db, joinerId, key, variants), ...more].map((text) => ({ text })));

  if (!yes) {
    mark("declined");
    await say(ctx, "joinDeclinedPoster", BRIEFS.joinDeclinedPoster());
    if (joiner && asked?.status === "asked") await tellJoiner("topics.declined", OTHER.declined);
    return;
  }
  // Checked again at the moment of connecting: both people's contact rules, and that this is still wanted.
  const me = getUserById(db, user.id);
  if (!isLive(post, now) || !joiner || joiner.stopped || asked?.status !== "asked" || joiner.contactMode === "no_contact" || me?.contactMode === "no_contact") {
    await say(ctx, "joinMovedOn", BRIEFS.joinMovedOn());
    return;
  }
  try {
    const theirs = getFlowState(db, joinerId);
    if (theirs?.flow === TOPICS) ctx.setStateFor(joinerId, null);
    deps.startRelay(db, joinerId, user.id, `topic:${postId}`, { a: "the person who's in", b: "the poster" });
  } catch {
    await say(ctx, "relayFailed", BRIEFS.relayFailed());
    await tellJoiner("topics.failed", OTHER.failed);
    return;
  }
  mark("connected");
  await ctx.say(...RELAY_COPY.start);
  await tellJoiner("topics.saidYes", OTHER.saidYes, RELAY_COPY.start);
}

// ---------- reports ----------

const REPORT = /\b(?:report (?:that|this|it|them|the post)|thats? (?:spam|inappropriate|not ok(?:ay)?|creepy|gross|a scam)|this is (?:spam|inappropriate|not ok(?:ay)?|creepy|a scam)|spam)\b/;

async function report(ctx: FlowContext, post: Post): Promise<void> {
  const { db, user } = ctx;
  // One report per person per post. Staff decide what happens to the poster; several reports hide the post meanwhile.
  const added = db.prepare("INSERT OR IGNORE INTO topic_alert_bubbles (messageId, postId, userId, role, createdAt) VALUES (?, ?, ?, 'report', ?)").run(`report:${post.id}:${user.id}`, post.id, user.id, deps.now());
  if (added.changes) {
    db.prepare("UPDATE topic_posts SET reports = reports + 1 WHERE id = ?").run(post.id);
    const fresh = getPost(db, post.id);
    if (fresh && fresh.status === "live" && fresh.reports >= REPORTS_TO_HIDE) await closePost(db, fresh, "removed", (id, bubbles) => ctx.sayToOwed(id, ...bubbles.map((text) => ({ text }))));
  }
  if (ctx.state?.flow === TOPICS) ctx.setState(null);
  await ctx.say(...FOOD_VOICE.bubbles(db, user.id, [...FOOD_COPY.reportThanks]));
}

// ---------- follow, unfollow, suggest ----------

const FOLLOW = /\b(?:sign me (?:back )?up|subscribe(?: me)?|resubscribe|add me (?:back )?(?:to|for)|put me (?:back )?(?:on|down for)|opt me (?:back )?in|count me in for|(?:text|alert|ping|tell|notify|hmu|hit me up|lmk|let me know) (?:me )?(?:about|when|for|if|whenever)|i (?:want|wanna get|would like|d like) (?:to get |the |some )?(?:texts|alerts|notifs|notifications) (?:about|for|on|when)|turn (?:on|back on)|follow)\b/;
const UNFOLLOW = /\b(?:stop|no more|unsubscribe|unfollow|turn off|take me off|remove me from|opt me out|dont (?:send|text|tell|alert|ping|notify)(?: me)?|quit (?:sending|texting)|mute|im done with|i dont want)\b/;
const ALERT_WORDS = /\b(?:texts?|alerts?|notifs?|notifications?|pings?|topics?|updates?|list)\b/;
const SUGGEST = /\bsomething else\b|\b(?:add|make|create|start|suggest|have|do|got)\b.{0,12}\b(?:topic|alert|category|option|list)\b|\b(?:topic|alerts?|option|list|texts) (?:for|about)\b|\bi wish (?:there was|u had|i got)\b|\bnew (?:topic|alert|one)\b/;
const LIST = /\bwh(?:at|ich) (?:topics?|alerts?|lists?)\b|\bwhat (?:kinds? of )?texts\b|\bwhat can i (?:follow|sign up for|get (?:texts|alerts) (?:about|for))\b|\bwhat (?:else )?can u (?:text|alert) me about\b/;
const MINE = /\bwhat (?:am i|im) (?:following|signed up for|subscribed to|on)\b|\bwh(?:at|ich) (?:topics?|alerts?|texts) (?:am i|do i)\b|\bmy (?:topics|alerts|subscriptions)\b/;
const END_POST = /\b(?:cancel|end|close|delete|take down|remove|kill) (?:my|the|that|this) (?:post|one|thing)\b|\btake (?:it|that|my post) down\b|\b(?:were|we are|im|i am) (?:full|all set|good now)\b|\bfound (?:someone|somebody|people|enough|a buyer|one)\b|\b(?:its|it is|thats) (?:over|done|sold|gone|taken)\b|\bnvm (?:the|my) post\b/;
const JOIN = /^(?:(?:yes|yeah|yep|ya|ok|bet|oh|ooh|yo|hey)[ ,]+)*(?:im in|i am in|im down|i am down|count me in|ill (?:come|be there|join|play|take it|take one)|i can (?:come|play|make it)|i want (?:in|it|one)|im interested|interested|omw|on my way|ill pull up|pulling up|me)\b/;
const JOIN_LOOSE = /^(?:in|down|yes|yeah|yep|yup|ya|sure|ok|okay|bet|me pls|me please|for sure|lets go)$/;
const CANCEL = /^(?:(?:actually|wait|oh|ah|sorry|lol|nah|no)[ ,]+)*(?:nvm|nevermind|never mind|cancel|cancel it|cancel that|forget it|forget that|scratch that|dont post(?: it| that)?|dont send(?: it| that)?)\b/;
const QUESTION = /\?\s*$|^(?:why|what|how|who|wait what|huh)\b/;
const OFFER = /\b(?:anyone|anybody|any1|who(?:s| is)?) (?:want|wanna|wants|down|tryna|trying|need|needs|got|have|has|selling|going|playing|free|up)\b|\b(?:i|we) (?:have|got|can|need|am|are|will)\b|\b(?:ive|weve|im|were) (?:got|selling|giving|looking|running|playing|hosting|free)\b|\b(?:extra|selling|looking for|need (?:one|\d|a few) more|free (?:on|this|rn|to)|lmk if|hmu if|dm if)\b/;

const NAME_LEAD = new Set(
  "hey yo hi ok okay um uh hmm actually troy pls please thanks thx lol maybe idk honestly tbh so and but well oh something else can could would will u you ya is are there was were i im id wish want wanna like need thinking think was am how what about sign me back up subscribe add put on down count in turn follow opt make create start suggest have had do get got set text alert ping tell notify hmu hit lmk let know a an the one some any my to topic topics alert alerts texts notifs notifications pings category option list updates for when if whenever of that thats theres someone somebody has its it be new".split(
    " ",
  ),
);
const NAME_TAIL = new Set("pls please thanks thx lol topic topics alert alerts texts text notifs notifications pings updates list too tho though maybe or something idk rn".split(" "));

/** The topic someone is describing, with the asking words around it taken off. Empty when they didn't name one yet. */
export function suggestedName(text: string): string {
  const words = (text ?? "")
    .toLowerCase()
    .replace(/https?:\/\/\S+|www\.\S+/g, " ")
    .replace(/[‘’'`]/g, "")
    .replace(/[^a-z0-9&+ -]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (words.length && NAME_LEAD.has(words[0]!)) words.shift();
  while (words.length && NAME_TAIL.has(words[words.length - 1]!)) words.pop();
  return cleanTopicName(words.join(" "));
}

async function follow(ctx: FlowContext, text: string): Promise<void> {
  const { db, user } = ctx;
  const hint = typeof ctx.intent.details.topic === "string" ? ctx.intent.details.topic : "";
  const topic = (hint ? findTopic(db, hint) : null) ?? findTopic(db, text);
  if (!topic) {
    // Not a topic that exists: the same as suggesting it.
    await suggest(ctx, hint || text);
    return;
  }
  ctx.setState(null);
  if (isSubscribed(db, user.id, topic)) {
    await say(ctx, "alreadyFollowing", BRIEFS.alreadyFollowing(topic.plain));
    return;
  }
  subscribe(db, user.id, topic.id);
  await say(ctx, "followed", BRIEFS.followed(topic.plain));
}

async function unfollow(ctx: FlowContext, text: string): Promise<void> {
  const { db, user } = ctx;
  const named = ctx.intent.command?.name === "unsubscribe_topic" && ctx.intent.command.topic ? ctx.intent.command.topic : typeof ctx.intent.details.topic === "string" ? ctx.intent.details.topic : "";
  const topic = (named ? findTopic(db, named) : null) ?? findTopic(db, text);
  const mine = topicsFor(db, user.id);
  if (!topic) {
    if (!mine.length) {
      ctx.setState(null);
      await say(ctx, "nothingToStop", BRIEFS.nothingToStop());
      return;
    }
    if (mine.length === 1 && ctx.state?.step === "unfollow_which") {
      // They were just asked and didn't name one; with a single topic there is only one thing they can mean.
      unsubscribe(db, user.id, mine[0]!.id);
      ctx.setState(null);
      await say(ctx, "unfollowed", BRIEFS.unfollowed(mine[0]!.plain));
      return;
    }
    ctx.setState({ flow: TOPICS, step: "unfollow_which", data: {} });
    await say(ctx, "unfollowWhich", BRIEFS.unfollowWhich(mine.map(nameOf).join(", ")));
    return;
  }
  ctx.setState(null);
  if (!isSubscribed(db, user.id, topic)) {
    await say(ctx, "notFollowing", BRIEFS.notFollowing(topic.plain));
    return;
  }
  unsubscribe(db, user.id, topic.id);
  await say(ctx, "unfollowed", BRIEFS.unfollowed(topic.plain));
}

/**
 * Someone names a topic that may not exist yet. Three outcomes, each in Troy's own varied words:
 * it exists (or is clearly fine and gets created) and they're added; it can't be judged right now, so nothing is
 * created and the request is saved for John; or it is declined in one line. Code decides which.
 */
async function suggest(ctx: FlowContext, text: string): Promise<void> {
  const { db, user } = ctx;
  if (screenedOut(text)) {
    ctx.setState(null);
    await say(ctx, "declined", BRIEFS.declined());
    return;
  }
  const existing = findTopic(db, text);
  if (existing) {
    ctx.setState(null);
    const had = isSubscribed(db, user.id, existing);
    subscribe(db, user.id, existing.id);
    await say(ctx, had ? "alreadyFollowing" : "existing", had ? BRIEFS.alreadyFollowing(existing.plain) : BRIEFS.existing(existing.plain));
    return;
  }
  const name = suggestedName(text);
  if (name.length < 3) {
    ctx.setState({ flow: TOPICS, step: "suggest_ask", data: {} });
    await say(ctx, "suggestAsk", BRIEFS.suggestAsk());
    return;
  }
  ctx.setState(null);
  const verdict = await deps.judgeTopic(name).catch(() => "unsure" as const);
  if (verdict === "no") {
    await say(ctx, "declined", BRIEFS.declined());
    return;
  }
  if (verdict !== "ok") {
    saveTopicRequest(db, text, user.id);
    await say(ctx, "unsure", BRIEFS.unsure());
    return;
  }
  const topic = createTopic(db, name, user.id);
  subscribe(db, user.id, topic.id);
  await say(ctx, "created", BRIEFS.created(topic.label));
  await aside(ctx, {
    step: "topic_created",
    behind: { did: "checked it against the {existing} topics already there, judged it fine for a campus, and made it a real topic anyone can follow", numbers: { existing: Math.max(0, listTopics(db).length - 1) } },
    decision: DECISION.oneEngine,
  });
}

/** For onboarding's "something else" option and anywhere else a student should be asked what they have in mind. */
export async function startTopicSuggestion(ctx: FlowContext): Promise<void> {
  ctx.setState({ flow: TOPICS, step: "suggest_ask", data: {} });
  await say(ctx, "suggestAsk", BRIEFS.suggestAsk());
}

// ---------- handing a message to another flow ----------

/** Give this message to a named flow with an action. False when that flow isn't registered. */
async function handTo(ctx: FlowContext, flow: FlowName, action: string): Promise<boolean> {
  const { getFlow } = await import("./index.ts");
  const target = getFlow(flow);
  if (!target || target.name === TOPICS) return false;
  if (ctx.state?.flow === TOPICS) ctx.setState(null);
  await target.handle({ ...unvoiced(ctx), intent: { ...ctx.intent, flow, action }, state: null });
  return true;
}

/** Not ours: the flow the intent names gets it, or free chat. Our open step is cleared only when `clear` is set. */
async function passOn(ctx: FlowContext, clear: boolean): Promise<void> {
  if (clear && ctx.state?.flow === TOPICS) ctx.setState(null);
  const { getFlow } = await import("./index.ts");
  const named = ctx.intent.flow !== TOPICS ? getFlow(ctx.intent.flow) : null;
  const target = named ?? getFlow("smalltalk");
  if (!target || target.name === TOPICS) return;
  const intent = named ? ctx.intent : { flow: "smalltalk" as const, action: "chat", details: ctx.intent.details, source: ctx.intent.source };
  await target.handle({ ...unvoiced(ctx), intent, state: ctx.state && ctx.state.flow !== TOPICS ? ctx.state : null });
}

/** The model is sure this message starts something in another flow. */
const startsElsewhere = (ctx: FlowContext) => ctx.intent.source === "ai" && ctx.intent.flow !== TOPICS && ctx.intent.flow !== "smalltalk" && ctx.intent.flow !== "onboarding";

// ---------- the handler ----------

function freshState(ctx: FlowContext, now: number): FlowState | null {
  const s = ctx.state?.flow === TOPICS ? ctx.state : null;
  if (!s) return null;
  const limit = s.step === "alerted" || s.step === "join_ask" ? ALERT_STALE_MS : STEP_STALE_MS;
  if (now - s.updatedAt > limit) {
    ctx.setState(null);
    return null;
  }
  return s;
}

async function handleReaction(ctx: FlowContext, state: FlowState | null): Promise<void> {
  const r = ctx.event.reaction!;
  if (r.removed) return;
  const positive = r.type === "love" || r.type === "like";
  // A tapback on the question itself is a yes or a no. On any other bubble it is only an acknowledgment.
  if (state?.step === "join_ask") {
    const askId = state.data.askId ?? state.data.qid;
    if (askId && askId === r.targetMessageId && (positive || r.type === "dislike")) {
      await answerJoin(ctx, state, positive);
      return;
    }
  }
  if (!positive) return;
  const bubble = ctx.db.prepare("SELECT postId FROM topic_alert_bubbles WHERE messageId = ? AND userId = ? AND role != 'report'").get(r.targetMessageId, ctx.user.id) as { postId: number } | undefined;
  if (bubble) await join(ctx, getPost(ctx.db, bubble.postId));
}

/** A question in the middle of a step gets an answer, and the step stays open. */
async function answerAtStep(ctx: FlowContext, key: string, waitingFor: string, fallback: Brief): Promise<string | null> {
  const at = deps.replyAtStep ?? brainFn<ReplyAtStep>("replyAtStep");
  if (at) {
    try {
      const out = await at(ctx, { flow: TOPICS, waitingFor, canDo: [{ name: "cancel", when: "they don't want to do this anymore" }] });
      if (out?.bubbles?.length) {
        await ctx.say(...out.bubbles.slice(0, 3));
        return out.action ?? null;
      }
    } catch {
      // The fallback below answers.
    }
  }
  await say(ctx, key, fallback);
  return null;
}

export const topics: FlowHandler = {
  name: TOPICS,
  async handle(ctx) {
    const { db, user } = ctx;
    const now = deps.now();
    // An open simulation (a follower's side, played out) gets the message first, taps included.
    if (await simulationTurn(ctx, OWN_STEPS)) return;
    const state = freshState(ctx, now);

    if (ctx.event.pollVote) return;
    if (ctx.event.reaction) {
      await handleReaction(ctx, state);
      return;
    }

    const text = (ctx.event.text ?? "").trim();
    const w = flat(text);
    const mineToHandle = ctx.intent.flow === TOPICS;
    // The router's names (post_to_topic, follow_topic, suggest_topic) and the short ones mean the same here.
    const action = mineToHandle ? ctx.intent.action.replace(/^(post)_to_topic$/, "$1").replace(/_topic$/, "") : "";
    if (!w) {
      await passOn(ctx, false);
      return;
    }

    // ----- open steps -----
    if (state?.step === "join_ask") {
      const answer = readsYesNo(text);
      if (answer) {
        await answerJoin(ctx, state, answer === "yes");
        return;
      }
    }
    if (state?.step === "post_place" || state?.step === "post_topic" || state?.step === "suggest_ask" || state?.step === "unfollow_which") {
      if (CANCEL.test(w)) {
        ctx.setState(null);
        await say(ctx, "postDropped", BRIEFS.postDropped());
        return;
      }
      if (startsElsewhere(ctx)) {
        await passOn(ctx, true);
        return;
      }
    }
    if (state?.step === "post_place") {
      const draft = state.data.draft as Draft;
      const topic = getTopic(db, draft.topicId);
      if (!topic) {
        ctx.setState(null);
        await say(ctx, "postDropped", BRIEFS.postDropped());
        return;
      }
      const place = spotIn(db, text);
      if (place) {
        await publish(ctx, draft, topic, place);
        return;
      }
      if (QUESTION.test(text.toLowerCase())) {
        const did = await answerAtStep(ctx, "whyPlace", "where the thing they want to post is happening (a campus building or spot)", BRIEFS.whyPlace());
        if (did === "cancel") ctx.setState(null);
        return;
      }
      // A spot Troy has no coordinates for still works: people just don't get a walking time.
      const phrase = w.replace(/^(?:its |it is |were |we are |ill be |im )?(?:at |in |outside |inside |near |by )?(?:the )?/, "").trim();
      if (phrase.length < 2 || phrase.length > 40 || /^(?:idk|not sure|dunno|anywhere|wherever|nowhere|no|none)$/.test(phrase) || screenedOut(phrase)) {
        await publish(ctx, draft, topic, null);
        return;
      }
      await publish(ctx, draft, topic, { spot: redactContacts(phrase) || phrase, lat: null, lng: null });
      return;
    }
    if (state?.step === "post_topic") {
      const topic = findTopic(db, text);
      const saved = typeof state.data.text === "string" ? state.data.text : "";
      if (topic && saved) {
        await startPost(ctx, saved, topic);
        return;
      }
      ctx.setState(null);
      await passOn(ctx, false);
      return;
    }
    if (state?.step === "suggest_ask") {
      if (QUESTION.test(text.toLowerCase()) && !findTopic(db, text) && suggestedName(text).split(" ").length > 4) {
        await answerAtStep(ctx, "suggestAsk", "what they'd want to get texts about (a new alert topic)", BRIEFS.suggestAsk());
        return;
      }
      await suggest(ctx, text);
      return;
    }
    if (state?.step === "unfollow_which") {
      await unfollow(ctx, text);
      return;
    }

    // ----- someone's post in front of them -----
    const seen = state?.step === "alerted" && typeof state.data.postId === "number" ? getPost(db, state.data.postId) : null;
    if (seen && (saysFake(text) || REPORT.test(w))) {
      await report(ctx, seen);
      return;
    }
    if (seen && (JOIN.test(w) || JOIN_LOOSE.test(w) || action === "join")) {
      await join(ctx, seen);
      return;
    }

    // ----- commands by meaning, then what the text itself says -----
    if (ctx.intent.command?.name === "unsubscribe_topic" || action === "unfollow") {
      await unfollow(ctx, text);
      return;
    }
    if (startsElsewhere(ctx)) {
      await passOn(ctx, false);
      return;
    }
    if (MINE.test(w) || action === "mine") {
      const mine = topicsFor(db, user.id);
      if (mine.length) await say(ctx, "mine", BRIEFS.mine(mine.map(nameOf).join(", ")));
      else await say(ctx, "mineNone", BRIEFS.mineNone());
      return;
    }
    if (LIST.test(w) || action === "list") {
      await say(ctx, "list", BRIEFS.list(listTopics(db).map(nameOf).join(", ")));
      return;
    }
    const named = findTopic(db, text);
    if (UNFOLLOW.test(w) && (named || ALERT_WORDS.test(w)) && !OFFER.test(w)) {
      await unfollow(ctx, text);
      return;
    }
    const mine = livePostOf(db, user.id, now);
    if (mine && (END_POST.test(w) || action === "end_post")) {
      await closePost(db, mine, "ended", async (id, bubbles) => {
        if (id !== user.id) await ctx.sayToOwed(id, ...bubbles.map((b) => ({ text: b })));
      });
      await say(ctx, "postEnded", BRIEFS.postEnded(nounFor(db, mine)));
      return;
    }
    if (action === "end_post") {
      await say(ctx, "noPost", BRIEFS.noPost());
      return;
    }
    if (action === "post") {
      await startPost(ctx, text, null);
      return;
    }
    if (action === "follow" || (FOLLOW.test(w) && !OFFER.test(w.replace(FOLLOW, " ")))) {
      await follow(ctx, text);
      return;
    }
    if (action === "suggest" || SUGGEST.test(w)) {
      await suggest(ctx, text);
      return;
    }
    // "i'm in" with no open step still finds the last post they were texted about.
    if (JOIN.test(w) || action === "join") {
      const last = alertedPost(db, user.id, now);
      if (last) {
        await join(ctx, last);
        return;
      }
    }
    if (saysFake(text) || REPORT.test(w)) {
      const last = alertedPost(db, user.id, now);
      if (last) {
        await report(ctx, last);
        return;
      }
    }
    // Something for a topic that reads like an offer or an ask to other people is a post.
    if (named && named.key !== "free_nearby" && named.key !== "rides" && OFFER.test(w) && (mineToHandle || !QUESTION.test(text.toLowerCase()) || /\bany(?:one|body)\b/.test(w))) {
      await startPost(ctx, text, named);
      return;
    }
    if (mineToHandle && named && !isSubscribed(db, user.id, named) && w.split(" ").length <= 6) {
      // A topic named on its own ("pickup games") by someone the router sent here: they want in.
      await follow(ctx, text);
      return;
    }
    await passOn(ctx, false);
  },
};

// ---------- timers, people leaving, questions that wait ----------

/** Posts past their time end; open "i'm in" pointers and chats for them close. Safe to call as often as you like. */
export async function sweepTopics(db: DatabaseSync, now: number, tell: (userId: number, bubbles: string[]) => Promise<unknown>): Promise<number> {
  const old = (db.prepare("SELECT * FROM topic_posts WHERE status = 'live' AND expiresAt <= ?").all(now) as Row[]).map(toPost);
  for (const p of old) await closePost(db, p, "ended", tell);
  db.prepare("DELETE FROM flow_state WHERE flow = ? AND step IN ('alerted','join_ask') AND updatedAt < ?").run(TOPICS, now - ALERT_STALE_MS);
  return old.length;
}

onSweep("topics", async (io, now) => {
  await sweepTopics(io.db, now, (id, bubbles) => io.sayTo(id, ...bubbles));
});

onUserGone("topics", async (io, userId) => {
  // STOP or "delete my data": their posts come down and anyone chatting about one is told.
  const mine = (io.db.prepare("SELECT * FROM topic_posts WHERE posterUserId = ? AND status = 'live'").all(userId) as Row[]).map(toPost);
  for (const p of mine) await closePost(io.db, p, "ended", (id, bubbles) => (id === userId ? Promise.resolve() : io.sayTo(id, ...bubbles)));
  io.db.prepare("UPDATE topic_joins SET status = 'declined' WHERE userId = ? AND status = 'asked'").run(userId);
});

registerPendingHooks(TOPICS, {
  // The poster's yes or no must land on this question, so another flow never replaces it silently.
  protects: (_db, state) => state.step === "join_ask",
  valid: (db, state) => {
    if (state.step !== "join_ask") return true;
    const post = typeof state.data.postId === "number" ? getPost(db, state.data.postId) : null;
    return isLive(post, Date.now());
  },
  reprompt: (db, state) => {
    if (state.step !== "join_ask") return [];
    const post = typeof state.data.postId === "number" ? getPost(db, state.data.postId) : null;
    return post ? rotate(db, post.posterUserId, "topics.joinAsk", OTHER.joinAsk(nounFor(db, post))) : [];
  },
});

export { topicByKey };
