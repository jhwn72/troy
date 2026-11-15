import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { GateInput } from "../src/adapters/gate.ts";

// config reads the environment when it's first imported, so set it before importing anything.
process.env.ALLOWED_HANDLES = "(310) 555-0001";
process.env.TROY_ENABLED = "true";
delete process.env.TROY_SIGNUPS;
delete process.env.TROY_MAX_USERS;

const { openDb, setSetting, getSetting, getOrCreateUser, updateUser } = await import("../src/db/index.ts");
const { decide, isAllowedChat } = await import("../src/adapters/gate.ts");
const signups = await import("../src/signups.ts");
const { createWebchatAdapter } = await import("../src/adapters/webchat.ts");
const { SIGNUP_NOTICE_TEXT, clampCap, consumeSignupNotice, issueSignupNotice, releaseSeat, setSignupCap, setSignupsOpen, signupCap, signupCount, signupNoticeHash, signupsOpen, signupsView, wasRefusedFirstMessage } = signups;

type Db = ReturnType<typeof openDb>;
const MANUAL = "+13105550001";
const phone = (n: number) => `+1213555${String(1000 + n)}`;
const chat = (h: string) => `any;-;${h}`;

function input(handle: string, over: Partial<GateInput> = {}): GateInput {
  return { isFromMe: false, handle, chatId: chat(handle), isGroup: false, text: "hey troy", hasHistoryBeforeGoLive: async () => false, ...over };
}

