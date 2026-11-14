import { test } from "node:test";
import assert from "node:assert/strict";
import type { FlowHandler, Intent, MessagingAdapter } from "../src/types.ts";
import { openDb, getOrCreateUser, getFlowState, updateUser } from "../src/db/index.ts";
import { seed } from "../src/db/seed.ts";
import { createPipeline } from "../src/pipeline.ts";
import { registerFlow } from "../src/flows/index.ts";
import { fallbackIntent, setModelCall } from "../src/ai.ts";
import { usg, ASK_NAME, isConcern, parseChoice, topicFromWords, EXPLAIN_NAME } from "../src/flows/usg.ts";
import { sentenceBubbles } from "../src/flows/reports-shared.ts";

/**
 * What was said, whatever bubbles it arrived in. The pipeline splits long bubbles at a comma or a space
 * (and drops the comma there), so the words are compared, not the bubble edges.
 */
const said = (bubbles: (string | null)[]): string => bubbles.filter(Boolean).join(" ").replace(/[\s,]+/g, " ").trim();

const DINING_COMMITTEE = "USG Committee on Sustainability and Campus Infrastructure";

type Report = { id: number; userId: number; anonymous: number; category: string; description: string; routedTo: string; status: string; followers: string; isExample: number };
type Dir = { name: string; details: string; url: string | null; isExample: number };

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
  return { db, student, reports, mine, dir, allUrls };
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

test("a similar open concern is joined as a follower: no new row and no question", async () => {
  const t = setup();
  // Example rows are never joined, so treat the seeded concerns as real here.
  t.db.prepare("UPDATE reports SET isExample = 0").run();
  const before = t.reports().length;
  const seeded = t.reports().find((r) => r.category === "dining" && r.status === "received")!;
  const a = t.student("+13235550007");
  const reply = await a.text("why does village dining close so early");
  assert.ok(!reply.includes(ASK_NAME));
  assert.match(reply[0], new RegExp(`^\\d+ others? (?:person )?already sent that to the ${DINING_COMMITTEE}`));
  assert.equal(t.reports().length, before);
  const after = t.reports().find((r) => r.id === seeded.id)!;
  assert.ok((JSON.parse(after.followers) as number[]).includes(a.id));
  assert.equal(a.state(), null);
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
