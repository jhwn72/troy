// The simulated other side (John, "Judge mode, additions (a)"): the honest offer, the one-tap start, each kind ending
// on the real texts, and nothing written where it could match or alert a real user. No model and no waiting here.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { Bubble, FlowContext, IncomingEvent, Intent, MessagingAdapter } from "../src/types.ts";
import { openDb, getOrCreateUser, getUserById, updateUser, getFlowState, setFlowState, saveMessage } from "../src/db/index.ts";
import { setModelCall } from "../src/ai.ts";
import { setFirstTenDeps } from "../src/firstten.ts";
import { NOT_NOW, SHOW_ME, SIM_OFFER_STEP, SIM_PICK_STEP, offerSimulation, runSimulation, setSimulateDeps, stepSimulation } from "../src/simulate.ts";
import type { SimKind } from "../src/simulate.ts";
import { tour } from "../src/flows/tour.ts";
import { COPY } from "../src/flows/lostfound/handler.ts";
import { FOOD_COPY } from "../src/flows/food.ts";

console.warn = () => {};
setModelCall(null);
setFirstTenDeps({ timers: false });
const CODE = "K7P2XQ";
const pauses: number[] = [];
setSimulateDeps({ pause: async (ms) => void pauses.push(ms), pickupCode: () => CODE });
after(() => {
  setSimulateDeps(null);
  setFirstTenDeps(null);
});

