import { test } from "node:test";
import assert from "node:assert/strict";
import { setDemoHooks } from "../src/staff.ts";
import type { AsideNote, SimKind } from "../src/staff.ts";
import type { FlowHandler, IncomingEvent, IncomingImage, Intent, MessagingAdapter } from "../src/types.ts";
import { openDb, getOrCreateUser, getFlowState, saveMessage, updateUser } from "../src/db/index.ts";
import { seed } from "../src/db/seed.ts";
import { createPipeline } from "../src/pipeline.ts";
import { registerFlow } from "../src/flows/index.ts";
import { fallbackIntent, setModelCall } from "../src/ai.ts";
import { DPS } from "../src/commands.ts";
import { repair, DANGER_LINE, REPAIR_POOLS, REPAIR_VOICE, thingOf } from "../src/flows/repair.ts";
import { DEMO_NOTE, DEMO_NOTE_POOL, poolProblems, setVariantPicker } from "../src/flows/reports-shared.ts";
import type { VariantPicker, Voice } from "../src/flows/reports-shared.ts";


/**
 * Facts locked, wording varied: any line Troy sends may be any variant from the exported pools. The fake adapter
 * records each bubble read back to its first wording, with every name, number and link kept exactly as sent, so
 * the assertions below hold for whichever variant went out. `raw` keeps the words as they were sent.
 */
const canon = (text: string): string => REPAIR_VOICE.canonical(text);

const FMS = "Facilities Management Services (FMS)";
const HOUSING = "USC Housing maintenance";
const CONFIRM_FMS = "reported to fms ✅ i'll text u when it moves.";
const CONFIRM_HOUSING = "reported to housing ✅ i'll text u when it moves.";

type Report = { id: number; userId: number; kind: string; category: string; description: string; photoUrl: string | null; locationText: string | null; routedTo: string; status: string; followers: string; isExample: number };

// No model by default: every reply path has to work without one.
let model: ((prompt: string, system: string) => string) | null = null;
// Judge asides (src/judge.ts) and the simulated other side (src/simulate.ts) are other modules. Every test in this
// file runs against these recording fakes: nothing is said for an aside, and no simulation is offered unless a test
// turns `demo.accept` on.
const SIM_LINE = "(example) here's how the other side would play out";
const demo = {
  asides: [] as { userId: number; note: AsideNote }[],
  offers: [] as { userId: number; kind: SimKind; context: Record<string, string> }[],
  runs: 0,
  /** offerSimulation says yes and takes the person's open step, the way the real one does. */
  accept: false,
  /** runSimulation says it handled the message. */
  consume: false,
  reset(): void {
    this.asides.length = 0;
    this.offers.length = 0;
    this.runs = 0;
    this.accept = false;
    this.consume = false;
  },
};
setDemoHooks({
  judgeAside: async (ctx, note) => {
    demo.asides.push({ userId: ctx.user.id, note });
  },
  offerSimulation: async (ctx, kind, context) => {
    demo.offers.push({ userId: ctx.user.id, kind, context });
    if (demo.accept) ctx.setState({ flow: "repair", step: "sim_offer", data: { simulation: kind } });
    return demo.accept;
  },
  runSimulation: async (ctx) => {
    demo.runs++;
    // The real one plays the other side out loud. One line stands in for that here.
    if (demo.consume) await ctx.say(SIM_LINE);
    return demo.consume;
  },
});

setModelCall(async (opts) => {
  if (!model) throw new Error("no json");
  return model(opts.prompt, opts.system);
});

const foodSeen: string[] = [];
const food: FlowHandler = {
  name: "food",
  async handle(ctx) {
    foodSeen.push(ctx.event.text);
    assert.equal(ctx.state, null);
    await ctx.say("food reply");
  },
};
registerFlow(repair);
registerFlow(food);

/** `route` stands in for the router model on the messages it names; everything else gets the keyword rules. */
function setup(route: (text: string) => Intent | null = () => null) {
  const db = openDb(":memory:");
  seed(db);
  const sent: { chatId: string; text: string; raw: string }[] = [];
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
    sendPoll: async (_c, _q, options) => ({ optionMessageIds: options.map(() => null), mode: "tap" }),
    createGroupChat: async () => null,
    getLiveLocation: async () => null,
    requestLocation: async () => false,
    chatIdForHandle: (h) => `chat-${h}`,
  };
  const pipeline = createPipeline({ db, getAdapter: () => adapter, pause: async () => {}, ackAfterMs: 60_000, detectIntent: async (i) => route(i.text) ?? fallbackIntent(i) });
  let m = 0;
  /** A verified student. `text` sends one message through the real pipeline and returns Troy's bubbles to them. */
  const student = (handle: string) => {
    const chatId = `chat-${handle}`;
    const u = getOrCreateUser(db, handle, chatId);
    updateUser(db, u.id, { verifiedAt: Date.now(), verifiedVia: "judge_skip", name: "Test Student" });
    const send = async (over: Partial<IncomingEvent>) => {
      const before = sent.length;
      await pipeline.handleEvent({ provider: "webchat", userHandle: handle, chatId, isGroup: false, messageId: `in-${++m}`, text: "", images: [], receivedAt: Date.now(), ...over });
      return sent.slice(before).filter((s) => s.chatId === chatId).map((s) => s.text);
    };
    return { id: u.id, text: (t: string, images: IncomingImage[] = []) => send({ text: t, images }), send, state: () => getFlowState(db, u.id) };
  };
  const reports = () => db.prepare("SELECT * FROM reports WHERE kind = 'repair' ORDER BY id").all() as unknown as Report[];
  const mine = () => reports().filter((r) => !r.isExample);
  return { db, student, reports, mine, sent };
}

