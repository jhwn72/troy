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
import { FALLBACK_POOLS, chatReply, fallbackReply, readHandoff, situationOf, smalltalk } from "../src/flows/smalltalk.ts";
import { chatSystem, isCapabilityList } from "../src/brain.ts";
import { countEmoji } from "../src/voice.ts";

// No test may reach the network.
config.anthropicKey = "";
const realRepair = getFlow("repair")!;
afterEach(() => {
  setModelCall(null);
  registerFlow(realRepair);
  delete process.env.TROY_CHAT_MODEL;
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

test("TROY_CHAT_MODEL picks the model, fast by default", async () => {
  process.env.TROY_CHAT_MODEL = "smart";
  const s = setup("hey");
  const calls = model(reply(["hey. what's going on"]));
  await smalltalk.handle(s.ctx);
  assert.equal(calls[0]!.model, "smart");
  process.env.TROY_CHAT_MODEL = "nonsense";
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
  for (const bad of ["lol not json", new Error("down")]) {
    const s = setup("thanks troy");
    const calls = model(bad);
    await smalltalk.handle(s.ctx);
    assert.equal(calls.length, 1);
    assert.ok(FALLBACK_POOLS.thanks.includes(s.said.join("|")));
  }
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
  // Vent lines carry no emoji and no jokes.
  for (const line of FALLBACK_POOLS.vent) assert.equal(countEmoji(line), 0);
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
