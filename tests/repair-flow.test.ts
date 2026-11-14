import { test } from "node:test";
import assert from "node:assert/strict";
import type { FlowHandler, IncomingEvent, IncomingImage, MessagingAdapter } from "../src/types.ts";
import { openDb, getOrCreateUser, getFlowState, updateUser } from "../src/db/index.ts";
import { seed } from "../src/db/seed.ts";
import { createPipeline } from "../src/pipeline.ts";
import { registerFlow } from "../src/flows/index.ts";
import { fallbackIntent, setModelCall } from "../src/ai.ts";
import { DPS } from "../src/commands.ts";
import { repair, DANGER_LINE, thingOf } from "../src/flows/repair.ts";

const FMS = "Facilities Management Services (FMS)";
const HOUSING = "USC Housing maintenance";
const CONFIRM_FMS = "reported to fms ✅ i'll text u when it moves.";
const CONFIRM_HOUSING = "reported to housing ✅ i'll text u when it moves.";

type Report = { id: number; userId: number; kind: string; category: string; description: string; photoUrl: string | null; locationText: string | null; routedTo: string; status: string; followers: string; isExample: number };

// No model by default: every reply path has to work without one.
let model: ((prompt: string) => string) | null = null;
setModelCall(async (opts) => {
  if (!model) throw new Error("no json");
  return model(opts.prompt);
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

function setup() {
  const db = openDb(":memory:");
  seed(db);
  const sent: { chatId: string; text: string }[] = [];
  let n = 0;
  const adapter: MessagingAdapter = {
    provider: "webchat",
    capabilities: () => ({ tapbacks: true, typing: true, readReceipts: true, edits: false, effects: true, polls: false, groupChats: false, contactCard: true, liveLocation: false }),
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
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
    chatIdForHandle: (h) => `chat-${h}`,
  };
  const pipeline = createPipeline({ db, getAdapter: () => adapter, pause: async () => {}, ackAfterMs: 60_000, detectIntent: async (i) => fallbackIntent(i) });
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

test("a broken thing with the place in the text is routed to FMS", async () => {
  const t = setup();
  const a = t.student("+13105550001");
  const reply = await a.text("the light is broken in taper hall 2nd floor");
  assert.equal(reply[0], CONFIRM_FMS);
  // The reply path says the FMS link is mocked.
  assert.match(reply.join("\n"), /mocked/);
  assert.match(reply.join("\n"), /staff dashboard/);
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
  assert.match(reply.join("\n"), /mocked/);
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
