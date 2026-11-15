import { test } from "node:test";
import assert from "node:assert/strict";
import { DECISION, aside, ctxAs, otherRealUsers, setDemoHooks, simulateIfAlone, simulationTurn } from "../src/staff.ts";
import type { FlowContext, FlowState, User } from "../src/types.ts";
import type { AsideNote, SimKind } from "../src/staff.ts";
import type { IncomingEvent, Intent, MessagingAdapter, TapbackType } from "../src/types.ts";
import { openDb, getOrCreateUser, getFlowState, getUserById, updateUser } from "../src/db/index.ts";
import { seed } from "../src/db/seed.ts";
import { createPipeline } from "../src/pipeline.ts";
import { fallbackIntent, setModelCall } from "../src/ai.ts";
import { createNotifier } from "../src/outbox.ts";
import { saveUserLocation } from "../src/location.ts";
import { insertReport } from "../src/flows/reports-shared.ts";
import "../src/flows/index.ts";
import {
  CONTACT_WARNING,
  STAFF_STEP,
  TALK_STEP,
  assignStaff,
  listStaff,
  notifyStaffOfReport,
  parseRole,
  readStaffWord,
  removeStaff,
  reportCounts,
  setStaffBrain,
  setStaffNotifier,
  staffLogFor,
  staffRoles,
} from "../src/staff.ts";

type Row = Record<string, any>;

const FMS = "Facilities Management Services (FMS)";
const DINING = "USG Committee on Sustainability and Campus Infrastructure";
const CONCERN = "why does village dining close so early";

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
const DEMO_HOOKS: Parameters<typeof setDemoHooks>[0] = {
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
};
setDemoHooks(DEMO_HOOKS);

// No model, and no chat brain: every path here has to work on code alone.
setModelCall(async () => {
  throw new Error("no model in tests");
});
setStaffBrain(null);

const asUsg: Intent = { flow: "usg", action: "concern", details: {}, source: "ai" };

function setup(opts: { groupChats?: boolean; outbox?: boolean; clock?: () => Date } = {}) {
  const db = openDb(":memory:");
  seed(db);
  const sent: { chatId: string; text: string; id: string }[] = [];
  const groups: { members: string[]; first: string }[] = [];
  let n = 0;
  const adapter: MessagingAdapter = {
    provider: "webchat",
    capabilities: () => ({ tapbacks: true, typing: true, readReceipts: true, edits: false, effects: true, polls: false, groupChats: !!opts.groupChats, contactCard: true, liveLocation: false }),
    async sendMessage(chatId, text) {
      const id = `out-${++n}`;
      sent.push({ chatId, text, id });
      return { messageId: id };
    },
    sendImage: async () => null,
    sendContactCard: async () => null,
    async markRead() {},
    async startTyping() {},
    async stopTyping() {},
    react: async () => true,
    editMessage: async () => false,
    sendPoll: async (_c, _q, options) => ({ optionMessageIds: options.map(() => null), mode: "tap" }),
    async createGroupChat(members, first) {
      if (!opts.groupChats) return null;
      groups.push({ members: [...members], first });
      return `group;+;${groups.length}`;
    },
    getLiveLocation: async () => null,
    requestLocation: async () => false,
    chatIdForHandle: (h) => `chat-${h}`,
  };
  const pipeline = createPipeline({
    db,
    getAdapter: () => adapter,
    pause: async () => {},
    ackAfterMs: 60_000,
    detectIntent: async (i) => (i.text === CONCERN ? asUsg : fallbackIntent(i)),
  });
  const notifier = opts.outbox ? createNotifier({ db, getAdapter: () => adapter, enabled: () => true, now: opts.clock }) : null;
  if (notifier) setStaffNotifier(db, notifier.notify);
  let m = 0;
  /** A verified person. `text` and `tap` go through the real pipeline and return what Troy sent to them. */
  const person = (handle: string, name = "Tess Trojan") => {
    const chatId = `chat-${handle}`;
    const u = getOrCreateUser(db, handle, chatId);
    updateUser(db, u.id, { verifiedAt: Date.now(), verifiedVia: "judge_skip", name });
    const send = async (over: Partial<IncomingEvent>) => {
      const before = sent.length;
      await pipeline.handleEvent({ provider: "webchat", userHandle: handle, chatId, isGroup: false, messageId: `in-${++m}`, text: "", images: [], receivedAt: Date.now(), ...over });
      return sent.slice(before).filter((s) => s.chatId === chatId).map((s) => s.text);
    };
    return {
      id: u.id,
      handle,
      chatId,
      text: (t: string) => send({ text: t }),
      tap: (targetMessageId: string, type: TapbackType = "like") => send({ reaction: { targetMessageId, type, removed: false } }),
      state: () => getFlowState(db, u.id),
      got: () => sent.filter((s) => s.chatId === chatId).map((s) => s.text),
      last: () => sent.filter((s) => s.chatId === chatId).at(-1)!,
    };
  };
  const report = (id: number) => db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as Row;
  const newest = (kind: string) => db.prepare("SELECT * FROM reports WHERE kind = ? AND isExample = 0 ORDER BY id DESC LIMIT 1").get(kind) as Row;
  return { db, adapter, pipeline, notifier, sent, groups, person, report, newest };
}

