import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { IncomingEvent, MessagingAdapter, TapbackType } from "../src/types.ts";
import { openDb, getUserByHandle, getFlowState, setFlowState } from "../src/db/index.ts";
import { createPipeline } from "../src/pipeline.ts";
import { fallbackIntent } from "../src/ai.ts";
import { registerFlow } from "../src/flows/index.ts";
import {
  notes,
  notesIntent,
  setRuleClassifier,
  parseAlertMinutes,
  parseQuietHours,
  parseSubscriptions,
  parseSpots,
  parseClock,
  formatClock,
  keywordContact,
  keywordGroupChats,
  morePrivateContact,
  morePrivateGroupChats,
  parse,
  parseAtNow,
  setNotesClock,
  NOTES_POOLS,
  NOTES_VOICE,
} from "../src/flows/notes.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCATION_STALE_MS, getUserLocation, saveUserLocation } from "../src/location.ts";
import type { RuleGuess } from "../src/flows/notes.ts";
import { poolProblems, setVariantPicker } from "../src/flows/reports-shared.ts";
import type { VariantPicker, Voice } from "../src/flows/reports-shared.ts";

/**
 * Facts locked, wording varied: any line Troy sends may be any variant from NOTES_POOLS. The fake adapter records
 * each bubble read back to its first wording, with every setting, time and place kept exactly as sent, so the
 * assertions below hold for whichever variant went out. `raw` keeps the words as they were sent.
 */
const canon = (text: string): string => NOTES_VOICE.canonical(text);

registerFlow(notes);

const A = "+12135550101";
const B = "+12135550102";

function fakeAdapter() {
  const sent: { chatId: string; text: string; id: string; raw: string }[] = [];
  let n = 0;
  const adapter: MessagingAdapter = {
    provider: "webchat",
    capabilities: () => ({ tapbacks: true, typing: true, readReceipts: true, edits: false, effects: true, polls: false, groupChats: false, contactCard: true, liveLocation: false }),
    async sendMessage(chatId, text) {
      const id = `out-${++n}`;
      sent.push({ chatId, text: canon(text), id, raw: text });
      return { messageId: id };
    },
    async sendImage() {
      return null;
    },
    async sendContactCard() {
      return null;
    },
    async markRead() {},
    async startTyping() {},
    async stopTyping() {},
    async react() {
      return true;
    },
    async editMessage() {
      return false;
    },
    async sendPoll(_chatId, _q, options) {
      return { optionMessageIds: options.map(() => null), mode: "tap" };
    },
    async createGroupChat() {
      return null;
    },
    async getLiveLocation() {
      return null;
    },
    requestLocation: async () => false,
    chatIdForHandle: (h) => `chat-${h}`,
  };
  return { adapter, sent };
}

/** Two verified students on the real pipeline. Routing is keywords only, the way it runs with no API key. */
function setup() {
  const db = openDb(":memory:");
  const fake = fakeAdapter();
  const pipeline = createPipeline({
    db,
    getAdapter: () => fake.adapter,
    pause: async () => {},
    ackAfterMs: 5000,
    detectIntent: async (input) => notesIntent(input.text) ?? fallbackIntent(input),
  });
  for (const h of [A, B]) {
    db.prepare("INSERT INTO users (handle, chatId, name, verifiedAt, verifiedVia, subscriptions, createdAt) VALUES (?, ?, ?, ?, 'usc_email', ?, ?)").run(
      h,
      `chat-${h}`,
      h === A ? "Maya" : "Sam",
      Date.now(),
      JSON.stringify(["free_food", "events"]),
      Date.now(),
    );
  }
  let m = 0;
  const event = (handle: string, over: Partial<IncomingEvent>): IncomingEvent => ({
    provider: "webchat",
    userHandle: handle,
    chatId: `chat-${handle}`,
    isGroup: false,
    messageId: `in-${++m}`,
    text: "",
    images: [],
    receivedAt: Date.now(),
    ...over,
  });
  const from = (handle: string) => async (t: string) => {
    const before = fake.sent.length;
    await pipeline.handleEvent(event(handle, { text: t }));
    return fake.sent.slice(before).map((s) => s.text);
  };
  const tap = async (handle: string, targetMessageId: string, type: TapbackType) => {
    const before = fake.sent.length;
    await pipeline.handleEvent(event(handle, { reaction: { targetMessageId, type, removed: false } }));
    return fake.sent.slice(before).map((s) => s.text);
  };
  const user = (h: string) => getUserByHandle(db, h)!;
  const notesOf = (h: string) =>
    (db.prepare("SELECT kind, text FROM user_notes WHERE userId = ? ORDER BY id").all(user(h).id) as { kind: string; text: string }[]).map((n) => ({ kind: n.kind, text: n.text }));
  const state = (h: string) => getFlowState(db, user(h).id);
  return { db, fake, a: from(A), b: from(B), tap, user, notesOf, state };
}

afterEach(() => {
  setRuleClassifier(null);
  setNotesClock(null);
});

function assertVoice(bubbles: string[]) {
  for (const b of bubbles) {
    assert.equal(b.replace(/STOP/g, ""), b.replace(/STOP/g, "").toLowerCase(), `not lowercase: ${b}`);
    assert.ok(!/[—–]/.test(b), `dash in: ${b}`);
    assert.ok(b.length <= 200, `too long: ${b}`);
  }
}

// ---------- contact and privacy rules ----------