const count = (db: Db, table: string) => Number((db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c);
/** Everything that could hold a trace of a refused chat. */
function traces(db: Db) {
  return { allow: count(db, "allow_list"), notices: count(db, "signup_notices"), users: count(db, "users"), messages: count(db, "messages"), salt: getSetting(db, "signup_notice_salt") };
}
const NOTHING = { allow: 0, notices: 0, users: 0, messages: 0, salt: null };

beforeEach(() => {
  // The judge pool is off for the older tests (they are about the student cap); the judge tests turn it on.
  process.env.TROY_MAX_JUDGES = "0";
  delete process.env.TROY_SIGNUPS;
  delete process.env.TROY_MAX_USERS;
  process.env.TROY_ENABLED = "true";
});

test("defaults: open, cap 40, count 0; env sets the defaults and the dashboard value wins once set", () => {
  const db = openDb(":memory:");
  assert.deepEqual(signupsView(db), { open: true, max: 40, count: 0, judges: { max: 0, count: 0 } });
  process.env.TROY_SIGNUPS = "closed";
  process.env.TROY_MAX_USERS = "25";
  assert.deepEqual(signupsView(db), { open: false, max: 25, count: 0, judges: { max: 0, count: 0 } });
  process.env.TROY_MAX_USERS = "9000";
  assert.equal(signupCap(db), 500);
  process.env.TROY_MAX_USERS = "-3";
  assert.equal(signupCap(db), 0);
  process.env.TROY_MAX_USERS = "lots";
  assert.equal(signupCap(db), 40);
  setSignupsOpen(db, true);
  assert.equal(setSignupCap(db, 12.4), 12);
  assert.deepEqual(signupsView(db), { open: true, max: 12, count: 0, judges: { max: 0, count: 0 } });
  assert.equal(getSetting(db, "signups_open"), "open");
  assert.equal(getSetting(db, "signups_max"), "12");
  assert.equal(clampCap(501), 500);
  assert.equal(clampCap(-1), 0);
  assert.equal(clampCap(null), 40);
});

test("under the cap a new hey troy is let in and counted", async () => {
  const db = openDb(":memory:");
  setSignupCap(db, 2);
  assert.deepEqual(await decide(db, input(phone(1))), { allow: true, newlyOptedIn: true });
  assert.deepEqual(await decide(db, input(phone(2))), { allow: true, newlyOptedIn: true });
  assert.equal(signupCount(db), 2);
  assert.equal(count(db, "signup_notices"), 0);
  assert.equal(getSetting(db, "signup_notice_salt"), null);
});

test("judges don't count toward the cap once they pick hackathon judge", async () => {
  const db = openDb(":memory:");
  setSignupCap(db, 1);
  const judge = phone(7);
  await decide(db, input(judge));
  assert.equal(signupCount(db), 1);
  const u = getOrCreateUser(db, judge, chat(judge));
  updateUser(db, u.id, { verifiedVia: "judge_skip" });
  assert.equal(signupCount(db), 0);
  assert.deepEqual(await decide(db, input(phone(8))), { allow: true, newlyOptedIn: true });
  assert.equal(signupCount(db), 1);
  assert.deepEqual(await decide(db, input(judge, { text: "hello" })), { allow: true, newlyOptedIn: false });
});

test("judges have their own 20 spots: a newcomer gets in on a judge spot when students are full", async () => {
  const db = openDb(":memory:");
  delete process.env.TROY_MAX_JUDGES;
  setSignupCap(db, 1);
  await decide(db, input(phone(1)));
  assert.deepEqual(signupsView(db).judges, { max: 20, count: 0 });
  const judge = phone(2);
  assert.deepEqual(await decide(db, input(judge)), { allow: true, newlyOptedIn: true });
  assert.equal(signups.studentSeatFull(db, judge), true);
  const u = getOrCreateUser(db, judge, chat(judge));
  updateUser(db, u.id, { verifiedVia: "judge_skip" });
  signups.clearJudgeSeat(db, judge);
  assert.deepEqual(signupsView(db).judges, { max: 20, count: 1 });
  assert.equal(signupCount(db), 1);
  // A student who got a judge spot keeps it once a student spot opens.
  const late = phone(3);
  await decide(db, input(late));
  assert.equal(signups.studentSeatFull(db, late), true);
  getOrCreateUser(db, phone(1), chat(phone(1)));
  updateUser(db, getOrCreateUser(db, phone(1), chat(phone(1))).id, { stopped: 1 });
  assert.equal(signups.studentSeatFull(db, late), false);
  assert.equal(signups.studentSeatFull(db, late), false);
});

test("both pools full: refused", async () => {
  const db = openDb(":memory:");
  setSignupCap(db, 1);
  process.env.TROY_MAX_JUDGES = "1";
  await decide(db, input(phone(1)));
  const j = phone(2);
  await decide(db, input(j));
  updateUser(db, getOrCreateUser(db, j, chat(j)).id, { verifiedVia: "judge_skip" });
  assert.deepEqual(await decide(db, input(phone(3))), { allow: false, notice: "full" });
});

test("at the cap: refused with 'full' once, then silently; only a salted hash is kept", async () => {
  const db = openDb(":memory:");
  setSignupCap(db, 1);
  await decide(db, input(phone(1)));
  const late = phone(2);
  assert.deepEqual(await decide(db, input(late)), { allow: false, notice: "full" });
  assert.deepEqual(await decide(db, input(late)), { allow: false });
  assert.deepEqual(await decide(db, input(late, { text: "hey troy pls" })), { allow: false });
  assert.equal(isAllowedChat(db, chat(late), late), false);
  assert.equal(signupCount(db), 1);
  const rows = db.prepare("SELECT * FROM signup_notices").all() as Record<string, unknown>[];
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["chatHash", "firstMsgs", "kind", "sentAt"]);
  assert.match(String(rows[0].chatHash), /^[0-9a-f]{64}$/);
  assert.equal(rows[0].chatHash, signupNoticeHash(db, late));
  // Nowhere in the database is the handle or chat id of the refused chat.
  const dump = JSON.stringify([db.prepare("SELECT * FROM signup_notices").all(), db.prepare("SELECT * FROM settings").all(), db.prepare("SELECT * FROM allow_list").all()]);
  assert.equal(dump.includes(late), false);
  assert.equal(dump.includes(late.slice(2)), false);
  assert.equal(count(db, "users"), 0);
  assert.equal(count(db, "messages"), 0);
  // An already allowed chat is untouched by the cap.
  assert.deepEqual(await decide(db, input(phone(1), { text: "hello" })), { allow: true, newlyOptedIn: false });
});