// ---------- assignment ----------

test("assigning a phone: the handle is normalized, the role is checked, and the chat is allowed in the same step", () => {
  const t = setup();
  const a = assignStaff(t.db, { role: "FMS", handle: "(310) 555-0142", label: "  Sam " });
  assert.ok(a.ok);
  assert.equal(a.contact.handle, "+13105550142");
  assert.equal(a.contact.role, "fms");
  assert.equal(a.contact.label, "sam");
  assert.equal(a.contact.isExample, true);
  assert.equal(a.addedToAllowList, true);
  assert.equal((t.db.prepare("SELECT reason FROM allow_list WHERE handle = '+13105550142'").get() as Row).reason, "manual");

  // The same phone again, typed another way: still one row on each list.
  const again = assignStaff(t.db, { role: "fms", handle: "+1 310 555 0142" });
  assert.ok(again.ok);
  assert.equal(again.addedToAllowList, false);
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM allow_list WHERE handle = '+13105550142'").get() as Row).n, 1);
  assert.equal(listStaff(t.db).length, 1);

  // A committee has to be one the directory lists, and comes back spelled as stored.
  assert.equal(parseRole(t.db, `usg: ${DINING.toLowerCase()}`), `usg:${DINING}`);
  assert.equal(parseRole(t.db, "usg:committee on vibes"), null);
  assert.deepEqual(assignStaff(t.db, { role: "usg:committee on vibes", handle: "3105550142" }), { ok: false, error: "bad_role" });
  assert.deepEqual(assignStaff(t.db, { role: "dps", handle: "3105550142" }), { ok: false, error: "bad_role" });
  assert.deepEqual(assignStaff(t.db, { role: "housing", handle: "call me" }), { ok: false, error: "bad_handle" });
  assert.equal(listStaff(t.db).length, 1);

  // One phone per role: a new one replaces the old. A label that looks like a number is dropped.
  const other = assignStaff(t.db, { role: "fms", handle: "310-555-0143", label: "555-0143" });
  assert.ok(other.ok);
  assert.equal(other.contact.label, null);
  assert.deepEqual(listStaff(t.db).map((s) => s.handle), ["+13105550143"]);
  assert.ok(staffRoles(t.db).some((r) => r.role === `usg:${DINING}`));
  assert.equal(staffRoles(t.db)[0]!.role, "fms");

  assert.equal(removeStaff(t.db, other.contact.id), true);
  assert.equal(listStaff(t.db).length, 0);
});

test("a staff answer is read from plain words, and a question is never one", () => {
  assert.equal(readStaffWord("on it"), "accept");
  assert.equal(readStaffWord("On it 👍"), "accept");
  assert.equal(readStaffWord("omw"), "accept");
  assert.equal(readStaffWord("done"), "done");
  assert.equal(readStaffWord("all fixed!"), "done");
  assert.equal(readStaffWord("we fixed it"), "done");
  assert.equal(readStaffWord("can't"), "cant");
  assert.equal(readStaffWord("cant today sorry"), "cant");
  assert.equal(readStaffWord("on the agenda"), "agenda");
  assert.equal(readStaffWord("yes"), "yes");
  assert.equal(readStaffWord("nah"), "no");
  assert.equal(readStaffWord("ok but where is it?"), null);
  assert.equal(readStaffWord("done?"), null);
  assert.equal(readStaffWord("lol"), null);
});

// ---------- repair ----------

