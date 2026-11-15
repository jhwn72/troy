// Break attempts on "a chat never files anything on its own" (John's live conversation, Nov 14 7pm).
//
// Everything here goes through the real pipeline and the real flows, with only the adapter and the model faked.
// The model is scripted to be hostile or sloppy: it hands off on anything, words offers as if they were done, and
// makes offers of its own. Whatever it does, a report or a concern exists only after the student said yes to a
// question that code asked.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { IncomingEvent, IncomingImage, Intent, MessagingAdapter } from "../src/types.ts";
import { openDb, getOrCreateUser, getFlowState, getUserById, saveMessage, updateUser } from "../src/db/index.ts";
import { seed } from "../src/db/seed.ts";
import { createPipeline } from "../src/pipeline.ts";
import "../src/flows/index.ts";
import { fallbackIntent, setModelCall } from "../src/ai.ts";
import { TEMPLATES } from "../src/commands.ts";
import { setDemoHooks } from "../src/staff.ts";
import { setFirstTenDeps } from "../src/firstten.ts";
import { REPAIR_VOICE } from "../src/flows/repair.ts";
import { USG_VOICE } from "../src/flows/usg.ts";
import { setVariantPicker } from "../src/flows/reports-shared.ts";

console.warn = () => {};
setFirstTenDeps({ timers: false });
// The judge asides and the simulated other side are other modules' business.
setDemoHooks({ judgeAside: async () => {}, offerSimulation: async () => false, runSimulation: async () => false });
setVariantPicker((_db, _userId, _key, variants) => variants[0]!);

type Script = (prompt: string, system: string) => string;
let model: Script | null = null;
setModelCall(async (opts) => {
  if (!model) throw new Error("no json");
  return model(opts.prompt, opts.system);
});
after(() => {
  setModelCall(null);
  setFirstTenDeps(null);
  setDemoHooks(null);
  setVariantPicker(null);
});

const isChat = (system: string) => system.includes("You are writing troy's next text in a free chat");
const isOwnLine = (prompt: string) => prompt.includes("troy is about to send a message on his own");
const chat = (bubbles: string[], handoff: unknown = null) => JSON.stringify({ bubbles, handoff });
const newMessage = (prompt: string): string => {
  const m = prompt.match(/their new message: ("(?:[^"\\]|\\.)*")/);
  return m ? (JSON.parse(m[1]!) as string) : "";
};
/** A model that hands every single chat message to one flow, whatever it says, and can't word anything itself. */
const alwaysHandsOff = (flow: string, action: string): Script => (prompt, system) => {
  if (isOwnLine(prompt) || !isChat(system)) throw new Error("no json");
  return chat([], { flow, action, accepted: true, unconfirmed: false, fromChat: false, details: { accepted: true, unconfirmed: false } });
};

const canon = (text: string): string => USG_VOICE.canonical(REPAIR_VOICE.canonical(text));
const FMS = "Facilities Management Services (FMS)";
const HOUSING = "USC Housing maintenance";
const WHERE = "which building and floor?";
const ASK_NAME = "want me to send it with ur name or anonymously?";
const FILED = /reported to|passed it to|sent to the|added u to it|✅/;

type Row = { id: number; userId: number; kind: string; description: string; locationText: string | null; routedTo: string; followers: string; anonymous: number; photoUrl: string | null };

