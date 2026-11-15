import { test } from "node:test";
import assert from "node:assert/strict";
import { setDemoHooks } from "../src/staff.ts";
import type { AsideNote, SimKind } from "../src/staff.ts";
import type { FlowHandler, Intent, MessagingAdapter } from "../src/types.ts";
import { openDb, getOrCreateUser, getFlowState, updateUser } from "../src/db/index.ts";
import { seed } from "../src/db/seed.ts";
import { createPipeline } from "../src/pipeline.ts";
import { registerFlow } from "../src/flows/index.ts";
import { fallbackIntent, setModelCall } from "../src/ai.ts";
import { usg, ASK_NAME, ASK_JOIN_NAME, isConcern, parseChoice, topicFromWords, EXPLAIN_NAME, USG_POOLS, USG_VOICE } from "../src/flows/usg.ts";
import { sentenceBubbles } from "../src/flows/reports-shared.ts";
import { poolProblems, setVariantPicker } from "../src/flows/reports-shared.ts";
import type { VariantPicker, Voice } from "../src/flows/reports-shared.ts";


/**
 * Facts locked, wording varied: any line Troy sends may be any variant from the exported pools. The fake adapter
 * records each bubble read back to its first wording, with every name, number and link kept exactly as sent, so
 * the assertions below hold for whichever variant went out. `raw` keeps the words as they were sent.
 */
const canon = (text: string): string => USG_VOICE.canonical(text);

/**
 * What was said, whatever bubbles it arrived in. The pipeline splits long bubbles at a comma or a space
 * (and drops the comma there), so the words are compared, not the bubble edges.
 */
const said = (bubbles: (string | null)[]): string => bubbles.filter(Boolean).join(" ").replace(/[\s,]+/g, " ").trim();

const DINING_COMMITTEE = "USG Committee on Sustainability and Campus Infrastructure";

type Report = { id: number; userId: number; anonymous: number; category: string; description: string; routedTo: string; status: string; followers: string; isExample: number };
type Dir = { name: string; details: string; url: string | null; isExample: number };

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
    if (demo.accept) ctx.setState({ flow: "usg", step: "sim_offer", data: { simulation: kind } });
    return demo.accept;
  },
  runSimulation: async (ctx) => {
    demo.runs++;
    // The real one plays the other side out loud. One line stands in for that here.
    if (demo.consume) await ctx.say(SIM_LINE);
    return demo.consume;
  },
});

// No model: every reply path has to work without one.
setModelCall(async () => {
  throw new Error("no json");
});

// The keyword rules in src/ai.ts don't catch the spec's two example texts, so these stand in for the model's intent.
const asModel = (action: string): Intent => ({ flow: "usg", action, details: {}, source: "ai" });
const MODEL_INTENTS: Record<string, Intent> = {
  "how does my club get funding": asModel("question"),
  "why does village dining close so early": asModel("concern"),
};

const repairSeen: string[] = [];
const repair: FlowHandler = {
  name: "repair",
  async handle(ctx) {
    repairSeen.push(ctx.event.text);
    assert.equal(ctx.state, null);
    await ctx.say("repair reply");
  },
};
registerFlow(usg);
registerFlow(repair);