test("a repair report texts the assigned technician with the walking time, and on it / done move the status and text the student", async () => {
  const t = setup();
  const tech = t.person("+13105550201", "Tina Tech");
  const a = assignStaff(t.db, { role: "fms", handle: tech.handle, label: "tina" });
  assert.ok(a.ok);
  // The technician's own saved spot (leavey library) gives the walking time. It never appears in the text itself.
  saveUserLocation(t.db, tech.id, { lat: 34.0217, lng: -118.2828 }, "pin");

  const student = t.person("+13105550202");
  const reply = await student.text("the light is broken in taper hall 2nd floor");
  assert.match(reply[0]!, /reported to fms/);
  // Said plainly right after: the technician is a stand-in.
  assert.match(reply.at(-1)!, /stand-in technician|stand-in for the hackathon|example technician/);

  const ask = tech.got();
  assert.equal(ask.length, 2);
  assert.match(ask[0]!, /someone reported a broken light at taper hall, 2nd floor, about a \d+ minute walk from u\. can u take (?:it|this one)\?$/);
  assert.match(ask[1]!, /"on it"/);
  assert.match(ask[1]!, /"can't"/);
  assert.ok(!ask.join(" ").includes("Tess"), "never the student's name");
  assert.equal(tech.state()?.step, STAFF_STEP);

  const r = t.newest("repair");
  assert.equal(r.routedTo, FMS);
  assert.equal(r.status, "received");

  const before = student.got().length;
  const ack = await tech.text("on it");
  assert.equal(ack.length, 1);
  assert.match(ack[0]!, /"done"/);
  assert.equal(t.report(r.id).status, "in_progress");
  const update = student.got().slice(before);
  assert.equal(update.length, 1);
  assert.match(update[0]!, /^update on "the light is broken in taper hall 2nd floor" at taper hall, 2nd floor: .*facilities.*🔧$/);
  // Still theirs: the step stays so "done" finds its way back.
  assert.equal(tech.state()?.step, STAFF_STEP);

  const fixed = await tech.text("done");
  assert.equal(fixed.length, 1);
  assert.equal(t.report(r.id).status, "fixed");
  assert.match(student.got().at(-1)!, /^update on .*: .*fixed ✅$/);
  // Nothing left to answer.
  assert.equal(tech.state(), null);

  const log = staffLogFor(t.db, r.id);
  assert.deepEqual(log.map((l) => l.kind), ["ask", "action", "action"]);
  assert.ok(log.every((l) => !l.example));
  // The dashboard's copy leaves the walking time out: it is the technician's location in another form.
  assert.equal(log[0]!.text, ask.join("\n").replace(/, about a \d+ minute walk from u/, ""));
  assert.ok(!staffLogFor(t.db, r.id).some((l) => /walk from u/.test(l.text)));
});

test("no saved location: the walking clause is left out. a thumbs up on the job bubble takes it, and can't hands it back", async () => {
  const t = setup();
  const tech = t.person("+13105550211");
  assignStaff(t.db, { role: "housing", handle: tech.handle });
  const student = t.person("+13105550212");
  await student.text("the shower is broken in birnkrant 4th floor");
  const r = t.newest("repair");
  assert.match(r.routedTo, /Housing/);
  assert.match(tech.got()[0]!, /someone reported a broken shower at birnkrant[^.]*\. can u take (?:it|this one)\?$/);
  assert.ok(!tech.got()[0]!.includes("walk from u"));

  // A tapback on some other bubble is only an acknowledgment.
  await tech.tap("out-does-not-exist");
  assert.equal(t.report(r.id).status, "received");

  const askId = t.sent.find((s) => s.chatId === tech.chatId)!.id;
  const ack = await tech.tap(askId, "like");
  assert.equal(ack.length, 1);
  assert.equal(t.report(r.id).status, "in_progress");
  assert.match(student.got().at(-1)!, /housing.*🔧$/);

  const back = await tech.text("can't today, sorry");
  assert.equal(back.length, 1);
  assert.match(back[0]!, /back/);
  assert.equal(t.report(r.id).status, "received");
  assert.equal(tech.state(), null);
  assert.match(staffLogFor(t.db, r.id).at(-1)!.text, /handed it back/);
});

test("a technician who texts something else keeps their job: the other request is handled and the answer still lands", async () => {
  const t = setup();
  const tech = t.person("+13105550221");
  assignStaff(t.db, { role: "fms", handle: tech.handle });
  const student = t.person("+13105550222");
  await student.text("the elevator is broken in leavey library");
  const r = t.newest("repair");

  // Their own repair report in the middle of it: filed as a new report (and, being the technician, they are asked about it too).
  const own = await tech.text("the door is broken in doheny library");
  assert.ok(own.some((b) => /reported to fms/.test(b)));
  assert.ok(own.some((b) => /someone reported a broken door/.test(b)));
  assert.equal(tech.state()?.step, STAFF_STEP);
  assert.equal(t.report(r.id).status, "received");

  // "on it" answers the newest ask; "done" finishes it.
  await tech.text("on it");
  const mine = t.newest("repair");
  assert.notEqual(mine.id, r.id);
  assert.equal(t.report(mine.id).status, "in_progress");
  await tech.text("done");
  assert.equal(t.report(mine.id).status, "fixed");
  // The first job is still open and still theirs to answer.
  assert.equal(tech.state()?.step, STAFF_STEP);
  await tech.text("on it");
  assert.equal(t.report(r.id).status, "in_progress");
});