/** What the adapter returns as the id of the newest bubble (ids count up across every chat). */
const lastBubbleId = (t: { sent: unknown[] }): string => `out-${t.sent.length}`;

test("a broken thing with the place in the text is routed to FMS", async () => {
  const t = setup();
  const a = t.student("+13105550001");
  const reply = await a.text("the light is broken in taper hall 2nd floor");
  assert.equal(reply[0], CONFIRM_FMS);
  // The first report says, in one short line, that it is logged on the dashboard and the office's system isn't connected.
  assert.deepEqual(reply, [CONFIRM_FMS, DEMO_NOTE]);
  assert.match(DEMO_NOTE, /staff dashboard/);
  assert.match(DEMO_NOTE, /isn't connected yet/);
  const rows = t.mine();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].routedTo, FMS);
  assert.equal(rows[0].userId, a.id);
  assert.equal(rows[0].category, "broken light");
  assert.equal(rows[0].locationText, "Taper Hall, 2nd floor");
  assert.equal(rows[0].description, "the light is broken in taper hall 2nd floor");
  assert.equal(rows[0].followers, "[]");
  assert.equal(rows[0].status, "received");
  assert.equal(a.state(), null);
});

test("a dorm is routed to USC Housing maintenance", async () => {
  const t = setup();
  const a = t.student("+13105550002");
  const reply = await a.text("the washer is broken in pardee tower");
  assert.equal(reply[0], CONFIRM_HOUSING);
  assert.equal(reply[1], DEMO_NOTE);
  assert.equal(t.mine().length, 1);
  assert.equal(t.mine()[0].routedTo, HOUSING);
  assert.equal(t.mine()[0].locationText, "Pardee Tower");
});

test("an unclear spot gets one question, then the report is filed", async () => {
  const t = setup();
  const a = t.student("+13105550003");
  assert.deepEqual(await a.text("the printer is broken"), ["which building and floor?"]);
  assert.equal(t.mine().length, 0);
  assert.equal(a.state()?.flow, "repair");
  const reply = await a.text("sgm 3rd floor");
  assert.equal(reply[0], CONFIRM_FMS);
  assert.ok(!reply.join("\n").includes("which building"));
  const rows = t.mine();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].description, "the printer is broken");
  assert.equal(rows[0].category, "broken printer");
  assert.equal(rows[0].locationText, "Seeley G. Mudd Building, 3rd floor");
  assert.equal(rows[0].routedTo, FMS);
  assert.equal(a.state(), null);
});

test("an answer that names no known place is still filed, never asked twice", async () => {
  const t = setup();
  const a = t.student("+13105550004");
  await a.text("the printer is broken");
  const reply = await a.text("the basement of my dorm");
  assert.equal(reply[0], CONFIRM_HOUSING);
  assert.equal(t.mine()[0].locationText, "the basement of my dorm");
  assert.equal(a.state(), null);
});

