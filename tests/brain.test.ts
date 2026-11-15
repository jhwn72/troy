import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Bubble, FlowContext, IncomingEvent, MessagingAdapter } from "../src/types.ts";
import { getOrCreateUser, getSetting, openDb, saveMessage, setFlowState, updateUser } from "../src/db/index.ts";
import { config } from "../src/config.ts";
import { setModelCall } from "../src/ai.ts";
import type { AskOpts } from "../src/ai.ts";
import { DPS as DPS_NUMBERS } from "../src/commands.ts";
import {
  aboutFor,
  clearHeavy,
  getChatHealth,
  isHeavy,
  markHeavy,
  missingPoint,
  noteDoubleReject,
  replyAtStep,
  sayInHisWords,
  HISTORY_LIMIT,
  askedWhatHeDoes,
  askedWhoHeIs,
  buildChatContext,
  chatSystem,
  checkReply,
  contactTokens,
  formatHistory,
  gapText,
  isCapabilityList,
  loadBrain,
  lookupFacts,
  recentMessages,
} from "../src/brain.ts";
import { countEmoji } from "../src/voice.ts";

// No test may reach the network.
config.anthropicKey = "";
afterEach(() => {
  setModelCall(null);
  delete process.env.TROY_EXPLAIN;
});

const CHAT = "chat-b";
const DPS = {
  kind: "office",
  name: "DPS Lost & Found",
  topics: ["lost and found", "lost item", "found item", "dps", "public safety"],
  contactMethod: "213-740-9759 or lostandfound@dps.usc.edu",
  url: "https://dps.usc.edu/services/lost-and-found/",
  details: "University Park Campus: 3667 McClintock Ave, Los Angeles, CA 90089. Found items are kept for 90 days.",
};
const FUNDING = {
  kind: "usg_program",
  name: "USG RSO funding",
  topics: ["club money", "funding", "club funding", "rso funding"],
  contactMethod: "usgfunds@usc.edu",
  url: "https://usg.usc.edu/branches/funding/",
  details: "apps are due wednesdays by 11:59pm. an rso can get up to $8,000 from usg a year.",
};
const MARKET = {
  kind: "usg_program",
  name: "USG farmers market",
  topics: ["farmers market", "produce"],
  contactMethod: null,
  url: "https://hospitality.usc.edu/upcoming-events/",
  details: "the next ones are wed nov 18 and wed dec 2.",
};

function seeded(): DatabaseSync {
  const db = openDb(":memory:");
  const add = db.prepare("INSERT INTO directory (kind, name, topics, contactMethod, url, details) VALUES (?, ?, ?, ?, ?, ?)");
  for (const r of [DPS, FUNDING, MARKET]) add.run(r.kind, r.name, JSON.stringify(r.topics), r.contactMethod, r.url, r.details);
  db.prepare("INSERT INTO campus_places (name, nicknames, lat, lng, kind) VALUES (?, ?, ?, ?, ?)").run("Leavey Library", JSON.stringify(["leavey"]), 34.0217, -118.2828, "campus");
  return db;
}

/** Save a message at a chosen time (saveMessage stamps "now"). */
function put(db: DatabaseSync, userId: number, direction: "in" | "out", text: string, at: number, id: string | null = null): void {
  saveMessage(db, { userId, chatId: CHAT, direction, providerMessageId: id, text });
  db.prepare("UPDATE messages SET createdAt = ? WHERE id = (SELECT max(id) FROM messages)").run(at);
}

const ctx = (over: Partial<Parameters<typeof checkReply>[1]> = {}): Parameters<typeof checkReply>[1] => ({
  allowText: "",
  echoText: "",
  askedCapabilities: false,
  askedIdentity: false,
  noEmoji: false,
  ...over,
});
const rejected = (raw: unknown, over: Partial<Parameters<typeof checkReply>[1]> = {}): string => {
  const r = checkReply(raw, ctx(over));
  assert.equal(r.ok, false, `expected a rejection for ${JSON.stringify(raw)}`);
  return r.ok ? "" : r.reason;
};
const passed = (raw: unknown, over: Partial<Parameters<typeof checkReply>[1]> = {}): string[] => {
  const r = checkReply(raw, ctx(over));
  assert.equal(r.ok, true, `expected a pass for ${JSON.stringify(raw)}: ${r.ok ? "" : r.reason}`);
  return r.ok ? r.bubbles : [];
};

// ---------- the files ----------