function world(route: (text: string) => Intent | null = () => null) {
  const db = openDb(":memory:");
  seed(db);
  const sent: { chatId: string; text: string; raw: string }[] = [];
  const prompts: { chatId: string | null; prompt: string }[] = [];
  let n = 0;
  const adapter: MessagingAdapter = {
    provider: "webchat",
    capabilities: () => ({ tapbacks: true, typing: true, readReceipts: true, edits: false, effects: true, polls: false, groupChats: false, contactCard: true, liveLocation: false }),
    async sendMessage(chatId, text) {
      sent.push({ chatId, text: canon(text), raw: text });
      return { messageId: `out-${++n}` };
    },
    sendImage: async () => null,
    sendContactCard: async () => null,
    async markRead() {},
    async startTyping() {},
    async stopTyping() {},
    react: async () => true,
    editMessage: async () => false,
    sendPoll: async (_c, _q, options) => ({ optionMessageIds: options.map(() => null), mode: "numbered" }),
    createGroupChat: async () => null,
    getLiveLocation: async () => null,
    requestLocation: async () => false,
    chatIdForHandle: (h) => `chat-${h}`,
  };
  const pipeline = createPipeline({ db, getAdapter: () => adapter, pause: async () => {}, ackAfterMs: 60_000, detectIntent: async (i) => route(i.text) ?? fallbackIntent(i) });
  let m = 0;
  const student = (handle: string, name = "Test Student") => {
    const chatId = `chat-${handle}`;
    const u = getOrCreateUser(db, handle, chatId);
    updateUser(db, u.id, { verifiedAt: Date.now(), verifiedVia: "usc_email", name });
    const send = async (over: Partial<IncomingEvent>) => {
      const before = sent.length;
      await pipeline.handleEvent({ provider: "webchat", userHandle: handle, chatId, isGroup: false, messageId: `in-${++m}`, text: "", images: [], receivedAt: Date.now(), ...over });
      return sent.slice(before).filter((s) => s.chatId === chatId).map((s) => s.text);
    };
    return { id: u.id, chatId, text: (t: string, images: IncomingImage[] = []) => send({ text: t, images }), send, state: () => getFlowState(db, u.id) };
  };
  const filed = () => db.prepare("SELECT * FROM reports WHERE isExample = 0 ORDER BY id").all() as unknown as Row[];
  /** Everyone following any real report: joining one is filing too. */
  const followers = () => filed().flatMap((r) => JSON.parse(r.followers || "[]") as number[]);
  return { db, student, filed, followers, sent, prompts, lastId: () => `out-${n}` };
}

// ---------- a hostile handoff ----------

test("a model that hands every message to repair never gets a report filed, whatever the student types short of a yes", async () => {
  model = alwaysHandsOff("repair", "report");
  try {
    const t = world();
    const a = t.student("+13105557001");
    const said: string[] = [];
    for (const text of ["leavey is such a mess lol", "haha", "Annenberg floor 3", "taper hall 2nd floor", "idk man", "its whatever", "what", "pardee tower", "3rd floor lobby", "my floor is so loud", "lol", "who even runs this place", "thanks i guess", "evk is falling apart", "birnkrant 5th floor"]) {
      said.push(...(await a.text(text)));
      assert.equal(t.filed().length, 0, `nothing filed after "${text}"`);
    }
    assert.ok(!said.some((b) => FILED.test(b)), said.join(" | "));
    assert.ok(!said.includes(WHERE), "he never collects a building for a report nobody asked for");
  } finally {
    model = null;
  }
});

test("a model that hands every message to usg as a concern never gets one sent, and never adds the student to someone else's", async () => {
  model = null;
  const t = world();
  // Someone else's open concern that reads the same.
  const other = t.student("+13105557010", "Other Person");
  await other.text("can u report that my roommates blast music at night in pardee tower");
  await other.text("with my name");
  assert.equal(t.filed().length, 1);
  model = alwaysHandsOff("usg", "concern");
  try {
    const a = t.student("+13105557011");
    const said: string[] = [];
    for (const text of ["my roommates blast music at night in pardee tower", "haha", "its so annoying", "idk", "pardee tower", "the dining hall food is mid", "class is hard", "lol", "what", "anonymously i guess they are loud", "whatever"]) {
      said.push(...(await a.text(text)));
      if (text.startsWith("anonymously")) break;
      assert.equal(t.filed().length, 1, `nothing new after "${text}"`);
      assert.deepEqual(t.followers(), [], `not added to anyone's concern after "${text}"`);
    }
    // "anonymously ..." typed at an open offer is the one thing above that answers it. Without an open offer it is nothing.
    assert.ok(t.filed().length <= 2);
  } finally {
    model = null;
  }
});

// ---------- a sloppy model: its own offer, then a yes ----------