/** Every table a real user could be matched or alerted from. */
const REAL_TABLES = ["listings", "matches", "verifications", "handoffs", "food_drops", "claims", "reports", "relays", "topic_posts", "topic_joins", "food_alert_bubbles", "pending_asks", "outbox"];
const count = (db: DatabaseSync, table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function world(opts: { pollMode?: "native" | "tap" | "numbered"; edits?: boolean; judge?: boolean } = {}) {
  const db = openDb(":memory:");
  const sent: { text: string; id: string }[] = [];
  const polls: { question: string; options: string[]; id: string }[] = [];
  const edits: { id: string; text: string }[] = [];
  const groups: unknown[] = [];
  const toOthers: unknown[] = [];
  let n = 0;
  const adapter: MessagingAdapter = {
    provider: "webchat",
    capabilities: () => ({ tapbacks: true, typing: true, readReceipts: true, edits: !!opts.edits, effects: true, polls: true, groupChats: true, contactCard: true, liveLocation: false }),
    async sendMessage(_chatId, text) {
      const id = `out-${++n}`;
      sent.push({ text, id });
      return { messageId: id };
    },
    sendImage: async () => null,
    sendContactCard: async () => null,
    markRead: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    react: async () => true,
    async editMessage(_chatId, id, text) {
      if (!opts.edits) return false;
      edits.push({ id, text });
      return true;
    },
    async sendPoll(_chatId, question, options) {
      const mode = opts.pollMode ?? "native";
      const id = `poll-${++n}`;
      polls.push({ question, options, id });
      if (mode === "native") return { optionMessageIds: options.map(() => id), mode };
      if (mode === "tap") return { optionMessageIds: options.map((_, i) => `${id}-opt-${i}`), mode };
      return { optionMessageIds: options.map(() => null), mode };
    },
    async createGroupChat(members) {
      groups.push(members);
      return "group-1";
    },
    getLiveLocation: async () => null,
    requestLocation: async () => false,
    chatIdForHandle: (h) => `chat-${h}`,
  };
  const handle = "+12135550401";
  const chatId = `chat-${handle}`;
  const u = getOrCreateUser(db, handle, chatId);
  updateUser(db, u.id, { verifiedAt: Date.now(), verifiedVia: opts.judge ? "judge_skip" : "usc_email" });
  // A second, real person: nothing may ever reach them.
  const bystander = getOrCreateUser(db, "+12135550402", "chat-+12135550402");
  updateUser(db, bystander.id, { verifiedAt: Date.now(), verifiedVia: "usc_email", subscriptions: JSON.stringify(["free_nearby"]) });
  let m = 0;
  const idle: Intent = { flow: "smalltalk", action: "chat", details: {}, source: "fallback" };
  const ctx = (over: Partial<IncomingEvent> = {}): FlowContext => {
    const event: IncomingEvent = { provider: "webchat", userHandle: handle, chatId, isGroup: false, messageId: `in-${++m}`, text: "", images: [], receivedAt: Date.now(), ...over };
    return {
      db,
      user: getUserById(db, u.id)!,
      event,
      intent: idle,
      state: getFlowState(db, u.id),
      adapter,
      async say(...bubbles: (string | Bubble)[]) {
        const out: (string | null)[] = [];
        for (const b of bubbles) {
          const text = typeof b === "string" ? b : b.text;
          const res = await adapter.sendMessage(chatId, text);
          saveMessage(db, { userId: u.id, chatId, direction: "out", providerMessageId: res!.messageId, text });
          out.push(res!.messageId);
        }
        return out;
      },
      sayTo: async (userId, ...b) => (toOthers.push(userId), b.map(() => null)),
      sayToOwed: async (userId, ...b) => (toOthers.push(userId), b.map(() => null)),
      setState: (s) => setFlowState(db, u.id, s),
      setStateFor: (userId, s) => (toOthers.push(userId), setFlowState(db, userId, s)),
    };
  };
  const texts = () => sent.map((s) => s.text);
  /** One turn through the tour flow, the way the pipeline routes a tap or a text while the state is the tour's. */
  const turn = async (over: Partial<IncomingEvent>) => {
    const before = sent.length;
    await tour.handle(ctx(over));
    return texts().slice(before);
  };
  const offer = async (kind: SimKind, context: Record<string, string>) => {
    const before = sent.length;
    const made = await offerSimulation(ctx(), kind, context);
    return { made, out: texts().slice(before) };
  };
  const tapShowMe = () => turn({ pollVote: { pollMessageId: polls.at(-1)!.id, optionIndex: 0 } });
  const nothingReal = () => {
    for (const table of REAL_TABLES) assert.equal(count(db, table), 0, `${table} is empty`);
    assert.equal(groups.length, 0, "no group chat is ever created with example people");
    assert.equal(toOthers.length, 0, "nothing was sent to, or changed for, anyone else");
    assert.equal(getFlowState(db, bystander.id), null);
  };
  return { db, id: u.id, ctx, sent, texts, polls, edits, turn, offer, tapShowMe, nothingReal, state: () => getFlowState(db, u.id) };
}

/** The one bubble that says the example people are not real. */
const LABEL = /made up|not real|nobody real|not a real person/;
const closes = (out: string[]) => assert.match(out.at(-1)!, /real trojans on here/, out.join(" / "));

test("the offer: honest about the demo, a one-tap 'show me', and the same line for a judge and a student", async () => {
  for (const judge of [false, true]) {
    const w = world({ judge });
    const { made, out } = await w.offer("repair", { what: "a stuck elevator", where: "fluor tower", office: "housing" });
    assert.equal(made, true);
    const all = out.join(" ");
    assert.match(all, /demo/);
    // Someone else (the bystander) is on troy, so the line says what is really true for this one, never "nobody else is on here".
    assert.match(all, /no technician for that is on here yet/);
    assert.doesNotMatch(all, /nobody else|no other users/);
    assert.match(all, /works|flow is real/);
    assert.match(all, /show u|play the other side/);
    assert.equal(w.polls.length, 1);
    assert.deepEqual(w.polls[0].options, [SHOW_ME, NOT_NOW]);
    assert.doesNotMatch(w.polls[0].question, /\btap\b/, "the poll question carries no tap instruction of its own");
    assert.deepEqual({ flow: w.state()?.flow, step: w.state()?.step, kind: w.state()?.data.kind }, { flow: "tour", step: SIM_OFFER_STEP, kind: "repair" });
    w.nothingReal();
    // Offered once per person and kind: the second time the caller says its normal line.
    assert.equal((await w.offer("repair", { what: "x" })).made, false);
    assert.equal((await w.offer("food", { what: "pizza" })).made, true);
  }
});

test("status is true to the moment: 'nobody else is on here' only when nobody else really is", async () => {
  const w = world({ judge: true });
  // The only other person stops: now it is literally true.
  w.db.prepare("UPDATE users SET stopped = 1 WHERE id != ?").run(w.id);
  const { out } = await w.offer("food", { what: "pizza", where: "leavey" });
  assert.match(out.join(" "), /nobody else|no other users|no one/);
  const v = world({ judge: true });
  const other = await v.offer("food", { what: "pizza", where: "leavey" });
  assert.match(other.out.join(" "), /no students who get food texts are close enough right now/);
  assert.doesNotMatch(other.out.join(" "), /nobody else|no other users/);
});

test("the offer poll: 'not now' is a no, by vote or by tapback on its bubble, and the tap hint is the only tap instruction", async () => {
  const w = world();
  await w.offer("usg", { what: "late village shuttles" });
  const no = await w.turn({ pollVote: { pollMessageId: w.polls.at(-1)!.id, optionIndex: 1 } });
  assert.equal(no.length, 1);
  assert.equal(w.state(), null);

  const v = world({ pollMode: "tap" });
  const { out } = await v.offer("usg", { what: "late village shuttles" });
  const tapLines = out.filter((b) => /\b(?:tap|heart|thumbs up)\b/.test(b));
  assert.equal(tapLines.length, 1, out.join(" / "));
  assert.doesNotMatch(out.join(" "), /tap ❤️ on ur pick/);
  const tapNo = await v.turn({ reaction: { targetMessageId: `${v.polls.at(-1)!.id}-opt-1`, type: "love", removed: false } });
  assert.equal(tapNo.length, 1);
  assert.equal(v.state(), null);
});

test("a no is one easy line, a typed yes works, and anything else lets the offer lapse", async () => {
  const w = world({ pollMode: "numbered" });
  const { out } = await w.offer("usg", { what: "late village shuttles" });
  assert.match(out.at(-1)!, /"show me"/, "with no native poll the exact words to text are in double quotes");
  const no = await w.turn({ text: "nah" });
  assert.equal(no.length, 1);
  assert.equal(w.state(), null);

  const v = world({ pollMode: "tap" });
  await v.offer("usg", { what: "late village shuttles" });
  const lapse = await v.turn({ text: "what time does leavey close" });
  assert.deepEqual(lapse, []);
  assert.equal(v.state(), null);
  assert.equal(await runSimulation(v.ctx({ text: "yes" })), false, "nothing is open anymore");

  const y = world();
  await y.offer("usg", { what: "late village shuttles" });
  const yes = await y.turn({ text: "show me" });
  assert.ok(yes.length > 3);
  closes(yes);
});

test("lost item, example finder picks dps: label once, the real blind check, then the real pickup code texts", async () => {
  const w = world();
  await w.offer("lost_found_owner", { what: "airpods pro", where: "leavey", color: "white", marks: "blue case, initials jw on the back", handoff: "dps" });
  const start = await w.tapShowMe();
  assert.equal(start.filter((b) => LABEL.test(b)).length, 1, "labeled once at the start");
  assert.ok(start.some((b) => b.startsWith('example finder: "')));
  assert.deepEqual(start.slice(-3), [COPY.turnedUp, COPY.quickCheck, COPY.describe], "the texts a real owner gets");
  assert.equal(w.state()?.step, "describe");
  assert.ok(pauses.length > 0, "the example finder takes a moment, like a real exchange");

  // "ok" is not a description: no try is used, the step stays open, and each nudge is in new words, written to them.
  const nudges = [await w.turn({ text: "ok" }), await w.turn({ text: "ok" }), await w.turn({ text: "ok" })].map((n) => n.join(" "));
  assert.equal(new Set(nudges).size, 3, nudges.join(" / "));
  for (const n of nudges) {
    assert.match(n, /ur own words/);
    assert.ok(!/\btheir\b|\bthey\b|not sure i followed|lost me/.test(n), n);
  }
  assert.equal(w.state()?.step, "describe");
  assert.equal((w.state()?.data.sim as { tries: number }).tries, 0);

  const done = await w.turn({ text: "white airpods pro in a blue case with jw on the back" });
  const all = done.join(" \n ");
  // The example finder's own line says how it's handed off, so nothing repeats it before that.
  assert.ok(!done.includes(COPY.checkingHandoff));
  assert.ok(done.some((b) => b.startsWith('example finder: "')));
  assert.ok(done.filter((b) => b.startsWith("(")).length === 0, "a student gets no parenthetical at all");
  assert.ok(done.includes(COPY.finderDropping), all);
  assert.ok(done.includes(`ur pickup code is ${CODE}`), all);
  assert.match(all, /example code|code's an example/);
  closes(done);
  assert.equal(w.state(), null);
  assert.equal(count(w.db, "handoffs"), 0, "the code exists only in the texts");
  w.nothingReal();
});

test("lost item, example finder picks meet: the group-chat warning is described and asked as pretend, never a real chat", async () => {
  const w = world();
  await w.offer("lost_found_owner", { what: "black north face backpack", where: "tcc", handoff: "meet" });
  await w.tapShowMe();
  const passed = await w.turn({ text: "black north face backpack with a red keychain" });
  assert.ok(!passed.includes(COPY.finderDown) && !passed.includes(COPY.checkingHandoff), "the example finder's line already says it");
  assert.ok(passed.length <= 5, passed.join(" / "));
  assert.match(passed.join(" "), /contact info/);
  assert.match(passed.at(-1)!, /"yes" or "no"/);
  assert.ok(!passed.includes(COPY.consent), "the real warning is only ever sent for a real handoff");
  assert.equal(w.state()?.step, "handoff");
  const yes = await w.turn({ text: "yes" });
  assert.match(yes.join(" "), /group chat/);
  assert.match(yes.join(" "), /"got it"/);
  closes(yes);
  w.nothingReal();
});

test("lost item: two descriptions that contradict the report end it the way the real one does", async () => {
  const w = world();
  await w.offer("lost_found_owner", { what: "navy hydro flask", color: "navy", brand: "Hydro Flask", marks: "usc sticker on the side, dent on the bottom" });
  await w.tapShowMe();
  const first = await w.turn({ text: "a pink stanley cup with a broken handle" });
  assert.deepEqual(first, [...COPY.retry]);
  const second = await w.turn({ text: "a red nalgene with a cracked lid" });
  assert.ok(second.includes(COPY.cantConfirmDescription));
  assert.match(second.join(" "), /finder/);
  assert.ok(!/sticker|dent/.test([...first, ...second].join(" ")), "no answer key");
  closes(second);
  w.nothingReal();
});

test("found item: an example owner asks, describes and passes, and the finder picks the handoff like a real one", async () => {
  for (const [pick, expected] of [
    ["2", `tell them it's for pickup code ${CODE}`],
    ["1", COPY.meetBusy],
  ] as const) {
    const w = world();
    await w.offer("lost_found_finder", { what: "black wallet", where: "the village" });
    const start = await w.tapShowMe();
    assert.equal(start.filter((b) => LABEL.test(b)).length, 1);
    assert.ok(start.some((b) => b.startsWith('example owner: "')));
    assert.ok(start.includes("someone's trying to claim the black wallet u found"));
    assert.deepEqual(start.slice(-2), ["the owner of the black wallet u found just checked out", COPY.handoffAsk]);
    assert.equal(w.state()?.step, SIM_PICK_STEP);
    const done = await w.turn({ text: pick });
    assert.ok(done.includes(expected), done.join(" / "));
    if (pick === "2") assert.ok(done.includes(COPY.dropAtDpsOk));
    else assert.match(done.join(" "), /group chat/);
    closes(done);
    w.nothingReal();
  }
});

test("food: example students claim and the count drops with the real count texts", async () => {
  const w = world();
  await w.offer("food", { what: "pizza", where: "tutor campus center", count: "12" });
  const out = await w.tapShowMe();
  assert.equal(out.filter((b) => LABEL.test(b)).length, 1);
  assert.ok(out.includes("posted. i texted 3 example students nearby"));
  assert.deepEqual(out.filter((b) => /^\d+ left$/.test(b)), ["12 left", "11 left", "10 left", "9 left"]);
  assert.equal(out.filter((b) => /^example student \d: "/.test(b)).length, 3);
  assert.ok(out.includes(FOOD_COPY.postedHow));
  closes(out);
  w.nothingReal();

  // When the provider can edit, the count bubble changes in place, as a real drop's does.
  const e = world({ edits: true });
  await e.offer("food", { what: "donuts", count: "2" });
  const edited = await e.tapShowMe();
  assert.deepEqual(e.edits.map((x) => x.text), ["last one", "all gone 😔"]);
  assert.equal(edited.filter((b) => /left$|^last one$|^all gone/.test(b)).length, 1, "only the first count bubble is a new text");
  e.nothingReal();
});

test("repair: an example technician says on it, then done, and the real status texts arrive", async () => {
  const w = world();
  await w.offer("repair", { what: "a leaking water fountain", where: "leavey library", office: "fms" });
  const out = await w.tapShowMe();
  const i = (text: string) => out.indexOf(text);
  assert.ok(i('example technician: "on it"') !== -1 && i("fms is on it 🔧") === i('example technician: "on it"') + 1, out.join(" / "));
  assert.ok(i('example technician: "done"') !== -1 && i("fixed ✅") === i('example technician: "done"') + 1);
  assert.match(out.join(" "), /a leaking water fountain/);
  assert.match(out.join(" "), /leavey library/);
  closes(out);
  w.nothingReal();
});

test("usg, rides and topics: example people answer, with the real status and join texts", async () => {
  const u = world();
  await u.offer("usg", { what: "late village shuttles", committee: "transportation" });
  const usg = await u.tapShowMe();
  assert.ok(usg.includes('example usg member: "on the agenda"') && usg.includes("it's on the agenda"));
  assert.ok(usg.includes("usg acted on it ✅"));
  assert.match(usg.join(" "), /late village shuttles/);
  closes(usg);
  u.nothingReal();

  const r = world();
  await r.offer("rides", { dest: "lax", day: "the 19th", time: "noon" });
  const rides = await r.tapShowMe();
  assert.equal(rides.filter((b) => /^example rider \d: "/.test(b)).length, 2);
  assert.match(rides.join(" "), /lax/);
  assert.match(rides.join(" "), /contact info/);
  assert.match(rides.join(" "), /no chat here|not opening one/);
  closes(rides);
  r.nothingReal();

  const t = world();
  await t.offer("topics", { topic: "pickup games", post: "pickup at lyon at 6" });
  const topics = await t.tapShowMe();
  assert.ok(topics.includes('example student: "i\'m in"'));
  assert.ok(topics.includes("a trojan wants in on ur pickup at lyon at 6"));
  assert.match(topics.join(" "), /no numbers shared/);
  closes(topics);
  t.nothingReal();
});

test("every kind: lowercase, u and ur, no em dashes, at most one emoji a bubble, and playing one counts as trying something", async () => {
  const contexts: Record<SimKind, Record<string, string>> = {
    lost_found_owner: { what: "Blue Umbrella", handoff: "dps" },
    lost_found_finder: { what: "Keys" },
    food: { what: "Bagels", count: "6" },
    repair: { what: "Broken Door", where: "Doheny" },
    usg: { what: "Dining Hall Hours" },
    rides: { dest: "LAX" },
    topics: { topic: "Study Groups", post: "Econ review at 7" },
  };
  for (const kind of Object.keys(contexts) as SimKind[]) {
    const w = world();
    await w.offer(kind, contexts[kind]);
    await w.tapShowMe();
    if (w.state()?.step === "describe") await w.turn({ text: "a blue umbrella with a wooden handle" });
    if (w.state()?.step === SIM_PICK_STEP) await w.turn({ text: "dps" });
    assert.equal(w.state(), null, kind);
    for (const b of w.texts()) {
      const plain = b.replace(CODE, "");
      assert.equal(plain, plain.toLowerCase(), `${kind}: ${b}`);
      assert.ok(!/\byou\b|\byour\b/.test(plain), `${kind}: ${b}`);
      assert.ok(!/[—–]/.test(b), `${kind}: ${b}`);
      assert.ok((b.match(/\p{Extended_Pictographic}/gu) ?? []).length <= 1, `${kind}: ${b}`);
    }
    w.nothingReal();
  }
  // Nothing of ours open: not consumed.
  const idle = world();
  assert.equal(await stepSimulation(idle.ctx({ text: "yes" })), "none");
});

// ---------- review fixes ----------

test("their own report: an honest description of the same item passes, a different color misses, and the close says the real report is still open", async () => {
  // What the lost and found flow hands over after a real report: kind, color, brand, the report sentence and its row.
  const own = { item: "wallet", category: "wallet", color: "black", brand: "", description: "i lost my black wallet at leavey today", where: "leavey", listingId: "12", handoff: "dps" };
  for (const honest of ["its a black leather wallet, bifold", "black leather wallet with my usc id inside"]) {
    const w = world();
    await w.offer("lost_found_owner", own);
    await w.tapShowMe();
    const out = await w.turn({ text: honest });
    assert.ok(!out.includes(COPY.retry[0]), `"${honest}" must not miss: ${out.join(" / ")}`);
    assert.ok(out.includes(`ur pickup code is ${CODE}`), out.join(" / "));
    // Their real report was saved by the real flow and stays open: the close never says nothing was saved.
    const end = out.slice(-2).join(" ");
    assert.match(end, /still open|stays saved and open/);
    assert.ok(!/nothing (?:got |was )?(?:saved|kept)/.test(out.join(" ")), out.join(" / "));
    w.nothingReal();
  }
  const w = world();
  await w.offer("lost_found_owner", own);
  await w.tapShowMe();
  assert.deepEqual(await w.turn({ text: "a bright blue wallet with a zipper" }), [...COPY.retry], "a different color than they reported still misses");
});

test("backing out at the describe step is not a failed description: one easy line, no try used, nothing offered after", async () => {
  for (const text of ["nah", "no", "idk", "i'm good", "maybe later"]) {
    const w = world();
    await w.offer("lost_found_owner", { what: "navy hydro flask", color: "navy", marks: "usc sticker on the side" });
    await w.tapShowMe();
    const out = await w.turn({ text });
    assert.equal(out.length, 1, `${text}: ${out.join(" / ")}`);
    assert.ok(!out.includes(COPY.retry[0]) && !out.includes(COPY.cantConfirmDescription), text);
    assert.ok(!/\?$/.test(out[0]!), "no follow-up offer");
    assert.equal(w.state(), null);
  }
});

test("a judge's run: the aside never sits in a turn that ends on a question, and there is never more than one parenthetical in a turn", async () => {
  const parens = (out: string[]) => out.filter((b) => b.startsWith("("));
  // Owner side, example finder meets: the pass turn ends on the pretend contact question, so the aside waits for the close.
  const w = world({ judge: true });
  await w.offer("lost_found_owner", { what: "black north face backpack", where: "tcc", handoff: "meet" });
  await w.tapShowMe();
  const passed = await w.turn({ text: "black north face backpack with a red keychain" });
  assert.equal(parens(passed).length, 0, passed.join(" / "));
  assert.ok(passed.length <= 5, passed.join(" / "));
  const end = await w.turn({ text: "yes" });
  assert.equal(parens(end).length, 1, end.join(" / "));
  for (const b of parens(end)) assert.ok(b.length <= 160 && b.endsWith(")"), `one bubble, not split: ${b}`);

  // Finder side: the opening ends on "1 or 2", so only troy's own narrator note is in parentheses there (never
  // dressed up as the example owner talking), and the pick's closing turn carries exactly one parenthetical.
  const f = world({ judge: true });
  await f.offer("lost_found_finder", { item: "black wallet", where: "leavey", listingId: "3" });
  const open = await f.tapShowMe();
  assert.equal(parens(open).length, 1, open.join(" / "));
  assert.ok(!open.some((b) => /^example owner: "\(/.test(b)), "the narrator line is troy's own, not the example owner's");
  const pick = await f.turn({ text: "2" });
  assert.equal(parens(pick).length, 1, pick.join(" / "));
  assert.match(pick.slice(-2).join(" "), /still open|stays saved and open/, "the real found report is still open");
});