test("a technician's question about the job is answered, never filed as a new report", async () => {
  const t = setup();
  const tech = t.person("+13105550211", "Tina Tech");
  assert.ok(assignStaff(t.db, { role: "fms", handle: tech.handle }).ok);
  const student = t.person("+13105550212");
  await student.text("the light is broken in taper hall 2nd floor");
  const r = t.newest("repair");
  const count = () => (t.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE kind = 'repair' AND isExample = 0").get() as { n: number }).n;
  const before = count();

  // The router keeps the open step's flow with action "answer" for a message like this. The chat brain answers it.
  const asked: string[] = [];
  setStaffBrain(async (_ctx, step) => (asked.push(step.facts?.where ?? ""), { bubbles: ["2nd floor, taper hall"], action: null }));
  try {
    const pipeline = createPipeline({ db: t.db, getAdapter: () => t.adapter, pause: async () => {}, ackAfterMs: 60_000, detectIntent: async () => ({ flow: "repair", action: "answer", details: {}, source: "ai" }) });
    const say = async (text: string) => {
      const n = t.sent.length;
      await pipeline.handleEvent({ provider: "webchat", userHandle: tech.handle, chatId: tech.chatId, isGroup: false, messageId: `q-${text.length}`, text, images: [], receivedAt: Date.now() });
      return t.sent.slice(n).filter((x) => x.chatId === tech.chatId).map((x) => x.text);
    };
    assert.deepEqual(await say("wait which floor again"), ["2nd floor, taper hall"]);
    assert.equal(asked.length, 1);
    assert.match(asked[0]!, /taper hall/);
    assert.equal(count(), before, "no new report");
    assert.equal(tech.state()?.step, STAFF_STEP);
    // And the job is still theirs to take.
    const ack = await say("on it");
    assert.match(ack.join(" "), /"done"/);
    assert.equal(t.report(r.id).status, "in_progress");
    assert.equal(count(), before);
  } finally {
    setStaffBrain(null);
  }
});

test("nobody assigned: nothing is sent, and the dashboard gets the exact text troy would have sent", async () => {
  const t = setup();
  const student = t.person("+13105550231");
  const reply = await student.text("the light is broken in taper hall 2nd floor");
  // Only the student heard anything, and there is no stand-in note because nobody was texted.
  assert.equal(t.sent.length, reply.length);
  assert.ok(t.sent.every((s) => s.chatId === student.chatId));
  assert.ok(!reply.join(" ").includes("stand-in"));

  const r = t.newest("repair");
  const log = staffLogFor(t.db, r.id);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.example, true);
  assert.match(log[0]!.text, /^someone reported a broken light at taper hall, 2nd floor\. can u take it\?/);

  // Asked again (the report is unchanged): still one example row, still nothing sent.
  const out = await notifyStaffOfReport({ db: t.db, notify: async () => assert.fail("nothing is sent with nobody assigned") }, r.id);
  assert.equal(out.sentTo, null);
  assert.equal(out.exampleText, log[0]!.text);
  assert.equal(staffLogFor(t.db, r.id).length, 1);
  assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM staff_jobs").get()!.n, 0);
});

test("a technician who texted STOP, or a phone that never texted troy, gets nothing", async () => {
  const t = setup();
  // Assigned, but this phone has no chat with Troy yet.
  assignStaff(t.db, { role: "fms", handle: "+13105550241" });
  const student = t.person("+13105550242");
  await student.text("the light is broken in taper hall 2nd floor");
  assert.ok(t.sent.every((s) => s.chatId === student.chatId));
  assert.equal(staffLogFor(t.db, t.newest("repair").id)[0]!.example, true);

  const tech = t.person("+13105550241");
  await tech.text("STOP");
  const before = tech.got().length;
  await student.text("the elevator is broken in leavey library");
  assert.equal(tech.got().length, before);
  assert.equal(getUserById(t.db, tech.id)!.stopped, true);
});

