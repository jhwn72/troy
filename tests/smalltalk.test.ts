import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { Bubble, FlowContext, FlowHandler, IncomingEvent, Intent, MessagingAdapter } from "../src/types.ts";
import { getFlowState, getOrCreateUser, openDb, saveMessage, setFlowState, updateUser } from "../src/db/index.ts";
import { config } from "../src/config.ts";
import { setModelCall } from "../src/ai.ts";
import type { AskOpts } from "../src/ai.ts";
import { createPipeline } from "../src/pipeline.ts";
import { getFlow, registerFlow } from "../src/flows/index.ts";
import { FALLBACK_POOLS, LOOKUP_ACKS, STUMP_INVITES, chatReply, fallbackReply, readHandoff, readLookup, setQuickLookup, situationOf, smalltalk, stumpInvite } from "../src/flows/smalltalk.ts";
import { asksSomething, chatSystem, getChatHealth, isCapabilityList, markHeavy, moveUsed, stumpOpen } from "../src/brain.ts";
import { countEmoji } from "../src/voice.ts";

// No test may reach the network.
config.anthropicKey = "";
const realRepair = getFlow("repair")!;
afterEach(() => {
  setModelCall(null);
  setQuickLookup(null);
  registerFlow(realRepair);
  delete process.env.TROY_CHAT_MODEL;
  delete process.env.TROY_LOOKUP;
});

const CHAT = "chat-s";
let n = 0;

function setup(text: string, opts: { intent?: Intent } = {}) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO directory (kind, name, topics, contactMethod, url, details) VALUES ('usg_program', 'USG RSO funding', ?, 'usgfunds@usc.edu', 'https://usg.usc.edu/branches/funding/', 'apps are due wednesdays by 11:59pm.')").run(JSON.stringify(["club funding", "funding"]));
  const user = getOrCreateUser(db, `+1213555${String(1000 + ++n)}`, CHAT);
  const event: IncomingEvent = { provider: "webchat", userHandle: user.handle, chatId: CHAT, isGroup: false, messageId: `in-${n}`, text, images: [], receivedAt: Date.now() };
  saveMessage(db, { userId: user.id, chatId: CHAT, direction: "in", providerMessageId: event.messageId, text });
  const said: string[] = [];
  const ctx: FlowContext = {
    db,
    user,
    event,
    intent: opts.intent ?? { flow: "smalltalk", action: "chat", details: {}, source: "fallback" },
    state: null,
    adapter: {} as MessagingAdapter,
    async say(...bubbles: (string | Bubble)[]) {
      for (const b of bubbles) said.push(typeof b === "string" ? b : b.text);
      return bubbles.map(() => null);
    },
    sayTo: async (_id, ...b) => b.map(() => null),
    sayToOwed: async (_id, ...b) => b.map(() => null),
    setState: (s) => setFlowState(db, user.id, s),
    setStateFor: (id, s) => setFlowState(db, id, s),
  };
  return { db, user, event, ctx, said };
}

/** A fake model that answers each call with the next reply in the list and records what it was asked. */
function model(...replies: (string | Error)[]) {
  const calls: AskOpts[] = [];
  setModelCall(async (opts) => {
    calls.push(opts);
    const next = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    if (next instanceof Error) throw next;
    return next;
  });
  return calls;
}

const reply = (bubbles: string[], handoff: unknown = null) => JSON.stringify({ bubbles, handoff });

// ---------- the model path ----------