function setup() {
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
  const pipeline = createPipeline({ db, getAdapter: () => adapter, pause: async () => {}, ackAfterMs: 60_000, detectIntent: async (i) => MODEL_INTENTS[i.text] ?? fallbackIntent(i) });
  let m = 0;
  const student = (handle: string, name = "Tess Trojan") => {
    const chatId = `chat-${handle}`;
    const u = getOrCreateUser(db, handle, chatId);
    updateUser(db, u.id, { verifiedAt: Date.now(), verifiedVia: "judge_skip", name });
    const text = async (t: string) => {
      const before = sent.length;
      await pipeline.handleEvent({ provider: "webchat", userHandle: handle, chatId, isGroup: false, messageId: `in-${++m}`, text: t, images: [], receivedAt: Date.now() });
      return sent.slice(before).filter((s) => s.chatId === chatId).map((s) => s.text);
    };
    return { id: u.id, text, state: () => getFlowState(db, u.id) };
  };
  const reports = () => db.prepare("SELECT * FROM reports WHERE kind = 'usg_concern' ORDER BY id").all() as unknown as Report[];
  const mine = () => reports().filter((r) => !r.isExample);
  const dir = (name: string) => db.prepare("SELECT name, details, url, isExample FROM directory WHERE name = ?").get(name) as unknown as Dir;
  const allUrls = () => (db.prepare("SELECT url FROM directory WHERE url IS NOT NULL").all() as { url: string }[]).map((r) => r.url);
  return { db, student, reports, mine, dir, allUrls, sent };
}

test("'how does my club get funding' answers with the stored RSO funding details and url, nothing invented", async () => {
  const t = setup();
  const a = t.student("+13235550001");
  const row = t.dir("USG RSO funding");
  assert.ok(row.details && row.url);
  const reply = await a.text("how does my club get funding");
  // The stored text comes back whole, in order, and the link is the row's own.
  assert.ok(said(reply).includes(said([row.details])));
  assert.ok(reply.includes(row.url!));
  // Every bubble is a piece of the stored row. Nothing else was said.
  assert.equal(said(reply), said([...sentenceBubbles(row.details), row.url]));
  assert.equal(t.mine().length, 0);
  assert.equal(a.state(), null);
});

// "Trust USG's own statements" (CLAUDE.md Decisions): the shuttle and the thrift are stated plainly.
const HEDGES = /couldn'?t confirm|not confirmed|i don'?t have confirmed|i'd check with usg|double check|not 100% sure|not sure|i think|might|maybe/;

test("the usg thrift is stated plainly: the stored sentences, the usg contact, no hedging, no link, no date", async () => {
  const t = setup();
  const a = t.student("+13235550002");
  const row = t.dir("USG thrift");
  assert.equal(row.isExample, 0);
  assert.equal(row.url, null);
  assert.equal(row.details, "usg runs a thrift for students. ask usg where and when the next one is.");
  const reply = await a.text("is there a usg thrift?");
  assert.equal(said(reply), "usg runs a thrift for students. ask usg where and when the next one is. u can reach them at usg@usc.edu");
  assert.equal(reply.at(-1), "u can reach them at usg@usc.edu");
  assert.ok(!HEDGES.test(reply.join(" ")));
  assert.ok(!/https?:\/\/|www\./.test(reply.join(" ")));
  assert.ok(!/\d/.test(reply.join(" ")), "no date or price");
  assert.equal(t.mine().length, 0);
});

test("the usg lax shuttle is stated plainly, and dates are left to usg", async () => {
  const t = setup();
  const a = t.student("+13235550012");
  const row = t.dir("USG LAX shuttle");
  assert.equal(row.isExample, 0);
  assert.equal(row.url, null);
  assert.equal(row.details, "usg runs a shuttle to lax around breaks. hit up usg for this year's dates and how to sign up.");
  const reply = await a.text("when does the usg lax shuttle run?");
  assert.equal(said(reply), "usg runs a shuttle to lax around breaks. hit up usg for this year's dates and how to sign up. u can reach them at usg@usc.edu");
  assert.equal(reply.at(-1), "u can reach them at usg@usc.edu");
  assert.ok(!HEDGES.test(reply.join(" ")));
  assert.ok(!/https?:\/\/|www\./.test(reply.join(" ")));
  assert.ok(!/\d/.test(reply.join(" ")), "no date or price");
});