test("quiet hours: the technician's text waits in the outbox and goes out when they end", async () => {
  // 3am in Los Angeles, then 10am.
  let now = new Date("2026-11-14T11:00:00Z");
  const t = setup({ outbox: true, clock: () => now });
  const tech = t.person("+13105550251");
  updateUser(t.db, tech.id, { quietHours: JSON.stringify({ start: "23:00", end: "08:00" }) });
  assignStaff(t.db, { role: "fms", handle: tech.handle });
  const student = t.person("+13105550252");
  await student.text("the light is broken in taper hall 2nd floor");

  assert.equal(tech.got().length, 0, "nothing during quiet hours");
  const waiting = t.db.prepare("SELECT text FROM outbox WHERE userId = ? ORDER BY id").all(tech.id) as Row[];
  assert.equal(waiting.length, 2);
  assert.match(waiting[0]!.text, /someone reported a broken light/);
  // It counts as sent (it will arrive), so the log is a real row and the job is open.
  assert.equal(staffLogFor(t.db, t.newest("repair").id)[0]!.example, false);

  now = new Date("2026-11-14T18:00:00Z");
  await t.notifier!.flush();
  assert.equal(tech.got().length, 2);
  assert.equal((t.db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as Row).n, 0);

  // Their answer still works, and the student's update goes through the same outbox.
  await tech.text("on it");
  assert.equal(t.newest("repair").status, "in_progress");
  assert.match(student.got().at(-1)!, /🔧$/);
});

// ---------- usg ----------

test("a usg concern texts the member counts only, and again when more students get behind it, never a name", async () => {
  const t = setup();
  const member = t.person("+13105550301", "Morgan Member");
  assignStaff(t.db, { role: `usg:${DINING}`, handle: member.handle, label: "morgan" });

  const a = t.person("+13105550302", "Alexandra Anonymous");
  await a.text(CONCERN);
  const sentReply = await a.text("anonymous");
  assert.match(sentReply.at(-1)!, /stand-in|example for the hackathon/);
  const r = t.newest("usg_concern");
  assert.equal(r.anonymous, 1);

  const first = member.got();
  assert.equal(first.length, 2);
  assert.match(first[0]!, /\b1 trojan\b/);
  assert.match(first[0]!, new RegExp(`"${CONCERN}"`));
  assert.match(first[0]!, /nobody shared their name/);
  assert.ok(!/group chat/.test(first[0]!), "no group chat is offered when nobody shared a name");
  assert.match(first[1]!, /"on the agenda"/);

  // A second student joins and puts their name on it: one more summary, with the new counts.
  const b = t.person("+13105550303", "Bartholomew Named");
  await b.text(CONCERN);
  assert.equal(member.got().length, 2, "the summary waits for the joiner's answer");
  await b.text("use my name");
  const second = member.got().slice(2);
  assert.equal(second.length, 1);
  assert.match(second[0]!, /2 trojans/);
  assert.match(second[0]!, /1 wants to talk\. want a group chat with them\?$/);
  assert.deepEqual(reportCounts(t.db, { id: r.id, userId: r.userId, anonymous: true, followers: JSON.parse(t.report(r.id).followers) }), { people: 2, named: 1 });

  // Nothing new behind it: no third text.
  await notifyStaffOfReport({ db: t.db, notify: async () => assert.fail("a concern that hasn't grown is not sent again") }, r.id);

  const all = member.got().join(" ");
  for (const name of ["Alexandra", "Anonymous", "Bartholomew", "Named"]) assert.ok(!all.includes(name) && !all.toLowerCase().includes(name.toLowerCase()), `the member never sees "${name}"`);
  for (const l of staffLogFor(t.db, r.id)) assert.ok(!/alexandra|bartholomew/i.test(l.text));
});

test("a joiner who never answers the name question: the sweep still sends the member the new count", async () => {
  const t = setup();
  const member = t.person("+13105550311");
  assignStaff(t.db, { role: `usg:${DINING}`, handle: member.handle });
  const a = t.person("+13105550312");
  await a.text(CONCERN);
  await a.text("with my name");
  const b = t.person("+13105550313");
  await b.text(CONCERN);
  assert.equal(member.got().length, 2);
  await t.pipeline.sweep(Date.now() + 60_000);
  assert.equal(member.got().length, 2, "not due yet");
  await t.pipeline.sweep(Date.now() + 10 * 60_000);
  assert.equal(member.got().length, 3);
  assert.match(member.got()[2]!, /2 trojans/);
  assert.match(member.got()[2]!, /1 wants to talk/);
});