test("a free message gets one model call: the stable brain as a cached system prompt, the context in the user turn", async () => {
  process.env.TROY_CHAT_MODEL = "fast";
  const s = setup("whats the best dining hall");
  const calls = model(reply(["Parkside gets my vote", "Village looks the coolest tho 👀"]));
  await smalltalk.handle(s.ctx);
  assert.deepEqual(s.said, ["parkside gets my vote", "village looks the coolest tho 👀"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, "fast");
  assert.equal(calls[0]!.cacheSystem, true);
  assert.equal(calls[0]!.system, chatSystem());
  // Nothing about this student or this message is in the cached part.
  assert.ok(!calls[0]!.system.includes("their new message") && !calls[0]!.system.includes(s.user.handle));
  assert.match(calls[0]!.prompt, /their new message: "whats the best dining hall"/);
  // Same system text for a different person and message.
  const other = setup("i hate my roommate lol");
  const more = model(reply(["lol what did they do"]));
  await smalltalk.handle(other.ctx);
  assert.equal(more[0]!.system, calls[0]!.system);
});

test("TROY_CHAT_MODEL picks the model", async () => {
  process.env.TROY_CHAT_MODEL = "smart";
  const s = setup("hey");
  const calls = model(reply(["hey. what's going on"]));
  await smalltalk.handle(s.ctx);
  assert.equal(calls[0]!.model, "smart");
  process.env.TROY_CHAT_MODEL = "fast";
  const t = setup("hey");
  const again = model(reply(["hey"]));
  await smalltalk.handle(t.ctx);
  assert.equal(again[0]!.model, "fast");
});

test("the conversation so far reaches the model oldest first, capped at 15", async () => {
  const s = setup("ok it went fine actually");
  s.db.prepare("DELETE FROM messages").run();
  for (let i = 1; i <= 22; i++) saveMessage(s.db, { userId: s.user.id, chatId: CHAT, direction: i % 2 ? "in" : "out", providerMessageId: `h-${i}`, text: `line ${i}` });
  saveMessage(s.db, { userId: s.user.id, chatId: CHAT, direction: "in", providerMessageId: s.event.messageId, text: s.event.text });
  const calls = model(reply(["knew it. nice"]));
  await smalltalk.handle(s.ctx);
  const prompt = calls[0]!.prompt;
  const lines = prompt.split("\n").filter((l) => /^(?:them|troy): line \d+$/.test(l));
  assert.deepEqual(lines.map((l) => Number(l.match(/\d+/)![0])), Array.from({ length: 15 }, (_, i) => i + 8));
  assert.equal(lines[0], "troy: line 8");
  assert.equal(lines[14], "troy: line 22");
  assert.ok(!prompt.includes("line 7\n"));
  assert.ok(!prompt.includes("them: ok it went fine actually"));
});

test("looked-up directory rows go to the model with their stored strings, and only their links get through", async () => {
  // A statement, not a question: a plain question about a program goes to the usg flow (tests/chat-safety.test.ts).
  const s = setup("my club needs funding so bad");
  const calls = model(reply(["usg funds student orgs", "apps go here: https://usg.usc.edu/branches/funding/"]));
  await smalltalk.handle(s.ctx);
  assert.ok(calls[0]!.prompt.includes("https://usg.usc.edu/branches/funding/"));
  assert.ok(calls[0]!.prompt.includes("usgfunds@usc.edu"));
  assert.ok(calls[0]!.prompt.includes("apps are due wednesdays by 11:59pm."));
  assert.deepEqual(s.said, ["usg funds student orgs", "apps go here: https://usg.usc.edu/branches/funding/"]);

  // The same link with no matching row is an invented link: rejected, retried, then the fallback.
  const t = setup("whats the best dining hall");
  const more = model(reply(["check https://usg.usc.edu/branches/funding/"]), reply(["try https://dining.usc.edu"]));
  await smalltalk.handle(t.ctx);
  assert.equal(more.length, 2);
  assert.ok(t.said.length >= 1);
  assert.ok(!t.said.join(" ").includes("http"));
});

test("a rejected reply is retried once with the reason, and the second try is sent", async () => {
  const s = setup("im so stressed about my econ midterm tmrw");
  const calls = model(
    reply(["that's rough", "i can help with lost or found stuff, free food, broken things on campus, or who to talk to about a campus issue"]),
    reply(["Econ the night before is rough 😭", "How much do you have left?"]),
  );
  await smalltalk.handle(s.ctx);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[0]!.prompt, /was not sent/);
  assert.match(calls[1]!.prompt, /your last reply was not sent: don't list what troy can help with/);
  assert.equal(calls[1]!.system, calls[0]!.system);
  assert.deepEqual(s.said, ["econ the night before is rough", "how much do u have left?"]);
  assert.equal(countEmoji(s.said.join("")), 0);
});

test("two rejected replies fall back to a hand-written line, never the capability list", async () => {
  const s = setup("im so stressed about my econ midterm tmrw");
  const calls = model(reply(["hey, i'm troy, an ai that connects usc students to the right people, offices and items."]));
  await smalltalk.handle(s.ctx);
  assert.equal(calls.length, 2);
  assert.equal(s.said.length, 1);
  assert.ok(FALLBACK_POOLS.vent.includes(s.said[0]!));
  assert.equal(isCapabilityList(s.said), false);
});

test("no answer from the model means one call and the fallback", async () => {
  const s = setup("thanks troy");
  const calls = model(new Error("down"));
  await smalltalk.handle(s.ctx);
  assert.equal(calls.length, 1);
  assert.ok(FALLBACK_POOLS.thanks.includes(s.said.join("|")));
});

test("a fast answer that isn't the JSON asked for gets one more try, then the fallback", async () => {
  const s = setup("thanks troy");
  const calls = model("lol not json");
  await smalltalk.handle(s.ctx);
  assert.equal(calls.length, 2);
  assert.ok(FALLBACK_POOLS.thanks.includes(s.said.join("|")));
});

test("bubbles sent back as a bare list are still his reply", async () => {
  const s = setup("thanks troy");
  const calls = model('["anytime", "that\'s what i\'m here for"]');
  await smalltalk.handle(s.ctx);
  assert.equal(calls.length, 1);
  assert.deepEqual(s.said, ["anytime", "that's what i'm here for"]);
});

// ---------- handoff ----------

test("a handoff routes the message to the named flow instead of replying", async () => {
  const s = setup("ugh the sink in my dorm wont stop dripping its so annoying");
  const got: { intent: Intent; text: string }[] = [];
  const stub: FlowHandler = {
    name: "repair",
    async handle(ctx) {
      got.push({ intent: ctx.intent, text: ctx.event.text });
      await ctx.say("on it. which building?");
    },
  };
  registerFlow(stub);
  const calls = model(reply(["this should never be sent"], { flow: "repair", action: "report", reason: "a broken sink" }));
  await smalltalk.handle(s.ctx);
  assert.equal(calls.length, 1);
  assert.deepEqual(s.said, ["on it. which building?"]);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.intent.flow, "repair");
  assert.equal(got[0]!.intent.action, "report");
  assert.equal(got[0]!.intent.source, "ai");
  assert.equal(got[0]!.text, s.event.text);
});

test("a handoff uses the keyword rules' action and details when they agree on the flow", async () => {
  const s = setup("i think i left my black airpods at leavey");
  const seen: Intent[] = [];
  const real = getFlow("lost_found")!;
  registerFlow({ name: "lost_found", handle: async (ctx) => void (seen.push(ctx.intent), await ctx.say("ok")) });
  try {
    model(reply([], { flow: "lost_found", action: "report_found", reason: "lost airpods" }));
    await smalltalk.handle(s.ctx);
  } finally {
    registerFlow(real);
  }
  assert.equal(seen[0]!.action, "report_lost");
  assert.equal(seen[0]!.details.category, "earbuds");
  assert.equal(seen[0]!.details.color, "black");
  assert.equal(seen[0]!.details.place, "leavey");
});

test("handoffs to unknown flows or actions are ignored or defaulted", () => {
  assert.equal(readHandoff(null), null);
  assert.equal(readHandoff({ flow: "smalltalk" }), null);
  assert.equal(readHandoff({ flow: "onboarding", action: "x" }), null);
  assert.equal(readHandoff({ flow: "constructor" }), null);
  assert.equal(readHandoff("repair"), null);
  assert.deepEqual(readHandoff({ flow: "usg", action: "concern" }), { flow: "usg", action: "concern" });
  assert.deepEqual(readHandoff({ flow: "food", action: "make_dinner" }), { flow: "food", action: "status" });
  assert.deepEqual(readHandoff({ flow: "lost_found" }), { flow: "lost_found", action: "report_lost" });
});

