// Free chat: everything that isn't one of the flows. One model call writes the reply in Troy's voice from the
// brain files (brain/*.md) plus the context src/brain.ts builds in code. Code checks the reply before it is sent,
// asks once more with the reason when a check fails, and falls back to hand-written lines when the model is down.
// When the message is really a request for a flow, the model hands it off and that flow answers instead.

import type { DatabaseSync } from "node:sqlite";
import type { Bubble, FlowContext, FlowHandler, IncomingEvent, Intent } from "../types.ts";
import { askJson, chatModel, fallbackIntent, lastCacheUsage, modelReady, pullDetails } from "../ai.ts";
import { HANDOFF_FLOWS, askedWhatHeDoes, askedWhoHeIs, buildChatContext, chatSystem, checkReply, loadBrain } from "../brain.ts";
import type { ChatContext, HandoffFlow } from "../brain.ts";
import { getFlowState } from "../db/index.ts";
import { isProtected, pendingFor } from "../pending.ts";
import { isDistress, pickVariant } from "../voice.ts";
import { directoryRows, rowMentioned } from "./reports-shared.ts";
import { isConcern } from "./usg.ts";

// ---------- fallback lines (no model) ----------

export type Situation = "greeting" | "thanks" | "vent" | "question" | "unclear" | "what_he_does" | "who_he_is";

/**
 * Hand-written lines for when the model can't be reached. Each entry is one reply; "|" splits it into bubbles.
 * Rotated per person, so nobody gets the same line twice in a row. None of them lists what Troy can do,
 * except the pool used when someone asks exactly that.
 */
export const FALLBACK_POOLS: Record<Situation, string[]> = {
  greeting: ["hey, what's up", "hey hey. what's going on", "yo. what do u need", "hi. what's the move", "hey, i'm around. what's up", "sup. talk to me"],
  thanks: ["anytime", "of course. that's what i'm here for", "got u", "np, text me whenever", "always. go be great", "easy. holler if u need anything else"],
  vent: [
    "ugh, that's a lot. i'm sorry",
    "that sounds rough, for real",
    "yeah that would get to me too",
    "oof. that's not a small thing",
    "that's a heavy one. hope today goes easier on u",
    "sorry ur dealing with that",
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
    "troy, an ai. no real person is reading this chat, just me",
  ],
};