test("closed: refused with 'closed' once, then silently, even with room", async () => {
  const db = openDb(":memory:");
  setSignupsOpen(db, false);
  assert.deepEqual(await decide(db, input(phone(1))), { allow: false, notice: "closed" });
  assert.deepEqual(await decide(db, input(phone(1))), { allow: false });
  assert.deepEqual(await decide(db, input(phone(2))), { allow: false, notice: "closed" });
  assert.equal(signupCount(db), 0);
  assert.equal(count(db, "allow_list"), 0);
});

test("the manual list always gets in and never counts", async () => {
  const db = openDb(":memory:");
  setSignupsOpen(db, false);
  setSignupCap(db, 0);
  // ALLOWED_HANDLES: past the history rule, the switch and the cap, once they say hey troy themselves.
  assert.deepEqual(await decide(db, input(MANUAL, { hasHistoryBeforeGoLive: async () => true })), { allow: true, newlyOptedIn: true });
  // A dashboard manual entry.
  const dash = phone(7);
  db.prepare("INSERT INTO allow_list (handle, chatId, reason, addedAt) VALUES (?, NULL, 'manual', ?)").run(dash, Date.now());
  assert.deepEqual(await decide(db, input(dash, { text: "hi" })), { allow: true, newlyOptedIn: false });
  // A group Troy created.
  db.prepare("INSERT INTO allow_list (handle, chatId, reason, addedAt) VALUES (NULL, 'any;+;chat1', 'troy_group', ?)").run(Date.now());
  assert.deepEqual(await decide(db, input(phone(8), { chatId: "any;+;chat1", isGroup: true, text: "yo" })), { allow: true, newlyOptedIn: false });
  assert.equal(signupCount(db), 0);
  assert.equal(count(db, "signup_notices"), 0);
  // With the cap at 1 and sign-ups open, the one spot is still free for a student.
  setSignupsOpen(db, true);
  setSignupCap(db, 1);
  assert.deepEqual(await decide(db, input(phone(9))), { allow: true, newlyOptedIn: true });
  assert.equal(signupCount(db), 1);
});

test("everything else stays silent when full or closed: history, failed lookup, no phrase, John, groups", async () => {
  for (const mode of ["full", "closed"] as const) {
    const db = openDb(":memory:");
    if (mode === "full") setSignupCap(db, 0);
    else setSignupsOpen(db, false);
    const s = phone(1);
    assert.deepEqual(await decide(db, input(s, { hasHistoryBeforeGoLive: async () => true })), { allow: false });
    assert.deepEqual(
      await decide(db, input(s, { hasHistoryBeforeGoLive: async () => { throw new Error("lookup failed"); } })),
      { allow: false },
    );
    assert.deepEqual(await decide(db, input(s, { text: "hello" })), { allow: false });
    assert.deepEqual(await decide(db, input(s, { text: "is the demo full" })), { allow: false });
    assert.deepEqual(await decide(db, input(s, { isFromMe: true })), { allow: false });
    assert.deepEqual(await decide(db, input(s, { chatId: "any;+;chat9", isGroup: true })), { allow: false });
    assert.deepEqual(await decide(db, input(s, { chatId: null })), { allow: false });
    assert.deepEqual(traces(db), NOTHING, mode);
  }
});

test("kill switch off: no notice and nothing stored", async () => {
  const db = openDb(":memory:");
  setSignupCap(db, 0);
  setSetting(db, "troy_enabled", "false");
  assert.deepEqual(await decide(db, input(phone(1))), { allow: false });
  assert.deepEqual(traces(db), NOTHING);
  // Flipped off while the history lookup runs: still nothing.
  setSetting(db, "troy_enabled", "true");
  const d = await decide(db, input(phone(1), { hasHistoryBeforeGoLive: async () => (setSetting(db, "troy_enabled", "false"), false) }));
  assert.deepEqual(d, { allow: false });
  assert.deepEqual(traces(db), NOTHING);
});