test("the group chat only includes students who said yes, each asked with the warning word for word", async () => {
  const t = setup({ groupChats: true });
  const member = t.person("+13105550321", "Morgan Member");
  assignStaff(t.db, { role: `usg:${DINING}`, handle: member.handle, label: "morgan" });

  const a = t.person("+13105550322", "Ana");
  await a.text(CONCERN);
  await a.text("with my name");
  const b = t.person("+13105550323", "Ben");
  await b.text(CONCERN);
  await b.text("use my name");
  const c = t.person("+13105550324", "Cam");
  await c.text(CONCERN);
  await c.text("use my name");
  // Joined, but kept their name off: never asked, never added.
  const d = t.person("+13105550325", "Dee");
  await d.text(CONCERN);
  await d.text("anonymous");
  const r = t.newest("usg_concern");

  assert.match(member.got().at(-1)!, /4 trojans/);
  assert.match(member.got().at(-1)!, /3 want to talk\. want a group chat with them\?$/);

  const marks = [a, b, c, d].map((p) => p.got().length);
  const ack = await member.text("yes");
  assert.equal(ack.length, 1);
  assert.match(ack[0]!, /"cancel"/);

  for (const [i, p] of [a, b, c].entries()) {
    const asked = p.got().slice(marks[i]);
    // The fixed line, alone in its own bubble, last. (A long lead may go out in pieces.)
    assert.equal(asked.at(-1), CONTACT_WARNING);
    assert.equal(asked.filter((x) => x.includes("contact info")).length, 1);
    assert.match(asked.slice(0, -1).join(" "), /group chat/);
    assert.match(asked.at(-2)!, /stand-in|example/);
    assert.equal(p.state()?.step, TALK_STEP);
  }
  assert.equal(d.got().length, marks[3], "someone who stayed anonymous is not asked");
  assert.equal(t.groups.length, 0, "no chat until they answer");

  // A question is not a yes.
  const explained = await a.text("who is it?");
  assert.equal(explained.length, 1);
  assert.equal(t.groups.length, 0);
  assert.equal(a.state()?.step, TALK_STEP);

  await a.text("yes");
  // A thumbs up on some other bubble is not consent; on the warning bubble it is.
  const warningId = t.sent.filter((s) => s.chatId === c.chatId && s.text === CONTACT_WARNING).at(-1)!.id;
  const otherId = t.sent.filter((s) => s.chatId === c.chatId && s.text !== CONTACT_WARNING).at(-1)!.id;
  await c.tap(otherId, "like");
  assert.equal(c.state()?.step, TALK_STEP);
  assert.equal(t.groups.length, 0);
  await c.tap(warningId, "like");
  assert.equal(t.groups.length, 0, "still waiting on the last one");
  await b.text("no thanks");

  assert.equal(t.groups.length, 1);
  assert.deepEqual([...t.groups[0]!.members].sort(), [member.handle, a.handle, c.handle].sort());
  assert.ok(!t.groups[0]!.members.includes(b.handle));
  assert.ok(!t.groups[0]!.members.includes(d.handle));
  // Introduced by role, with the committee's own name.
  assert.match(t.groups[0]!.first, new RegExp(`^meet morgan from the ${DINING.toLowerCase()}`));
  for (const p of [a, b, c]) assert.equal(p.state(), null);
  assert.match(staffLogFor(t.db, r.id).at(-1)!.text, /group chat started with 2 people/);
});

test("contact rules win: someone who went relay only is not asked, and with no group chats one student is connected through troy", async () => {
  const t = setup({ groupChats: false });
  const member = t.person("+13105550331");
  assignStaff(t.db, { role: `usg:${DINING}`, handle: member.handle });
  const a = t.person("+13105550332");
  await a.text(CONCERN);
  await a.text("with my name");
  const b = t.person("+13105550333");
  await b.text(CONCERN);
  await b.text("use my name");
  updateUser(t.db, b.id, { contactMode: "relay_only" });

  const mark = b.got().length;
  await member.text("yes");
  assert.equal(b.got().length, mark, "relay only: never asked to share contact info");
  assert.equal(a.got().at(-1), CONTACT_WARNING);
  await a.text("yes");
  const relay = t.db.prepare("SELECT * FROM relays WHERE status = 'active'").get() as Row;
  assert.deepEqual([relay.userA, relay.userB].sort(), [member.id, a.id].sort());
  assert.equal(relay.context, `usg:${t.newest("usg_concern").id}`);
});

test("the member's status reply updates the concern and texts everyone behind it", async () => {
  const t = setup();
  const member = t.person("+13105550341");
  assignStaff(t.db, { role: `usg:${DINING}`, handle: member.handle });
  const a = t.person("+13105550342");
  await a.text(CONCERN);
  await a.text("anonymous");
  const b = t.person("+13105550343");
  await b.text(CONCERN);
  await b.text("anonymous");
  const r = t.newest("usg_concern");

  const ack = await member.text("it's on the agenda for thursday");
  assert.equal(ack.length, 1);
  assert.match(ack[0]!, /2 people/);
  assert.equal(t.report(r.id).status, "on_agenda");
  for (const p of [a, b]) assert.match(p.got().at(-1)!, new RegExp(`^update on the usg concern "${CONCERN}": .*agenda`));
  assert.equal(member.state()?.step, STAFF_STEP);

  await member.text("we fixed it");
  assert.equal(t.report(r.id).status, "acted_on");
  for (const p of [a, b]) assert.match(p.got().at(-1)!, /✅$/);
  assert.equal(member.state(), null);
});

