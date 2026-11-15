// Onboarding state machine, stored in flow_state (flow "onboarding").
// Steps: email -> code -> subscriptions -> location -> done (state cleared).
// A choice (student or judge, what to get texts about) can arrive three ways: a vote on a native poll,
// a tapback on an option bubble, or typed text. All three are handled at every step that offers one.
// Every reply here is fixed copy. Verification results and attempt limits are decided in code.

import { randomInt } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { FlowContext, User } from "./types.ts";
import { saveMessage, updateUser } from "./db/index.ts";
import { TEMPLATES, SUBSCRIPTION_LABELS } from "./commands.ts";
import { sendVerificationEmail } from "./email.ts";
import { locationOptedOut, noteLocationRequestedByUser } from "./location.ts";

export const SUBSCRIPTIONS = ["free_food", "free_stuff", "events", "class_help"] as const;
const OPTION_LABELS = SUBSCRIPTIONS.map((s) => SUBSCRIPTION_LABELS[s]);

export const CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
/** Stops someone using Troy to spam an inbox. */
const MAX_CODES_PER_HOUR = 5;

const ASK_EMAIL = "quick thing, gotta make sure ur a trojan. what's ur usc email";
// Honor system: anyone could tap "hackathon judge", so the line asks them kindly not to.
const JUDGE_LINE = "hackathon judges can skip this. not a judge? pls don't tap it, i'm trusting u";
const JUDGE_QUESTION = "which one are u?";
export const JUDGE_OPTIONS = ["usc student", "hackathon judge"];
const JUDGE_CONFIRM = "ur in as a judge. this skip is demo only, the real campus version wouldn't have it";
const STUDENT_REASK = "bet. what's ur usc email?";
const LOCATION_KEPT = "last thing. i keep the last location u share so alerts and walking times are accurate. text forget my location anytime to erase it";
// The request has no bubble in the chat: it shows up inside the Find My app, under People, with no notification.
const LOCATION_REQUESTED = "i sent u a location request. open find my, then people, and accept it";
const LOCATION_HOW = "tap the + in this chat, then Location, then Share";
const LOCATION_OR = "or just tell me ur usual spots, or reply skip";

/** What the pipeline lends onboarding: saving a location goes through src/location.ts. */
export type OnboardingExtras = { saveLocation?: (userId: number, loc: { lat: number; lng: number }) => Promise<void> };

type PollRef = { pollId: string | null; optionIds: (string | null)[]; mode: "native" | "tap" | "numbered" };

type Data = Record<string, unknown>;