test("every relay-only phrase sets contactMode and saves the student's words as a rule", async () => {
  const phrases = [
    "don't let people text me directly",
    "Don’t share my number",
    "relay only",
    "pls dont give out my phone number",
    "never let anyone message me directly",
    "keep my number private",
    "nobody should have my number",
    "i don't want people texting me",
    "it's not ok to share my number",
    "don't let ppl hmu directly",
  ];
  for (const phrase of phrases) {
    const t = setup();
    const out = await t.a(phrase);
    assert.equal(t.user(A).contactMode, "relay_only", phrase);
    assert.equal(t.user(A).groupChatsAllowed, true, phrase);
    assert.deepEqual(t.notesOf(A), [{ kind: "rule", text: phrase }], phrase);
    assert.deepEqual(out, ["got it. want me to relay their requests to u instead? they won't get ur number."], phrase);
    assert.equal(t.state(A)?.step, "relay_offer");
    // The other student is untouched.
    assert.equal(t.user(B).contactMode, "direct");
    assert.deepEqual(t.notesOf(B), []);
  }
});

test("the reverse phrases turn relay only back off", async () => {
  for (const phrase of ["people can text me directly again", "u can share my number", "turn off relay only", "it's fine to share my number", "you can give out my number again"]) {
    const t = setup();
    await t.a("don't share my number");
    await t.a("yes");
    const out = await t.a(phrase);
    assert.equal(t.user(A).contactMode, "direct", phrase);
    assert.match(out[0]!, /people i connect u with can text u directly/, phrase);
    assert.equal(t.notesOf(A).length, 2, phrase);
    assert.equal(t.notesOf(A)[1]!.kind, "rule");
    assert.equal(t.state(A), null);
    assertVoice(out);
  }
});