test("notifyStaffOfReport on its own: sent to the assigned person's user id, with the text that went out", async () => {
  const t = setup();
  const tech = t.person("+13105550351");
  assignStaff(t.db, { role: "fms", handle: tech.handle });
  const student = t.person("+13105550352");
  const id = insertReport(t.db, { userId: student.id, kind: "repair", category: "leaking faucet", description: "the faucet keeps dripping", locationText: "Doheny Library, 1st floor", routedTo: FMS });
  const calls: { userId: number; bubbles: string[] }[] = [];
  const out = await notifyStaffOfReport({ db: t.db, notify: async (userId, bubbles) => void calls.push({ userId, bubbles }) }, id);
  assert.equal(out.sentTo, tech.id);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.userId, tech.id);
  assert.equal(out.exampleText, calls[0]!.bubbles.join("\n"));
  assert.match(out.exampleText, /someone reported a leaking faucet at doheny library, 1st floor/);
  // A repair is asked once.
  await notifyStaffOfReport({ db: t.db, notify: async () => assert.fail("asked twice") }, id);
  // A send that fails is not counted as texted: the dashboard shows it as the example text.
  const id2 = insertReport(t.db, { userId: student.id, kind: "repair", category: "broken door", description: "door won't latch", locationText: "Taper Hall", routedTo: FMS });
  const failed = await notifyStaffOfReport({ db: t.db, notify: async () => false }, id2);
  assert.equal(failed.sentTo, null);
  assert.equal(staffLogFor(t.db, id2)[0]!.example, true);
});

// ---------- judges, and the other side when nobody real is there ----------

const staffAsides = (p: { id: number }) => demo.asides.filter((a) => a.userId === p.id).map((a) => a.note);

test("asides: a technician's on it and done, and a member's yes, each say what that answer set in motion", async () => {
  demo.reset();
  const t = setup({ groupChats: true });
  const tech = t.person("+13105550401", "Tina Tech");
  assignStaff(t.db, { role: "fms", handle: tech.handle });
  const student = t.person("+13105550402");
  await student.text("the light is broken in taper hall 2nd floor");
  assert.equal(demo.offers.length, 0, "someone is assigned, so nothing is simulated");

  demo.reset();
  await tech.text("on it");
  assert.deepEqual(staffAsides(tech), [
    { step: "staff_repair_in_progress", behind: { did: "set the report to {status} from ur text and texted everyone following it, {following} in all", numbers: { status: "in progress", following: 1 } }, decision: "texts_first" },
  ]);
  await tech.text("done");
  assert.deepEqual(staffAsides(tech).at(-1)!.behind?.numbers, { status: "fixed", following: 1 });

  // Handing a job back is not a moment for commentary.
  const tech2 = t.person("+13105550403", "Hal Housing");
  assignStaff(t.db, { role: "housing", handle: tech2.handle });
  await student.text("the washer is broken in pardee tower");
  demo.reset();
  await tech2.text("can't");
  assert.deepEqual(staffAsides(tech2), []);

  const member = t.person("+13105550404", "Morgan Member");
  assignStaff(t.db, { role: `usg:${DINING}`, handle: member.handle });
  const a = t.person("+13105550405", "Ana");
  await a.text(CONCERN);
  await a.text("with my name");
  demo.reset();
  await member.text("yes");
  assert.deepEqual(staffAsides(member), [{ step: "staff_usg_talk", behind: { did: "asked each student who shared their name, {asked} in all, before adding anyone to a group chat", numbers: { asked: 1 } }, decision: "contact" }]);
  // The student's own yes to the warning: the decision only.
  await a.text("yes");
  assert.deepEqual(staffAsides(a).at(-1), { step: "usg_talk_yes", decision: "contact" });
});

/** A bare context for the seam's own functions. */
function bareCtx(t: ReturnType<typeof setup>, userId: number, state: FlowState | null = null): FlowContext & { said: string[]; owed: { to: number; text: string }[] } {
  const user = getUserById(t.db, userId) as User;
  const said: string[] = [];
  const owed: { to: number; text: string }[] = [];
  const plain = (b: string | { text: string }) => (typeof b === "string" ? b : b.text);
  return {
    db: t.db,
    user,
    event: { provider: "webchat", userHandle: user.handle, chatId: user.chatId, isGroup: false, messageId: "in-x", text: "hi", images: [], receivedAt: Date.now() },
    intent: { flow: "repair", action: "", details: {}, source: "fallback" },
    state,
    adapter: t.adapter,
    said,
    owed,
    async say(...b) {
      said.push(...b.map(plain));
      return b.map(() => null);
    },
    sayTo: async (_id, ...b) => b.map(() => null),
    async sayToOwed(id, ...b) {
      owed.push(...b.map((x) => ({ to: id, text: plain(x) })));
      return b.map(() => null);
    },
    setState() {},
    setStateFor() {},
  };
}