test("a refused chat gets in later when the cap is raised or sign-ups reopen, with no second notice", async () => {
  const db = openDb(":memory:");
  setSignupCap(db, 0);
  const a = phone(1);
  assert.deepEqual(await decide(db, input(a)), { allow: false, notice: "full" });
  setSignupCap(db, 1);
  assert.deepEqual(await decide(db, input(a)), { allow: true, newlyOptedIn: true });
  assert.equal(signupCount(db), 1);

  const b = phone(2);
  setSignupsOpen(db, false);
  setSignupCap(db, 10);
  assert.deepEqual(await decide(db, input(b)), { allow: false, notice: "closed" });
  // Closed, then full: still only the one notice ever.
  setSignupsOpen(db, true);
  setSignupCap(db, 1);
  assert.deepEqual(await decide(db, input(b)), { allow: false });
  setSignupCap(db, 2);
  assert.deepEqual(await decide(db, input(b)), { allow: true, newlyOptedIn: true });
  assert.equal(count(db, "signup_notices"), 2);
});

test("two hey troys arriving together for the last spot: one gets in, one gets the notice", async () => {
  const db = openDb(":memory:");
  setSignupCap(db, 1);
  let release!: () => void;
  const both = new Promise<void>((r) => (release = r));
  let waiting = 0;
  const lookup = async () => {
    if (++waiting === 2) release();
    await both; // both lookups are in flight before either answers
    return false;
  };
  const results = await Promise.all([decide(db, input(phone(1), { hasHistoryBeforeGoLive: lookup })), decide(db, input(phone(2), { hasHistoryBeforeGoLive: lookup }))]);
  assert.equal(results.filter((r) => r.allow).length, 1);
  assert.deepEqual(results.filter((r) => !r.allow), [{ allow: false, notice: "full" }]);
  assert.equal(signupCount(db), 1);
});

test("the grant: only the gate's notice for this chat and kind, once, and never with Troy off", async () => {
  const db = openDb(":memory:");
  const h = phone(1);
  const c = chat(h);
  // No grant at all, and asking does not create a salt.
  assert.equal(consumeSignupNotice(db, c, h, "full"), false);
  assert.equal(getSetting(db, "signup_notice_salt"), null);

  assert.equal(issueSignupNotice(db, { handle: h, chatId: c, kind: "full" }), true);
  assert.equal(issueSignupNotice(db, { handle: h, chatId: c, kind: "full" }), false); // already recorded
  assert.equal(consumeSignupNotice(db, chat(phone(2)), phone(2), "full"), false); // another person
  assert.equal(consumeSignupNotice(db, `SMS;-;${h}`, h, "full"), false); // the same person's other chat
  assert.equal(consumeSignupNotice(db, c, null, "full"), false); // no handle
  assert.equal(consumeSignupNotice(db, c, h, "closed"), false); // another kind
  assert.equal(consumeSignupNotice(db, c, h, "full"), true);
  assert.equal(consumeSignupNotice(db, c, h, "full"), false); // used up

  const d = phone(3);
  assert.equal(issueSignupNotice(db, { handle: d, chatId: chat(d), kind: "closed" }), true);
  setSetting(db, "troy_enabled", "false");
  assert.equal(consumeSignupNotice(db, chat(d), d, "closed"), false);

  // A grant belongs to the database it was issued on.
  const other = openDb(":memory:");
  const e = phone(4);
  issueSignupNotice(db, { handle: e, chatId: chat(e), kind: "full" });
  assert.equal(consumeSignupNotice(other, chat(e), e, "full"), false);
});

test("one person, several chat ids (iMessage, SMS, any): the notice is recorded per handle and given once", async () => {
  const db = openDb(":memory:");
  setSignupCap(db, 0);
  const h = phone(1);
  assert.deepEqual(await decide(db, input(h, { chatId: `iMessage;-;${h}` })), { allow: false, notice: "full" });
  assert.deepEqual(await decide(db, input(h, { chatId: `SMS;-;${h}` })), { allow: false });
  assert.deepEqual(await decide(db, input(h, { chatId: `any;-;${h}` })), { allow: false });
  assert.equal(count(db, "signup_notices"), 1);
  // The grant is for the chat that was refused first, and only that one.
  assert.equal(consumeSignupNotice(db, `SMS;-;${h}`, h, "full"), false);
  assert.equal(consumeSignupNotice(db, `iMessage;-;${h}`, h, "full"), true);
});