function word(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function findEmail(text: string): string | null {
  const m = text.match(/[^\s@<>(),;:]+@[^\s@<>(),;:]+\.[a-z]{2,}/i);
  return m ? m[0].toLowerCase().replace(/[.!?]+$/, "") : null;
}

/** "tommy.trojan" becomes "Tommy Trojan". Anything that doesn't look like first.last gives null. */
export function guessName(email: string): string | null {
  const m = email.split("@")[0].match(/^([a-z]{2,})[._-]([a-z]{2,})$/);
  if (!m) return null;
  return [m[1], m[2]].map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
}

function latestCode(db: DatabaseSync, userId: number) {
  return db.prepare("SELECT * FROM verification_codes WHERE userId = ? ORDER BY id DESC LIMIT 1").get(userId) as
    | { id: number; email: string; code: string; attempts: number; expiresAt: number }
    | undefined;
}

async function sendCode(ctx: FlowContext, email: string): Promise<void> {
  const { db, user } = ctx;
  // The judge poll stays answerable after an email is typed.
  const judge = ctx.state?.flow === "onboarding" ? (ctx.state.data.judge ?? null) : null;
  const recent = db.prepare("SELECT COUNT(*) AS n FROM verification_codes WHERE userId = ? AND createdAt > ?").get(user.id, Date.now() - 60 * 60 * 1000) as { n: number };
  if (recent.n >= MAX_CODES_PER_HOUR) {
    await ctx.say("that's a lot of codes. give it an hour and try again");
    return;
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const now = Date.now();
  // Old codes stop working the moment a new one goes out (rows stay for the hourly count).
  db.prepare("UPDATE verification_codes SET expiresAt = 0 WHERE userId = ?").run(user.id);
  db.prepare("INSERT INTO verification_codes (userId, email, code, expiresAt, createdAt) VALUES (?, ?, ?, ?, ?)").run(user.id, email, code, now + CODE_TTL_MS, now);
  const sent = await sendVerificationEmail(email, code);
  if (!sent) {
    ctx.setState({ flow: "onboarding", step: "email", data: { judge } });
    await ctx.say("couldn't send that email. text me ur usc email again to retry");
    return;
  }
  ctx.setState({ flow: "onboarding", step: "code", data: { email, judge } });
  await ctx.say(`sent a 6 digit code to ${email}`, "text it back to me. might be in spam since i'm new 👀");
}

/**
 * Sends a poll and remembers its ids. Native: every option id is the poll's own id and a vote arrives as
 * event.pollVote. Tap: one bubble per option. Numbered: a list, answered in text.
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
 * Which option of a poll this event picks, or -1. `positive` is false for a removed or negative tapback.
 * A vote or tapback aimed at a different poll or bubble is -1.
 */
function pollChoice(ctx: FlowContext, ref: PollRef | null | undefined): { index: number; positive: boolean } {
  const { event } = ctx;
  if (!ref) return { index: -1, positive: false };
  if (event.pollVote) {
    const ours = !ref.pollId || !event.pollVote.pollMessageId || event.pollVote.pollMessageId === ref.pollId;
    const i = event.pollVote.optionIndex;
    return { index: ours && Number.isInteger(i) && i >= 0 && i < ref.optionIds.length ? i : -1, positive: true };
  }
  if (event.reaction && ref.mode !== "native") {
    const r = event.reaction;
    return { index: ref.optionIds.indexOf(r.targetMessageId), positive: !r.removed && (r.type === "love" || r.type === "like" || r.type === "emphasize") };
  }
  return { index: -1, positive: false };
}

/** True when the provider's native polls take more than one choice. Nothing says so today, so the default is one. */
function multiChoice(ctx: FlowContext, poll: unknown): boolean {
  const caps = ctx.adapter.capabilities() as unknown as Record<string, unknown>;
  const p = (poll ?? {}) as Record<string, unknown>;
  return caps.pollMultiple === true || caps.multiChoicePolls === true || p.multiple === true || p.multipleChoice === true;
}

async function askSubscriptions(ctx: FlowContext, firstBubble: string): Promise<void> {
  await ctx.say(firstBubble);
  const question = "what do u want texts about?";
  const ref = await sendPoll(ctx, question, OPTION_LABELS);
  const multiple = ref.mode === "native" && multiChoice(ctx, ref);
  ctx.setState({ flow: "onboarding", step: "subscriptions", data: { pollId: ref.pollId, optionIds: ref.optionIds, picked: [], mode: ref.mode, multiple } });
  if (ref.mode === "tap") await ctx.say("tap a heart or thumbs up on the ones u want, then text done. or reply skip");
  else if (ref.mode === "numbered") await ctx.say("reply with the numbers u want, like 1 3. or reply skip");
  else if (multiple) await ctx.say("pick any u want in the poll, then text done. or reply skip");
  else await ctx.say("pick one in the poll, or text me a few like 1 and 3. or reply skip");
}

async function verified(ctx: FlowContext, fields: Record<string, string | number | null>, bubble: string): Promise<void> {
  updateUser(ctx.db, ctx.user.id, { verifiedAt: Date.now(), ...fields });
  ctx.db.prepare("DELETE FROM verification_codes WHERE userId = ?").run(ctx.user.id);
  await askSubscriptions(ctx, bubble);
}

function judgeSkip(ctx: FlowContext): Promise<void> {
  return verified(ctx, { verifiedVia: "judge_skip" }, JUDGE_CONFIRM);
}

async function handleEmail(ctx: FlowContext, text: string): Promise<void> {
  const email = findEmail(text);
  if (!email) {
    await ctx.say("hmm that doesn't look like an email. what's ur usc email? it ends in @usc.edu");
    return;
  }
  if (!email.endsWith("@usc.edu")) {
    await ctx.say("that's not a usc email. i need the one that ends in @usc.edu");
    return;
  }
  await sendCode(ctx, email);
}

async function handleCode(ctx: FlowContext, text: string, data: Data): Promise<void> {
  const { db, user } = ctx;
  if (word(text) === "resend" || word(text) === "resend code") {
    await sendCode(ctx, String(data.email));
    return;
  }
  // A different email here means they mistyped the first one.
  if (findEmail(text)) {
    await handleEmail(ctx, text);
    return;
  }
  const guess = text.replace(/[\s-]/g, "").match(/^\D*(\d{6})\D*$/)?.[1];
  if (!guess) {
    await ctx.say("text me the 6 digit code from the email. reply resend for a new one");
    return;
  }
  const row = latestCode(db, user.id);
  if (!row || row.expiresAt < Date.now()) {
    await ctx.say("that code expired. reply resend and i'll send a new one");
    return;
  }
  if (row.attempts >= MAX_ATTEMPTS) {
    await ctx.say("too many wrong tries on that code. reply resend for a new one");
    return;
  }
  if (guess !== row.code) {
    const attempts = row.attempts + 1;
    db.prepare("UPDATE verification_codes SET attempts = ? WHERE id = ?").run(attempts, row.id);
    const left = MAX_ATTEMPTS - attempts;
    await ctx.say(left > 0 ? `that's not the code. ${left} ${left === 1 ? "try" : "tries"} left` : "that's not the code and ur out of tries. reply resend for a new one");
    return;
  }
  await verified(ctx, { uscEmail: row.email, verifiedVia: "usc_email", name: user.name ?? guessName(row.email) }, "ur verified. welcome in");
}

function parseSubscriptions(text: string): number[] | null {
  const w = word(text);
  if (/^(skip|none|no|nah|nope|nothing|no thanks)$/.test(w)) return [];
  if (/^(done|thats it|thats all|ok|okay)$/.test(w)) return [];
  if (/\b(all|everything|all of them)\b/.test(w)) return [0, 1, 2, 3];
  const picked = new Set<number>();
  for (const d of w.match(/\b[1-4]\b/g) ?? []) picked.add(Number(d) - 1);
  if (/\bfood\b/.test(w)) picked.add(0);
  if (/\b(stuff|items|things|clothes)\b/.test(w)) picked.add(1);
  if (/\bevents?\b/.test(w)) picked.add(2);
  if (/\b(class|classes|tutor|tutoring|help)\b/.test(w)) picked.add(3);
  return picked.size ? [...picked] : null;
}

async function handleSubscriptions(ctx: FlowContext, data: Data): Promise<void> {
  const { event } = ctx;
  let picked = (data.picked as number[]) ?? [];
  const ref: PollRef = { pollId: (data.pollId as string | null) ?? null, optionIds: (data.optionIds as (string | null)[]) ?? [], mode: (data.mode as PollRef["mode"]) ?? "tap" };

  if (event.reaction || event.pollVote) {
    const { index, positive } = pollChoice(ctx, ref);
    if (index < 0 || index >= SUBSCRIPTIONS.length) return;
    // A native poll that takes one choice: a new vote replaces the last one. Everything else adds up.
    const single = !!event.pollVote && ref.mode === "native" && !data.multiple;
    if (single) picked = [index];
    else picked = positive ? [...new Set([...picked, index])] : picked.filter((i) => i !== index);
    ctx.setState({ flow: "onboarding", step: "subscriptions", data: { ...data, picked, nudged: true } });
    // One nudge only, so tapping three options doesn't get three replies.
    if (!data.nudged) await ctx.say(single ? "got it. want more? text the numbers like 1 and 3. or text done" : "got it. tap any others u want, then text done");
    return;
  }

  const parsed = parseSubscriptions(event.text);
  if (parsed === null && !picked.length) {
    await ctx.say("didn't catch that. reply with numbers like 1 3 (1 free food, 2 free stuff, 3 events, 4 class help), or skip");
    return;
  }
  const all = [...new Set([...picked, ...(parsed ?? [])])].sort();
  const subs = all.map((i) => SUBSCRIPTIONS[i]);
  updateUser(ctx.db, ctx.user.id, { subscriptions: JSON.stringify(subs) });
  ctx.setState({ flow: "onboarding", step: "location", data: {} });
  const confirm = subs.length ? `bet, i'll text u about ${subs.map((s) => SUBSCRIPTION_LABELS[s]).join(", ")}` : "no alerts then. u can always text me first";
  await ctx.say(confirm, LOCATION_KEPT);
  // A Find My request when the provider could send one (they accept it in the Find My app), else how to share by hand.
  const requested = await ctx.adapter.requestLocation(ctx.event.chatId).catch(() => false);
  await ctx.say(requested ? LOCATION_REQUESTED : LOCATION_HOW, LOCATION_OR);
}

async function finish(ctx: FlowContext, bubble: string): Promise<void> {
  ctx.setState(null);
  await ctx.say(bubble, 'ur all set. try sending me a pic of something u found, or ask "who do i talk to about dining hall hours"');
}

const DECLINE = /^(?:skip|no|nah|nope|not now|not rn|later|maybe later|im good|i am good|im ok|im okay|idk|pass|never ?mind|nvm|dont want|i dont want|id rather not|rather not)\b/;
const QUESTION = /^(?:why|what|how|who|when|where|is|are|do|does|can|could|will|would|wait)\b/;
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
  if (!pieces.length) return null;
  if (pieces.some((p) => knownPlace(db, p))) return pieces;
  const plain = pieces.every((p) => {
    const w = word(p);
    return !!w && w.split(" ").length <= 4 && !NOT_A_PLACE.test(w);
  });
  return plain && !text.includes("?") ? pieces : null;
}

/** Returns false when the text wasn't about location at all, so the pipeline can treat it as a normal request. */
async function handleLocation(ctx: FlowContext, data: Data, extras: OnboardingExtras): Promise<boolean> {
  const { event } = ctx;
  if (event.reaction || event.pollVote) return true;
  const w = word(event.text.replace(/[‘’'`]/g, ""));
  // The pipeline has already saved the share as their last known location.
  if (event.location) {
    await finish(ctx, TEMPLATES.locationSaved);
    return true;
  }
  if (DECLINE.test(w)) {
    await finish(ctx, "no worries, i'll just ask where u are when it matters");
    return true;
  }
  if (!w || /^(done|shared|sharing|sent|ok|okay|did it|there|yes|yeah|yep|sure)$/.test(w)) {
    // After "forget my location" a plain "ok" is not a share: nothing is looked up and the opt-out stays.
    const live = locationOptedOut(ctx.db, ctx.user.id) ? null : await ctx.adapter.getLiveLocation(ctx.user.handle).catch(() => null);
    if (live && Number.isFinite(live.lat) && Number.isFinite(live.lng)) {
      await extras.saveLocation?.(ctx.user.id, { lat: live.lat, lng: live.lng });
      await finish(ctx, "got it, i can see where u are now");
    } else {
      // After "forget my location" nothing is read on their word alone: the background refresh now watches for
      // a fix taken after this moment (src/location.ts). For everyone else this does nothing.
      noteLocationRequestedByUser(ctx.db, ctx.user.id);
      await ctx.say("i'm not seeing it yet. it can take a min after u accept, so text done again in a sec", "or tap the + in this chat, then Location, then Share. or tell me ur usual spots, or reply skip");
    }
    return true;
  }
  const spots = parseSpots(ctx.db, event.text);
  if (spots) {
    updateUser(ctx.db, ctx.user.id, { usualSpots: JSON.stringify(spots) });
    await finish(ctx, "saved ur usual spots");
    return true;
  }
  // A question about the ask itself gets one explanation, then onboarding ends either way.
  if ((event.text.includes("?") || QUESTION.test(w)) && /\b(?:location|share|sharing|spots?|where|that|this|it|need|for|track|tracking|see)\b/.test(w) && !data.explained) {
    ctx.setState({ flow: "onboarding", step: "location", data: { ...data, explained: true } });
    await ctx.say("it's so alerts and walking times fit where u actually are. i only keep the last one u share, and forget my location erases it", "share it, tell me ur usual spots, or reply skip");
    return true;
  }
  // Anything else is not an answer. Onboarding is done; nothing is saved as a spot.
  ctx.setState(null);
  return false;
}

/** True when this user's next message belongs to onboarding. */
export function needsOnboarding(user: User, state: FlowContext["state"]): boolean {
  return !user.verifiedAt || state?.flow === "onboarding";
}

/**
 * Returns true when onboarding handled the event. False means onboarding just finished without using this
 * text (the student typed a real request at the last step), so the caller should handle it normally.
 */
export async function handleOnboarding(ctx: FlowContext, extras: OnboardingExtras = {}): Promise<boolean> {
  const { user, event, adapter } = ctx;
  const state = ctx.state?.flow === "onboarding" ? ctx.state : null;
  const text = event.text ?? "";
  const tap = !!(event.reaction || event.pollVote);

  if (!user.verifiedAt) {
    const atStep = !!state && (state.step === "email" || state.step === "code");
    if (tap) {
      // A vote or tapback on the student / judge poll. Anything else tapped before verification means nothing.
      if (!atStep) return true;
      const { index, positive } = pollChoice(ctx, state.data.judge as PollRef | null);
      if (index === 1 && positive) await judgeSkip(ctx);
      else if (index === 0 && positive) await ctx.say(STUDENT_REASK);
      return true;
    }
    const w = word(text.replace(/[‘’'`]/g, ""));
    const judge = /^(?:im |i am )?(?:a |the )?(?:hackathon )?judge$/.test(w);
    // First contact (or state lost): welcome first, even if the first text already asked for something.
    if (!atStep) {
      await adapter.onAllowed?.(event.chatId)?.catch(() => {});
      await ctx.say(...TEMPLATES.welcome, TEMPLATES.saveContact);
      const card = await adapter.sendContactCard(event.chatId).catch(() => null);
      if (card) saveMessage(ctx.db, { userId: user.id, chatId: event.chatId, direction: "out", providerMessageId: card.messageId, text: "[contact card]" });
      // JUDGE works from any point before verification (for example after STOP then START wiped the state).
      if (judge) {
        await judgeSkip(ctx);
        return true;
      }
      ctx.setState({ flow: "onboarding", step: "email", data: {} });
      await ctx.say(ASK_EMAIL, JUDGE_LINE);
      const ref = await sendPoll(ctx, JUDGE_QUESTION, JUDGE_OPTIONS);
      ctx.setState({ flow: "onboarding", step: "email", data: { judge: ref } });
      return true;
    }
    if (judge) await judgeSkip(ctx);
    else if (state.step === "email") {
      // Typed answers to the poll: the option's words or its number. A usc email means student.
      if (w === "2") await judgeSkip(ctx);
      else if (!findEmail(text) && /^(?:1|(?:im |i am )?(?:a )?(?:usc )?student)$/.test(w)) await ctx.say(STUDENT_REASK);
      else await handleEmail(ctx, text);
    } else await handleCode(ctx, text, state.data);
    return true;
  }

  if (state?.step === "subscriptions") {
    await handleSubscriptions(ctx, state.data);
    return true;
  }
  if (state?.step === "location") return handleLocation(ctx, state.data, extras);
  // Verified with a stale onboarding state: nothing left to ask.
  ctx.setState(null);
  return true;
}