test("a yes to something troy offered in his own words never files a repair: code names the office and asks first", async () => {
  model = (prompt, system) => {
    if (isOwnLine(prompt) || !isChat(system)) throw new Error("no json");
    const text = newMessage(prompt);
    if (text === "yes") return chat([], { flow: "repair", action: "report" });
    return chat(["lol classic", "i can tell u which stairs are faster, want that?"]);
  };
  try {
    const t = world();
    const a = t.student("+13105557021");
    await a.text("the elevator in leavey library is so slow");
    const reply = await a.text("yes");
    assert.equal(t.filed().length, 0, "a yes to a different question is not consent to report");
    assert.ok(!reply.some((b) => FILED.test(b)), reply.join(" | "));
    // What he says next is code's question, and it names where it would go.
    assert.match(reply.join(" "), /\bfms\b/);
    assert.match(reply.at(-1)!, /\?$/);
    // Saying no to it leaves nothing behind.
    await a.text("no");
    assert.equal(t.filed().length, 0);
    assert.equal(a.state(), null);
  } finally {
    model = null;
  }
});

test("a yes to something troy offered in his own words never joins someone else's concern without a code-worded offer", async () => {
  model = null;
  const t = world();
  const other = t.student("+13105557030", "Other Person");
  await other.text("can u report that my roommates blast music at night in pardee tower");
  await other.text("with my name");
  model = (prompt, system) => {
    if (isOwnLine(prompt) || !isChat(system)) throw new Error("no json");
    const text = newMessage(prompt);
    if (text === "yes") return chat([], { flow: "usg", action: "concern" });
    return chat(["ugh that's rough", "i can tell u a trick for sleeping through it, want that?"]);
  };
  try {
    const a = t.student("+13105557031");
    await a.text("my roommates blast music at night in pardee tower");
    const reply = await a.text("yes");
    assert.deepEqual(t.followers(), [], "not added to anyone's concern on a yes to something else");
    assert.equal(t.filed().length, 1);
    assert.ok(!reply.some((b) => FILED.test(b)), reply.join(" | "));
    assert.match(reply.join(" "), /usc housing/);
  } finally {
    model = null;
  }
});

// ---------- the router model alone ----------

test("the router model alone reading a vent as a repair gets an offer, never the building question and never a report", async () => {
  model = null;
  const VENT = "I told them but they didn't do anything";
  const SLOW = "the one in leavey library has been acting weird all week";
  const t = world((text) => (text === VENT || text === SLOW ? { flow: "repair", action: "report", details: {}, source: "ai" } : null));
  const a = t.student("+13105557041");
  const first = await a.text(VENT);
  assert.ok(!first.includes(WHERE), first.join(" | "));
  assert.equal(t.filed().length, 0);
  // The answer from that night, typed anyway: still nothing filed.
  const second = await a.text("Annenberg floor 3");
  assert.equal(t.filed().length, 0);
  assert.ok(!second.some((b) => FILED.test(b)), second.join(" | "));

  // Something that may well be a repair, read only by the model: he offers, naming the office, and a yes files it.
  const b = t.student("+13105557042");
  const offer = await b.text(SLOW);
  assert.equal(t.filed().length, 0);
  assert.equal(offer.length, 1);
  assert.match(offer[0]!, /report.*\bfms\b.*\?$/);
  assert.equal(b.state()?.step, "offer");
  assert.match((await b.text("yes"))[0]!, /reported to fms/);
  assert.deepEqual(t.filed().map((r) => [r.kind, r.routedTo, r.description]), [["repair", FMS, SLOW]]);
});

test("the router model alone reading a vent as a usg concern gets an offer that says where it would go", async () => {
  model = null;
  const VENT = "this econ class is wrecking me this semester";
  const t = world((text) => (text === VENT ? { flow: "usg", action: "concern", details: {}, source: "ai" } : null));
  const a = t.student("+13105557051");
  const reply = await a.text(VENT);
  assert.equal(t.filed().length, 0);
  assert.ok(!reply.includes(ASK_NAME), "never the bare name question on something they didn't ask to send");
  assert.equal(a.state()?.step, "offer");
  assert.match(reply.at(-1)!, /committee/i);
  assert.match(reply.at(-1)!, /\?/);
  await a.text("nah");
  assert.equal(t.filed().length, 0);
  assert.equal(a.state(), null);
});