test("group chat phrases set groupChatsAllowed off, and the reverse turns it back on", async () => {
  for (const phrase of ["don't add me to group chats", "no group chats", "never put me in a gc", "keep me out of group chats", "i hate group chats"]) {
    const t = setup();
    const out = await t.a(phrase);
    assert.equal(t.user(A).groupChatsAllowed, false, phrase);
    assert.equal(t.user(A).contactMode, "direct", phrase);
    assert.deepEqual(t.notesOf(A), [{ kind: "rule", text: phrase }]);
    assert.match(out[0]!, /won't add u to group chats/);
    assert.equal(t.state(A), null);
    assertVoice(out);
  }
  for (const phrase of ["u can add me to group chats again", "group chats are fine", "add me to group chats again", "turn group chats back on"]) {
    const t = setup();
    await t.a("don't add me to group chats");
    const out = await t.a(phrase);
    assert.equal(t.user(A).groupChatsAllowed, true, phrase);
    assert.match(out.join(" "), /group chats are back on/, phrase);
  }
});

test("no-contact phrases set no_contact, and the reverse undoes it", async () => {
  for (const phrase of ["don't connect me with anyone", "stop matching me with people", "no contact", "i don't want to be connected with anyone"]) {
    const t = setup();
    const out = await t.a(phrase);
    assert.equal(t.user(A).contactMode, "no_contact", phrase);
    assert.deepEqual(t.notesOf(A), [{ kind: "rule", text: phrase }]);
    assert.match(out[0]!, /i don't connect u with anyone/);
    assert.equal(t.state(A), null);
    const back = await t.a("connect me again");
    assert.equal(t.user(A).contactMode, "direct", phrase);
    assert.match(back[0]!, /can text u directly/);
  }
});

test("the spec example sets both rules and offers relay", async () => {
  const t = setup();
  const said = "don't let people text me directly about usg stuff or add me to group chats.";
  const out = await t.a(said);
  assert.equal(t.user(A).contactMode, "relay_only");
  assert.equal(t.user(A).groupChatsAllowed, false);
  assert.deepEqual(t.notesOf(A), [{ kind: "rule", text: said }]);
  assert.deepEqual(out, ["got it. i won't add u to group chats", "want me to relay their requests to u instead? they won't get ur number."]);
});

test("relay offer: yes keeps relay only, no means no contact, a tapback answers too", async () => {
  const yes = setup();
  await yes.a("don't share my number");
  assert.match((await yes.a("yeah"))[0]!, /pass their messages along/);
  assert.equal(yes.user(A).contactMode, "relay_only");
  assert.equal(yes.state(A), null);

  const no = setup();
  await no.a("don't share my number");
  const out = await no.a("no");
  assert.equal(no.user(A).contactMode, "no_contact");
  assert.match(out[0]!, /won't connect u with anyone/);
  assert.equal(no.state(A), null);
  assert.equal(no.notesOf(A).length, 1);

  const liked = setup();
  await liked.a("don't share my number");
  const offerId = liked.fake.sent[liked.fake.sent.length - 1]!.id;
  assert.match((await liked.tap(A, offerId, "like"))[0]!, /pass their messages along/);
  assert.equal(liked.user(A).contactMode, "relay_only");
  assert.equal(liked.state(A), null);

  const disliked = setup();
  await disliked.a("don't share my number");
  await disliked.tap(A, disliked.fake.sent[disliked.fake.sent.length - 1]!.id, "dislike");
  assert.equal(disliked.user(A).contactMode, "no_contact");
});

test("an open question never traps the student", async () => {
  const t = setup();
  await t.a("don't share my number");
  assert.equal(t.state(A)?.step, "relay_offer");
  // nvm closes it and the rule stays.
  assert.match((await t.a("nvm"))[0]!, /still on relay only/);
  assert.equal(t.state(A), null);
  assert.equal(t.user(A).contactMode, "relay_only");

  // A new notes request is handled as that request.
  const u = setup();
  await u.a("relay only");
  await u.a("no emoji");
  assert.equal(u.state(A), null);
  assert.equal(u.user(A).contactMode, "relay_only");
  assert.deepEqual(u.notesOf(A).map((n) => n.kind), ["rule", "preference"]);

  // Something unrelated goes to the flow it belongs to (smalltalk here), and the step is closed.
  const v = setup();
  await v.a("relay only");
  const out = await v.a("hey");
  assert.equal(v.state(A), null);
  assert.equal(out.length > 0, true);
  assert.equal(v.user(A).contactMode, "relay_only");
});

test("a rule given while another flow's conversation is open doesn't take that conversation over", async () => {
  const t = setup();
  setFlowState(t.db, t.user(A).id, { flow: "lost_found", step: "clarify", data: { keep: 1 } });
  // The model routed this to notes even though lost_found is open.
  const pipeline = createPipeline({
    db: t.db,
    getAdapter: () => t.fake.adapter,
    pause: async () => {},
    ackAfterMs: 5000,
    detectIntent: async () => ({ flow: "notes", action: "add_note", details: {}, source: "ai" }),
  });
  await pipeline.handleEvent({ provider: "webchat", userHandle: A, chatId: `chat-${A}`, isGroup: false, messageId: "x-1", text: "don't share my number", images: [], receivedAt: Date.now() });
  assert.equal(t.user(A).contactMode, "relay_only");
  assert.equal(t.state(A)?.flow, "lost_found");
  assert.match(t.fake.sent[t.fake.sent.length - 1]!.text, /relay only\. i pass messages along and nobody gets ur number/);
});

// ---------- classifier against keywords ----------

test("when the classifier and the keywords disagree, the more private one wins", async () => {
  const guess = (g: Partial<RuleGuess>) => setRuleClassifier(async () => ({ contact: null, groupChats: null, ...g }));

  // Keywords say relay only, the model says no contact.
  let t = setup();
  guess({ contact: "no_contact" });
  await t.a("don't share my number");
  assert.equal(t.user(A).contactMode, "no_contact");

  // Keywords say no contact, the model says relay only.
  t = setup();
  guess({ contact: "relay_only" });
  await t.a("don't connect me with anyone");
  assert.equal(t.user(A).contactMode, "no_contact");

  // Keywords hear "open it back up", the model hears "relay only": it stays private.
  t = setup();
  await t.a("relay only");
  await t.a("yes");
  guess({ contact: "relay_only" });
  const out = await t.a("people can text me directly");
  assert.equal(t.user(A).contactMode, "relay_only");
  assert.match(out[0]!, /that's already how i have it\. contact: relay only/);
  assert.equal(t.notesOf(A).length, 1);

  // Keywords say group chats are fine again, the model says they aren't.
  t = setup();
  await t.a("no group chats");
  guess({ groupChats: false });
  await t.a("group chats are fine");
  assert.equal(t.user(A).groupChatsAllowed, false);

  // Keywords see nothing, the model sees a privacy rule: the rule is set.
  t = setup();
  guess({ contact: "relay_only", groupChats: false });
  await t.a("from now on i'd rather stay anonymous to other people");
  assert.equal(t.user(A).contactMode, "relay_only");
  assert.equal(t.user(A).groupChatsAllowed, false);
  assert.equal(t.notesOf(A)[0]!.kind, "rule");

  // The model has no opinion: keywords decide.
  t = setup();
  guess({});
  await t.a("don't share my number");
  assert.equal(t.user(A).contactMode, "relay_only");

  // The model fails: keywords decide.
  t = setup();
  setRuleClassifier(async () => {
    throw new Error("down");
  });
  await t.a("don't add me to group chats");
  assert.equal(t.user(A).groupChatsAllowed, false);
});

test("the model alone can never loosen privacy: the student has to say yes", async () => {
  const t = setup();
  await t.a("don't connect me with anyone");
  setRuleClassifier(async () => ({ contact: "direct", groupChats: null }));
  const out = await t.a("from now on i'm cool with whatever other people need");
  assert.equal(t.user(A).contactMode, "no_contact");
  assert.match(out[out.length - 1]!, /just checking\. u want people to be able to text u directly again\? reply yes or no/);
  assert.equal(t.state(A)?.step, "confirm_loosen");
  await t.a("no");
  assert.equal(t.user(A).contactMode, "no_contact");
  assert.equal(t.state(A), null);

  await t.a("from now on i'm cool with whatever other people need");
  const done = await t.a("yes");
  assert.equal(t.user(A).contactMode, "direct");
  assert.match(done[0]!, /done\. people i connect u with can text u directly/);
  assert.equal(t.state(A), null);
});

test("the more-private helpers", () => {
  assert.equal(morePrivateContact("direct", "relay_only"), "relay_only");
  assert.equal(morePrivateContact("no_contact", "relay_only"), "no_contact");
  assert.equal(morePrivateContact(null, "direct"), "direct");
  assert.equal(morePrivateContact("relay_only", null), "relay_only");
  assert.equal(morePrivateContact(null, null), null);
  assert.equal(morePrivateGroupChats(true, false), false);
  assert.equal(morePrivateGroupChats(false, true), false);
  assert.equal(morePrivateGroupChats(null, true), true);
  assert.equal(morePrivateGroupChats(null, null), null);
});

test("texts that are not privacy rules don't set one", () => {
  for (const s of ["keep it short", "no emoji", "dont text me after midnight", "only tell me about food within 5 min", "i lost my wallet", "stop the food alerts", "can people text me", "u can call me mj"]) {
    assert.equal(keywordContact(s.replace(/'/g, "")), null, s);
    assert.equal(keywordGroupChats(s.replace(/'/g, "")), null, s);
  }
});

// ---------- alert distance ----------

test("alert distance: phrasings, and the 1 to 60 bounds", async () => {
  assert.deepEqual(parseAlertMinutes("only tell me about food within 5 min"), { minutes: 5 });
  assert.deepEqual(parseAlertMinutes("alert distance 20"), { minutes: 20 });
  assert.deepEqual(parseAlertMinutes("only stuff under ten minutes away"), { minutes: 10 });
  assert.deepEqual(parseAlertMinutes("10 min walk max for alerts"), { minutes: 10 });
  assert.deepEqual(parseAlertMinutes("within 1 min"), { minutes: 1 });
  assert.deepEqual(parseAlertMinutes("within 60 min"), { minutes: 60 });
  assert.deepEqual(parseAlertMinutes("within 0 min"), { error: "range" });
  assert.deepEqual(parseAlertMinutes("within 61 min"), { error: "range" });
  assert.deepEqual(parseAlertMinutes("within 500 minutes"), { error: "range" });
  assert.deepEqual(parseAlertMinutes("reset my alert distance"), { minutes: 15 });
  assert.deepEqual(parseAlertMinutes("change my alert distance"), { error: "missing" });
  assert.equal(parseAlertMinutes("i lost my keys"), null);

  const t = setup();
  let out = await t.a("only tell me about food within 5 min");
  assert.equal(t.user(A).alertMinutes, 5);
  assert.deepEqual(out, ["done. i'll only text u about stuff within a 5 min walk"]);
  assert.deepEqual(t.notesOf(A), []);
  assert.equal(t.user(B).alertMinutes, 15);

  out = await t.a("only alert me within 90 min");
  assert.equal(t.user(A).alertMinutes, 5);
  assert.match(out[0]!, /between 1 and 60 min/);
  out = await t.a("only alert me within 0 min");
  assert.equal(t.user(A).alertMinutes, 5);
  await t.a("only alert me within 60 min");
  assert.equal(t.user(A).alertMinutes, 60);
  await t.a("alert me within 1 min walk only");
  assert.equal(t.user(A).alertMinutes, 1);

  // No number: Troy asks, and a bare number answers.
  out = await t.a("change my alert distance");
  assert.match(out[0]!, /how many min away is too far\? anything from 1 to 60/);
  assert.equal(t.state(A)?.step, "ask_alert");
  out = await t.a("75");
  assert.match(out[0]!, /between 1 and 60/);
  assert.equal(t.user(A).alertMinutes, 1);
  await t.a("12");
  assert.equal(t.user(A).alertMinutes, 12);
  assert.equal(t.state(A), null);
});

// ---------- quiet hours ----------

test("quiet hours parsing", () => {
  const set = (start: string, end: string) => ({ set: { start, end } });
  assert.deepEqual(parseQuietHours("don't text me after midnight"), set("00:00", "08:00"));
  assert.deepEqual(parseQuietHours("quiet 11pm to 8am"), set("23:00", "08:00"));
  assert.deepEqual(parseQuietHours("quiet hours 11-7"), set("23:00", "07:00"));
  assert.deepEqual(parseQuietHours("no texts between 10:30pm and 7:15am"), set("22:30", "07:15"));
  assert.deepEqual(parseQuietHours("dont text me from 12am to 9 a.m."), set("00:00", "09:00"));
  assert.deepEqual(parseQuietHours("don't message me after 10"), set("22:00", "08:00"));
  assert.deepEqual(parseQuietHours("pls don't ping me before 9am"), set("00:00", "09:00"));
  assert.deepEqual(parseQuietHours("don't text me before 9am or after 11pm"), set("23:00", "09:00"));
  assert.deepEqual(parseQuietHours("only text me between 9am and 10pm"), set("22:00", "09:00"));
  assert.deepEqual(parseQuietHours("don't text me at night"), set("23:00", "08:00"));
  assert.deepEqual(parseQuietHours("quiet hours 23:00 to 07:30"), set("23:00", "07:30"));
  assert.deepEqual(parseQuietHours("do not disturb 1pm-3pm"), set("13:00", "15:00"));
  assert.deepEqual(parseQuietHours("turn off quiet hours"), { off: true });
  assert.deepEqual(parseQuietHours("no more quiet hours"), { off: true });
  assert.deepEqual(parseQuietHours("text me whenever"), { off: true });
  assert.deepEqual(parseQuietHours("set quiet hours"), { error: "missing" });
  assert.deepEqual(parseQuietHours("quiet 9pm to 9pm"), { error: "same" });
  assert.equal(parseQuietHours("i lost my wallet at 11pm"), null);
  assert.equal(parseQuietHours("only tell me about food within 5 min"), null);
  assert.equal(parseQuietHours("11pm to 8am"), null);
  assert.deepEqual(parseQuietHours("11pm to 8am", { bare: true }), set("23:00", "08:00"));
  assert.equal(parseClock("12", "start"), "00:00");
  assert.equal(parseClock("12", "end"), "12:00");
  assert.equal(parseClock("12am", "end"), "00:00");
  assert.equal(parseClock("12pm", "start"), "12:00");
  assert.equal(parseClock("25", "start"), null);
  assert.equal(formatClock("23:00"), "11pm");
  assert.equal(formatClock("00:00"), "midnight");
  assert.equal(formatClock("07:15"), "7:15am");
  assert.equal(formatClock("12:00"), "noon");
});

test("quiet hours through the pipeline: set, ask, clear", async () => {
  const t = setup();
  let out = await t.a("don't text me after midnight");
  assert.deepEqual(t.user(A).quietHours, { start: "00:00", end: "08:00" });
  assert.deepEqual(out, ["done. no alerts from midnight to 8am", "i'll still answer whenever u text me"]);
  assert.equal(t.user(B).quietHours, null);
  assert.deepEqual(t.notesOf(A), []);

  await t.a("quiet 11pm to 8am");
  assert.deepEqual(t.user(A).quietHours, { start: "23:00", end: "08:00" });

  out = await t.a("turn off quiet hours");
  assert.equal(t.user(A).quietHours, null);
  assert.match(out[0]!, /quiet hours are off/);

  out = await t.a("set quiet hours");
  assert.match(out[0]!, /what hours should i stay quiet/);
  assert.equal(t.state(A)?.step, "ask_quiet");
  await t.a("10pm to 7");
  assert.deepEqual(t.user(A).quietHours, { start: "22:00", end: "07:00" });
  assert.equal(t.state(A), null);

  // A rule and quiet hours in one text.
  const both = setup();
  await both.a("don't text me after 11pm and don't share my number");
  assert.deepEqual(both.user(A).quietHours, { start: "23:00", end: "08:00" });
  assert.equal(both.user(A).contactMode, "relay_only");
});

// ---------- subscriptions and spots ----------

test("subscriptions", async () => {
  assert.deepEqual(parseSubscriptions("stop the food alerts"), { add: [], remove: ["free_food"] });
  assert.deepEqual(parseSubscriptions("sign me up for free stuff"), { add: ["free_stuff"], remove: [] });
  assert.deepEqual(parseSubscriptions("unsubscribe me from events"), { add: [], remove: ["events"] });
  assert.deepEqual(parseSubscriptions("stop food alerts but sign me up for class help"), { add: ["class_help"], remove: ["free_food"] });
  assert.equal(parseSubscriptions("i want pizza"), null);

  const t = setup();
  let out = await t.a("stop the food alerts");
  assert.deepEqual(t.user(A).subscriptions, ["events"]);
  assert.deepEqual(out, ["done. ur alerts now: events"]);
  out = await t.a("sign me up for free stuff");
  assert.deepEqual(t.user(A).subscriptions, ["free_stuff", "events"]);
  assert.deepEqual(out, ["done. ur alerts now: free stuff, events"]);
  out = await t.a("stop all alerts");
  assert.deepEqual(t.user(A).subscriptions, []);
  assert.match(out[0]!, /not getting any alerts now/);
  assert.deepEqual(t.user(B).subscriptions, ["free_food", "events"]);
});

test("usual spots", async () => {
  assert.deepEqual(parseSpots("i'm usually at leavey and the village"), { set: ["leavey", "the village"] });
  assert.deepEqual(parseSpots("my spots are doheny, tcc and parkside"), { set: ["doheny", "tcc", "parkside"] });
  assert.deepEqual(parseSpots("add annenberg to my spots"), { add: ["annenberg"] });
  assert.equal(parseSpots("i lost my keys at leavey"), null);

  const t = setup();
  const out = await t.a("i'm usually at leavey and the village");
  assert.deepEqual(t.user(A).usualSpots, ["leavey", "the village"]);
  assert.deepEqual(out, ["saved. usual spots: leavey, the village"]);
  await t.a("add annenberg to my spots");
  assert.deepEqual(t.user(A).usualSpots, ["leavey", "the village", "annenberg"]);
  await t.a("remove leavey from my spots");
  assert.deepEqual(t.user(A).usualSpots, ["the village", "annenberg"]);
  await t.a("clear my spots");
  assert.deepEqual(t.user(A).usualSpots, []);
});

// ---------- preferences, list, forget ----------

test("soft preferences are saved as notes and change no setting", async () => {
  const t = setup();
  const before = t.user(A);
  assert.deepEqual(await t.a("keep it short"), ["got it. i'll remember that"]);
  assert.deepEqual(await t.a("no emoji"), ["got it. i'll remember that"]);
  assert.deepEqual(await t.a("no emoji"), ["already got that one"]);
  assert.deepEqual(t.notesOf(A), [
    { kind: "preference", text: "keep it short" },
    { kind: "preference", text: "no emoji" },
  ]);
  assert.deepEqual({ ...t.user(A) }, { ...before });
});

test("what do u know about me lists settings and notes, built in code", async () => {
  const t = setup();
  await t.a("don't share my number");
  await t.a("yes");
  await t.a("don't add me to group chats");
  await t.a("only tell me about food within 5 min");
  await t.a("quiet 11pm to 8am");
  await t.a("i'm usually at leavey and the village");
  await t.a("Keep it short");
  const out = await t.a("what do u know about me");
  assert.deepEqual(out, [
    "here's what i have. ur maya",
    "contact: relay only. i pass messages along and nobody gets ur number. group chats: off",
    "alerts: on. topics: free food, events. within a 5 min walk. quiet hours: 11pm to 8am",
    "usual spots: leavey, the village",
    "location: none saved",
    'notes: 1. "don\'t share my number" 2. "don\'t add me to group chats" 3. "keep it short"',
    'say "forget that" to drop the last one',
  ]);
  assertVoice(out);
  assert.equal(t.state(A), null);

  const empty = await t.b("what do you know about me?");
  assert.equal(empty[1], "contact: people i connect u with can text u directly. group chats: ok");
  assert.equal(empty[2], "alerts: on. topics: free food, events. within a 15 min walk. quiet hours: off");
  assert.equal(empty[3], "location: none saved");
  assert.match(empty[4]!, /no notes yet/);
});

test("settings questions are answered from the row", async () => {
  const t = setup();
  await t.a("quiet 11pm to 8am");
  await t.a("only food within 7 min");
  assert.deepEqual(await t.a("what are my quiet hours"), ["quiet hours: 11pm to 8am"]);
  assert.deepEqual(await t.a("what's my alert distance?"), ["alert distance: a 7 min walk"]);
  assert.deepEqual(await t.a("what am i subscribed to"), ["ur alerts: free food, events"]);
  assert.deepEqual(await t.a("can people text me?"), ["contact: people i connect u with can text u directly. group chats: ok"]);
  assert.deepEqual(await t.b("what are my quiet hours"), ["quiet hours are off"]);
  const all = await t.a("show me my settings");
  assert.equal(all.length, 2);
  assert.match(all[1]!, /within a 7 min walk\. quiet hours: 11pm to 8am/);
  // Asking changed nothing.
  assert.deepEqual(t.user(A).quietHours, { start: "23:00", end: "08:00" });
  assert.equal(t.user(A).alertMinutes, 7);
});

test("forget that removes the latest note and puts its setting back", async () => {
  const t = setup();
  await t.a("don't share my number");
  await t.a("yes");
  await t.a("don't add me to group chats");
  await t.a("keep it short");

  let out = await t.a("forget that");
  assert.deepEqual(out, ['done. forgot "keep it short"']);
  assert.equal(t.notesOf(A).length, 2);
  assert.equal(t.user(A).groupChatsAllowed, false);

  out = await t.a("forget that");
  assert.deepEqual(out, ['done. forgot "don\'t add me to group chats"', "group chats: ok again"]);
  assert.equal(t.user(A).groupChatsAllowed, true);
  assert.equal(t.user(A).contactMode, "relay_only");

  out = await t.a("undo that");
  assert.equal(out[1], "contact is back to: people i connect u with can text u directly");
  assert.equal(t.user(A).contactMode, "direct");
  assert.deepEqual(t.notesOf(A), []);

  assert.deepEqual(await t.a("forget that"), ["nothing to forget. i don't have any notes on u"]);
});

test("forgetting a rule after answering no to the relay offer goes all the way back", async () => {
  const t = setup();
  await t.a("relay only");
  await t.a("no");
  assert.equal(t.user(A).contactMode, "no_contact");
  await t.a("forget that");
  assert.equal(t.user(A).contactMode, "direct");
});

test("forgetting an older rule by name keeps the newer rule's setting", async () => {
  const t = setup();
  await t.a("don't share my number");
  await t.a("yes");
  await t.a("don't connect me with anyone");
  const out = await t.a("forget the number thing");
  assert.match(out[0]!, /forgot "don't share my number"/);
  assert.equal(t.user(A).contactMode, "no_contact");
  // The newer rule now goes back to where things started.
  await t.a("forget that");
  assert.equal(t.user(A).contactMode, "direct");
  assert.match((await t.a("forget the pizza thing"))[0]!, /nothing to forget/);
});

test("forget everything clears notes after one confirmation and leaves settings alone", async () => {
  const t = setup();
  await t.a("don't add me to group chats");
  await t.a("keep it short");
  await t.b("no emoji");

  let out = await t.a("forget everything");
  assert.deepEqual(out, ["that clears all 2 of ur notes. ur contact settings stay how they are", "reply yes to clear them"]);
  assert.equal(t.notesOf(A).length, 2);
  assert.equal(t.state(A)?.step, "confirm_forget_all");
  out = await t.a("nvm");
  assert.deepEqual(out, ["ok, kept everything"]);
  assert.equal(t.notesOf(A).length, 2);
  assert.equal(t.state(A), null);

  await t.a("forget everything");
  out = await t.a("yes");
  assert.match(out[0]!, /ur notes are cleared/);
  assert.deepEqual(t.notesOf(A), []);
  assert.equal(t.user(A).groupChatsAllowed, false);
  assert.equal(t.state(A), null);
  assert.equal(t.notesOf(B).length, 1);

  assert.match((await t.a("forget everything"))[0]!, /nothing to clear/);
  assert.equal(t.state(A), null);
});

test("pointers to the real commands", async () => {
  const t = setup();
  const mute = await t.a("don't text me");
  assert.match(mute[0]!, /text pause.*text STOP/);
  assert.deepEqual(t.notesOf(A), []);
  const me = await t.a("forget about me");
  assert.match(me[0]!, /delete my data/);
});

// ---------- routing ----------

test("notesIntent routes notes texts and leaves everything else alone", () => {
  const action = (s: string) => notesIntent(s)?.action ?? null;
  assert.equal(action("don't share my number"), "add_note");
  assert.equal(action("don't add me to group chats"), "add_note");
  assert.equal(action("stop the food alerts"), "add_note");
  assert.equal(action("i'm usually at leavey and the village"), "add_note");
  assert.equal(action("keep it short"), "add_note");
  assert.equal(action("don't text me after midnight"), "set_quiet_hours");
  assert.equal(action("only tell me about food within 5 min"), "set_alert_distance");
  assert.equal(action("what do u know about me"), "recall");
  assert.equal(action("what are my settings"), "recall");
  assert.equal(action("forget that"), "forget");
  assert.equal(action("forget everything"), "forget");
  for (const s of ["i lost my wallet at leavey", "found a black hydro flask", "free pizza at tcc, 20 slices", "the elevator in thh is broken", "hey", "who do i talk to about dining hall hours", "6 left", "need a ride to lax friday", "i'll take one", "thanks"]) {
    assert.equal(notesIntent(s), null, s);
  }
});

// ---------- last known location ----------

const PLACES = JSON.parse(readFileSync(join(import.meta.dirname, "../src/db/seed-data/campus_places.json"), "utf8")) as { name: string; nicknames: string[]; lat: number; lng: number; kind: string }[];
const LEAVEY = PLACES.find((p) => p.name === "Leavey Library")!;

function withPlaces() {
  const t = setup();
  const add = t.db.prepare("INSERT INTO campus_places (name, nicknames, lat, lng, kind) VALUES (?, ?, ?, ?, ?)");
  for (const p of PLACES) add.run(p.name, JSON.stringify(p.nicknames), p.lat, p.lng, p.kind);
  const row = (h: string) => ({
    ...(t.db.prepare("SELECT lastLat, lastLng, lastLocationAt, lastLocationSource FROM users WHERE id = ?").get(t.user(h).id) as { lastLat: number | null; lastLng: number | null; lastLocationAt: number | null; lastLocationSource: string | null }),
  });
  return { ...t, row };
}

test("i'm at leavey rn saves that place as the location, source asked", async () => {
  const t = withPlaces();
  const now = Date.now();
  setNotesClock(() => now);
  for (const phrase of ["i'm at leavey rn", "im at leavey", "I am at Leavey right now", "hey troy i'm by leavey library rn", "im in leavey rn"]) {
    t.db.prepare("UPDATE users SET lastLat = NULL, lastLng = NULL, lastLocationAt = NULL, lastLocationSource = NULL").run();
    const out = await t.a(phrase);
    assert.deepEqual(out, ["got it, ur at leavey library", 'i\'ll use that for walking times. say "forget my location" anytime'], phrase);
    assertVoice(out);
    assert.deepEqual(t.row(A), { lastLat: LEAVEY.lat, lastLng: LEAVEY.lng, lastLocationAt: now, lastLocationSource: "asked" }, phrase);
  }
  assert.equal(t.row(B).lastLat, null, "only the student who said it");
  assert.deepEqual(t.notesOf(A), [], "where someone is right now is not a note");
  assert.equal(t.user(A).usualSpots.length, 0, "and not a usual spot");
  assert.equal(t.state(A), null);
});

test("a place troy doesn't know is not saved, and everyday phrases are not read as places", async () => {
  const t = withPlaces();
  const out = await t.a("i'm at my cousin's place rn");
  if (out.length) assert.ok(!out.join(" ").includes("got it, ur at"));
  assert.deepEqual(await t.a("im at narnia rn"), ["i don't know that spot, so i didn't save it", 'try a campus spot, like "i\'m at leavey rn"']);
  assert.equal(t.row(A).lastLat, null);
  for (const phrase of ["i'm in a rush", "im at a loss", "i'm in class", "im at leavey and i lost my airpods", "i'm usually at leavey", "im at leavey where is the free food at tcc or the village or wherever"]) {
    assert.equal(parseAtNow(phrase), null, phrase);
    assert.ok(!parse(phrase).at, phrase);
  }
  assert.equal(parseAtNow("i'm at leavey rn"), "leavey");
  assert.equal(parseAtNow("im in the village right now"), "village");
});

test("what do u know about me says whether a location is saved and how old, by place name, never coordinates", async () => {
  const t = withPlaces();
  const now = Date.now();
  setNotesClock(() => now);
  const line = async () => (await t.a("what do u know about me")).find((b) => b.startsWith("location:"));
  assert.equal(await line(), "location: none saved");

  // 60 m from leavey: named by the nearest campus place.
  saveUserLocation(t.db, t.user(A).id, { lat: LEAVEY.lat + 0.00054, lng: LEAVEY.lng }, "find_my", now - 12 * 60_000);
  assert.equal(await line(), 'location: near leavey library. u shared it 12 min ago. say "forget my location" to erase it');

  saveUserLocation(t.db, t.user(A).id, { lat: LEAVEY.lat, lng: LEAVEY.lng }, "asked", now - LOCATION_STALE_MS - 60_000);
  assert.equal(await line(), 'location: near leavey library. u told me 3 hr ago. say "forget my location" to erase it');

  // Downtown, nowhere near a campus place.
  saveUserLocation(t.db, t.user(A).id, { lat: 34.0407123, lng: -118.2468456 }, "pin", now - 2 * 24 * 60 * 60 * 1000);
  const all = await t.a("what do u know about me");
  assert.ok(all.includes('location: a spot off campus. u shared it 2 days ago. say "forget my location" to erase it'));
  assertVoice(all);
  for (const b of all) assert.ok(!/\d{2,3}\.\d{3}/.test(b), `coordinates in: ${b}`);

  // The question on its own works too, and the other student sees nothing of it.
  assert.deepEqual(await t.a("do u have my location?"), ['location: a spot off campus. u shared it 2 days ago. say "forget my location" to erase it']);
  assert.ok((await t.b("what do u know about me")).includes("location: none saved"));
});

test("the 150 m edge: just inside is named, just outside is a spot off campus", async () => {
  const t = withPlaces();
  // Hoose Library and friends are close to each other, so use one isolated point: only the test place is in the table.
  t.db.prepare("DELETE FROM campus_places").run();
  t.db.prepare("INSERT INTO campus_places (name, nicknames, lat, lng, kind) VALUES ('Leavey Library', '[\"leavey\"]', ?, ?, 'library')").run(LEAVEY.lat, LEAVEY.lng);
  const metersNorth = (m: number) => ({ lat: LEAVEY.lat + m / 111_195, lng: LEAVEY.lng });
  saveUserLocation(t.db, t.user(A).id, metersNorth(149), "pin");
  assert.match((await t.a("what do u know about me")).join(" "), /location: near leavey library\./);
  saveUserLocation(t.db, t.user(A).id, metersNorth(151), "pin");
  assert.match((await t.a("what do u know about me")).join(" "), /location: a spot off campus\./);
});

test("forget my location erases only the location", async () => {
  const t = withPlaces();
  await t.a("keep it short");
  await t.a("i'm usually at leavey");
  // The exact phrase "forget my location" is also a code command in src/commands.ts, which answers before any flow.
  // These wordings reach this flow through the pipeline.
  for (const phrase of ["can u forget my location troy", "stop saving my location", "forget where i am", "Wipe my saved location."]) {
    saveUserLocation(t.db, t.user(A).id, { lat: LEAVEY.lat, lng: LEAVEY.lng }, "find_my");
    saveUserLocation(t.db, t.user(B).id, { lat: LEAVEY.lat, lng: LEAVEY.lng }, "pin");
    const out = await t.a(phrase);
    assert.deepEqual(out, ["done. i forgot ur location", "walking times will go off ur usual spots until u share again"], phrase);
    assertVoice(out);
    assert.deepEqual(t.row(A), { lastLat: null, lastLng: null, lastLocationAt: null, lastLocationSource: null }, phrase);
    assert.notEqual(t.row(B).lastLat, null, "someone else's location is untouched");
  }
  assert.deepEqual(t.notesOf(A), [{ kind: "preference", text: "keep it short" }], "notes stay");
  assert.deepEqual(t.user(A).usualSpots, ["leavey"], "usual spots stay");
  assert.equal(getUserLocation(t.db, t.user(A))!.source, "usual_spot");
  assert.deepEqual(await t.a("forget where i am"), ["i don't have a location saved for u"]);
  assert.deepEqual(await t.b("stop saving my location"), ["done. i forgot ur location", "i won't show walking times until u share again or tell me where u are"]);
  assert.equal(t.state(A), null);
});

test("the plain phrase forget my location works inside the notes flow itself", async () => {
  const t = withPlaces();
  for (const phrase of ["forget my location", "Forget my location.", "delete my location", "erase my last location"]) {
    assert.equal(parse(phrase).command, "forget_location", phrase);
    assert.deepEqual(notesIntent(phrase), { flow: "notes", action: "forget", details: {}, source: "fallback" }, phrase);
  }
  // Never mistaken for "forget that" (which drops a note) or for a usual-spots change.
  assert.notEqual(parse("forget that").command, "forget_location");
  assert.notEqual(parse("forget my spots").command, "forget_location");

  const user = t.user(A);
  saveUserLocation(t.db, user.id, { lat: LEAVEY.lat, lng: LEAVEY.lng }, "pin");
  const said: string[] = [];
  await notes.handle({
    db: t.db,
    user,
    event: { provider: "webchat", userHandle: A, chatId: `chat-${A}`, isGroup: false, messageId: "in-x", text: "forget my location", images: [], receivedAt: Date.now() },
    intent: { flow: "notes", action: "forget", details: {}, source: "fallback" },
    state: null,
    say: async (...b) => b.map((x) => (said.push(canon(typeof x === "string" ? x : x.text)), null)),
    sayTo: async () => [],
    sayToOwed: async () => [],
    setState: () => {},
    setStateFor: () => {},
    adapter: t.fake.adapter,
  });
  assert.deepEqual(said, ["done. i forgot ur location", "i won't show walking times until u share again or tell me where u are"]);
  assert.equal(t.row(A).lastLat, null);
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

test("notes wording pools are well formed, and the read-backs and command hints have no variants", () => {
  assert.deepEqual(poolProblems(NOTES_POOLS), []);
  for (const line of [
    "here's what i have",
    "contact: relay only. i pass messages along and nobody gets ur number. group chats: ok",
    "to mute alerts text pause. to stop every text from me text STOP",
    'to wipe everything i have on u, text "delete my data"',
  ]) {
    assert.deepEqual(NOTES_VOICE.variantsOf(line), [line]);
  }
  // Every wording of a contact setting states the same rule.
  for (const v of NOTES_VOICE.variantsOf("got it. relay only. i pass messages along and nobody gets ur number")) assert.match(v, /relay only\..*(?:nobody|no one) gets ur number$/);
  for (const v of NOTES_VOICE.variantsOf("got it. no contact. i don't connect u with anyone")) assert.match(v, /no contact\..*(?:don't|won't|not) connect(?:ing)? u with anyone$/);
  for (const v of NOTES_VOICE.variantsOf("done. no alerts from 11pm to 8am")) assert.match(v, /from 11pm to 8am$/);
});

test("notes: with other wording on every line, the setting that was saved and the times said are exactly the same", async () => {
  setVariantPicker(lastVariant);
  try {
    const t = setup();
    await t.a("quiet hours 11pm to 8am");
    await t.a("only food within 5 min");
    await t.a("don't share my number with anyone");
    await t.a("no");
    const row = t.user(A);
    assert.deepEqual(row.quietHours, { start: "23:00", end: "08:00" });
    assert.equal(row.alertMinutes, 5);
    assert.equal(row.contactMode, "no_contact");
    const mine = t.fake.sent.filter((s) => s.chatId === `chat-${A}`);
    assertSameFacts(NOTES_VOICE, mine);
    assert.ok(mine.filter((s) => s.raw !== s.text).length >= 5 && mine.length === 6, "the wording really did change");
    const raw = mine.map((s) => s.raw).join("\n");
    assert.match(raw, /from 11pm to 8am/);
    assert.match(raw, /within a 5 min walk/);
  } finally {
    setVariantPicker(null);
  }
});