test("who counts as another real student: a usc email, not example data, not gone, not a judge", () => {
  const t = setup();
  const me = t.person("+13105550411");
  assert.equal(otherRealUsers(t.db, me.id), 0, "the seeded example people and other judges never count");
  const s = t.person("+13105550412");
  updateUser(t.db, s.id, { verifiedVia: "usc_email" });
  assert.equal(otherRealUsers(t.db, me.id), 1);
  assert.equal(otherRealUsers(t.db, s.id), 0, "nobody counts themselves");
  updateUser(t.db, s.id, { stopped: 1 });
  assert.equal(otherRealUsers(t.db, me.id), 0);
});

test("the offer goes to a judge always and to a student only when alone, and a broken module never costs a reply", async () => {
  demo.reset();
  demo.accept = true;
  const t = setup();
  const judge = t.person("+13105550421");
  const s1 = t.person("+13105550422");
  const s2 = t.person("+13105550423");
  for (const s of [s1, s2]) updateUser(t.db, s.id, { verifiedVia: "usc_email" });
  assert.equal(await simulateIfAlone(bareCtx(t, judge.id), "repair", { where: "taper" }), true);
  assert.equal(await simulateIfAlone(bareCtx(t, s1.id), "repair", { where: "taper" }), false);
  assert.deepEqual(demo.offers.map((o) => o.userId), [judge.id], "the student's offer was never even asked for");

  setDemoHooks({
    judgeAside: async () => {
      throw new Error("judge module broke");
    },
    offerSimulation: async () => {
      throw new Error("simulate module broke");
    },
    runSimulation: async () => {
      throw new Error("simulate module broke");
    },
  });
  try {
    await aside(bareCtx(t, judge.id), { step: "x", decision: DECISION.oneEngine });
    assert.equal(await simulateIfAlone(bareCtx(t, judge.id), "usg", {}), false);
    assert.equal(await simulationTurn(bareCtx(t, judge.id, { flow: "repair", step: "sim_offer", data: {}, updatedAt: Date.now() }), new Set(["ask_place"])), false);
  } finally {
    setDemoHooks(DEMO_HOOKS);
  }
});

test("a simulation gets first chance only at a step the flow didn't open itself", async () => {
  demo.reset();
  demo.consume = true;
  const t = setup();
  const p = t.person("+13105550431");
  const own = new Set(["ask_place", STAFF_STEP]);
  const at = (step: string, data: Record<string, unknown> = {}): FlowState => ({ flow: "repair", step, data, updatedAt: Date.now() });
  assert.equal(await simulationTurn(bareCtx(t, p.id, null), own), false, "no open step");
  assert.equal(await simulationTurn(bareCtx(t, p.id, at("ask_place")), own), false, "the flow's own question");
  assert.equal(await simulationTurn(bareCtx(t, p.id, at(STAFF_STEP)), own), false, "a technician's job pointer");
  assert.equal(demo.runs, 0);
  assert.equal(await simulationTurn(bareCtx(t, p.id, at("sim_offer")), own), true);
  assert.equal(await simulationTurn(bareCtx(t, p.id, at("ask_place", { simulation: "repair" })), own), true, "a simulation replaying one of the flow's own steps says so in its data");
  assert.equal(demo.runs, 2);
});

test("an aside for the other person goes to their chat as an owed text, never to someone who left", async () => {
  demo.reset();
  const t = setup();
  const me = t.person("+13105550441");
  const them = t.person("+13105550442", "Finn Finder");
  const mine = bareCtx(t, me.id);
  assert.equal(ctxAs(mine, me.id), mine);
  const theirs = ctxAs(mine, them.id)!;
  assert.equal(theirs.user.id, them.id);
  assert.equal(theirs.event.chatId, them.chatId);
  assert.equal(theirs.event.text, "", "the other person never inherits this person's message");
  await theirs.say("(an aside)");
  assert.deepEqual(mine.owed, [{ to: them.id, text: "(an aside)" }]);
  assert.deepEqual(mine.said, []);
  updateUser(t.db, them.id, { stopped: 1 });
  assert.equal(ctxAs(mine, them.id), null);
});