// ---------- a yes to a different question ----------

const HOUSING_VENT = "my roommates are so loud every night and my ra does nothing";
const housingOffer: Script = (prompt, system) => {
  if (isOwnLine(prompt) || !isChat(system)) throw new Error("no json");
  return newMessage(prompt) === HOUSING_VENT ? chat([], { flow: "usg", action: "concern" }) : chat(["lol fair"]);
};

async function withOffer(handle: string) {
  const t = world();
  const a = t.student(handle);
  const reply = await a.text(HOUSING_VENT);
  assert.equal(a.state()?.flow, "usg");
  assert.equal(a.state()?.step, "offer");
  assert.match(reply.at(-1)!, /usc housing.*\?|\?.*usc housing/);
  assert.equal(t.filed().length, 0);
  return { t, a };
}

test("with an offer open, a yes to the delete question deletes and files nothing", async () => {
  model = housingOffer;
  try {
    const { t, a } = await withOffer("+13105557061");
    const ask = await a.text("erase everything u have on me");
    assert.match(ask.join(" "), /delete|erase/);
    assert.match(ask.join(" "), /"yes"/);
    assert.ok(getUserById(t.db, a.id), "not deleted before the yes");
    assert.equal(t.filed().length, 0);
    await a.text("yes");
    assert.equal(t.filed().length, 0, "the yes was to deleting, not to passing anything on");
    assert.ok(!t.sent.some((s) => s.text === ASK_NAME || FILED.test(s.text)));
    assert.equal(a.state(), null);
    // And nothing is left that a later yes could pick up.
    await a.text("yes");
    assert.equal(t.filed().length, 0);
  } finally {
    model = null;
  }
});

test("with an offer open, anything else troy sends closes it: a later yes, thumbs up or poll vote files nothing", async () => {
  model = housingOffer;
  try {
    // Something of his went out after the offer (an alert, a parked question, a move of his own).
    const { t, a } = await withOffer("+13105557062");
    const offerBubble = t.lastId();
    saveMessage(t.db, { userId: a.id, chatId: a.chatId, direction: "out", providerMessageId: "later-1", text: "btw there's free pizza about 8 min from u. want the spot?" });
    const reply = await a.text("yes");
    assert.equal(t.filed().length, 0);
    assert.ok(!reply.includes(ASK_NAME), reply.join(" | "));
    assert.notEqual(a.state()?.flow, "usg");
    // A thumbs up on the old offer bubble is late too.
    await a.send({ reaction: { targetMessageId: offerBubble, type: "like", removed: false } });
    assert.equal(t.filed().length, 0);
    assert.ok(!t.sent.some((s) => s.text === ASK_NAME));

    // A poll vote and a tapback on some other bubble never answer an open offer.
    const { t: t2, a: b } = await withOffer("+13105557063");
    await b.send({ pollVote: { pollMessageId: "poll-x", optionIndex: 0, optionText: "yes", selected: true } as unknown as IncomingEvent["pollVote"] });
    await b.send({ reaction: { targetMessageId: `out-${t2.sent.length - 1}`, type: "love", removed: false } });
    await b.send({ reaction: { targetMessageId: "in-1", type: "like", removed: false } });
    // A thumbs up that was taken back is not a yes either.
    await b.send({ reaction: { targetMessageId: t2.lastId(), type: "like", removed: true } });
    assert.equal(t2.filed().length, 0);
    assert.ok(!t2.sent.some((s) => s.text === ASK_NAME));
  } finally {
    model = null;
  }
});