test("the two rows keep the usg contact and carry no link, date or price", () => {
  const t = setup();
  for (const name of ["USG LAX shuttle", "USG thrift"]) {
    const row = t.db.prepare("SELECT details, url, contactMethod FROM directory WHERE name = ?").get(name) as { details: string; url: string | null; contactMethod: string | null };
    assert.equal(row.url, null, name);
    assert.equal(row.contactMethod, "usg@usc.edu", name);
    assert.ok(!HEDGES.test(row.details), name);
    assert.ok(!/\d|\$|https?:/.test(row.details), name);
    assert.equal(row.details, row.details.toLowerCase(), name);
    assert.ok(!row.details.includes("\u2014"), name);
  }
});

test("a program row still marked as example data keeps the check-with-usg line", async () => {
  const t = setup();
  t.db.prepare("UPDATE directory SET isExample = 1, details = 'usg has a pilot going.' WHERE name = 'USG thrift'").run();
  const a = t.student("+13235550013");
  const reply = await a.text("is there a usg thrift?");
  assert.deepEqual(reply, ["usg has a pilot going.", "i'd check with usg", "u can reach them at usg@usc.edu"]);
});

test("a program with no stored details still says to check with usg, and never borrows a link", async () => {
  const t = setup();
  t.db.prepare("UPDATE directory SET details = NULL WHERE name = 'USG LAX shuttle'").run();
  const a = t.student("+13235550003");
  const reply = await a.text("when does the usg lax shuttle run?");
  assert.match(reply.join(" "), /i'd check with usg/);
  assert.ok(!/https?:\/\//.test(reply.join(" ")));
  assert.ok(!/\d/.test(reply.join(" ")));
});

test("a dining concern asks name or anonymous once, routes to the right committee and stores the choice", async () => {
  const t = setup();
  const a = t.student("+13235550004");
  assert.deepEqual(await a.text("usc should have more vegetarian options at evk"), [ASK_NAME]);
  assert.equal(t.mine().length, 0);
  assert.equal(a.state()?.flow, "usg");

  const reply = await a.text("anonymously pls");
  assert.equal(reply[0], `sent to the ${DINING_COMMITTEE}. i'll text u when they pick it up.`);
  assert.ok(!reply.join(" ").includes("Tess"));
  const rows = t.mine();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].anonymous, 1);
  assert.equal(rows[0].routedTo, DINING_COMMITTEE);
  assert.equal(rows[0].category, "dining");
  assert.equal(rows[0].description, "usc should have more vegetarian options at evk");
  assert.equal(rows[0].userId, a.id);
  assert.equal(rows[0].status, "received");
  assert.equal(a.state(), null);

  const b = t.student("+13235550005");
  assert.deepEqual(await b.text("dining halls should be open later during finals"), [ASK_NAME]);
  const named = await b.text("with my name");
  assert.deepEqual(named, [`sent to the ${DINING_COMMITTEE}. i'll text u when they pick it up.`]);
  const mine = t.mine().find((r) => r.userId === b.id)!;
  assert.equal(mine.anonymous, 0);
  assert.equal(mine.routedTo, DINING_COMMITTEE);
});

test("topics pick the committee row by its stored topics", async () => {
  const t = setup();
  const a = t.student("+13235550006");
  await a.text("i have a concern about registration, classes fill up before sophomores can pick");
  await a.text("name");
  assert.equal(t.mine()[0].routedTo, "USG Committee on Academic Affairs");
  assert.equal(t.mine()[0].category, "academics");

  await a.text("usc should add more quiet space");
  await a.text("anon");
  assert.equal(t.mine()[1].routedTo, "USG general contact");
  assert.equal(t.mine()[1].category, "other");
});

