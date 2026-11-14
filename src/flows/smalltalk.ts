// Default handler for anything without a flow yet. One or two short bubbles.

import type { FlowHandler } from "../types.ts";
import { composeReply } from "../ai.ts";

const CAN_DO = "i can help with lost or found stuff, free food, broken things on campus, or who to talk to about a campus issue";
// Used when the model is down or there is no key. Neutral, so a plain "hi" doesn't get "not sure i got that".
const FALLBACK = ["hey, troy here", CAN_DO];
const FALLBACK_GREETING = ["hey", `what's up? ${CAN_DO}`];
const GREETING = /^(?:hi+|hey+|heyo|hello+|yo+|sup|wassup|whats up|hiya|howdy|gm|good (?:morning|afternoon|evening))(?: troy)?$/;

export const smalltalk: FlowHandler = {
  name: "smalltalk",
  async handle(ctx) {
    const text = ctx.event.text.trim();
    // A location share with no words never gets here: the pipeline saves it and answers with a fixed line.
    const plain = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
    const notes = (ctx.db.prepare("SELECT text FROM user_notes WHERE userId = ? ORDER BY id").all(ctx.user.id) as { text: string }[]).map((n) => n.text);
    const bubbles = await composeReply({
      goal:
        `reply in one or two short bubbles to this text from a student: ${JSON.stringify(ctx.event.text.slice(0, 500))}. ` +
        "if it's a greeting or small talk, be friendly and brief. if it asks for something, say what you can help with: " +
        "lost or found items, free food, broken things on campus, or who to talk to about a campus issue. don't promise anything else.",
      facts: {},
      notes,
      fallback: GREETING.test(plain) ? FALLBACK_GREETING : FALLBACK,
    });
    await ctx.say(...bubbles.slice(0, 2));
  },
};