test("a flow that hands the message straight back gets a chat reply, not a loop", async () => {
  const s = setup("the vibes in parkside are broken lol");
  let visits = 0;
  registerFlow({
    name: "repair",
    async handle(ctx) {
      visits++;
      // Not ours after all: back to free chat, the way the real flows do it.
      await getFlow("smalltalk")!.handle({ ...ctx, state: null, intent: { flow: "smalltalk", action: "chat", details: {}, source: "ai" } });
    },
  });
  const calls = model(reply([], { flow: "repair", action: "report", reason: "broken" }), reply(["lol parkside has its moments"], { flow: "repair", action: "report" }));
  await smalltalk.handle(s.ctx);
  assert.equal(visits, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(s.said, ["lol parkside has its moments"]);
});

test("a handoff to a flow that stays silent still gets an answer", async () => {
  const s = setup("something something rides");
  registerFlow({ name: "repair", handle: async () => {} });
  const calls = model(reply([], { flow: "repair", action: "report" }), reply(["say a little more?"]));
  await smalltalk.handle(s.ctx);
  assert.equal(calls.length, 2);
  assert.deepEqual(s.said, ["say a little more?"]);
  // A silent flow that opened its own step has taken the message: nothing more is said.
  const t = setup("the thing by the door");
  registerFlow({ name: "repair", handle: async (ctx) => ctx.setState({ flow: "repair", step: "ask_where", data: {} }) });
  const more = model(reply([], { flow: "repair", action: "report" }));
  await smalltalk.handle(t.ctx);
  assert.equal(more.length, 1);
  assert.deepEqual(t.said, []);
  assert.equal(getFlowState(t.db, t.user.id)?.flow, "repair");
});

test("through the pipeline: intent detection says chat, the chat model hands off, the flow answers", async () => {
  const db = openDb(":memory:");
  const sent: string[] = [];
  const adapter = {
    provider: "webchat",
    capabilities: () => ({ tapbacks: false, typing: true, readReceipts: true, edits: false, effects: false, polls: false, groupChats: false, contactCard: false, liveLocation: false }),
    sendMessage: async (_c: string, text: string) => (sent.push(text), { messageId: `o-${sent.length}` }),
    markRead: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    react: async () => false,
  } as unknown as MessagingAdapter;
  registerFlow({ name: "repair", handle: async (ctx) => void (await ctx.say("got it, sending that to the right people")) });
  const pipeline = createPipeline({ db, getAdapter: () => adapter, pause: async () => {}, ackAfterMs: 5000, detectIntent: async () => ({ flow: "smalltalk", action: "chat", details: {}, source: "ai" }) });
  const user = getOrCreateUser(db, "+12135559001", "chat-pipe");
  updateUser(db, user.id, { verifiedAt: Date.now(), verifiedVia: "judge_skip" });
  const send = (text: string, id: string) => pipeline.handleEvent({ provider: "webchat", userHandle: user.handle, chatId: "chat-pipe", isGroup: false, messageId: id, text, images: [], receivedAt: Date.now() });

  const calls = model(reply(["lol what did they do this time"]), reply([], { flow: "repair", action: "report" }));
  await send("i hate my roommate lol", "p1");
  assert.deepEqual(sent, ["lol what did they do this time"]);
  await send("they broke the door handle in our room", "p2");
  assert.deepEqual(sent.slice(1), ["got it, sending that to the right people"]);
  // The second call saw the first exchange, oldest first.
  const p = calls[1]!.prompt;
  assert.ok(p.indexOf("them: i hate my roommate lol") !== -1);
  assert.ok(p.indexOf("them: i hate my roommate lol") < p.indexOf("troy: lol what did they do this time"));
});

// ---------- fallbacks ----------

test("with no model the reply fits the situation and is never the capability list", async () => {
  const cases: [string, keyof typeof FALLBACK_POOLS][] = [
    ["hey", "greeting"],
    ["yo troy", "greeting"],
    ["thanks troy", "thanks"],
    ["ty!!", "thanks"],
    ["i hate my roommate lol", "vent"],
    ["im so stressed about my econ midterm tmrw", "vent"],
    ["whats the best dining hall", "question"],
    ["is leavey open rn?", "question"],
    ["thats fire lol", "unclear"],
    ["", "unclear"],
    ["what can u do", "what_he_does"],
    ["are you a real person", "who_he_is"],
    ["what data do u keep on me", "about_troy"],
    ["can john read my texts", "about_troy"],
    ["u suck", "insult"],
  ];
  for (const [text, want] of cases) {
    assert.equal(situationOf(text), want, text);
    const s = setup(text);
    await smalltalk.handle(s.ctx);
    assert.ok(FALLBACK_POOLS[want].includes(s.said.join("|")), `${text} -> ${s.said.join("|")}`);
    assert.equal(isCapabilityList(s.said), want === "what_he_does", text);
  }
});

test("the fallback pools are hand-written in troy's voice", () => {
  const everything = new Set<string>();
  for (const [name, pool] of Object.entries(FALLBACK_POOLS)) {
    assert.ok(pool.length >= 4 && pool.length <= 6, `${name} has ${pool.length}`);
    for (const line of pool) {
      assert.ok(!everything.has(line), `repeated line: ${line}`);
      everything.add(line);
      assert.equal(line, line.toLowerCase(), line);
      assert.doesNotMatch(line, /[—–]|\b(?:you|your|you're)\b/, line);
      for (const bubble of line.split("|")) {
        assert.ok(bubble.length <= 160, bubble);
        assert.ok(countEmoji(bubble) <= 1, bubble);
      }
      if (name !== "what_he_does") assert.equal(isCapabilityList(line.split("|")), false, line);
      if (name !== "who_he_is") assert.doesNotMatch(line, /\bi'm troy\b|\btroy here\b/, line);
    }
  }
  // Vent lines carry no emoji, no jokes and no counselor words.
  for (const line of FALLBACK_POOLS.vent) {
    assert.equal(countEmoji(line), 0);
    assert.doesNotMatch(line, /\b(?:carry|carrying|burden|weight|heavy|valid|navigate|process|journey|space)\b/, line);
  }
  // A question about himself or their privacy never gets an "idk": it points to the commands that answer without the model, in quotes.
  for (const line of FALLBACK_POOLS.about_troy) {
    assert.doesNotMatch(line, /\bidk\b|not sure|no real person/, line);
    assert.match(line, /"(?:what do u know about me|settings|delete my data)"/, line);
  }
  // The heavy line always carries a way to reach a real person, and never a joke.
  for (const line of FALLBACK_POOLS.heavy) {
    assert.match(line, /988/, line);
    assert.equal(countEmoji(line), 0);
    assert.doesNotMatch(line, /\blol\b|\bha\b/, line);
  }
  assert.ok(!FALLBACK_POOLS.who_he_is.some((l) => /no real person is reading/.test(l)));
});

test("fallback lines rotate per person and never repeat twice in a row", () => {
  const db: DatabaseSync = openDb(":memory:");
  for (const text of ["hey", "thanks", "i hate my roommate lol", "whats the best dining hall", "hmm"]) {
    const seen: string[] = [];
    for (let i = 0; i < 14; i++) seen.push(fallbackReply(db, 3, text).join("|"));
    for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1], text);
    assert.equal(new Set(seen).size, FALLBACK_POOLS[situationOf(text)].length, "every line in the pool gets used");
  }
  // Each person has their own place in the rotation.
  const a = [fallbackReply(db, 10, "hey"), fallbackReply(db, 10, "hey")].map((b) => b.join("|"));
  const b = [fallbackReply(db, 11, "hey"), fallbackReply(db, 11, "hey")].map((x) => x.join("|"));
  assert.notEqual(a[0], a[1]);
  assert.notEqual(b[0], b[1]);
  assert.notEqual(a[0], b[0]);
});

test("chatReply reports where the reply came from", async () => {
  const s = setup("hey");
  assert.equal((await chatReply({ db: s.db, ctx: s.ctx })).source, "fallback");
  model(reply(["hey. what's going on"]));
  assert.deepEqual(await chatReply({ db: s.db, ctx: s.ctx }), { bubbles: ["hey. what's going on"], handoff: null, source: "model" });
  model(reply([], { flow: "usg", action: "concern" }));
  assert.deepEqual(await chatReply({ db: s.db, ctx: s.ctx }), { bubbles: [], handoff: { flow: "usg", action: "concern" }, source: "model" });
  assert.equal((await chatReply({ db: s.db, ctx: s.ctx, allowHandoff: false })).source, "fallback");
});

// ---------- quick lookup ----------

const FOUND = { answer: "guests sign in at the front desk with a photo id. up to 2 overnight guests.", sourceUrl: "https://housing.usc.edu/guests/", sourceTitle: "usc housing guest policy" };
const LOOKUP = JSON.stringify({ bubbles: [], handoff: null, lookup: "usc housing overnight guest policy" });

test("a factual campus question with no directory row gets one lookup, and he answers from it with its one link", async () => {
  const s = setup("whats the guest policy for the dorms");
  const asked: { question: string; userId: number }[] = [];
  setQuickLookup(async (q) => (asked.push({ question: q.question, userId: q.userId }), FOUND));
  const calls = model(LOOKUP, reply(["Looks like guests sign in at the front desk with a photo ID, going by the USC housing guest policy. double check tho", "https://housing.usc.edu/guests/"]));
  await smalltalk.handle(s.ctx);
  assert.match(calls[0]!.prompt, /quick lookup: available/);
  // The search is the model's short generic topic, never the student's own string.
  assert.deepEqual(asked, [{ question: "usc housing overnight guest policy", userId: s.user.id }]);
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.prompt, /quick lookup result/);
  assert.ok(calls[1]!.prompt.includes(FOUND.sourceUrl));
  assert.doesNotMatch(calls[1]!.prompt, /quick lookup: available/);
  assert.equal(calls[1]!.system, calls[0]!.system);
  // It came back fast, so no "lemme check" went out.
  assert.deepEqual(s.said, ["looks like guests sign in at the front desk with a photo id, going by the usc housing guest policy. double check tho", "https://housing.usc.edu/guests/"]);
});

test("a slow lookup gets a short lemme check first, and the reply still stays short", async () => {
  const s = setup("whats the guest policy for the dorms");
  setQuickLookup(async () => (await new Promise((r) => setTimeout(r, 60)), FOUND), 10);
  model(LOOKUP, reply(["one", "two", "https://housing.usc.edu/guests/"]), reply(["front desk sign in with a photo id, per usc housing. double check", "https://housing.usc.edu/guests/"]));
  await smalltalk.handle(s.ctx);
  assert.ok(LOOKUP_ACKS.includes(s.said[0]!), s.said[0]);
  assert.deepEqual(s.said.slice(1), ["front desk sign in with a photo id, per usc housing. double check", "https://housing.usc.edu/guests/"]);
  for (const line of LOOKUP_ACKS) {
    assert.equal(line, line.toLowerCase());
    assert.doesNotMatch(line, /\b(?:you|your)\b/);
  }
});

test("a second link, or a link that isn't the lookup's, never gets out", async () => {
  const s = setup("whats the guest policy for the dorms");
  setQuickLookup(async () => FOUND);
  const calls = model(LOOKUP, reply(["sign in at the front desk, double check", "https://housing.usc.edu/guests/ or https://usc.edu/guests"]), reply(["sign in at the front desk, double check", "https://bit.ly/usc-guests"]));
  await smalltalk.handle(s.ctx);
  assert.equal(calls.length, 3);
  assert.match(calls[2]!.prompt, /only the lookup's own link/);
  assert.ok(!s.said.join(" ").includes("http"));
});

test("an empty lookup means an honest idk, and the lookup is never offered when it shouldn't be", async () => {
  // Nothing found: he is told so and answers without a number or a link.
  const s = setup("whats the guest policy for the dorms");
  let runs = 0;
  setQuickLookup(async () => (runs++, null));
  const calls = model(LOOKUP, reply(["not sure on that one tbh. housing would know"]));
  await smalltalk.handle(s.ctx);
  assert.equal(runs, 1);
  assert.match(calls[1]!.prompt, /found nothing usable/);
  assert.deepEqual(s.said, ["not sure on that one tbh. housing would know"]);

  // Switched off (the default): the model is never told a lookup exists, and a request for one runs nothing.
  setQuickLookup(null);
  const off = setup("whats the guest policy for the dorms");
  const quiet = model(LOOKUP, reply(["not sure, housing would know"]));
  await smalltalk.handle(off.ctx);
  assert.doesNotMatch(quiet[0]!.prompt, /quick lookup: available/);
  assert.deepEqual(off.said, ["not sure, housing would know"]);

  // A directory row matched: the lookup is only offered for when that row doesn't answer it, and answering from
  // the row runs nothing. A heavy conversation, a frightened message: no lookup at all.
  setQuickLookup(async () => (runs++, FOUND));
  runs = 0;
  const row = setup("my club needs funding so bad");
  const r = model(reply(["usg funds student orgs"]));
  await smalltalk.handle(row.ctx);
  assert.match(r[0]!.prompt, /quick lookup: available, but only if none of the looked up rows above answers/);
  assert.equal(runs, 0);
  const heavy = setup("whats the guest policy for the dorms");
  markHeavy(heavy.db, heavy.user.id);
  const h = model(LOOKUP, reply(["not sure on that one. how are u holding up"]));
  await smalltalk.handle(heavy.ctx);
  assert.doesNotMatch(h[0]!.prompt, /quick lookup: available/);
  const scared = setup("im so scared rn where is the counseling office");
  const sc = model(reply(["that sounds scary. are u somewhere safe right now"]));
  await smalltalk.handle(scared.ctx);
  assert.doesNotMatch(sc[0]!.prompt, /quick lookup: available/);
  assert.equal(runs, 0);

  // What a lookup is never for, whatever the model asks.
  for (const bad of ["how many tylenol is too many", "is tyler from sig ep cheating rumor", "troy verification how many tries", "jtrojan@usc.edu password", "12345678 student id", "x", null, 7]) assert.equal(readLookup(bad), null, String(bad));
  assert.equal(readLookup("  USC  parking permit price "), "usc parking permit price");
});

// ---------- heavy, and the counter ----------

test("with no model a heavy conversation gets the gentle line with a way to reach a person, whatever the words", async () => {
  for (const text of ["yeah", "lol", "what can u do", "thanks"]) {
    const s = setup(text);
    markHeavy(s.db, s.user.id);
    await smalltalk.handle(s.ctx);
    assert.ok(FALLBACK_POOLS.heavy.includes(s.said.join("|")), `${text} -> ${s.said.join("|")}`);
  }
  // The pipeline can also flag the one message; that sticks.
  const s = setup("idk", { intent: { flow: "smalltalk", action: "chat", details: { heavy: true }, source: "ai" } });
  const calls = model(reply(["i'm here. what's going on 💛"]));
  await smalltalk.handle(s.ctx);
  assert.match(calls[0]!.prompt, /this conversation is heavy/);
  assert.deepEqual(s.said, ["i'm here. what's going on"]);
  setModelCall(null);
  assert.ok(FALLBACK_POOLS.heavy.includes(fallbackReply(s.db, s.user.id, "ok", { heavy: true }).join("|")));
});

test("a reply rejected twice is counted", async () => {
  const s = setup("im so stressed about my econ midterm tmrw");
  assert.equal(getChatHealth(s.db).doubleRejectsToday, 0);
  model(reply(["hey, i'm troy, an ai that connects usc students to the right people, offices and items."]));
  await smalltalk.handle(s.ctx);
  assert.equal(getChatHealth(s.db).doubleRejectsToday, 1);
  // A model that is simply down is not a rejection.
  model(new Error("down"));
  await smalltalk.handle(s.ctx);
  assert.equal(getChatHealth(s.db).doubleRejectsToday, 1);
});

// ---------- stump me ----------

test("stump me: the dare goes out in his words, counts as used, and the next message is their attempt", async () => {
  // No model: a rotated hand-written dare.
  const s = setup("stump me");
  await smalltalk.handle(s.ctx);
  assert.ok(STUMP_INVITES.some((v) => v.join("|") === s.said.join("|")), s.said.join("|"));
  assert.equal(moveUsed(s.db, s.user.id, "stump"), true);
  assert.equal(stumpOpen(s.db, s.user.id), true);
  for (const v of STUMP_INVITES) for (const b of v) assert.equal(b, b.toLowerCase());

  // From the try-me poll (the pipeline hands it over as an action), with the model writing it.
  const t = setup("", { intent: { flow: "smalltalk", action: "stump", details: {}, source: "fallback" } });
  const calls = model(JSON.stringify({ bubbles: ["ok try me. name any campus problem and i'll tell u who handles it"], covers: ["name any campus problem", "i'll tell u who handles it"] }));
  await smalltalk.handle(t.ctx);
  assert.equal(calls.length, 1);
  assert.deepEqual(t.said, ["ok try me. name any campus problem and i'll tell u who handles it"]);

  // What they name next reaches the model with the dare marked open and the matching row looked up.
  const u = setup("ok try this one: club funding");
  await stumpInvite(u.ctx);
  const next = model(reply(["too easy. usg funds student orgs", "https://usg.usc.edu/branches/funding/"]));
  u.said.length = 0;
  await smalltalk.handle(u.ctx);
  assert.match(next[0]!.prompt, /troy just dared them to stump him/);
  assert.match(next[0]!.prompt, /moves this person has already seen \(never make one again\): stump me/);
  assert.deepEqual(u.said, ["too easy. usg funds student orgs", "https://usg.usc.edu/branches/funding/"]);

  // When he makes the dare himself in a casual chat, it counts as used too.
  const v = setup("what can u do");
  model(reply(["easier to show u. name any campus problem and i'll say who handles it"]));
  await smalltalk.handle(v.ctx);
  assert.equal(moveUsed(v.db, v.user.id, "stump"), true);
  // An ordinary reply uses nothing up.
  const w = setup("hey");
  model(reply(["hey. what's going on"]));
  await smalltalk.handle(w.ctx);
  assert.equal(moveUsed(w.db, w.user.id, "stump"), false);
});

test("handoffs to topics, rides and the tour are understood", () => {
  assert.deepEqual(readHandoff({ flow: "topics", action: "post" }), { flow: "topics", action: "post" });
  assert.deepEqual(readHandoff({ flow: "topics", action: "nope" }), { flow: "topics", action: "follow" });
  assert.deepEqual(readHandoff({ flow: "rides" }), { flow: "rides", action: "find" });
  assert.deepEqual(readHandoff({ flow: "tour", action: "start" }), { flow: "tour", action: "start" });
});

test("a topics handoff on the model's word alone carries no action of its own", async () => {
  const s = setup("everyone on my floor is so loud at night");
  const seen: Intent[] = [];
  const real = getFlow("topics");
  registerFlow({ name: "topics", handle: async (ctx) => void (seen.push(ctx.intent), await ctx.say("ok")) });
  try {
    model(reply([], { flow: "topics", action: "post" }));
    await smalltalk.handle(s.ctx);
  } finally {
    if (real) registerFlow(real);
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.action, "from_chat");
  assert.equal(seen[0]!.details.unconfirmed, true);
});

// ---------- new and untried: he pulls ----------

test("new and untried: 'ok' gets his next move with no model call, and a move the model makes in its own words counts as made", async () => {
  const { afterOnboarding, isUntried, hasMove, setFirstTenDeps } = await import("../src/firstten.ts");
  const { moveUsed } = await import("../src/brain.ts");
  setFirstTenDeps({ timers: false });
  const withPoll = (s: ReturnType<typeof setup>) => {
    s.ctx.adapter = { sendPoll: async (_c: string, _q: string, options: string[]) => ({ optionMessageIds: options.map(() => "poll-1"), mode: "native" as const }) } as unknown as MessagingAdapter;
    return s;
  };
  try {
    // A bare "ok" from someone who just finished setup: the tour offer, from code, with no model call.
    const a = withPoll(setup("ok"));
    await afterOnboarding(a.ctx);
    a.said.length = 0;
    const calls = model(reply(["bet, no rush"]));
    calls.length = 0;
    setModelCall(null);
    await smalltalk.handle(a.ctx);
    assert.equal(a.said.length, 1);
    assert.match(a.said[0]!, /pretend u lost something/);
    assert.match(a.said[0]!, /\?$/);
    assert.ok(hasMove(a.db, a.user.id, "tour_offer"));

    // The model is told, its sign-off is refused, and the retry that offers the run goes out and counts as the offer.
    const b = withPoll(setup("so what now"));
    await afterOnboarding(b.ctx);
    b.said.length = 0;
    const asked = model(reply(["bet, no rush on any of it"]), reply(["lemme show u. pretend u lost something and i'll run the real check on u. down?"]));
    await smalltalk.handle(b.ctx);
    assert.equal(asked.length, 2);
    assert.match(asked[0]!.prompt, /NEW AND UNTRIED/);
    assert.match(asked[1]!.prompt, /sign-off/);
    assert.deepEqual(b.said, ["lemme show u. pretend u lost something and i'll run the real check on u. down?"]);
    assert.ok(moveUsed(b.db, b.user.id, "tour"), "so code never offers it a second time");
    assert.ok(isUntried(b.db, b.user.id), "an offer is not a try");

    // Someone who is not new gets none of this: "ok" is just "ok".
    const c = setup("ok");
    const plain = model(reply(["bet"]));
    await smalltalk.handle(c.ctx);
    assert.deepEqual(c.said, ["bet"]);
    assert.ok(!/NEW AND UNTRIED/.test(plain[0]!.prompt));
  } finally {
    setFirstTenDeps(null);
  }
});

// ---------- a chat never files anything on its own ----------

test("a usg handoff from a chat is marked so the flow only offers, unless the student asked for it to be sent", async () => {
  const realUsg = getFlow("usg")!;
  const seen: Intent[] = [];
  registerFlow({ name: "usg", handle: async (c) => void (seen.push(c.intent), await c.say("ok")) });
  try {
    // Only the model read it as a concern.
    let s = setup("i told them but they didn't do anything");
    model(reply([], { flow: "usg", action: "concern", reason: "an ra who won't act" }));
    await smalltalk.handle(s.ctx);
    // The keyword rules agree it is about dining, but nobody asked for it to go anywhere.
    s = setup("the dining halls close way too early its so annoying");
    model(reply([], { flow: "usg", action: "concern" }));
    await smalltalk.handle(s.ctx);
    // They asked.
    s = setup("can u tell usg the dining halls close too early");
    model(reply([], { flow: "usg", action: "concern" }));
    await smalltalk.handle(s.ctx);
  } finally {
    registerFlow(realUsg);
  }
  assert.deepEqual(seen.map((i) => [i.details.fromChat === true, i.details.meant]), [[true, "concern"], [true, "concern"], [false, undefined]]);
  // The keyword rules' own read goes through untouched, and the flow's rules decide it is a concern ("too early").
  assert.equal(seen[2]!.flow, "usg");
});

test("a yes to an offer troy made in his own words starts the flow without a second offer", async () => {
  const seen: Intent[] = [];
  registerFlow({ name: "repair", handle: async (c) => void (seen.push(c.intent), await c.say("ok")) });
  let s = setup("yes pls");
  saveMessage(s.db, { userId: s.user.id, chatId: CHAT, direction: "out", providerMessageId: null, text: "want me to report that to facilities for u?" });
  model(reply([], { flow: "repair", action: "report" }));
  await smalltalk.handle(s.ctx);
  // A yes after anything else is just a yes.
  s = setup("yes pls");
  saveMessage(s.db, { userId: s.user.id, chatId: CHAT, direction: "out", providerMessageId: null, text: "is the elevator still stuck?" });
  model(reply([], { flow: "repair", action: "report" }));
  await smalltalk.handle(s.ctx);
  assert.deepEqual(seen.map((i) => [i.details.unconfirmed, i.details.accepted]), [[true, true], [true, undefined]]);
});

test("after two questions in a row, the hand-written line is never a third", async () => {
  // No model: this is where "hm, say a little more?" came from.
  for (let i = 0; i < 8; i++) {
    const s = setup("Getting up");
    s.db.prepare("DELETE FROM messages").run();
    for (const [direction, text] of [["out", "what's one thing u wish was easier at usc?"], ["in", "Probably class"], ["out", "what about it?"], ["in", "Getting up"]] as const) {
      saveMessage(s.db, { userId: s.user.id, chatId: CHAT, direction, providerMessageId: direction === "in" && text === "Getting up" ? s.event.messageId : null, text });
    }
    await smalltalk.handle(s.ctx);
    assert.equal(s.said.length, 1);
    assert.ok(FALLBACK_POOLS.heard.includes(s.said[0]!), s.said[0]);
    assert.ok(!asksSomething(s.said[0]!), s.said[0]);
  }
  // With no streak the same text still gets the usual "say more" line.
  const fresh = setup("Getting up");
  await smalltalk.handle(fresh.ctx);
  assert.ok(FALLBACK_POOLS.unclear.includes(fresh.said[0]!));
});

// ---------- tapbacks, serious statements, one-tap offers (John, second live test, Nov 14 8pm) ----------

import { REACTION_EVERY, ackFits, readReaction, seriousComplaint, seriousStatement } from "../src/flows/smalltalk.ts";
import { OFFER_OPTIONS } from "../src/flows/usg.ts";
import { NOBODY_ON, checkReply, othersOnTroy } from "../src/brain.ts";

/** A context whose adapter records tapbacks and polls. */
function withAdapter(s: ReturnType<typeof setup>, opts: { polls?: boolean } = {}) {
  const reacts: { id: string; type: string }[] = [];
  const polls: { question: string; options: string[]; id: string }[] = [];
  let p = 0;
  s.ctx.adapter = {
    provider: "webchat",
    capabilities: () => ({ tapbacks: true, typing: true, readReceipts: true, edits: false, effects: false, polls: !!opts.polls, groupChats: false, contactCard: false, liveLocation: false }),
    react: async (_c: string, id: string, type: string) => (reacts.push({ id, type }), true),
    sendPoll: async (_c: string, question: string, options: string[]) => {
      const id = `poll-${++p}`;
      polls.push({ question, options, id });
      return { optionMessageIds: options.map(() => id), mode: "native" as const };
    },
  } as unknown as MessagingAdapter;
  return { reacts, polls };
}

test("serious statements: complaints, distress and emergencies are serious; jokes and small talk are not", () => {
  for (const t of ["the professors suck and are overpaid", "my ra won't do anything about the noise", "the village shuttles are always late and its ridiculous", "dining hall food is honestly disgusting"]) assert.equal(seriousComplaint(t), true, t);
  for (const t of ["that exam killed me lol", "the professors suck lol", "i hate mondays", "whats the best dining hall", "nice", "my roommate is so funny 😂"]) assert.equal(seriousComplaint(t), false, t);
  assert.equal(seriousStatement("my grandma passed away"), true);
  assert.equal(seriousStatement("lol ok"), false);
});

test("the 'got it' acknowledgement fits only a request, never a statement or something serious", () => {
  assert.equal(ackFits("where can i print on campus?"), true);
  assert.equal(ackFits("can u find me a study group"), true);
  assert.equal(ackFits("anything", { hasImage: true }), true);
  assert.equal(ackFits("the light in taper is broken", { realFlow: true }), true);
  assert.equal(ackFits("the professors suck and are overpaid"), false, "never a thumbs up on a complaint");
  assert.equal(ackFits("the professors suck and are overpaid", { realFlow: true }), false);
  assert.equal(ackFits("my dog died today"), false);
  assert.equal(ackFits("lol nice"), false, "small talk gets no acknowledgement");
  assert.equal(ackFits("how was ur day?"), false, "a casual question is small talk, not a request");
  assert.equal(ackFits("whats ur favorite dining hall?"), false);
  assert.equal(ackFits("would u rather fight one horse sized duck?"), false);
  assert.equal(ackFits("can u believe this weather"), false);
  assert.equal(ackFits("is there free food anywhere rn?"), true);
  assert.equal(ackFits("how do i report a broken light"), true);
});

test("his own tapbacks: only heart, haha or !!, never a thumbs up, and the model's pick is read loosely", () => {
  assert.equal(readReaction("love"), "love");
  assert.equal(readReaction("haha"), "laugh");
  assert.equal(readReaction("!!"), "emphasize");
  assert.equal(readReaction("like"), null);
  assert.equal(readReaction(null), null);
  assert.match(chatSystem(), /"reaction": null/);
});

test("a heart lands on something kind alongside a real answer, and reactions stay rare", async () => {
  const s = setup("ur honestly the best troy, thank u");
  const { reacts } = withAdapter(s);
  model(JSON.stringify({ bubbles: ["anytime, that's what i'm here for"], handoff: null, reaction: "love" }));
  await smalltalk.handle(s.ctx);
  assert.deepEqual(s.said, ["anytime, that's what i'm here for"]);
  assert.deepEqual(reacts, [{ id: s.event.messageId, type: "love" }]);
  // The very next message: he already reacted recently, so no second one even when the model asks.
  for (let i = 0; i < REACTION_EVERY - 1; i++) {
    const id = `in-more-${i}`;
    saveMessage(s.db, { userId: s.user.id, chatId: CHAT, direction: "in", providerMessageId: id, text: "haha ok" });
    s.ctx.event = { ...s.event, messageId: id, text: "haha ok" };
    model(JSON.stringify({ bubbles: ["lol"], handoff: null, reaction: "laugh" }));
    await smalltalk.handle(s.ctx);
  }
  assert.equal(reacts.length, 1, "rare: one per few messages");
});

test("no reaction instead of an answer, and none at all on a serious statement", async () => {
  const s = setup("my grandpa is in the hospital and i can't focus");
  const { reacts } = withAdapter(s);
  model(JSON.stringify({ bubbles: ["i'm really sorry. that's a lot to hold while classes keep going"], handoff: null, reaction: "laugh" }));
  await smalltalk.handle(s.ctx);
  assert.equal(reacts.length, 0, "a haha never lands on something sad");
  assert.ok(s.said.length > 0, "the answer still goes out");
});

test("a real complaint gets one line of acknowledgment and the ask-first offer, never a shrug or a thumbs up", async () => {
  const s = setup("the professors suck and are overpaid");
  const { reacts } = withAdapter(s);
  // The model only shrugs and even picks a reaction: code does his job instead.
  model(JSON.stringify({ bubbles: ["oof that would get to me too"], handoff: null, reaction: "emphasize" }));
  await smalltalk.handle(s.ctx);
  const all = s.said.join(" ");
  assert.ok(!s.said.includes("oof that would get to me too"), all);
  assert.match(all, /\?/);
  assert.match(all, /pass|send|get this in front of|over to/);
  assert.equal(getFlowState(s.db, s.user.id)?.flow, "usg");
  assert.equal(getFlowState(s.db, s.user.id)?.step, "offer");
  assert.equal(reacts.length, 0);
  assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM reports").get() as { n: number }).n, 0, "nothing is filed without a yes");
});

test("a joke about professors is just chat: no offer", async () => {
  const s = setup("the professors suck lol");
  withAdapter(s);
  model(reply(["lol which one"]));
  await smalltalk.handle(s.ctx);
  assert.deepEqual(s.said, ["lol which one"]);
  assert.equal(getFlowState(s.db, s.user.id), null);
});

test("with polls the offer is one tap: name, anonymous or not now, and a vote files it", async () => {
  const s = setup("the dining hall food is honestly disgusting every single day");
  const { polls } = withAdapter(s, { polls: true });
  model(reply(["ugh that's rough"]));
  await smalltalk.handle(s.ctx);
  assert.equal(polls.length, 1);
  assert.deepEqual(polls[0]!.options, OFFER_OPTIONS);
  assert.doesNotMatch(polls[0]!.question, /\btap\b|❤️/);
  assert.match(polls[0]!.question, /\?/);
  const state = getFlowState(s.db, s.user.id)!;
  assert.equal(state.step, "offer");
  const { usg } = await import("../src/flows/usg.ts");
  s.ctx.event = { ...s.event, messageId: "vote-1", text: "", pollVote: { pollMessageId: polls[0]!.id, optionIndex: 1 } };
  s.ctx.state = state;
  s.ctx.intent = { flow: "usg", action: "poll_vote", details: {}, source: "fallback" };
  await usg.handle(s.ctx);
  const row = s.db.prepare("SELECT anonymous FROM reports WHERE kind = 'usg_concern'").get() as { anonymous: number } | undefined;
  assert.ok(row, "filed on the tap");
  assert.equal(row!.anonymous, 1);
});

test("status lines: 'nobody else is on here' is rejected unless the real count is 0", () => {
  const db = openDb(":memory:");
  const me = getOrCreateUser(db, "+12135558801", "c1");
  assert.equal(othersOnTroy(db, me.id), 0);
  const other = getOrCreateUser(db, "+12135558802", "c2");
  updateUser(db, other.id, { verifiedAt: Date.now(), verifiedVia: "judge_skip" });
  assert.equal(othersOnTroy(db, me.id), 1);
  assert.ok(NOBODY_ON.test("nobody else is on me rn"));
  const base = { allowText: "", echoText: "", askedCapabilities: false, askedIdentity: false, noEmoji: false };
  assert.equal(checkReply(["nobody else is on me rn, it's a demo"], { ...base, others: 1 }).ok, false);
  assert.equal(checkReply(["nobody else is on me rn, it's a demo"], { ...base, others: 0 }).ok, true);
  assert.equal(checkReply(["nobody close by rn, but it's posted"], { ...base, others: 3 }).ok, true);
});

import { askPoll } from "../src/flows/reports-shared.ts";

test("askPoll: once the poll went out it never returns null (so the question is not asked again in words)", async () => {
  const db = openDb(":memory:");
  const u = getOrCreateUser(db, "+12135550777", "chat-askpoll");
  const said: string[] = [];
  const ctxWith = (sendPoll: MessagingAdapter["sendPoll"]): FlowContext =>
    ({
      db,
      user: u,
      event: { provider: "webchat", userHandle: u.handle, chatId: u.chatId, isGroup: false, messageId: "m", text: "", images: [], receivedAt: Date.now() },
      adapter: { capabilities: () => ({ polls: true }), sendPoll } as unknown as MessagingAdapter,
      async say(...b: Bubble[]) {
        for (const x of b) said.push(typeof x === "string" ? x : x.text);
        return b.map(() => null);
      },
    }) as unknown as FlowContext;
  // Native, but the provider gave back no ids: still a poll, with no poll id.
  const noIds = await askPoll(ctxWith(async (_c, _q, o) => ({ optionMessageIds: o.map(() => null), mode: "native" })), "send it?", ["yes", "no"], "t1");
  assert.ok(noIds, "the poll is out, so it is not null");
  assert.equal(noIds.pollId, null);
  // The send itself threw before anything went out: null, the caller asks in words.
  assert.equal(await askPoll(ctxWith(async () => { throw new Error("down"); }), "send it?", ["yes", "no"], "t2"), null);
  // Numbered: exactly one instruction of ours.
  said.length = 0;
  await askPoll(ctxWith(async (_c, _q, o) => ({ optionMessageIds: o.map(() => null), mode: "numbered" })), "send it?", ["yes", "no"], "t3");
  assert.equal(said.length, 1);
  assert.match(said[0]!, /number/);
});