test("the refused first message is remembered as a salted hash only, for the history rule", async () => {
  const db = openDb(":memory:");
  setSignupCap(db, 0);
  const h = phone(1);
  // Nothing recorded yet: no match, and asking creates nothing.
  assert.equal(wasRefusedFirstMessage(db, h, "MSG-A"), false);
  assert.equal(getSetting(db, "signup_notice_salt"), null);
  assert.deepEqual(await decide(db, input(h, { firstMessageId: () => "MSG-A" })), { allow: false, notice: "full" });
  assert.equal(wasRefusedFirstMessage(db, h, "MSG-A"), true);
  assert.equal(wasRefusedFirstMessage(db, h, "MSG-B"), false);
  assert.equal(wasRefusedFirstMessage(db, phone(2), "MSG-A"), false);
  // A retry that is not its chat's first message adds nothing; a first message in another chat is added quietly.
  assert.deepEqual(await decide(db, input(h, { firstMessageId: () => null })), { allow: false });
  assert.deepEqual(await decide(db, input(h, { chatId: `SMS;-;${h}`, firstMessageId: () => "MSG-C" })), { allow: false });
  assert.equal(wasRefusedFirstMessage(db, h, "MSG-C"), true);
  const row = db.prepare("SELECT * FROM signup_notices").get() as { firstMsgs: string };
  assert.match(row.firstMsgs, /^[0-9a-f]{64} [0-9a-f]{64}$/);
  const dump = JSON.stringify([db.prepare("SELECT * FROM signup_notices").all(), db.prepare("SELECT * FROM settings").all()]);
  assert.equal(/MSG-[AC]/.test(dump), false);
  assert.equal(dump.includes(h), false);
  // Never asked for when the chat is let in, has history, or did not say the phrase.
  let asked = 0;
  const spy = () => (asked++, "MSG-Z");
  await decide(db, input(phone(3), { hasHistoryBeforeGoLive: async () => true, firstMessageId: spy }));
  await decide(db, input(phone(3), { text: "hello", firstMessageId: spy }));
  setSignupCap(db, 5);
  await decide(db, input(phone(3), { firstMessageId: spy }));
  assert.equal(asked, 0);
});

test("the count gives a seat back on STOP and on delete my data, and takes it back when they return", async () => {
  const db = openDb(":memory:");
  setSignupCap(db, 1);
  const a = phone(1);
  await decide(db, input(a));
  const user = getOrCreateUser(db, a, chat(a));
  assert.equal(signupCount(db), 1);
  assert.deepEqual(await decide(db, input(phone(2))), { allow: false, notice: "full" });

  // STOP: the seat is free, and START (stopped = 0) takes it back.
  updateUser(db, user.id, { stopped: 1 });
  assert.equal(signupCount(db), 0);
  assert.deepEqual(await decide(db, input(phone(3))), { allow: true, newlyOptedIn: true });
  updateUser(db, user.id, { stopped: 0 });
  assert.equal(signupCount(db), 2); // an existing user coming back may go over the cap

  // "delete my data": free until they text again; the allow-list row stays so they can come back.
  releaseSeat(db, a);
  assert.equal(signupCount(db), 1);
  assert.equal(isAllowedChat(db, chat(a), a), true);
  assert.deepEqual(await decide(db, input(a, { text: "hey troy" })), { allow: true, newlyOptedIn: false });
  assert.equal(signupCount(db), 2);
  assert.equal(getSetting(db, `signup_left:${a}`), null);
});

test("someone who came in by the phrase and was then put on the manual list no longer counts", async () => {
  const db = openDb(":memory:");
  await decide(db, input(phone(1)));
  await decide(db, input(phone(2)));
  assert.equal(signupCount(db), 2);
  db.prepare("INSERT INTO allow_list (handle, chatId, reason, addedAt) VALUES (?, NULL, 'manual', ?)").run(phone(1), Date.now());
  assert.equal(signupCount(db), 1);
  // On ALLOWED_HANDLES with an old opt-in row: not counted either.
  db.prepare("INSERT INTO allow_list (handle, chatId, reason, addedAt) VALUES (?, ?, 'opt_in_phrase', ?)").run(MANUAL, chat(MANUAL), Date.now());
  assert.equal(signupCount(db), 1);
});