test("a similar open concern is joined as a follower: no new row, and one optional question about their name", async () => {
  const t = setup();
  // Example rows are never joined, so treat the seeded concerns as real here.
  t.db.prepare("UPDATE reports SET isExample = 0").run();
  const before = t.reports().length;
  const seeded = t.reports().find((r) => r.category === "dining" && r.status === "received")!;
  const a = t.student("+13235550007");
  const reply = await a.text("why does village dining close so early");
  assert.ok(!reply.includes(ASK_NAME));
  assert.match(reply[0], new RegExp(`^\\d+ others? (?:person )?already sent that to the ${DINING_COMMITTEE}`));
  assert.equal(reply.at(-1), ASK_JOIN_NAME);
  assert.equal(t.reports().length, before);
  const after = t.reports().find((r) => r.id === seeded.id)!;
  // Added right away, whatever they answer.
  assert.ok((JSON.parse(after.followers) as number[]).includes(a.id));
  assert.equal(a.state()?.step, "ask_join_name");
  const named = () => (t.db.prepare("SELECT named FROM report_people WHERE reportId = ? AND userId = ?").get(seeded.id, a.id) as { named: number }).named;
  assert.equal(named(), 0);

  // A question about it is answered and nothing is decided.
  const explained = await a.text("who sees my name?");
  assert.equal(explained.length, 2);
  assert.equal(named(), 0);
  assert.equal(a.state()?.step, "ask_join_name");

  assert.deepEqual(await a.text("use my name"), ["bet, ur name's on it. if usg wants to talk i'll ask u first"]);
  assert.equal(named(), 1);
  assert.equal(a.state(), null);
});

test("a joiner who says anonymous, or just moves on, stays a nameless count", async () => {
  const t = setup();
  t.db.prepare("UPDATE reports SET isExample = 0").run();
  const seeded = t.reports().find((r) => r.category === "dining" && r.status === "received")!;
  const named = (id: number) => (t.db.prepare("SELECT named FROM report_people WHERE reportId = ? AND userId = ?").get(seeded.id, id) as { named: number }).named;

  const a = t.student("+13235550031");
  await a.text("why does village dining close so early");
  assert.deepEqual(await a.text("anonymous pls"), ["all good, ur counted without ur name"]);
  assert.equal(named(a.id), 0);
  assert.equal(a.state(), null);

  // "yes" doesn't say which: the choice that shares less, said plainly.
  const b = t.student("+13235550032");
  await b.text("why does village dining close so early");
  assert.deepEqual(await b.text("yes"), ["wasn't sure which u meant, so i left ur name off"]);
  assert.equal(named(b.id), 0);

  // Something for another flow goes there, with no complaint about the unanswered question.
  const c = t.student("+13235550033");
  await c.text("why does village dining close so early");
  assert.deepEqual(await c.text("the elevator in leavey is broken"), ["repair reply"]);
  assert.equal(named(c.id), 0);
  assert.equal(c.state(), null);
  assert.ok((JSON.parse(t.reports().find((r) => r.id === seeded.id)!.followers) as number[]).includes(c.id));
});

test("a concern a program fits gets the program's stored details first, then the question", async () => {
  const t = setup();
  const a = t.student("+13235550008");
  const row = t.dir("USG RSO funding");
  const reply = await a.text("club funding takes too long, the rso funding deadlines are ridiculous");
  assert.equal(said(reply), said([...sentenceBubbles(row.details), row.url, ASK_NAME]));
  assert.equal(reply.at(-1), ASK_NAME);
  assert.equal(reply.at(-2), row.url);
  await a.text("anonymous");
  assert.equal(t.mine()[0].routedTo, "USG Funding Department");
  assert.equal(t.mine()[0].anonymous, 1);
});

test("a plain complaint that only shares a word with a program is just the complaint: no program recited at them", async () => {
  const t = setup();
  const a = t.student("+13235550018");
  const reply = await a.text("i have a complaint for usg: the late night village shuttles never show up on time");
  assert.deepEqual(reply, [ASK_NAME]);
  // More than a few words, and it still picks the name.
  await a.text("put my name on it, im gabe");
  assert.equal(t.mine()[0].anonymous, 0);
  // The committee member reads the concern itself, without the "complaint for usg" in front.
  assert.equal(t.mine()[0].description, "the late night village shuttles never show up on time");
});