const GREETING = /^(?:hi+|hey+|heyo|hello+|yo+|sup|wassup|what'?s up|whats good|hiya|howdy|gm|gn|good (?:morning|afternoon|evening|night))(?: troy)?$/;
const THANKS = /\b(?:thanks?|thank (?:u|you)|thx|ty|tysm|tyvm|appreciate (?:it|u|you)|ur the best|you'?re the best|goated|lifesaver)\b/;
const VENT = /\b(?:hate|annoy(?:ed|ing)|ugh+|so mad|pissed|sucks?|the worst|tired of|sick of|can'?t stand|over it|frustrat(?:ed|ing)|rough (?:day|week)|bad day|drama|is killing me|fml)\b/;
const QUESTION = /\?\s*$|^(?:what|whats|when|where|who|whos|why|how|is|are|does|do|did|can|could|will|would|should|which)\b/;

/** Which pool a message falls in. Plain rules: this runs exactly when there is no model to ask. */
export function situationOf(text: string): Situation {
  const t = (text ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  const plain = t.replace(/[^a-z0-9'\s]/g, "").trim();
  if (!plain) return "unclear";
  if (askedWhatHeDoes(t)) return "what_he_does";
  if (askedWhoHeIs(t)) return "who_he_is";
  if (GREETING.test(plain)) return "greeting";
  if (isDistress(t) || VENT.test(t)) return "vent";
  if (THANKS.test(t) && plain.split(" ").length <= 8) return "thanks";
  if (QUESTION.test(t)) return "question";
  return "unclear";
}

/** One hand-written reply for this message, never the line this person got last time in the same situation. */
export function fallbackReply(db: DatabaseSync, userId: number, text: string): string[] {
  const situation = situationOf(text);
  return pickVariant(db, userId, `chat:${situation}`, FALLBACK_POOLS[situation]).split("|").map((b) => b.trim()).filter(Boolean);
}

// ---------- handoff ----------

type ModelReply = { bubbles?: unknown; handoff?: unknown };

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
 * - repair: the flow opens with its question ("where is it?") and files nothing until the student answers it,
 *   unless there is a photo to go on. A chat line with a building in it is not a report to staff.
 * - food: a read-only look at what's out there. - usg: a question, and the flow's own rules decide if it is a concern.
 * - lost_found: the model's action. Both only open the flow's first question.
 */
function unconfirmedHandoff(to: { flow: HandoffFlow; action: string }, hasImage: boolean): { action: string; unconfirmed?: boolean } | null {
  switch (to.flow) {
    case "notes":
      return null;
    case "repair":
      return { action: "report", unconfirmed: !hasImage };
    case "food":
      return { action: "status" };
    case "usg":
      return { action: "question" };
    case "lost_found":
      return { action: to.action };
  }
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
  let intent: Intent;
  if (rules.flow === to.flow) intent = { ...rules, source: "ai" };
  else {
    const safe = unconfirmedHandoff(to, hasImage);
    if (!safe) return false;
    // `unconfirmed` tells the flow that only the model read this as its job: open a question, change nothing yet.
    intent = { flow: to.flow, action: safe.action, details: { ...pullDetails(ctx.event.text), ...(safe.unconfirmed ? { unconfirmed: true } : {}) }, source: "ai" };
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

// ---------- the reply ----------

function modelPrompt(c: ChatContext, rejected: string | null): string {
  return rejected ? `${c.prompt}\n\nyour last reply was not sent: ${rejected}. write it again.` : c.prompt;
}

/**
 * Troy's reply to a free message: the bubbles to send, or a flow to hand the message to.
 * Two tries at most (the second one carries the reason the first was rejected), then the hand-written fallback.
 */
export async function chatReply(input: {
  db: DatabaseSync;
  ctx: Pick<FlowContext, "user" | "event" | "intent">;
  allowHandoff?: boolean;
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
  const fallback = () => ({ bubbles: fallbackReply(db, user.id, event.text), handoff: null, source: "fallback" as const });
  if (!modelReady()) return fallback();

  const brain = loadBrain();
  const c = buildChatContext({
    db,
    user,
    chatId: event.chatId,
    text: event.text,
    messageId: event.messageId,
    hasImage: event.images.length > 0,
    details: intent.details,
    brain,
    lockedStep: lockedStepOpen(db, user.id),
  });
  const model = chatModel();
  let rejected: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out: ModelReply | null = await askJson<ModelReply>({
      model,
      system: chatSystem(brain),
      prompt: modelPrompt(c, rejected),
      maxTokens: 500,
      timeoutMs: model === "smart" ? 20_000 : 9000,
      cacheSystem: true,
    });
    // No answer at all (down, slow, refused): asking again would only double the wait.
    if (!out || typeof out !== "object" || Array.isArray(out)) {
      debug("fallback(no answer)", attempt + 1);
      return fallback();
    }
    const handoff = input.allowHandoff === false ? null : readHandoff(out.handoff);
    if (handoff) {
      debug(`handoff(${handoff.flow}.${handoff.action})`, attempt + 1);
      return { bubbles: [], handoff, source: "model" };
    }
    const check = checkReply(out.bubbles, c);
    if (check.ok) {
      debug("model", attempt + 1);
      return { bubbles: check.bubbles, handoff: null, source: "model" };
    }
    rejected = check.reason;
    debug("rejected", attempt + 1, check.reason);
  }
  debug("fallback(rejected twice)", 2);
  return fallback();
}

export const smalltalk: FlowHandler = {
  name: "smalltalk",
  async handle(ctx) {
    // A location share with no words never gets here: the pipeline saves it and answers with a fixed line.
    const again = handedOff.has(ctx.event);
    // A question about a directory program goes to the flow that sends the stored answer.
    if (!again && asksAboutProgram(ctx.db, ctx.event.text) && (await handOff(ctx, { flow: "usg", action: "question" }))) return;
    let reply = await chatReply({ db: ctx.db, ctx, allowHandoff: !again });
    if (reply.handoff) {
      if (await handOff(ctx, reply.handoff)) return;
      // The flow didn't take it (not registered, or it stayed silent): Troy answers it himself after all.
      reply = await chatReply({ db: ctx.db, ctx, allowHandoff: false });
    }
    const bubbles = reply.bubbles.length ? reply.bubbles : fallbackReply(ctx.db, ctx.user.id, ctx.event.text);
    await ctx.say(...bubbles);
  },
};