test("webchat: a refused phone sees the one fixed line once, and nothing else happens", async () => {
  const db = openDb(":memory:");
  const events: unknown[] = [];
  const { adapter, routes } = createWebchatAdapter({ db, onEvent: async (e) => void events.push(e) });
  const post = async (path: string, body: unknown) =>
    (await (await routes.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as Record<string, unknown>;
  const wc = (h: string) => `webchat;-;${h}`;
  setSignupCap(db, 1);
  assert.equal((await post("/webchat/send", { handle: phone(1), text: "hey troy" })).accepted, true);

  const late = phone(2);
  assert.equal((await post("/webchat/send", { handle: late, text: "hey troy" })).accepted, false);
  assert.equal((await post("/webchat/send", { handle: late, text: "hey troy" })).accepted, false);
  assert.equal((await post("/webchat/send", { handle: late, text: "why" })).accepted, false);
  const seen = adapter.transcript(wc(late));
  assert.deepEqual(seen.map((e) => [e.from, e.kind, e.text]), [["troy", "message", "demo's full rn, try again in a bit"]]);
  assert.equal(events.length, 1);
  assert.equal(count(db, "users"), 0);
  assert.equal(count(db, "messages"), 0);
  // Ordinary sends to the refused chat are still locked.
  assert.equal(await adapter.sendMessage(wc(late), "hi"), null);
  await adapter.markRead(wc(late));
  await adapter.startTyping(wc(late));
  assert.equal(adapter.transcript(wc(late)).length, 1);

  // Closed: the other fixed line, for a phone that has not been told anything yet.
  setSignupsOpen(db, false);
  const third = phone(3);
  await post("/webchat/send", { handle: third, text: "hey troy" });
  assert.deepEqual(adapter.transcript(wc(third)).map((e) => e.text), ["sign-ups are closed rn"]);
  // A phone with old history gets nothing at all.
  const old = phone(4);
  await post("/webchat/history", { handle: old, hasOldHistory: true });
  await post("/webchat/send", { handle: old, text: "hey troy" });
  assert.equal(adapter.transcript(wc(old)).length, 0);

  // Reopened with room: the refused phone gets in.
  setSignupsOpen(db, true);
  setSignupCap(db, 5);
  assert.equal((await post("/webchat/send", { handle: late, text: "hey troy" })).accepted, true);
  assert.equal(signupCount(db), 2);
});

test("webchat adapter method: refuses without a grant, a second use, a wrong kind, a group and with Troy off", async () => {
  const db = openDb(":memory:");
  const { adapter } = createWebchatAdapter({ db, onEvent: async () => {} });
  const c = `webchat;-;${phone(1)}`;
  const send = adapter.sendSignupNotice!.bind(adapter);
  assert.equal(await send(c, "full"), false);
  issueSignupNotice(db, { handle: phone(1), chatId: c, kind: "full" });
  assert.equal(await send(c, "closed"), false);
  assert.equal(await send(c, "nope" as "full"), false);
  assert.equal(await send(c, "full"), true);
  assert.equal(await send(c, "full"), false);
  assert.deepEqual(adapter.transcript(c).map((e) => e.text), [SIGNUP_NOTICE_TEXT.full]);

  const g = "webchat;+;abcd1234";
  issueSignupNotice(db, { handle: phone(5), chatId: g, kind: "full" });
  assert.equal(await send(g, "full"), false);

  const d = `webchat;-;${phone(2)}`;
  issueSignupNotice(db, { handle: phone(2), chatId: d, kind: "closed" });
  setSetting(db, "troy_enabled", "false");
  assert.equal(await send(d, "closed"), false);
  assert.equal(adapter.transcript(d).length, 0);
});

test("the two fixed lines, word for word", () => {
  assert.deepEqual(SIGNUP_NOTICE_TEXT, { full: "demo's full rn, try again in a bit", closed: "sign-ups are closed rn" });
  assert.equal(signupsOpen(openDb(":memory:")), true);
});