test("a question nothing covers gets an honest guess in two bubbles, with a link only from the directory", async () => {
  const t = setup();
  const a = t.student("+13235550009");
  const reply = await a.text("who do i ask about the usg elections timeline?");
  assert.equal(reply.length, 2);
  assert.match(reply.join(" "), /not sure/);
  assert.match(reply.join(" "), /double check/);
  const links = reply.join(" ").match(/https?:\/\/\S+/g) ?? [];
  for (const l of links) assert.ok(t.allUrls().includes(l));
  assert.equal(t.mine().length, 0);
  assert.equal(a.state(), null);
});

test("a question a committee covers offers to send it, and yes leads to the name question", async () => {
  const t = setup();
  const a = t.student("+13235550010");
  const reply = await a.text("what's the policy on dining hall menus?");
  // The guess can arrive as one bubble or split in two. The offer is always the last one.
  const guess = said(reply.slice(0, -1));
  assert.ok(guess.includes(said([DINING_COMMITTEE])));
  assert.match(guess, /double check/);
  assert.equal(reply.at(-1), "want me to send them ur question?");
  assert.deepEqual(await a.text("yes"), [ASK_NAME]);
  await a.text("with my name");
  assert.equal(t.mine().length, 1);
  assert.equal(t.mine()[0].anonymous, 0);

  const b = t.student("+13235550011");
  await b.text("what's the policy on dining hall menus?");
  assert.deepEqual(await b.text("nah"), ["all good"]);
  assert.equal(b.state(), null);
});

test("no one gets stuck: nvm cancels, an unrelated request moves on, an unclear yes sends without the name", async () => {
  const t = setup();
  const a = t.student("+13235550012");
  await a.text("usc should have more vegetarian options at evk");
  assert.deepEqual(await a.text("nvm"), ["all good, dropped it"]);
  assert.equal(a.state(), null);
  assert.equal(t.mine().length, 0);

  await a.text("usc should have more vegetarian options at evk");
  repairSeen.length = 0;
  assert.deepEqual(await a.text("the elevator in leavey is broken"), ["repair reply"]);
  assert.equal(repairSeen.length, 1);
  assert.equal(a.state(), null);
  assert.equal(t.mine().length, 0);

  await a.text("usc should have more vegetarian options at evk");
  const reply = await a.text("sure");
  assert.match(reply[0], /^sent to the /);
  assert.match(reply[1], /without ur name/);
  assert.equal(t.mine()[0].anonymous, 1);
  assert.equal(a.state(), null);

  // Something that is neither an answer nor a new ask: nothing is sent and the state is cleared.
  await a.text("dining halls should be open later during finals");
  await a.text("lol idk");
  assert.equal(a.state(), null);
  assert.equal(t.mine().length, 1);
});

test("asking 'will they see my name?' never sends the concern with the name: it gets an answer and the question again", async () => {
  for (const asked of ["wait will they see my name?", "who sees my name", "is my name attached", "what name would it show", "so would my name be on it"]) {
    const t = setup();
    const a = t.student("+13235550031");
    assert.deepEqual(await a.text("why does village dining close so early"), [ASK_NAME]);
    assert.deepEqual(await a.text(asked), EXPLAIN_NAME, asked);
    assert.equal(t.mine().length, 0, `${asked}: nothing was sent`);
    assert.equal(a.state()?.step, "ask_name");
    // The real answer still works afterwards, either way.
    await a.text("anonymous");
    assert.equal(t.mine().length, 1);
    assert.equal(t.mine()[0].anonymous, 1);
  }
  assert.equal(parseChoice("wait will they see my name?"), null);
  assert.equal(parseChoice("who sees my name"), null);
  assert.equal(parseChoice("with my name"), "name");
  assert.equal(parseChoice("name is fine"), "name");
  assert.equal(parseChoice("name"), "name");
});