test("with an offer open, a question is not a yes, and a real request for something else takes over and clears it", async () => {
  model = housingOffer;
  try {
    const { t, a } = await withOffer("+13105557064");
    for (const text of ["yes?", "ok but why", "sure if it's anonymous?"]) {
      await a.text(text);
      assert.equal(t.filed().length, 0, text);
    }
    const { t: t2, a: b } = await withOffer("+13105557065");
    await b.text("i lost my airpods at leavey yesterday");
    assert.notEqual(b.state()?.flow, "usg", "the offer is gone");
    assert.equal(t2.filed().length, 0);
    await b.text("yes");
    assert.equal(t2.filed().length, 0, "a yes after the subject changed is not a yes to the offer");
    assert.ok(!t2.sent.some((s) => s.text === ASK_NAME));
  } finally {
    model = null;
  }
});

// ---------- the offer is only ever about their own words ----------

test("an offer, and what is filed from it, carries only that student's own words", async () => {
  const offers: string[] = [];
  model = (prompt, system) => {
    if (isOwnLine(prompt)) {
      offers.push(prompt);
      throw new Error("no json");
    }
    if (!isChat(system)) throw new Error("no json");
    return /loud|ra\b/.test(newMessage(prompt)) ? chat([], { flow: "usg", action: "concern" }) : chat(["lol fair"]);
  };
  try {
    const t = world();
    const a = t.student("+13105557071", "Priya Zebrowski");
    await a.text("my roommate mallory in birnkrant 412 is so loud and my ra does nothing");
    await a.text("with my name");
    assert.equal(t.filed().length, 1);
    const before = offers.length;
    const b = t.student("+13105557072", "Sam Okafor");
    const said = [...(await b.text("ugh")), ...(await b.text("my floor is so loud at night and the ra shrugs"))];
    const state = b.state()!;
    assert.equal(state.step, "offer");
    const theirs = /mallory|birnkrant|412|priya|zebrowski/i;
    assert.ok(!theirs.test(JSON.stringify(state.data)), "nothing of the other student's in what he holds");
    assert.ok(!theirs.test(said.join(" ")), said.join(" | "));
    for (const p of offers.slice(before)) assert.ok(!theirs.test(p), "nothing of the other student's reaches the model for this offer");
    const done = await b.text("anonymously");
    assert.ok(!theirs.test(done.join(" ")), done.join(" | "));
    const mine = t.filed().filter((r) => r.userId === b.id);
    assert.equal(mine.length, 1, "a different hall and a different situation is its own concern");
    assert.equal(mine[0]!.description, "ugh. my floor is so loud at night and the ra shrugs");
    assert.equal(mine[0]!.anonymous, 1);
    assert.deepEqual(t.followers(), []);
  } finally {
    model = null;
  }
});

// ---------- the offer's wording ----------