test("a second student reporting the same thing becomes a follower, with no new row", async () => {
  const t = setup();
  const a = t.student("+13105550005");
  const b = t.student("+13105550006");
  await a.text("the light is out in fertitta 3rd floor");
  const before = t.reports().length;
  const reply = await b.text("broken light at jff, third floor");
  assert.equal(t.reports().length, before);
  assert.match(reply[0], /^1 other person already reported that to fms/);
  assert.match(reply.join("\n"), /i'll text u when it moves/);
  assert.ok(!reply.includes(CONFIRM_FMS));
  const row = t.mine()[0];
  assert.equal(row.userId, a.id);
  assert.deepEqual(JSON.parse(row.followers), [b.id]);

  // The same student again is not added twice.
  const again = await b.text("broken light at jff, third floor");
  assert.match(again[0], /already reported/);
  assert.deepEqual(JSON.parse(t.mine()[0].followers), [b.id]);
  assert.equal(t.reports().length, before);

  // A different floor is a different problem.
  await b.text("broken light at jff, 1st floor");
  assert.equal(t.reports().length, before + 1);
});

test("different rooms and different fixtures in one building are different reports", async () => {
  const t = setup();
  const a = t.student("+13105550041");
  const b = t.student("+13105550042");
  await a.text("the toilet in birnkrant room 204 is clogged");
  const before = t.mine().length;
  const reply = await b.text("toilet is clogged in birnkrant room 512");
  assert.equal(reply[0], CONFIRM_HOUSING);
  assert.equal(t.mine().length, before + 1, "room 512 gets its own report");
  assert.match(t.mine().at(-1)!.locationText!, /room 512/);

  // A card reader and a door lock are not the same repair.
  await a.text("card reader is broken at leavey entrance");
  const n = t.mine().length;
  const other = await b.text("the bathroom door lock is broken in leavey");
  assert.equal(other[0], CONFIRM_FMS);
  assert.equal(t.mine().length, n + 1);

  // The same room and the same thing still joins.
  const c = t.student("+13105550043");
  const joined = await c.text("clogged toilet, birnkrant room 204");
  assert.match(joined[0], /^1 other person already reported that to housing/);
  assert.equal(thingOf("card reader won't scan"), "card reader");
  assert.equal(thingOf("the lock is jammed"), "lock");
  assert.equal(thingOf("door won't close"), "door");
});

test("a report that matches an open one filed under the short office name (routedTo 'FMS') joins it", async () => {
  const t = setup();
  // Example rows are never joined (a real student isn't counted with made-up people), so treat the seeded rows as real here.
  t.db.prepare("UPDATE reports SET isExample = 0").run();
  const seeded = t.reports().find((r) => r.locationText === "leavey library" && r.status === "received")!;
  assert.ok(seeded);
  const before = t.reports().length;
  const a = t.student("+13105550007");
  const reply = await a.text("the elevator in leavey is stuck again");
  assert.match(reply[0], /already reported that to fms/);
  assert.equal(t.reports().length, before);
  const after = t.reports().find((r) => r.id === seeded.id)!;
  assert.ok((JSON.parse(after.followers) as number[]).includes(a.id));
});

test("an example report is never joined: the student's own report is filed", async () => {
  const t = setup();
  const before = t.reports().length;
  const a = t.student("+13105550017");
  const reply = await a.text("the elevator in leavey is stuck again");
  assert.match(reply[0], /^reported to fms/);
  assert.equal(t.reports().length, before + 1);
});

test("something dangerous gets the fixed DPS line and no emoji", async () => {
  const t = setup();
  const a = t.student("+13105550008");
  const reply = await a.text("the outlet is broken and there are exposed wires in olin hall");
  assert.equal(reply[0], DANGER_LINE);
  assert.ok(reply[0].includes(DPS.upcNonEmergency));
  assert.equal(reply[1], "reported to fms. i'll text u when it moves.");
  assert.ok(!reply.join("").includes("✅"));
  assert.equal(t.mine().length, 1);
});

test("nvm cancels the open question, and an unrelated request goes to its own flow", async () => {
  const t = setup();
  const a = t.student("+13105550009");
  await a.text("the printer is broken");
  assert.deepEqual(await a.text("nvm"), ["all good, dropped it"]);
  assert.equal(a.state(), null);
  assert.equal(t.mine().length, 0);

  await a.text("the printer is broken");
  foodSeen.length = 0;
  assert.deepEqual(await a.text("we have leftover pizza at tcc, come grab some"), ["food reply"]);
  assert.equal(foodSeen.length, 1);
  assert.equal(a.state(), null);
  assert.equal(t.mine().length, 0);
});

test("a shrug is not a building, and a stale question is forgotten", async () => {
  const t = setup();
  const a = t.student("+13105550011");
  await a.text("the printer is broken");
  const reply = await a.text("idk");
  assert.equal(reply.length, 1);
  assert.match(reply[0], /didn't report/);
  assert.equal(a.state(), null);
  assert.equal(t.mine().length, 0);

  await a.text("the printer is broken");
  t.db.prepare("UPDATE flow_state SET updatedAt = ? WHERE userId = ?").run(Date.now() - 2 * 60 * 60 * 1000, a.id);
  // Hours later this is a new report, not the answer to the old question.
  assert.equal((await a.text("the toilet is clogged in leavey 1st floor"))[0], CONFIRM_FMS);
  assert.equal(t.mine().length, 1);
  assert.equal(t.mine()[0].description, "the toilet is clogged in leavey 1st floor");
  assert.equal(a.state(), null);
});

test("with a model, one photo call fills category, description and the place", async () => {
  const t = setup();
  const a = t.student("+13105550010");
  let calls = 0;
  model = () => {
    calls++;
    return '{"category": "Broken Light", "description": "ceiling light is hanging loose", "location": "taper hall 2nd floor hallway"}';
  };
  try {
    const direct = await a.text("this is broken", [{ path: "/tmp/troy-test/light.jpg", mime: "image/jpeg" }]);
    assert.equal(direct[0], CONFIRM_FMS);
    assert.equal(calls, 1);
    const row = t.mine()[0];
    assert.equal(row.category, "broken light");
    assert.equal(row.description, "ceiling light is hanging loose");
    assert.equal(row.photoUrl, "/tmp/troy-test/light.jpg");
    assert.equal(row.locationText, "Taper Hall, 2nd floor, hallway");
    assert.equal(row.routedTo, FMS);
  } finally {
    model = null;
  }
});

// ---------- facts locked, wording varied ----------

/** Always the last variant of a pool, so every pooled line goes out in words other than its first wording. */
const lastVariant: VariantPicker = (_db, _userId, _key, variants) => variants[variants.length - 1]!;
const numbersIn = (t: string): string => (t.match(/\d+/g) ?? []).join(",");
/** Every bubble is one of its line's own variants, and carries exactly the numbers its first wording carries. */
function assertSameFacts(voice: Voice, sent: { text: string; raw: string }[]): void {
  for (const b of sent) {
    assert.ok(voice.variantsOf(b.text).includes(b.raw), `not a known variant: ${b.raw}`);
    assert.equal(numbersIn(b.raw), numbersIn(b.text), b.raw);
  }
}

test("repair wording pools are well formed, the danger line has no variants, and every demo note is one short line", () => {
  assert.deepEqual(poolProblems(REPAIR_POOLS), []);
  assert.deepEqual(REPAIR_VOICE.variantsOf(DANGER_LINE), [DANGER_LINE]);
  assert.deepEqual(REPAIR_VOICE.variantsOf(DEMO_NOTE), [...DEMO_NOTE_POOL]);
  for (const v of DEMO_NOTE_POOL) {
    assert.ok(v.length <= 110 && !v.includes("\n"), `one short line: ${v}`);
    assert.match(v, /staff dashboard/);
    assert.match(v, /(?:isn't connected|isn't hooked up) yet/);
    assert.doesNotMatch(v, /[—–]|\byou\b|[A-Z]/);
  }
  // Every wording of the confirmation names the same office.
  for (const v of REPAIR_VOICE.variantsOf(CONFIRM_FMS)) assert.match(v, /\bfms\b/);
});

test("repair: with other wording on every line, the office, the count of others and the danger line are exactly the same", async () => {
  setVariantPicker(lastVariant);
  try {
    const t = setup();
    const a = t.student("+13105550001");
    const b = t.student("+13105550002");
    assert.equal((await a.text("the light is broken in taper hall 2nd floor"))[0], CONFIRM_FMS);
    const joined = await b.text("broken light at taper hall 2nd floor");
    assert.equal(joined[0], "1 other person already reported that to fms, so i added u to it");
    const danger = await a.text("the outlet is broken and there are exposed wires in olin hall");
    assert.equal(danger[0], DANGER_LINE);
    assertSameFacts(REPAIR_VOICE, t.sent);
    assert.ok(t.sent.filter((s) => s.raw !== s.text).length >= 3, "the wording really did change");
    const raw = t.sent.map((s) => s.raw);
    assert.ok(raw.includes(DANGER_LINE), "the danger line went out word for word");
    assert.ok(raw.some((r) => /^1 other person .*\bfms\b/.test(r)));
    // A dangerous report is a stressful moment: no emoji in any wording of what follows.
    const after = raw.slice(raw.indexOf(DANGER_LINE));
    for (const r of after) assert.ok(!/\p{Extended_Pictographic}/u.test(r), r);
    assert.equal(t.mine().length, 2);
  } finally {
    setVariantPicker(null);
  }
});

// ---------- judge asides and the simulated technician ----------

type Setup = ReturnType<typeof setup>;
const repairAsides = () => demo.asides.map((a) => a.note);
/** The fixture's people took the judge skip. This makes one a real student (a usc email). */
const realStudent = (t: Setup, handle: string) => {
  const s = t.student(handle);
  updateUser(t.db, s.id, { verifiedVia: "usc_email" });
  return s;
};

test("asides: a filed repair says where it was routed and why, with the directory's own office name", async () => {
  demo.reset();
  const t = setup();
  const a = t.student("+13105550301");
  await a.text("the light is broken in taper hall 2nd floor");
  assert.deepEqual(repairAsides(), [
    { step: "repair_filed", behind: { did: "worked out what's broken from ur words and routed it to {office} because {because}", numbers: { office: FMS, because: "it's a campus building" } }, decision: "steps_back" },
  ]);

  demo.reset();
  await a.text("the washer is broken in pardee tower");
  assert.deepEqual(repairAsides()[0]!.behind?.numbers, { office: HOUSING, because: "it's in usc housing" });

  // A second student on the same thing: the aside carries how many were already on it.
  demo.reset();
  const b = t.student("+13105550302");
  await b.text("light is out on the 2nd floor of taper hall");
  assert.deepEqual(repairAsides().map((n) => [n.step, n.behind?.numbers]), [["repair_joined", { alreadyOnIt: 1, office: FMS }]]);
});

test("asides: a photo the model read is the 'photo replaces the form' one, an unread photo is the 'works when the ai is down' one", async () => {
  demo.reset();
  const t = setup();
  const a = t.student("+13105550303");
  model = () => '{"category": "Broken Light", "description": "ceiling light is hanging loose", "location": "taper hall 2nd floor hallway"}';
  try {
    await a.text("this is broken", [{ path: "/tmp/troy-test/light.jpg", mime: "image/jpeg" }]);
  } finally {
    model = null;
  }
  assert.equal(repairAsides()[0]!.decision, "photo");
  assert.match(repairAsides()[0]!.behind!.did, /^read ur photo/);

  demo.reset();
  await a.text("the door is broken at leavey library 3rd floor", [{ path: "/tmp/troy-test/door.jpg", mime: "image/jpeg" }]);
  assert.equal(repairAsides()[0]!.decision, "ai_down");
  assert.match(repairAsides()[0]!.behind!.did, /^couldn't get the photo read by the ai/);
});

test("something dangerous: the dps line, no aside and no simulation, even for a judge", async () => {
  demo.reset();
  demo.accept = true;
  const t = setup();
  const a = t.student("+13105550304");
  const reply = await a.text("the outlet is broken and there are exposed wires in olin hall");
  assert.equal(reply[0], DANGER_LINE);
  assert.equal(demo.asides.length, 0);
  assert.equal(demo.offers.length, 0);
  assert.equal(a.state(), null);
});

test("simulation: with no technician assigned, a judge is offered the technician's side and the flow stops there", async () => {
  demo.reset();
  demo.accept = true;
  const t = setup();
  const judge = t.student("+13105550305");
  const reply = await judge.text("the light is broken in taper hall 2nd floor");
  assert.equal(reply[0], CONFIRM_FMS);
  assert.equal(reply.at(-1), DEMO_NOTE, "the confirmation and the honest demo note still go out first");
  assert.deepEqual(demo.offers.map((o) => [o.kind, o.context.where, o.context.office]), [["repair", "Taper Hall, 2nd floor", FMS]]);
  assert.equal(judge.state()?.step, "sim_offer");
  assert.equal(demo.asides.length, 0, "no aside stacked on the offer");
  assert.equal(t.mine().length, 1, "the report itself is real");

  // The tap on "show me" is a poll vote. The simulation gets it first; the flow itself ignores poll votes.
  demo.consume = true;
  assert.deepEqual(await judge.send({ pollVote: { pollMessageId: "poll-1", optionIndex: 0 } }), [SIM_LINE]);
  assert.equal(demo.runs, 1);
});

test("simulation: a student is offered it only when nobody else real is on troy, and otherwise just waits for the status text", async () => {
  demo.reset();
  demo.accept = true;
  const t = setup();
  const alone = realStudent(t, "+13105550306");
  await alone.text("the light is broken in taper hall 2nd floor");
  assert.deepEqual(demo.offers.map((o) => o.kind), ["repair"], "the seeded example people and judges don't count as other students");

  demo.reset();
  demo.accept = true;
  const t2 = setup();
  realStudent(t2, "+13105550307");
  const pilot = realStudent(t2, "+13105550308");
  const reply = await pilot.text("the light is broken in taper hall 2nd floor");
  assert.equal(demo.offers.length, 0, "a student in a live pilot is never shown a simulation in place of real waiting");
  assert.equal(reply[0], CONFIRM_FMS);
  assert.equal(pilot.state(), null);
  assert.equal(demo.asides.length, 1, "the aside hook is still called; it is the judge module that says nothing to a student");
});


// ---------- a chat never files anything on its own (John's live conversation, Nov 14) ----------
//
// The conversation that went wrong: a student vented about loud dormmates and an RA who wouldn't act, Troy asked
// five questions in a row, then "which building and floor?", then said "reported to fms ✅". These run the same
// messages through the real pipeline, with the model scripted to make the same moves it made that night.

const firstVariant: VariantPicker = (_db, _userId, _key, variants) => variants[0]!;
const HOUSING_SENT = "passed it to usc housing. i'll text u when they pick it up.";
/** With no model the offer is one of the hand-written lines (rotated per person): who it would go to, name or anonymous, and a question. */
const isHousingOffer = (reply: string[]): boolean => reply.length === 1 && /usc housing/.test(reply[0]!) && /\bname\b.*\banonym/.test(reply[0]!) && reply[0]!.includes("?") && !/which building|floor/.test(reply[0]!);
const isRepairOffer = (reply: string[], office: string | null): boolean => reply.length === 1 && /\breport\b/.test(reply[0]!) && /\?$/.test(reply[0]!) && (office ? reply[0]!.includes(` ${office} `) : !/\bfms\b|\bhousing\b/.test(reply[0]!));
const WHERE = "which building and floor?";
const LEFT_IT = "all good, i'll leave it";

const newMessage = (prompt: string): string => {
  const m = prompt.match(/their new message: ("(?:[^"\\]|\\.)*")/);
  return m ? (JSON.parse(m[1]!) as string) : "";
};
const isChat = (system: string) => system.includes("You are writing troy's next text in a free chat");
const isOwnLine = (prompt: string) => prompt.includes("troy is about to send a message on his own");
const chat = (bubbles: string[], handoff: unknown = null) => JSON.stringify({ bubbles, handoff });

/** What Troy actually said that night, turn by turn, and what he says when code sends a question back. */
const THAT_NIGHT: Record<string, [original: string, instead: string]> = {
  "Probably class": ["what about it?", "class is a lot rn"],
  "Getting up": ["hm, say a little more?", "oof, mornings are undefeated"],
  "Like it's hard to get up cus I hardly get sleep": ["is it homework keeping u up or just ur brain not shutting off", "no sleep makes everything harder, that's rough"],
  "Dorm mates are annoying": ["what are they doing, loud at night?", "ugh, a loud floor when ur already wiped is the worst"],
  "Yeah and my ra doesn't enforce it": ["did u ever tell ur ra straight up or is it more of a vibe thing", "that's the ra's whole job tho"],
};
const HANDED_OFF_AT = "I told them but they didn't do anything";

/** The model as it behaved that night: the same questions, and at the end the same handoff to the repair flow. */
function thatNight(log: { rejected: string[]; offerPrompts: string[] }): (prompt: string, system: string) => string {
  return (prompt, system) => {
    if (isOwnLine(prompt)) {
      log.offerPrompts.push(prompt);
      return JSON.stringify({ bubbles: ["an ra who shrugs it off is so frustrating", "want me to pass this to usc housing? i can send it with ur name or anonymously"], covers: ["pass this to usc housing", "with ur name or anonymously"] });
    }
    if (!isChat(system)) throw new Error("no json");
    const text = newMessage(prompt);
    if (text === HANDED_OFF_AT) return chat([], { flow: "repair", action: "report", reason: "a housing problem" });
    const lines = THAT_NIGHT[text];
    if (!lines) return chat(["lol fair"]);
    const again = prompt.includes("your last reply was not sent");
    if (again) log.rejected.push(lines[0]);
    return chat([again ? lines[1] : lines[0]]);
  };
}

async function dormNoise(t: Setup, handle: string) {
  const a = realStudent(t, handle);
  // The one question went out on its own a moment earlier.
  saveMessage(t.db, { userId: a.id, chatId: `chat-${handle}`, direction: "out", providerMessageId: "seed-q", text: "what's one thing u wish was easier at usc?" });
  const turns: string[][] = [];
  for (const text of [...Object.keys(THAT_NIGHT), HANDED_OFF_AT]) turns.push(await a.text(text));
  return { a, turns };
}

const allReports = (t: Setup) => t.db.prepare("SELECT * FROM reports WHERE isExample = 0 ORDER BY id").all() as unknown as (Report & { anonymous: number })[];

test("the dorm-noise conversation: no third question in a row, and it ends on an offer to pass it to housing with nothing filed", async () => {
  demo.reset();
  setVariantPicker(firstVariant);
  const log = { rejected: [] as string[], offerPrompts: [] as string[] };
  model = thatNight(log);
  try {
    const t = setup();
    const { a, turns } = await dormNoise(t, "+13105550401");
    // Two questions in a row is the most he gets. The third each time was sent back and replaced by something that isn't one.
    assert.deepEqual(log.rejected, ["hm, say a little more?", "did u ever tell ur ra straight up or is it more of a vibe thing"]);
    assert.deepEqual(turns.slice(0, 5), [
      ["what about it?"],
      ["oof, mornings are undefeated"],
      ["is it homework keeping u up or just ur brain not shutting off"],
      ["what are they doing, loud at night?"],
      ["that's the ra's whole job tho"],
    ]);
    // His third turn on the dorm thread: what he could do, for whom, and a question. Never "which building and floor?".
    const last = turns[5]!;
    assert.deepEqual(last, ["an ra who shrugs it off is so frustrating", "want me to pass this to usc housing? i can send it with ur name or anonymously"]);
    assert.ok(!t.sent.some((b) => b.text === WHERE || /reported to/.test(b.text)), "no building question and no report");
    assert.equal(allReports(t).length, 0, "nothing is filed on a chat's say-so");
    // The office name was code's to give: it reached the model as an exact value, from the directory row.
    assert.match(log.offerPrompts[0]!, /usc housing/);
    // The offer is an open step that remembers what they said, so a yes never asks for it again.
    const state = a.state()!;
    assert.equal(state.flow, "usg");
    assert.equal(state.step, "offer");
    assert.equal(state.data.routedTo, HOUSING);
    assert.match(String(state.data.description), /Dorm mates are annoying/);
    assert.match(String(state.data.description), /my ra doesn't enforce it/);
  } finally {
    model = null;
    setVariantPicker(null);
  }
});

test("a yes to the offer files it as a concern for usc housing, in their own earlier words, after the name question. never with fms", async () => {
  demo.reset();
  setVariantPicker(firstVariant);
  model = thatNight({ rejected: [], offerPrompts: [] });
  try {
    const t = setup();
    const { a } = await dormNoise(t, "+13105550402");
    assert.deepEqual(await a.text("yes"), ["want me to send it with ur name or anonymously?"]);
    assert.equal(allReports(t).length, 0, "still nothing filed: the name question comes first");
    assert.deepEqual(await a.text("with my name"), [HOUSING_SENT, DEMO_NOTE]);
    const rows = allReports(t);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "usg_concern");
    assert.equal(rows[0]!.routedTo, HOUSING, "the directory's housing row, exactly as stored");
    assert.equal(rows[0]!.anonymous, 0);
    assert.equal(rows[0]!.category, "housing");
    assert.equal(rows[0]!.description, "Like it's hard to get up cus I hardly get sleep. Dorm mates are annoying. Yeah and my ra doesn't enforce it. I told them but they didn't do anything");
    assert.equal(rows[0]!.locationText, null);
    assert.equal(t.reports().length - t.reports().filter((r) => r.isExample).length, 0, "no repair report, so nothing for fms");
    assert.equal(a.state(), null);

    // A thumbs up on the offer bubble is the same yes, and "anonymously" answers the name question.
    const t2 = setup();
    const { a: b } = await dormNoise(t2, "+13105550403");
    assert.deepEqual(await b.send({ reaction: { targetMessageId: lastBubbleId(t2), type: "like", removed: false } }), ["want me to send it with ur name or anonymously?"]);
    assert.deepEqual(await b.text("anonymously"), [HOUSING_SENT, "sent anonymously, ur name isn't on it", DEMO_NOTE]);
    assert.equal(allReports(t2)[0]!.anonymous, 1);
    assert.equal(allReports(t2)[0]!.routedTo, HOUSING);

    // A thumbs up on any other bubble is only an acknowledgement.
    const t3 = setup();
    const { a: c } = await dormNoise(t3, "+13105550404");
    assert.deepEqual(await c.send({ reaction: { targetMessageId: `out-${t3.sent.length - 1}`, type: "like", removed: false } }), []);
    assert.equal(c.state()?.step, "offer");
    // "anonymously" straight away is a yes that already answers the name question.
    assert.deepEqual(await c.text("anonymously pls"), [HOUSING_SENT, "sent anonymously, ur name isn't on it", DEMO_NOTE]);
  } finally {
    model = null;
    setVariantPicker(null);
  }
});

test("a no, a change of subject or silence drops the offer, and nothing is filed", async () => {
  demo.reset();
  setVariantPicker(firstVariant);
  model = thatNight({ rejected: [], offerPrompts: [] });
  try {
    // no
    const t = setup();
    const { a } = await dormNoise(t, "+13105550405");
    assert.deepEqual(await a.text("nah it's fine"), [LEFT_IT]);
    assert.equal(a.state(), null);
    assert.equal(allReports(t).length, 0);
    // A yes after that is a yes to nothing.
    await a.text("yes");
    assert.equal(allReports(t).length, 0);
    assert.equal(a.state(), null);

    // a thumbs down on the offer
    const t1 = setup();
    const { a: d } = await dormNoise(t1, "+13105550406");
    assert.deepEqual(await d.send({ reaction: { targetMessageId: lastBubbleId(t1), type: "dislike", removed: false } }), [LEFT_IT]);
    assert.equal(d.state(), null);

    // a change of subject: the chat brain answers, the offer is gone, and a later yes files nothing
    const t2 = setup();
    const { a: b } = await dormNoise(t2, "+13105550407");
    assert.deepEqual(await b.text("lol anyway did u watch the game"), ["lol fair"]);
    assert.equal(b.state(), null);
    await b.text("yes");
    assert.equal(allReports(t2).length, 0);

    // silence: the offer lapses, and a yes much later is not a yes to it
    const t3 = setup();
    const { a: c } = await dormNoise(t3, "+13105550408");
    t3.db.prepare("UPDATE flow_state SET updatedAt = ? WHERE userId = ?").run(Date.now() - 11 * 60 * 1000, c.id);
    const late = await c.text("yes");
    assert.equal(allReports(t3).length, 0);
    assert.equal(c.state(), null);
    assert.ok(!late.some((b) => /name or anonymously/.test(b)), "no name question on a lapsed offer");
  } finally {
    model = null;
    setVariantPicker(null);
  }
});

test("a broken door lock still goes straight to repair, with or without a photo, to fms or housing by the kind of building", async () => {
  demo.reset();
  const t = setup();
  const a = t.student("+13105550411");
  assert.deepEqual(await a.text("my door lock is broken"), [WHERE]);
  assert.equal((await a.text("pardee tower 3rd floor"))[0], CONFIRM_HOUSING);
  assert.equal(t.mine()[0]!.routedTo, HOUSING);
  assert.equal(t.mine()[0]!.locationText, "Pardee Tower, 3rd floor");

  const b = t.student("+13105550412");
  assert.equal((await b.text("my door lock is broken in taper hall", [{ path: "/tmp/lock.jpg", mime: "image/jpeg" }]))[0], CONFIRM_FMS);
  assert.equal(t.mine()[1]!.routedTo, FMS);
  assert.equal(t.mine()[1]!.photoUrl, "/tmp/lock.jpg");

  // A photo with a building is enough even when only the chat model read it as a repair: no offer step.
  const c = t.student("+13105550413");
  assert.deepEqual(await c.text("my door lock is broken", [{ path: "/tmp/lock2.jpg", mime: "image/jpeg" }]), [WHERE]);
  assert.equal(c.state()?.step, "ask_place");
});

test("annenberg is not a dorm: a report there goes to fms, and a housing concern never records it as someone's hall", async () => {
  demo.reset();
  setVariantPicker(firstVariant);
  try {
    const t = setup((text) => (/roommates/.test(text) ? { flow: "usg", action: "concern", details: {}, source: "ai" } : null));
    const a = t.student("+13105550421");
    assert.equal((await a.text("the light in my dorm hallway is broken, annenberg 3rd floor"))[0], CONFIRM_FMS);
    assert.equal(t.mine()[0]!.routedTo, FMS);
    assert.equal(t.mine()[0]!.locationText, "Wallis Annenberg Hall, 3rd floor, hallway");

    // The answer from that night, typed at the building question.
    const b = t.student("+13105550422");
    await b.text("the heater is broken");
    assert.equal((await b.text("Annenberg floor 3"))[0], CONFIRM_FMS);

    const c = t.student("+13105550423");
    assert.ok(isHousingOffer(await c.text("my roommates blast music at night, annenberg floor 3")));
    await c.text("with my name");
    const d = t.student("+13105550424");
    await d.text("my roommates blast music at night in pardee tower");
    await d.text("with my name");
    const concerns = allReports(t).filter((r) => r.kind === "usg_concern");
    assert.deepEqual(concerns.map((r) => [r.routedTo, r.locationText]), [[HOUSING, null], [HOUSING, "Pardee Tower"]]);
  } finally {
    setVariantPicker(null);
  }
});

test("\"my ra won't do anything about the noise\" never reaches fms, however it was routed", async () => {
  demo.reset();
  setVariantPicker(firstVariant);
  const RA = "my ra won't do anything about the noise";
  try {
    // The keyword rules don't read it as a repair at all.
    assert.equal(fallbackIntent({ text: RA, hasImage: false, state: null }).flow, "smalltalk");
    assert.equal(fallbackIntent({ text: "my ra doesn't work", hasImage: false, state: null }).flow, "smalltalk");

    // The router model says repair anyway: the flow's own guard re-checks and passes it to the concern flow, which offers.
    const t = setup((text) => (text === RA ? { flow: "repair", action: "report", details: {}, source: "ai" } : null));
    const a = t.student("+13105550431");
    assert.ok(isHousingOffer(await a.text(RA)));
    assert.equal(a.state()?.flow, "usg");
    assert.equal(allReports(t).length, 0);
    assert.deepEqual(await a.text("ok"), ["want me to send it with ur name or anonymously?"]);
    assert.deepEqual(await a.text("anonymous"), [HOUSING_SENT, "sent anonymously, ur name isn't on it", DEMO_NOTE]);
    const rows = allReports(t);
    assert.deepEqual(rows.map((r) => [r.kind, r.routedTo, r.description]), [["usg_concern", HOUSING, RA]]);
    assert.ok(!t.sent.some((s) => /\bfms\b|reported to/.test(s.text)));

    // The chat model hands it to repair: same guard, same offer, nothing filed.
    model = (prompt, system) => {
      if (!isChat(system)) throw new Error("no json");
      return chat([], { flow: "repair", action: "report" });
    };
    const t2 = setup();
    const b = t2.student("+13105550432");
    assert.ok(isHousingOffer(await b.text(RA)));
    assert.equal(b.state()?.flow, "usg");
    assert.equal(allReports(t2).length, 0);
    model = null;

    // A policy-level complaint goes to the usg committee for it, not to an office and not to fms.
    const POLICY = "the guest policy in my dorm is broken, they should change it";
    const t3 = setup((text) => (text === POLICY ? { flow: "repair", action: "report", details: {}, source: "ai" } : null));
    const c = t3.student("+13105550433");
    // Only the router model read it, and they never asked for it to go anywhere: an offer that names the committee.
    const offered = await c.text(POLICY);
    assert.equal(offered.length, 1);
    assert.match(offered[0]!, /USG Committee on Affordability and Basic Needs/);
    assert.match(offered[0]!, /\?/);
    assert.equal(c.state()?.step, "offer");
    assert.equal(allReports(t3).length, 0);
    await c.text("anonymously");
    assert.deepEqual(allReports(t3).map((r) => [r.kind, r.routedTo]), [["usg_concern", "USG Committee on Affordability and Basic Needs"]]);
  } finally {
    model = null;
    setVariantPicker(null);
  }
});

test("only the chat model read it as a repair: he offers, a yes asks where, then names the office before anything is filed", async () => {
  demo.reset();
  setVariantPicker(firstVariant);
  model = (prompt, system) => {
    if (!isChat(system)) throw new Error("no json");
    return /the vending thing ate my dollar|evk is falling apart/.test(newMessage(prompt)) ? chat([], { flow: "repair", action: "report" }) : chat(["lol fair"]);
  };
  try {
    const t = setup();
    const a = t.student("+13105550441");
    // No place named: the offer names no office, asks nothing else, and files nothing.
    assert.ok(isRepairOffer(await a.text("the vending thing ate my dollar again"), null));
    assert.equal(a.state()?.step, "offer");
    assert.equal(t.mine().length, 0);
    assert.deepEqual(await a.text("yes pls"), [WHERE]);
    assert.deepEqual(await a.text("taper hall 1st floor"), ["sending this to fms as a repair report. ok?"]);
    assert.equal(t.mine().length, 0, "the confirmation names where it is going before it is filed");
    assert.equal((await a.send({ reaction: { targetMessageId: lastBubbleId(t), type: "like", removed: false } }))[0], CONFIRM_FMS);
    assert.equal(t.mine().length, 1);
    assert.equal(t.mine()[0]!.description, "the vending thing ate my dollar again");
    assert.equal(t.mine()[0]!.locationText, "Taper Hall, 1st floor");

    // A no at the confirmation files nothing.
    const b = t.student("+13105550442");
    await b.text("the vending thing ate my dollar again");
    await b.text("yes");
    await b.text("taper hall 1st floor");
    assert.deepEqual(await b.text("no"), [LEFT_IT]);
    assert.equal(t.mine().length, 1);
    assert.equal(b.state(), null);

    // The place was in what they said: the offer names the office, so a yes files it.
    const c = t.student("+13105550443");
    assert.ok(isRepairOffer(await c.text("evk is falling apart lol"), "fms"));
    assert.equal(t.mine().length, 1);
    assert.equal((await c.text("yeah"))[0], CONFIRM_FMS);
    assert.equal(t.mine().length, 2);
  } finally {
    model = null;
    setVariantPicker(null);
  }
});

test("the demo note is one short line and each person sees it once, whatever they file", async () => {
  demo.reset();
  setVariantPicker(firstVariant);
  try {
    const t = setup((text) => (/vegetarian/.test(text) ? { flow: "usg", action: "concern", details: {}, source: "ai" } : null));
    const a = t.student("+13105550451");
    assert.deepEqual(await a.text("the light is broken in taper hall 2nd floor"), [CONFIRM_FMS, DEMO_NOTE]);
    assert.deepEqual(await a.text("the elevator is out of order in olin hall"), [CONFIRM_FMS]);
    await a.text("usc should have more vegetarian options at evk");
    const concern = await a.text("anonymously");
    assert.ok(!concern.includes(DEMO_NOTE), "not again after a concern either");
    // Someone joining a report sees it once too.
    const b = t.student("+13105550452");
    assert.equal((await b.text("broken light at taper hall 2nd floor")).at(-1), DEMO_NOTE);
    assert.ok(!(await b.text("the sink is leaking in doheny")).includes(DEMO_NOTE));
    assert.equal(t.sent.filter((s) => s.text === DEMO_NOTE).length, 2, "once per person");
    assert.ok(!t.sent.some((s) => /demo note:|mocked/.test(s.text)), "the old paragraph is gone");
  } finally {
    setVariantPicker(null);
  }
});