test("code helpers: concern or question, choice, topic", () => {
  assert.equal(isConcern("why does village dining close so early", "question"), true);
  assert.equal(isConcern("how does my club get funding", "concern"), false);
  assert.equal(isConcern("usc needs more study rooms", "concern"), true);
  assert.equal(parseChoice("anonymously"), "anonymous");
  assert.equal(parseChoice("anon"), "anonymous");
  assert.equal(parseChoice("don't use my name"), "anonymous");
  assert.equal(parseChoice("use my name"), "name");
  assert.equal(parseChoice("not anonymous, name is fine"), "name");
  assert.equal(parseChoice("sure"), null);
  assert.equal(topicFromWords("the lax shuttle is always full"), "transportation");
  assert.equal(topicFromWords("how do rsos get funding"), "club funding");
  assert.equal(topicFromWords("hello there"), "other");
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

test("usg wording pools are well formed, and directory text has no variants", () => {
  assert.deepEqual(poolProblems(USG_POOLS), []);
  const t = setup();
  const row = t.dir("USG RSO funding");
  for (const line of [...sentenceBubbles(row.details!), row.url!]) assert.deepEqual(USG_VOICE.variantsOf(line), [line]);
  // Every wording of a best guess still says it is a guess and to double check, and keeps the name and the link.
  for (const v of USG_VOICE.variantsOf("not 100% sure, but my best guess is the Dining Committee covers that. i'd double check: https://example.edu/x")) {
    assert.match(v, /not 100% sure/);
    assert.match(v, /best guess/);
    assert.match(v, /double check: https:\/\/example\.edu\/x$/);
    assert.match(v, /\bDining Committee\b/);
  }
});

test("usg: with other wording on every line, the committee, the anonymous choice and stored text are exactly the same", async () => {
  setVariantPicker(lastVariant);
  try {
    const t = setup();
    const a = t.student("+13235550001");
    assert.deepEqual(await a.text("why does the village dining hall close so early"), [ASK_NAME]);
    const done = await a.text("anonymous");
    assert.match(done[0], /^sent to the .+\. i'll text u when they pick it up\.$/);
    assert.equal(done[1], "sent anonymously, ur name isn't on it");
    const report = t.mine()[0];
    assert.equal(report.anonymous, 1);
    const row = t.dir("USG RSO funding");
    const funding = await a.text("how does my club get funding");
    assert.equal(said(funding), said([...sentenceBubbles(row.details!), row.url!]));
    assertSameFacts(USG_VOICE, t.sent);
    const raw = t.sent.map((s) => s.raw);
    assert.ok(t.sent.filter((s) => s.raw !== s.text).length >= 3, "the wording really did change");
    // The committee's name is the directory's, in every wording. Stored program text went out untouched.
    assert.ok(raw.some((r) => r.includes(report.routedTo) && /pick it up/.test(r)));
    assert.ok(said(raw).includes(said([...sentenceBubbles(row.details!), row.url!])));
  } finally {
    setVariantPicker(null);
  }
});

test("poolProblems catches a variant that drops a value, adds an emoji, shouts, or has too few wordings", () => {
  assert.deepEqual(poolProblems({ ok: ["one way", "another way", "a third way"], code: (c) => [`ur code is ${c}`, `code: ${c}`, `here it is, ${c}`] }), []);
  assert.match(poolProblems({ code: (c) => [`ur code is ${c}`, "ur code is on its way", `code: ${c}`] }).join("\n"), /different values|every value/);
  assert.match(poolProblems({ sad: ["all gone, sorry", "all gone, sorry 😔", "none left, sorry"] }).join("\n"), /adds an emoji/);
  assert.match(poolProblems({ loud: ["got it", "Got it", "ok got it"] }).join("\n"), /capitals/);
  assert.match(poolProblems({ few: ["only one", "only two"] }).join("\n"), /want 3 to 5/);
  assert.match(poolProblems({ a: ["same words", "x one", "x two"], b: ["other words", "same words", "y two"] }).join("\n"), /also in/);
  assert.match(poolProblems({ two: [["a b", "c d"], ["only one bubble"], ["e f", "g h"]] }).join("\n"), /bubbles/);
});

// ---------- judge asides and the simulated usg member ----------

const usgAsides = () => demo.asides.map((a) => a.note);

test("asides: a sent concern names the committee and how many students share it; a joined one carries the real count", async () => {
  demo.reset();
  const t = setup();
  const a = t.student("+13235550301");
  await a.text("usc should have more vegetarian options at evk");
  assert.equal(demo.asides.length, 0, "nothing while the name question is still open");
  await a.text("anonymously pls");
  assert.deepEqual(usgAsides().map((n) => [n.step, n.decision, n.behind?.numbers]), [["usg_sent", "steps_back", { committee: DINING_COMMITTEE, topic: "dining", studentsSharingIt: 1 }]]);
  assert.ok(!JSON.stringify(demo.asides).includes("Tess"), "a name is never handed over");

  // Someone else raises the same thing: the aside says how many share it now.
  demo.reset();
  const b = t.student("+13235550302");
  const reply = await b.text("usc should really have more vegetarian options at evk");
  const others = Number(reply[0]!.match(/^(\d+) other/)![1]);
  assert.deepEqual(usgAsides().map((n) => [n.step, n.decision, n.behind?.numbers]), [["usg_joined", "texts_first", { studentsSharingIt: others + 1, committee: DINING_COMMITTEE }]]);
  assert.equal(others + 1, 2);
});

test("a plain program answer gets no aside: the stored text is the whole reply", async () => {
  demo.reset();
  const t = setup();
  const a = t.student("+13235550303");
  await a.text("how does my club get funding");
  assert.equal(demo.asides.length, 0);
  assert.equal(demo.offers.length, 0);
});

test("simulation: with no usg member assigned, a judge is offered the member's side; a student in a live pilot just waits", async () => {
  demo.reset();
  demo.accept = true;
  const t = setup();
  const judge = t.student("+13235550304");
  await judge.text("usc should have more vegetarian options at evk");
  const reply = await judge.text("with my name");
  assert.equal(reply[0], `sent to the ${DINING_COMMITTEE}. i'll text u when they pick it up.`);
  assert.deepEqual(demo.offers.map((o) => [o.kind, o.context.committee, o.context.topic, o.context.anonymous]), [["usg", DINING_COMMITTEE, "dining", "no"]]);
  assert.equal(judge.state()?.step, "sim_offer");
  assert.equal(demo.asides.length, 0, "no aside stacked on the offer");
  assert.equal(t.mine().length, 1, "the concern itself is real and on the dashboard");
  // A typed yes is the simulation's.
  demo.consume = true;
  assert.deepEqual(await judge.text("yes"), [SIM_LINE]);

  // Two real students: neither is ever shown a simulation.
  demo.reset();
  demo.accept = true;
  const t2 = setup();
  const s1 = t2.student("+13235550305");
  const s2 = t2.student("+13235550306");
  for (const s of [s1, s2]) updateUser(t2.db, s.id, { verifiedVia: "usc_email" });
  await s1.text("usc should have more vegetarian options at evk");
  const waited = await s1.text("anonymously pls");
  assert.equal(demo.offers.length, 0);
  assert.equal(waited[0], `sent to the ${DINING_COMMITTEE}. i'll text u when they pick it up.`);
  assert.equal(s1.state(), null);

  // One real student and nobody else: offered.
  demo.reset();
  demo.accept = true;
  const t3 = setup();
  const only = t3.student("+13235550307");
  updateUser(t3.db, only.id, { verifiedVia: "usc_email" });
  await only.text("usc should have more vegetarian options at evk");
  await only.text("anonymously pls");
  assert.deepEqual(demo.offers.map((o) => [o.kind, o.context.anonymous]), [["usg", "yes"]]);
});