test("the three brain files load as one stable block with the expected sections", () => {
  const brain = loadBrain();
  for (const part of [brain.persona, brain.about, brain.playbook]) assert.ok(part.length > 400);
  assert.match(brain.persona, /## Who troy is/);
  assert.match(brain.persona, /## How he texts/);
  assert.match(brain.persona, /## Where the line is/);
  assert.match(brain.persona, /## Examples of the tone/);
  assert.match(brain.about, /AI@USC Hackathon, Nov 14 to 15, 2026/);
  assert.match(brain.about, /not an official USC service/);
  assert.match(brain.about, /forget my location/);
  assert.match(brain.about, /delete my data/);
  assert.match(brain.playbook, /## Things to mention when they fit/);
  for (const heading of ["## The rule above the rest", "## Ten things that hold", "## When someone vents", "## When it's heavy"]) assert.ok(brain.persona.includes(heading), heading);
  for (const heading of ["## About John and USC", "## Example mode", "## What is saved and who can see it", "## The lost and found check: what he never explains"]) assert.ok(brain.about.includes(heading), heading);
  for (const heading of ["### Topics", "### Rides", "## Moves for someone new", "## The campus directory"]) assert.ok(brain.playbook.includes(heading), heading);
  // John's story is background he knows, never a script.
  assert.deepEqual(brain.extras.map((e) => e.name), ["origin-story"]);
  assert.match(brain.block, /<background name="origin-story">/);
  assert.match(brain.extras[0]!.text, /never recites or quotes/i);
  assert.match(brain.extras[0]!.text, /John Wang/);
  // The old claim that nobody can ever see a chat is gone, and a complaint is no longer a concern by default.
  assert.doesNotMatch(brain.about, /no person reading the chat/i);
  assert.doesNotMatch(brain.playbook, /is a concern for usg\. hand off/);
  assert.match(brain.playbook, /only becomes a concern when they say they want it sent/);
  // Same bytes on every call: this is what makes the system prompt cacheable.
  assert.equal(chatSystem(), chatSystem());
  assert.ok(chatSystem().startsWith(brain.block));
  // Long enough to cache: 512 tokens is the minimum on both models, and three characters a token is a harsh estimate.
  assert.ok(chatSystem().length / 3 > 512);
  // No em dashes anywhere in the copy, and no made-up contact details in about-troy.md.
  assert.doesNotMatch(brain.block, /[—–]/);
  assert.deepEqual(contactTokens(brain.about), []);
});

test("the persona has 8 to 10 example exchanges and tells the model not to reuse them", () => {
  const { persona } = loadBrain();
  const examples = persona.split("## Examples of the tone")[1] ?? "";
  const count = (examples.match(/^them: /gm) ?? []).length;
  assert.ok(count >= 8 && count <= 10, `found ${count} examples`);
  assert.match(examples, /never reuse their wording/i);
  // The examples follow troy's own rules.
  for (const line of examples.match(/^troy: .+$/gm) ?? []) {
    assert.equal(line, line.toLowerCase(), line);
    assert.doesNotMatch(line, /\b(?:you|your|you're)\b/, line);
    assert.ok(countEmoji(line) <= 1, line);
  }
});

test("an edited brain file is picked up without a restart, and a missing one never breaks a reply", () => {
  const dir = mkdtempSync(join(tmpdir(), "troy-brain-"));
  writeFileSync(join(dir, "persona.md"), "first persona");
  writeFileSync(join(dir, "about-troy.md"), "about");
  const one = loadBrain(dir);
  assert.equal(one.persona, "first persona");
  assert.equal(one.playbook, "");
  assert.equal(loadBrain(dir), one, "unchanged files are served from memory");
  writeFileSync(join(dir, "persona.md"), "second persona, edited while running");
  utimesSync(join(dir, "persona.md"), new Date(), new Date(Date.now() + 5000));
  writeFileSync(join(dir, "playbook.md"), "the playbook");
  const two = loadBrain(dir);
  assert.equal(two.persona, "second persona, edited while running");
  assert.equal(two.playbook, "the playbook");
  assert.match(two.block, /second persona/);
  // Another .md file dropped in the folder becomes background, after the three, and its edits are picked up too.
  assert.deepEqual(two.extras, []);
  writeFileSync(join(dir, "origin-story.md"), "why troy exists");
  const three = loadBrain(dir);
  assert.deepEqual(three.extras, [{ name: "origin-story", text: "why troy exists" }]);
  assert.ok(three.block.indexOf("the playbook") < three.block.indexOf('<background name="origin-story">\nwhy troy exists'));
  // No files at all: the built-in voice stands in.
  const empty = loadBrain(mkdtempSync(join(tmpdir(), "troy-brain-empty-")));
  assert.match(empty.persona, /you are troy/);
});

// ---------- history ----------

test("history is the last 15 messages, both directions, oldest first, without the message being answered", () => {
  const db = seeded();
  const user = getOrCreateUser(db, "+12135550150", CHAT);
  const t0 = Date.now() - 60 * 60_000;
  for (let i = 1; i <= 20; i++) put(db, user.id, i % 2 ? "in" : "out", `msg ${i}`, t0 + i * 1000, `m-${i}`);
  put(db, user.id, "in", "the new one", t0 + 30_000, "m-new");
  // Another chat never leaks in.
  saveMessage(db, { userId: user.id, chatId: "other-chat", direction: "in", providerMessageId: "x", text: "someone else" });

  const lines = recentMessages(db, CHAT, { excludeMessageId: "m-new" });
  assert.equal(lines.length, HISTORY_LIMIT);
  assert.equal(HISTORY_LIMIT, 15);
  assert.deepEqual(lines.map((l) => l.text), Array.from({ length: 15 }, (_, i) => `msg ${i + 6}`));
  assert.equal(lines[0]!.from, "troy");
  assert.equal(lines[14]!.from, "troy");
  assert.equal(lines[13]!.from, "them");
  for (let i = 1; i < lines.length; i++) assert.ok(lines[i]!.at > lines[i - 1]!.at);

  const built = buildChatContext({ db, user, chatId: CHAT, text: "the new one", messageId: "m-new" });
  assert.equal(built.history.length, 15);
  const at = (s: string) => built.prompt.indexOf(s);
  assert.ok(at("troy: msg 6") !== -1 && at("troy: msg 6") < at("them: msg 7") && at("them: msg 7") < at("troy: msg 20"));
  assert.equal(at("msg 5"), -1);
  assert.equal(at("someone else"), -1);
  // The new message appears once, after the history, never as a history line.
  assert.equal(at("them: the new one"), -1);
  assert.ok(at('their new message: "the new one"') > at("troy: msg 20"));
});

test("history marks rough time gaps and photo-only messages", () => {
  const now = 1_800_000_000_000;
  const H = 60 * 60_000;
  const text = formatHistory(
    [
      { from: "them", text: "im so stressed about my econ midterm tmrw", at: now - 26 * H },
      { from: "troy", text: "econ is rough", at: now - 26 * H + 5000 },
      { from: "them", text: "ok it went fine", at: now - 2 * H },
    ],
    now,
  );
  assert.deepEqual(text.split("\n"), [
    "them: im so stressed about my econ midterm tmrw",
    "troy: econ is rough",
    "(a day later)",
    "them: ok it went fine",
    "(about 2 hours later, the new message arrives)",
  ]);
  assert.equal(gapText(5 * 60_000), null);
  assert.equal(gapText(45 * 60_000), "about an hour");
  assert.equal(gapText(3 * 24 * H), "3 days");
  assert.match(formatHistory([], now), /nothing yet/);

  const db = seeded();
  const user = getOrCreateUser(db, "+12135550151", CHAT);
  saveMessage(db, { userId: user.id, chatId: CHAT, direction: "in", providerMessageId: "p1", text: "", media: [{ path: "/tmp/x.jpg", mime: "image/jpeg" }] });
  assert.deepEqual(recentMessages(db, CHAT).map((l) => l.text), ["[photo]"]);
});

// ---------- lookups ----------

test("directory lookup returns the matching rows with their stored strings, and the place by its stored name", () => {
  const db = seeded();
  const money = lookupFacts(db, "how does my club get funding from usg");
  assert.equal(money.rows[0]!.name, FUNDING.name);
  assert.equal(money.rows[0]!.contactMethod, FUNDING.contactMethod);
  assert.equal(money.rows[0]!.url, FUNDING.url);
  assert.equal(money.rows[0]!.details, FUNDING.details);
  assert.equal(money.place, null);

  // By a name word, and a place by its nickname.
  const dps = lookupFacts(db, "does dps keep stuff people turn in at leavey");
  assert.deepEqual(dps.rows.map((r) => r.name), [DPS.name]);
  assert.deepEqual(dps.place, { name: "Leavey Library", kind: "campus" });

  // The details intent detection pulled out count too.
  assert.equal(lookupFacts(db, "when is it", { category: "farmers market" }).rows[0]!.name, MARKET.name);

  // Nothing fits: nothing is passed.
  assert.deepEqual(lookupFacts(db, "i hate my roommate lol"), { rows: [], place: null });

  const user = getOrCreateUser(db, "+12135550152", CHAT);
  const built = buildChatContext({ db, user, chatId: CHAT, text: "how does my club get funding from usg" });
  for (const stored of [FUNDING.name, FUNDING.contactMethod, FUNDING.url, FUNDING.details]) assert.ok(built.prompt.includes(stored), stored);
  assert.ok(!built.prompt.includes(DPS.contactMethod), "rows that didn't match are not passed");
  assert.ok(built.allowText.includes(FUNDING.url));
  const none = buildChatContext({ db, user, chatId: CHAT, text: "i hate my roommate lol" });
  assert.match(none.prompt, /looked up rows: none matched/);
});

test("the context carries notes and settings, and never the saved coordinates", () => {
  const db = seeded();
  const user = getOrCreateUser(db, "+12135550153", CHAT);
  updateUser(db, user.id, { name: "Sam", alertMinutes: 5, lastLat: 34.02, lastLng: -118.28, lastLocationAt: Date.now(), lastLocationSource: "find_my" });
  db.prepare("INSERT INTO user_notes (userId, kind, text, createdAt) VALUES (?, 'preference', 'no emoji', ?)").run(user.id, Date.now());
  const fresh = getOrCreateUser(db, "+12135550153", CHAT);
  const built = buildChatContext({ db, user: fresh, chatId: CHAT, text: "hey" });
  assert.match(built.prompt, /name: Sam/);
  assert.match(built.prompt, /alert distance 5 min walk/);
  assert.match(built.prompt, /saved location: yes/);
  assert.match(built.prompt, /no emoji/);
  assert.doesNotMatch(built.prompt, /34\.02|118\.28/);
  assert.equal(built.noEmoji, true);
});

// ---------- checks ----------

test("repairs: lowercase, u and ur, one emoji a bubble, no em dashes", () => {
  assert.deepEqual(passed(["Honestly Parkside — You should try it 🔥🔥", "Your call tho, you're the one eating 😂"]), [
    "honestly parkside, u should try it 🔥",
    "ur call tho, ur the one eating 😂",
  ]);
});

test("no emoji at all when the student's message reads as distress", () => {
  const db = seeded();
  const user = getOrCreateUser(db, "+12135550154", CHAT);
  const upset = buildChatContext({ db, user, chatId: CHAT, text: "im so stressed about my econ midterm tmrw" });
  assert.equal(upset.noEmoji, true);
  const out = checkReply(["that's a rough night 😭", "u got this 💪"], upset);
  assert.ok(out.ok);
  assert.equal(countEmoji(out.bubbles.join("")), 0);
  assert.equal(buildChatContext({ db, user, chatId: CHAT, text: "whats the best dining hall" }).noEmoji, false);
});

test("at most three bubbles, each under about 170 characters", () => {
  assert.match(rejected(["one", "two", "three", "four"]), /three bubbles/);
  assert.match(rejected(["x".repeat(400)]), /too long/);
  assert.match(rejected([]), /no bubbles/);
  assert.match(rejected({ nope: true }), /no bubbles/);
  // A long bubble made of sentences is split, and still has to fit in three.
  const split = passed([`${"this one runs on for a while. ".repeat(9)}`.trim()]);
  assert.match(rejected([`${"this one runs on for a while. ".repeat(20)}`.trim()]), /too long/);
  assert.ok(split.length >= 2 && split.length <= 3);
  assert.ok(split.every((b) => b.length <= 170));
  assert.equal(passed(["a".repeat(165)]).length, 1);
});

test("a link, email or phone number must be in the looked-up rows or about-troy.md", () => {
  const allowText = [FUNDING.name, FUNDING.contactMethod, FUNDING.url, FUNDING.details, DPS.contactMethod, DPS.url].join("\n");
  // Stored strings pass, exactly as stored.
  assert.deepEqual(passed(["apps go through usg funding", `here: ${FUNDING.url}`], { allowText }), ["apps go through usg funding", `here: ${FUNDING.url}`]);
  passed(["email usgfunds@usc.edu and they'll sort u out"], { allowText });
  passed(["dps lost and found is 213-740-9759"], { allowText });
  passed(["try usg.usc.edu/branches/funding"], { allowText });
  // Anything else is rejected, including a near miss.
  assert.match(rejected(["check https://usc.edu/dining-hours"], { allowText }), /not in the looked up rows/);
  assert.match(rejected(["email funding@usg.usc.edu"], { allowText }), /not in the looked up rows/);
  assert.match(rejected(["call 213-740-1111"], { allowText }), /not in the looked up rows/);
  assert.match(rejected(["it's on usc.edu somewhere"], { allowText }), /not in the looked up rows/);
  assert.match(rejected(["try www.uscdining.com"], { allowText }), /not in the looked up rows/);
  // With nothing looked up, no contact gets through at all.
  assert.match(rejected([`here: ${FUNDING.url}`]), /not in the looked up rows/);
});

test("a date or a price must come from the looked-up rows or the student's own words", () => {
  assert.match(rejected(["the market is on nov 20"], { allowText: MARKET.details }), /date, time, price/);
  passed(["next one is wed nov 18"], { allowText: MARKET.details });
  assert.match(rejected(["it's like $12 a swipe"]), /date, time, price/);
  passed(["up to $8,000 a year from usg"], { allowText: FUNDING.details });
  passed(["dec 3 is close. how much is left to study?"], { echoText: "my final is dec 3" });
});

test("no pickup-code-shaped strings", () => {
  assert.match(rejected(["ur code is M4WKYM, show it at dps"]), /pickup code/);
  assert.match(rejected(["Show them K7Q2XB at the desk"]), /pickup code/);
  assert.match(rejected(["the code is 4821"]), /pickup code/);
  // Course names and ordinary words are fine.
  passed(["writ 150 is rough", "BUAD 304 too"]);
  passed(["dps gives u a pickup code when it's ur turn"]);
});

test("the capability list is rejected unless the student asked what troy can do", () => {
  const list = ["i can help with lost or found stuff, free food, broken things on campus, or who to talk to about a campus issue"];
  const spread = ["midterms are rough", "btw i do lost and found, free food and broken stuff"];
  assert.equal(isCapabilityList(list), true);
  assert.equal(isCapabilityList(spread), true);
  assert.match(rejected(list), /don't list what troy can help with/);
  assert.match(rejected(spread), /don't list what troy can help with/);
  // One mention that fits is not the list.
  assert.equal(isCapabilityList(["econ the night before is rough", "if u get hungry later i know where the free food is"]), false);
  passed(["econ the night before is rough", "if u get hungry later i know where the free food is"]);

  for (const asked of ["what can u do", "what do you do", "wait what are u for", "how does this work", "what can i ask u"]) {
    assert.equal(askedWhatHeDoes(asked), true, asked);
    passed(list, { askedCapabilities: askedWhatHeDoes(asked) });
  }
  for (const not of ["whats the best dining hall", "what do u think about evk", "im so stressed", "what are u doing rn"]) assert.equal(askedWhatHeDoes(not), false, not);
});

test("no self-introduction unless the student asked who he is", () => {
  assert.match(rejected(["hey, i'm troy, an ai that connects usc students to the right people"]), /don't introduce troy again/);
  assert.match(rejected(["troy here. what's up"]), /don't introduce troy again/);
  assert.match(rejected(["parkside. also i'm an ai that connects trojans"]), /don't introduce troy again/);
  for (const asked of ["who are u", "wait who is this", "are you a real person", "whats ur name", "r u a bot"]) {
    assert.equal(askedWhoHeIs(asked), true, asked);
    passed(["i'm troy. an ai, not a person"], { askedIdentity: askedWhoHeIs(asked) });
  }
  for (const not of ["whats the best dining hall", "what are u doing rn", "who should i ask about housing"]) assert.equal(askedWhoHeIs(not), false, not);
  // Saying he's an ai without the introduction is always fine.
  passed(["nope, i'm an ai. i just know a lot of people"]);
});

test("nothing that claims he did something he cannot do, or that he is a person", () => {
  for (const claim of ["i emailed housing for u", "ok i've called dps", "i just booked u a room", "i sent it to usg", "i'll email ur professor rn", "i already reported it to fms"]) {
    assert.match(rejected([claim]), /can't email, call, book or send/, claim);
  }
  for (const fine of ["i can't call anyone, i'm an ai", "i haven't sent anything", "u could email ur professor tonight", "i can send that to usg if u want"]) passed([fine]);
  assert.match(rejected(["i'm a student too so i get it"]), /troy is an ai/);
  assert.match(rejected(["as a student i feel that"]), /troy is an ai/);
  passed(["i'm not a person but that sounds rough"]);
});

test("a reply that repeats one of the persona's example lines word for word is asked for again", async () => {
  const { exampleLinesOf, checkReply } = await import("../src/brain.ts");
  const lines = exampleLinesOf("them: hi\ntroy: doheny if u want quiet. the stacks are undefeated\ntroy: bet\ntroy: (hand it off.)");
  assert.deepEqual([...lines], ["doheny if u want quiet. the stacks are undefeated"]);
  const base = { allowText: "", echoText: "", askedCapabilities: false, askedIdentity: false, noEmoji: false, exampleLines: lines };
  assert.equal(checkReply(["doheny if u want quiet. the stacks are undefeated"], base).ok, false);
  assert.equal(checkReply(["doheny is the quiet one"], base).ok, true);
  assert.equal(checkReply(["bet"], base).ok, true);
});

// ---------- explain mode ----------

test("TROY_EXPLAIN picks which explanation of his own workings reaches the model", () => {
  const detailed = loadBrain(undefined, "detailed");
  const generic = loadBrain(undefined, "generic");
  assert.equal(detailed.mode, "detailed");
  assert.match(detailed.about, /built on claude/);
  assert.match(detailed.about, /bluebubbles/);
  assert.match(detailed.about, /staff dashboard/);
  assert.match(detailed.about, /example data/);
  assert.doesNotMatch(generic.about, /claude|anthropic|bluebubbles/i);
  assert.match(generic.about, /his brain runs on ai/);
  for (const brain of [detailed, generic]) {
    // One plain heading, never the mode label, and never both sections.
    assert.equal(brain.about.split("## Explaining how he works").length, 2);
    assert.doesNotMatch(brain.about, /\((?:detailed|generic) mode\)/);
    // In both modes: no answer key, and the facts about john and usc.
    assert.match(brain.about, /never gives the answer key/);
    assert.match(brain.about, /free for students/);
    assert.match(brain.about, /nobody at usc has been told/);
    assert.deepEqual(contactTokens(brain.about), []);
  }
  assert.notEqual(chatSystem(detailed), chatSystem(generic));
  // The environment decides, read on every call, detailed by default.
  assert.equal(loadBrain().mode, "detailed");
  process.env.TROY_EXPLAIN = "generic";
  assert.equal(loadBrain().mode, "generic");
  assert.equal(chatSystem(), chatSystem(generic));
  process.env.TROY_EXPLAIN = "nonsense";
  assert.equal(loadBrain().mode, "detailed");
  assert.equal(aboutFor("a\n## Explaining how he works (detailed mode)\nd\n## Explaining how he works (generic mode)\ng\n## Next\nn", "generic"), "a\n## Explaining how he works\ng\n## Next\nn");
});

// ---------- a reply at an open step, and lines in his own words ----------

let who = 0;
function scene(text: string) {
  const db = seeded();
  const user = getOrCreateUser(db, `+1213555${String(2000 + ++who)}`, CHAT);
  const event: IncomingEvent = { provider: "webchat", userHandle: user.handle, chatId: CHAT, isGroup: false, messageId: `in-${who}`, text, images: [], receivedAt: Date.now() };
  saveMessage(db, { userId: user.id, chatId: CHAT, direction: "in", providerMessageId: event.messageId, text });
  const said: string[] = [];
  const flow: FlowContext = {
    db,
    user,
    event,
    intent: { flow: "onboarding", action: "answer", details: {}, source: "fallback" },
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
  return { db, user, flow, said };
}

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

const EMAIL_STEP = {
  flow: "onboarding",
  waitingFor: "ur usc email",
  canDo: [
    { name: "start_over", when: "they want to start over" },
    { name: "resend_code", when: "they ask for the code again" },
  ],
};

test("replyAtStep answers what they said, knows the step, and only returns an action from canDo", async () => {
  const s = scene("can we start over");
  const calls = model(JSON.stringify({ bubbles: [], action: "start_over" }));
  assert.deepEqual(await replyAtStep(s.flow, EMAIL_STEP), { bubbles: [], action: "start_over" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.system, chatSystem());
  assert.match(calls[0]!.prompt, /troy is waiting for: ur usc email/);
  assert.match(calls[0]!.prompt, /- start_over: they want to start over/);
  assert.match(calls[0]!.prompt, /never tell them the format is wrong/);
  assert.match(calls[0]!.prompt, /their new message: "can we start over"/);

  // An action that isn't on the list is never returned, whatever the model says.
  const t = scene("wait why do u need my email");
  model(JSON.stringify({ bubbles: ["Just to check you're a Trojan, it's not saved for anything else", "what's the email?"], action: "delete_everything" }));
  assert.deepEqual(await replyAtStep(t.flow, EMAIL_STEP), { bubbles: ["just to check ur a trojan, it's not saved for anything else", "what's the email?"], action: null });

  // With nothing code can do, there is never an action.
  const n = scene("lol what");
  model(JSON.stringify({ bubbles: ["ha, fair"], action: "start_over" }));
  assert.equal((await replyAtStep(n.flow, { ...EMAIL_STEP, canDo: [] })).action, null);

  // A reply and an action together: both come back, and the reply went through the checks.
  const u = scene("ugh i typed it wrong, send the code again? also are u a bot");
  model(JSON.stringify({ bubbles: ["Yep, I'm an AI 🤖🤖"], action: "resend_code" }));
  assert.deepEqual(await replyAtStep(u.flow, EMAIL_STEP), { bubbles: ["yep, i'm an ai 🤖"], action: "resend_code" });
});

test("replyAtStep uses the same checks as free chat and never throws", async () => {
  // First try invents a link: rejected with the reason, second try is sent.
  const s = scene("where do i add a class");
  const calls = model(JSON.stringify({ bubbles: ["try https://classes.usc.edu"], action: null }), JSON.stringify({ bubbles: ["the registrar handles adds, i'd start there", "anyway, what's ur usc email?"], action: null }));
  const out = await replyAtStep(s.flow, EMAIL_STEP);
  assert.equal(calls.length, 2);
  assert.match(calls[1]!.prompt, /your last reply was not sent: .*not in the looked up rows/);
  assert.deepEqual(out, { bubbles: ["the registrar handles adds, i'd start there", "anyway, what's ur usc email?"], action: null });

  // Rejected twice: a varied hand-written line that names what he's waiting for, counted, and action null.
  const t = scene("where do i add a class");
  model(JSON.stringify({ bubbles: ["i emailed the registrar for u"], action: null }));
  const before = getChatHealth(t.db).doubleRejectsToday;
  const a = await replyAtStep(t.flow, EMAIL_STEP);
  const b = await replyAtStep(t.flow, EMAIL_STEP);
  assert.equal(a.action, null);
  assert.match(a.bubbles[0]!, /ur usc email/);
  assert.notEqual(a.bubbles[0], b.bubbles[0], "the fallback varies");
  assert.equal(getChatHealth(t.db).doubleRejectsToday, before + 2);
  // A picked action survives a wording problem: code does it and says so itself.
  model(JSON.stringify({ bubbles: ["i emailed the registrar for u"], action: "start_over" }));
  assert.deepEqual(await replyAtStep(t.flow, EMAIL_STEP), { bubbles: [], action: "start_over" });

  // No model, a broken model, junk: always a line, never a throw.
  for (const bad of [null, "not json at all", new Error("down")]) {
    if (bad === null) setModelCall(null);
    else model(bad);
    const r = await replyAtStep(scene("huh").flow, EMAIL_STEP);
    assert.equal(r.action, null);
    assert.equal(r.bubbles.length, 1);
    assert.match(r.bubbles[0]!, /ur usc email/);
    assert.doesNotMatch(r.bubbles[0]!, /doesn't look like|invalid|format/);
  }
  // A lost and found step keeps its verdict lock.
  const l = scene("lol whats ur fav dining hall");
  model(JSON.stringify({ bubbles: ["that checks out, it's urs"], action: null }), JSON.stringify({ bubbles: ["parkside, easy", "so, how would u describe it?"], action: null }));
  assert.deepEqual((await replyAtStep(l.flow, { flow: "lost_found", waitingFor: "a description of the item", canDo: [] })).bubbles, ["parkside, easy", "so, how would u describe it?"]);
});

const TOPIC_BRIEF = {
  goal: "confirm the texts they just picked",
  mustCover: ["he will text them when someone needs help with a class", "they can add more later"],
  fallback: [["bet, i'll text u when someone needs help with a class", "u can add more whenever"], ["got it. when someone needs a hand with a class, i'll hit u up", "add more anytime"], ["done. i'll ping u when a trojan needs class help. more can be added later"]],
};

test("sayInHisWords needs every point covered and every fact verbatim, and goes through the checks", async () => {
  const s = scene("1 and 3");
  // First try drops the second point, second try covers both (and quotes the words that do).
  const calls = model(
    JSON.stringify({ bubbles: ["Bet, I'll text you when someone needs help with a class"], covers: ["text u when someone needs help with a class", ""] }),
    JSON.stringify({ bubbles: ["bet, i'll hit u up when a trojan is stuck on a class", "want more? just tell me whenever"], covers: ["hit u up when a trojan is stuck on a class", "want more? just tell me whenever"] }),
  );
  assert.deepEqual(await sayInHisWords(s.flow, TOPIC_BRIEF), ["bet, i'll hit u up when a trojan is stuck on a class", "want more? just tell me whenever"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.system, chatSystem());
  assert.match(calls[0]!.prompt, /1\. he will text them when someone needs help with a class\n2\. they can add more later/);
  assert.match(calls[0]!.prompt, /never read back like a list or a label/);
  // Their last message is in the history, not posed as a question to answer.
  assert.match(calls[0]!.prompt, /them: 1 and 3/);
  assert.doesNotMatch(calls[0]!.prompt, /their new message/);
  assert.match(calls[1]!.prompt, /doesn't get across this point: "they can add more later"/);

  // A quote that isn't in the reply proves nothing.
  assert.equal(missingPoint(["bet, i'll text u about classes"], TOPIC_BRIEF.mustCover, ["text u about classes", "u can add more later"]), "they can add more later");
  assert.equal(missingPoint(["i'll text u when someone needs class help", "add more later if u want"], TOPIC_BRIEF.mustCover, []), null);

  // Facts appear exactly as given, capitals and all, or the fallback is used.
  const f = scene("where is it");
  const brief = { goal: "tell them where the free pizza is", mustCover: ["where the food is"], facts: { place: "Leavey Library", count: "12" }, fallback: [["it's at Leavey Library, 12 left"], ["Leavey Library has it. 12 left"]] };
  model(JSON.stringify({ bubbles: ["It's at Leavey Library, 12 left"], covers: ["at Leavey Library"] }));
  assert.deepEqual(await sayInHisWords(f.flow, brief), ["it's at Leavey Library, 12 left"]);
  model(JSON.stringify({ bubbles: ["it's at the library, a dozen left"], covers: ["at the library"] }));
  const fell = (await sayInHisWords(f.flow, brief)).join("|");
  assert.ok(brief.fallback.some((v) => v.join("|") === fell), fell);
  // The free-chat checks apply: an invented link never gets out.
  model(JSON.stringify({ bubbles: ["it's at Leavey Library, 12 left. map: bit.ly/leavey"], covers: ["at Leavey Library"] }));
  assert.ok(!(await sayInHisWords(f.flow, brief)).join(" ").includes("bit.ly"));
  // A true promise from code is his to make here.
  model(JSON.stringify({ bubbles: ["i'll text the people who follow it", "12 left at Leavey Library"], covers: ["at Leavey Library"] }));
  assert.deepEqual(await sayInHisWords(f.flow, brief), ["i'll text the people who follow it", "12 left at Leavey Library"]);
});

test("sayInHisWords never sends a fact with its label or braces around it, and the prompt hands facts over as plain words", async () => {
  const f = scene("ok");
  const brief = { goal: "there's free pizza close by, ask if they want the spot", mustCover: ["free pizza close to them"], facts: { walk: "8 min" }, fallback: [["btw there's free pizza about 8 min from u. want the spot?"]] };
  // What the live model once did with a JSON object in the prompt: it copied the structure into the text.
  const calls = model(
    JSON.stringify({ bubbles: ['free pizza just popped up, about {"walk":"8 min"} from u'], covers: ["free pizza just popped up"] }),
    JSON.stringify({ bubbles: ["free pizza just popped up close to u, walk: 8 min"], covers: ["free pizza just popped up"] }),
  );
  assert.deepEqual(await sayInHisWords(f.flow, brief), brief.fallback[0]);
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[0]!.prompt, /\{"walk"/);
  assert.match(calls[0]!.prompt, /- 8 min {3}<- \(a note for u only, never sent: this is the walk\)/);
  assert.match(calls[1]!.prompt, /braces or a label and a colon/);
  model(JSON.stringify({ bubbles: ["free pizza about 8 min from u rn. want the spot?"], covers: ["free pizza about 8 min from u"] }));
  assert.deepEqual(await sayInHisWords(f.flow, brief), ["free pizza about 8 min from u rn. want the spot?"]);
});

test("replyAtStep hands facts over as plain lines, and never tells anyone they can skip", async () => {
  const s = scene("why tho");
  const calls = model(JSON.stringify({ bubbles: ["so alerts fit where u actually are"], action: null }));
  await replyAtStep(s.flow, { flow: "onboarding", waitingFor: "ur location, only if u want", canDo: [{ name: "skip_optional_step", when: "they don't want to" }], facts: { why: "alerts and walking times fit where they actually are" } });
  assert.match(calls[0]!.prompt, /- why: alerts and walking times fit where they actually are/);
  assert.doesNotMatch(calls[0]!.prompt, /\{"why"/);
  assert.match(calls[0]!.prompt, /never use the word skip/);
});

test("describing the build as a student project is not a person claim; saying he is a student still is", () => {
  const c = buildChatContext({ db: scene("who are u").db, user: scene("x").flow.user, chatId: "c", text: "can john read this", brain: loadBrain() });
  assert.equal(checkReply(["nobody is typing for me. i'm a student project, so john can open the chats during the demo"], { ...c, askedIdentity: true }).ok, true);
  assert.equal(checkReply(["i'm a student-built prototype, not a usc service"], { ...c, askedIdentity: true }).ok, true);
  assert.equal(checkReply(["nope, not official. john built me as a student project at the hackathon"], { ...c, askedIdentity: true }).ok, true);
  assert.equal(checkReply(["as a student i get it"], { ...c, askedIdentity: true }).ok, false);
  assert.equal(checkReply(["i'm a student here too lol"], { ...c, askedIdentity: true }).ok, false);
  assert.equal(checkReply(["i'm a usc student"], { ...c, askedIdentity: true }).ok, false);
});

test("sayInHisWords rotates the hand-written versions when the model is down or keeps failing", async () => {
  const s = scene("1 and 3");
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) seen.push((await sayInHisWords(s.flow, TOPIC_BRIEF)).join("|"));
  for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1]);
  assert.equal(new Set(seen).size, TOPIC_BRIEF.fallback.length);
  for (const line of seen) assert.ok(TOPIC_BRIEF.fallback.some((v) => v.join("|") === line));

  const before = getChatHealth(s.db).doubleRejectsToday;
  const calls = model(JSON.stringify({ bubbles: ["ur subscribed"], covers: [] }));
  const out = (await sayInHisWords(s.flow, TOPIC_BRIEF)).join("|");
  assert.equal(calls.length, 2);
  assert.ok(TOPIC_BRIEF.fallback.some((v) => v.join("|") === out));
  assert.equal(getChatHealth(s.db).doubleRejectsToday, before + 1);
  model(new Error("down"));
  const down = (await sayInHisWords(s.flow, TOPIC_BRIEF)).join("|");
  assert.ok(TOPIC_BRIEF.fallback.some((v) => v.join("|") === down));
  assert.deepEqual(await sayInHisWords(s.flow, { ...TOPIC_BRIEF, fallback: [] }), []);
});

// ---------- the double-reject counter ----------

test("replies rejected twice are counted per day for the panel", () => {
  const db = seeded();
  const now = Date.parse("2026-11-15T03:00:00Z"); // still nov 14 in los angeles
  assert.deepEqual(getChatHealth(db, now), { day: "2026-11-14", doubleRejectsToday: 0, lastSevenDays: Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-${String(14 - i).padStart(2, "0")}`, count: 0 })) });
  noteDoubleReject(db, now);
  noteDoubleReject(db, now);
  noteDoubleReject(db, now - 24 * 60 * 60_000);
  assert.equal(getSetting(db, "chat_double_rejects:2026-11-14"), "2");
  const health = getChatHealth(db, now);
  assert.equal(health.doubleRejectsToday, 2);
  assert.deepEqual(health.lastSevenDays.slice(0, 2), [{ day: "2026-11-14", count: 2 }, { day: "2026-11-13", count: 1 }]);
});

// ---------- heavy conversations, safety numbers, lookup results ----------

test("a heavy conversation makes him gentle: no emoji, no laughing along, no offers", () => {
  const db = seeded();
  const user = getOrCreateUser(db, "+12135550160", CHAT);
  assert.equal(isHeavy(db, user.id), false);
  assert.doesNotMatch(buildChatContext({ db, user, chatId: CHAT, text: "yeah" }).prompt, /conversation is heavy/);
  markHeavy(db, user.id);
  assert.equal(isHeavy(db, user.id), true);
  const c = buildChatContext({ db, user, chatId: CHAT, text: "yeah", lookupAvailable: true });
  assert.equal(c.heavy, true);
  assert.equal(c.noEmoji, true);
  assert.match(c.prompt, /this conversation is heavy/);
  assert.doesNotMatch(c.prompt, /quick lookup: available/);
  const kind = checkReply(["i'm really sorry about ur grandma 💔", "do u want to tell me about her"], c);
  assert.ok(kind.ok);
  assert.equal(countEmoji(kind.bubbles.join("")), 0);
  assert.match(rejected(["lol that's rough"], c), /heavy moment/);
  assert.match(rejected(["that's so hard. btw there's free food at tcc if u need a pick me up"], c), /no offers/);
  // What they brought up themselves is theirs to talk about.
  const theirs = buildChatContext({ db, user, chatId: CHAT, text: "i lost my wallet and my grandma died this week" });
  assert.ok(checkReply(["i'm so sorry about ur grandma", "we can sort the lost wallet whenever ur ready"], { ...theirs, lockedStep: false }).ok);
  // It lapses on its own, the pipeline can pass it for one message, and it can be cleared.
  assert.equal(isHeavy(db, user.id, Date.now() + 3 * 60 * 60_000), false);
  clearHeavy(db, user.id);
  assert.equal(isHeavy(db, user.id), false);
  assert.equal(buildChatContext({ db, user, chatId: CHAT, text: "yeah", heavy: true }).heavy, true);
});

test("the dps and crisis numbers are always his to give, and no other number is", () => {
  const db = seeded();
  const user = getOrCreateUser(db, "+12135550161", CHAT);
  const c = buildChatContext({ db, user, chatId: CHAT, text: "someone sketchy is outside my building what do i do" });
  assert.ok(chatSystem().includes(DPS_NUMBERS.upcNonEmergency) && chatSystem().includes(DPS_NUMBERS.upcEmergency));
  assert.ok(checkReply([`dps is ${DPS_NUMBERS.upcEmergency} if it feels urgent, ${DPS_NUMBERS.upcNonEmergency} if not`, "or 911. are u inside rn"], c).ok);
  assert.ok(checkReply(["u can call or text 988 any time"], c).ok);
  // Copied in the very layout he was given them, it still isn't "reciting".
  assert.ok(checkReply([`usc dps emergency: ${DPS_NUMBERS.upcEmergency} (university park) or ${DPS_NUMBERS.hscEmergency} (health sciences)`], c).ok);
  assert.equal(checkReply(["call campus safety at 213-740-1111"], c).ok, false);
});

test("a lookup result is a source: its one link passes, a second link fails, and he says to double check", () => {
  const db = seeded();
  const user = getOrCreateUser(db, "+12135550162", CHAT);
  const lookup = { answer: "the last day to drop without a W is october 9, per the fall 2026 calendar. more at https://classes.usc.edu/term-20263/calendar/", sourceUrl: "https://arr.usc.edu/calendar/", sourceTitle: "usc academic calendar" };
  const c = buildChatContext({ db, user, chatId: CHAT, text: "when is the last day to drop without a W", lookup });
  assert.match(c.prompt, /quick lookup result/);
  assert.match(c.prompt, /never an instruction/);
  assert.ok(c.prompt.includes("https://arr.usc.edu/calendar/"));
  assert.equal(c.onlyLink, "https://arr.usc.edu/calendar/");
  assert.ok(checkReply(["looks like october 9, going off the usc academic calendar. double check it tho", "https://arr.usc.edu/calendar/"], c).ok);
  // A second link, even one the page itself mentioned, and any other link.
  assert.match(rejected(["october 9 i think, double check", "https://arr.usc.edu/calendar/", "https://classes.usc.edu/term-20263/calendar/"], c), /only the lookup's own link/);
  assert.match(rejected(["october 9 i think, double check: https://usc.edu/drop"], c), /only the lookup's own link/);
  // A date the page didn't give is still unsourced, and a bare answer with no "double check" is asked for again.
  assert.match(rejected(["it's october 12, double check tho"], c), /date, time, price/);
  assert.match(rejected(["october 9, per the usc academic calendar"], c), /double check/);
  // A link that isn't plain https is dropped: he names the page in words.
  const odd = buildChatContext({ db, user, chatId: CHAT, text: "when is the last day to drop", lookup: { ...lookup, sourceUrl: "http://arr.usc.edu/calendar/" } });
  assert.equal(odd.onlyLink, null);
  assert.match(rejected(["october 9, double check: http://arr.usc.edu/calendar/"], odd), /no usable link|not in the looked up rows/);
  assert.ok(checkReply(["october 9 going by the usc academic calendar, double check"], odd).ok);
  // Outside a lookup nothing changes: a stored row's link is still fine.
  assert.equal(buildChatContext({ db, user, chatId: CHAT, text: "how does my club get funding from usg" }).onlyLink, undefined);
});