test("an offer the model words as already done is never sent: the hand-written question goes out instead", async () => {
  for (const lie of [
    ["done, i reported it to usc housing for u ✅", "anything else?"],
    ["ugh that's rough", "i already passed this to usc housing with ur name. cool?"],
    ["it's sent to usc housing. want anything else?"],
  ]) {
    model = (prompt, system) => {
      if (isOwnLine(prompt)) return JSON.stringify({ bubbles: lie, covers: ["passed this to usc housing", "with ur name"] });
      if (!isChat(system)) throw new Error("no json");
      return newMessage(prompt) === HOUSING_VENT ? chat([], { flow: "usg", action: "concern" }) : chat(["lol fair"]);
    };
    try {
      const t = world();
      const a = t.student("+13105557081");
      const reply = await a.text(HOUSING_VENT);
      assert.equal(t.filed().length, 0);
      assert.ok(!reply.some((b) => /✅|\breported\b|already|it's sent/.test(b)), reply.join(" | "));
      assert.match(reply.at(-1)!, /usc housing/);
      assert.match(reply.at(-1)!, /\?/);
    } finally {
      model = null;
    }
  }
});

// ---------- asking for it, or sending a photo, still skips the offer ----------

test("an explicit request or a photo goes straight through with a hostile model around", async () => {
  model = alwaysHandsOff("usg", "concern");
  try {
    const t = world();
    const a = t.student("+13105557091");
    assert.match((await a.text("the elevator in leavey library is broken"))[0]!, /reported to fms/);
    const b = t.student("+13105557092");
    assert.match((await b.text("this is broken, taper hall 2nd floor", [{ path: "/tmp/troy-test/light.jpg", mime: "image/jpeg" }]))[0]!, /reported to fms/);
    const c = t.student("+13105557093");
    assert.deepEqual(await c.text("my door lock is broken", [{ path: "/tmp/troy-test/lock.jpg", mime: "image/jpeg" }]), [WHERE]);
    assert.match((await c.text("pardee tower 3rd floor"))[0]!, /reported to housing/);
    assert.deepEqual(t.filed().map((r) => [r.kind, r.routedTo]), [["repair", FMS], ["repair", FMS], ["repair", HOUSING]]);
    assert.equal(t.filed()[2]!.photoUrl, "/tmp/troy-test/lock.jpg");

    // Asking for a concern to be passed on: where it goes and the one name question, no offer step.
    const d = t.student("+13105557094");
    const asked = await d.text("can u report my ra, he won't do anything about the noise");
    assert.equal(asked.at(-1), ASK_NAME);
    assert.match(asked.join(" "), /usc housing/);
    assert.equal(d.state()?.step, "ask_name");
    assert.match((await d.text("anonymously"))[0]!, /passed it to usc housing/);
    const e = t.student("+13105557095");
    assert.deepEqual(await e.text("can u tell usg the dining halls close way too early"), [ASK_NAME]);
  } finally {
    model = null;
  }
});

// ---------- emergency, crisis and STOP still win ----------

test("with an offer open, emergency, crisis and STOP get their fixed replies and nothing is filed", async () => {
  model = housingOffer;
  try {
    const fire = await withOffer("+13105557101");
    assert.deepEqual(await fire.a.text("there's a fire in my dorm"), TEMPLATES.emergency);
    assert.equal(fire.t.filed().length, 0);

    const crisis = await withOffer("+13105557102");
    assert.deepEqual(await crisis.a.text("i want to kill myself"), TEMPLATES.crisis);
    assert.equal(crisis.t.filed().length, 0);
    // A yes right after the crisis line is never a yes to the offer.
    await crisis.a.text("yes");
    assert.equal(crisis.t.filed().length, 0);
    assert.ok(!crisis.t.sent.some((s) => s.text === ASK_NAME));

    const stop = await withOffer("+13105557103");
    assert.deepEqual(await stop.a.text("STOP"), TEMPLATES.stop);
    assert.equal(getUserById(stop.t.db, stop.a.id)!.stopped, true);
    assert.deepEqual(await stop.a.text("yes"), [], "nothing at all after STOP");
    assert.equal(stop.t.filed().length, 0);
    // Coming back does not revive the offer.
    await stop.a.text("START");
    await stop.a.text("yes");
    assert.equal(stop.t.filed().length, 0);
    assert.ok(!stop.t.sent.some((s) => s.text === ASK_NAME));
  } finally {
    model = null;
  }
});

// From the live replay: the router model (not the chat model) read the last line of the dorm thread as a usg concern.
// The line itself names nothing, so what he understood has to come from what they said just before.
test("the router model reading the end of a vent as a concern: the offer is built from the thread and names usc housing", async () => {
  const LAST = "I told them but they didn't do anything";
  model = (prompt, system) => {
    if (isOwnLine(prompt) || !isChat(system)) throw new Error("no json");
    return chat(["ugh, that's rough"]);
  };
  try {
    const t = world((text) => (text === LAST ? { flow: "usg", action: "concern", details: {}, source: "ai" } : null));
    const a = t.student("+13105557111");
    await a.text("Dorm mates are annoying");
    await a.text("Yeah and my ra doesn't enforce it");
    const offer = await a.text(LAST);
    assert.equal(t.filed().length, 0);
    assert.match(offer.at(-1)!, /usc housing/);
    assert.ok(!/usg general/i.test(offer.join(" ")), offer.join(" | "));
    assert.equal(a.state()?.step, "offer");
    assert.equal(a.state()?.data.description, "Dorm mates are annoying. Yeah and my ra doesn't enforce it. I told them but they didn't do anything");
    assert.equal((await a.text("yes")).at(-1), ASK_NAME);
    assert.match((await a.text("with my name"))[0]!, /passed it to usc housing/);
    assert.deepEqual(t.filed().map((r) => [r.kind, r.routedTo, r.anonymous]), [["usg_concern", HOUSING, 0]]);
  } finally {
    model = null;
  }
});

// ---------- one offer, not the same offer again and again ----------
//
// From the live replay: he offered after "Dorm mates are annoying", they kept explaining instead of answering, and
// the same offer went out three messages in a row.

/** Hands the dorm thread to usg every time, reacts when told the offer stands, and talks about anything else. */
function dormModel(reaction: string[]): Script {
  // He never says the same thing twice in one conversation (the reply check holds him to it), so each reaction differs.
  const openers = ["ugh", "oof", "yeah no", "honestly", "man", "wow"];
  let n = 0;
  return (prompt, system) => {
    if (isOwnLine(prompt) || !isChat(system)) throw new Error("no json");
    if (prompt.includes("that offer is still open")) return chat(reaction.map((r, i) => (i === 0 ? `${openers[n++ % openers.length]}, ${r}` : r)));
    return /dorm|ra\b|told them|loud/i.test(newMessage(prompt)) ? chat([], { flow: "usg", action: "concern" }) : chat(["lol fair"]);
  };
}

test("an open offer stands while they keep talking about it: he reacts, never repeats it, and a later yes is still asked where and how", async () => {
  model = dormModel(["an ra who lets it slide is the worst part"]);
  try {
    const t = world();
    const a = t.student("+13105557121");
    const first = await a.text("Dorm mates are annoying");
    assert.match(first.at(-1)!, /usc housing.*\?|\?.*usc housing/);
    const offers = () => t.sent.filter((s) => /usc housing/.test(s.text) && /\?/.test(s.text)).length;
    assert.equal(offers(), 1);
    assert.deepEqual(await a.text("Yeah and my ra doesn't enforce it"), ["ugh, an ra who lets it slide is the worst part"]);
    assert.deepEqual(await a.text("I told them but they didn't do anything"), ["oof, an ra who lets it slide is the worst part"]);
    assert.equal(offers(), 1, "the offer went out once");
    assert.equal(t.filed().length, 0);
    const state = a.state()!;
    assert.equal(state.step, "offer");
    assert.equal(state.data.description, "Dorm mates are annoying. Yeah and my ra doesn't enforce it. I told them but they didn't do anything");
    // The yes comes after other bubbles of his, so code says where it goes again and asks the one question.
    assert.deepEqual(await a.text("yes"), ["that one goes to usc housing", ASK_NAME]);
    assert.equal(t.filed().length, 0);
    assert.match((await a.text("anonymously"))[0]!, /passed it to usc housing/);
    assert.deepEqual(t.filed().map((r) => [r.kind, r.routedTo, r.anonymous, r.description]), [["usg_concern", HOUSING, 1, "Dorm mates are annoying. Yeah and my ra doesn't enforce it. I told them but they didn't do anything"]]);
  } finally {
    model = null;
  }
});

test("an open offer stands whichever way the router read their next message", async () => {
  const NEXT = "I told them but they didn't do anything";
  for (const routed of ["smalltalk", "usg", "repair"] as const) {
    model = dormModel(["so u told them and nothing changed. that's the part that would get me"]);
    try {
      const t = world((text) => (text === NEXT ? { flow: routed, action: routed === "smalltalk" ? "chat" : routed === "usg" ? "concern" : "report", details: {}, source: "ai" } : null));
      const a = t.student("+13105557127");
      await a.text("Dorm mates are annoying");
      const reply = await a.text(NEXT);
      assert.equal(t.sent.filter((s) => /usc housing/.test(s.text) && /\?/.test(s.text)).length, 1, `${routed}: the offer went out once`);
      assert.deepEqual(reply, ["ugh, so u told them and nothing changed. that's the part that would get me"], routed);
      assert.equal(a.state()?.step, "offer", routed);
      assert.equal(t.filed().length, 0, routed);
      assert.ok(!t.sent.some((s) => /\bfms\b|which building/.test(s.text)), routed);
    } finally {
      model = null;
    }
  }
});

test("a standing offer ends when he asks something else, when they move on, or after a few messages: a yes after that files nothing", async () => {
  try {
    // His reaction carried a question of its own: the next yes answers that.
    model = dormModel(["that's rough", "is it every night?"]);
    const t = world();
    const a = t.student("+13105557122");
    await a.text("Dorm mates are annoying");
    await a.text("Yeah and my ra doesn't enforce it");
    assert.equal(a.state(), null, "the offer is gone once he asked something else");
    model = (prompt, system) => {
      if (isOwnLine(prompt) || !isChat(system)) throw new Error("no json");
      return chat(["ok"]);
    };
    const yes = await a.text("yes");
    assert.ok(!yes.includes(ASK_NAME), yes.join(" | "));
    assert.equal(t.filed().length, 0);

    // They moved on: the model no longer reads it as the concern.
    model = dormModel(["that's the worst part"]);
    const t2 = world();
    const b = t2.student("+13105557123");
    await b.text("Dorm mates are annoying");
    await b.text("Yeah and my ra doesn't enforce it");
    assert.equal(b.state()?.step, "offer");
    assert.deepEqual(await b.text("anyway did u watch the game"), ["lol fair"]);
    assert.equal(b.state(), null);
    await b.text("yes");
    assert.equal(t2.filed().length, 0);
    assert.ok(!t2.sent.some((s) => s.text === ASK_NAME));

    // It is kept a few times at most, however long the model keeps reading it as the same thing.
    const t3 = world();
    const c = t3.student("+13105557124");
    await c.text("Dorm mates are annoying");
    for (const more of ["my ra is useless", "so loud every night", "told them twice", "the ra just shrugs", "still loud"]) await c.text(more);
    assert.ok(t3.sent.filter((s) => /usc housing/.test(s.text) && /\?/.test(s.text)).length <= 2, "never the same offer message after message");
    assert.equal(t3.filed().length, 0);

    // A standing offer still lapses with time.
    const t4 = world();
    const d = t4.student("+13105557125");
    await d.text("Dorm mates are annoying");
    await d.text("Yeah and my ra doesn't enforce it");
    t4.db.prepare("UPDATE flow_state SET updatedAt = ? WHERE userId = ?").run(Date.now() - 11 * 60 * 1000, d.id);
    model = (prompt, system) => {
      if (isOwnLine(prompt) || !isChat(system)) throw new Error("no json");
      return chat(["ok"]);
    };
    const late = await d.text("yes");
    assert.ok(!late.includes(ASK_NAME), late.join(" | "));
    assert.equal(t4.filed().length, 0);
  } finally {
    model = null;
  }
});

test("a standing repair offer: a later yes gets the office named again before anything is filed", async () => {
  model = (prompt, system) => {
    if (isOwnLine(prompt) || !isChat(system)) throw new Error("no json");
    if (prompt.includes("that offer is still open")) return chat(["that building has seen better days"]);
    return /evk|falling apart|ceiling/.test(newMessage(prompt)) ? chat([], { flow: "repair", action: "report" }) : chat(["lol fair"]);
  };
  try {
    const t = world();
    const a = t.student("+13105557126");
    const offer = await a.text("evk is falling apart lol");
    assert.match(offer.at(-1)!, /\bfms\b.*\?/);
    assert.deepEqual(await a.text("like the ceiling tiles look rough"), ["that building has seen better days"]);
    assert.equal(a.state()?.step, "offer");
    assert.deepEqual(await a.text("yes"), ["sending this to fms as a repair report. ok?"]);
    assert.equal(t.filed().length, 0);
    assert.match((await a.text("ok"))[0]!, /reported to fms/);
    assert.equal(t.filed().length, 1);
  } finally {
    model = null;
  }
});
