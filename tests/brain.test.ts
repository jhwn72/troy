import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getOrCreateUser, openDb, saveMessage, updateUser } from "../src/db/index.ts";
import { config } from "../src/config.ts";
import {
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
