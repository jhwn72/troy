import { test } from "node:test";
import assert from "node:assert/strict";
import type { GateInput } from "../src/adapters/gate.ts";

// config reads the environment when it's first imported, so set it before importing anything.
process.env.ALLOWED_HANDLES = "(310) 555-0001, Judge@Example.com";
process.env.TROY_ENABLED = "true";

const { openDb, setSetting, getSetting } = await import("../src/db/index.ts");
const gate = await import("../src/adapters/gate.ts");
const { normalizeHandle, isEnabled } = await import("../src/config.ts");
const { decide, isOptInPhrase, isAllowedChat, allowChat, removeFromAllowList, sendAllowed, getGoLiveAt } = gate;

const STRANGER = "+12135550199";
const chat = (h: string) => `any;-;${h}`;

function input(over: Partial<GateInput> = {}): GateInput & { lookups: number } {
  const i = {
    isFromMe: false,
    handle: STRANGER,
    chatId: chat(STRANGER),
    isGroup: false,
    text: "hello",
    lookups: 0,
    hasHistoryBeforeGoLive: async () => {
      i.lookups++;
      return false;
    },
    ...over,
  };
  if (over.hasHistoryBeforeGoLive) {
    const inner = over.hasHistoryBeforeGoLive;
    i.hasHistoryBeforeGoLive = async () => {
      i.lookups++;
      return inner();
    };
  }
  return i;
}

const rows = (db: ReturnType<typeof openDb>) => db.prepare("SELECT handle, chatId, reason FROM allow_list").all();

test("isOptInPhrase: variants", () => {
  for (const t of ["hey troy", "Hey Troy!", "HEY TROY", "  hey,  troy  ", "hey troy, i lost my wallet", "Hey Troy.", "hey\ntroy", "👋 hey troy", "Hey Troy's free food?"]) {
    assert.equal(isOptInPhrase(t), true, t);
  }
  for (const t of ["", "hey", "troy", "hey there troy", "heytroy", "hey troye", "ok hey troy", "they troy", "hi troy", "hey troyy"]) {
    assert.equal(isOptInPhrase(t), false, t);
  }
  assert.equal(isOptInPhrase(undefined as unknown as string), false);
});

test("John's own message is denied first, even in an allowed chat and even saying hey troy", async () => {
  const db = openDb(":memory:");
  const i = input({ isFromMe: true, handle: "+13105550001", chatId: chat("+13105550001"), text: "hey troy" });
  assert.deepEqual(await decide(db, i), { allow: false });
  assert.equal(i.lookups, 0);
  // A missing isFromMe counts as John's.
  assert.deepEqual(await decide(db, input({ isFromMe: undefined as unknown as boolean, handle: "+13105550001", chatId: chat("+13105550001") })), { allow: false });
  assert.equal(rows(db).length, 0);
});

test("a stranger's normal text is denied with no lookup and no row", async () => {
  const db = openDb(":memory:");
  const i = input({ text: "are we still on for dinner?" });
  assert.deepEqual(await decide(db, i), { allow: false });
  assert.equal(i.lookups, 0);
  assert.equal(rows(db).length, 0);
});

test("a stranger saying hey troy with prior history is denied", async () => {
  const db = openDb(":memory:");
  const i = input({ text: "hey troy", hasHistoryBeforeGoLive: async () => true });
  assert.deepEqual(await decide(db, i), { allow: false });
  assert.equal(i.lookups, 1);
  assert.equal(rows(db).length, 0);
  assert.equal(isAllowedChat(db, chat(STRANGER), STRANGER), false);
});

test("a brand-new chat saying hey troy is allowed and recorded", async () => {
  const db = openDb(":memory:");
  assert.deepEqual(await decide(db, input({ text: "Hey Troy!" })), { allow: true, newlyOptedIn: true });
  assert.deepEqual(rows(db).map((r) => ({ ...r })), [{ handle: STRANGER, chatId: chat(STRANGER), reason: "opt_in_phrase" }]);
});

test("a later message from an opted-in chat is allowed without another lookup", async () => {
  const db = openDb(":memory:");
  await decide(db, input({ text: "hey troy" }));
  const later = input({ text: "i lost my airpods", hasHistoryBeforeGoLive: async () => true });
  assert.deepEqual(await decide(db, later), { allow: true, newlyOptedIn: false });
  assert.equal(later.lookups, 0);
  // Saying it again isn't a new opt-in.
  assert.deepEqual(await decide(db, input({ text: "hey troy" })), { allow: true, newlyOptedIn: false });
  assert.equal(rows(db).length, 1);
});

test("manual env list: phone and email handles, any text, no lookup", async () => {
  const db = openDb(":memory:");
  const phone = input({ handle: "+13105550001", chatId: chat("+13105550001"), text: "yo", hasHistoryBeforeGoLive: async () => true });
  assert.deepEqual(await decide(db, phone), { allow: true, newlyOptedIn: false });
  assert.equal(phone.lookups, 0);
  const email = input({ handle: "judge@example.com", chatId: chat("judge@example.com"), text: "yo" });
  assert.deepEqual(await decide(db, email), { allow: true, newlyOptedIn: false });
  assert.equal(rows(db).length, 0);
});

test("manual rows added from the dashboard work, and removal takes effect", async () => {
  const db = openDb(":memory:");
  allowChat(db, { handle: STRANGER, chatId: null, reason: "manual" });
  allowChat(db, { handle: STRANGER, chatId: null, reason: "manual" }); // no duplicate
  assert.equal(rows(db).length, 1);
  assert.deepEqual(await decide(db, input()), { allow: true, newlyOptedIn: false });
  removeFromAllowList(db, STRANGER);
  assert.deepEqual(await decide(db, input()), { allow: false });
});

test("removing an opted-in handle closes the chat again", async () => {
  const db = openDb(":memory:");
  await decide(db, input({ text: "hey troy" }));
  removeFromAllowList(db, STRANGER);
  assert.equal(rows(db).length, 0);
  assert.deepEqual(await decide(db, input({ text: "thanks" })), { allow: false });
});

test("group chats: denied unless Troy created them", async () => {
  const db = openDb(":memory:");
  const group = "any;+;chat123456";
  // hey troy in a group does nothing
  const g1 = input({ isGroup: true, chatId: group, text: "hey troy" });
  assert.deepEqual(await decide(db, g1), { allow: false });
  assert.equal(g1.lookups, 0);
  // a manual-list handle doesn't make the group allowed
  assert.deepEqual(await decide(db, input({ isGroup: true, chatId: group, handle: "+13105550001" })), { allow: false });
  // nor does an opted-in handle
  await decide(db, input({ text: "hey troy" }));
  assert.deepEqual(await decide(db, input({ isGroup: true, chatId: group })), { allow: false });
  // a group guid is treated as a group even if the caller says it isn't
  assert.deepEqual(await decide(db, input({ isGroup: false, chatId: group, handle: "+13105550001" })), { allow: false });
  assert.equal(isAllowedChat(db, group, "+13105550001"), false);
  assert.equal(sendAllowed(db, group, null), false);
  // a manual row for the group's chat id isn't enough either
  allowChat(db, { handle: null, chatId: group, reason: "manual" });
  assert.deepEqual(await decide(db, input({ isGroup: true, chatId: group })), { allow: false });
  assert.equal(sendAllowed(db, group, null), false);
  // Troy's own group is allowed
  allowChat(db, { handle: null, chatId: group, reason: "troy_group" });
  assert.deepEqual(await decide(db, input({ isGroup: true, chatId: group })), { allow: true, newlyOptedIn: false });
  assert.equal(sendAllowed(db, group, null), true);
  assert.deepEqual(await decide(db, input({ isGroup: true, chatId: "any;+;chat999" })), { allow: false });
});

test("kill switch off denies everything, including allowed chats and sends", async () => {
  const db = openDb(":memory:");
  await decide(db, input({ text: "hey troy" }));
  setSetting(db, "troy_enabled", "false");
  assert.deepEqual(await decide(db, input({ text: "hi" })), { allow: false });
  assert.deepEqual(await decide(db, input({ handle: "+13105550001", chatId: chat("+13105550001") })), { allow: false });
  const fresh = input({ handle: "+12135550123", chatId: chat("+12135550123"), text: "hey troy" });
  assert.deepEqual(await decide(db, fresh), { allow: false });
  assert.equal(fresh.lookups, 0);
  assert.equal(sendAllowed(db, chat(STRANGER), STRANGER), false);
  setSetting(db, "troy_enabled", "true");
  assert.equal(sendAllowed(db, chat(STRANGER), STRANGER), true);

  process.env.TROY_ENABLED = "false";
  try {
    assert.deepEqual(await decide(db, input({ text: "hi" })), { allow: false });
    assert.equal(sendAllowed(db, chat(STRANGER), STRANGER), false);
  } finally {
    process.env.TROY_ENABLED = "true";
  }
});

test("kill switch flipped during the history lookup still denies", async () => {
  const db = openDb(":memory:");
  const i = input({
    text: "hey troy",
    hasHistoryBeforeGoLive: async () => {
      setSetting(db, "troy_enabled", "false");
      return false;
    },
  });
  assert.deepEqual(await decide(db, i), { allow: false });
  assert.equal(rows(db).length, 0);
});

test("the history lookup throwing denies", async () => {
  const db = openDb(":memory:");
  const i = input({
    text: "hey troy",
    hasHistoryBeforeGoLive: async () => {
      throw new Error("server down");
    },
  });
  assert.deepEqual(await decide(db, i), { allow: false });
  assert.equal(rows(db).length, 0);
});

test("missing handle or chat id denies", async () => {
  const db = openDb(":memory:");
  assert.deepEqual(await decide(db, input({ handle: null, text: "hey troy" })), { allow: false });
  assert.deepEqual(await decide(db, input({ chatId: null, text: "hey troy" })), { allow: false });
  assert.deepEqual(await decide(db, input({ handle: null, chatId: chat("+13105550001") })), { allow: false });
});

test("sendAllowed and isAllowedChat for 1:1 chats", () => {
  const db = openDb(":memory:");
  assert.equal(sendAllowed(db, chat(STRANGER), STRANGER), false);
  assert.equal(sendAllowed(db, chat("+13105550001"), "+13105550001"), true);
  assert.equal(sendAllowed(db, chat("+13105550001"), null), false);
  assert.equal(isAllowedChat(db, "", "+13105550001"), false);
});

test("getGoLiveAt is set once and then stays", () => {
  const db = openDb(":memory:");
  assert.equal(getSetting(db, "go_live_at"), null);
  const first = getGoLiveAt(db);
  assert.ok(Math.abs(first - Date.now()) < 2000);
  assert.equal(getSetting(db, "go_live_at"), String(first));
  setSetting(db, "go_live_at", "1700000000000");
  assert.equal(getGoLiveAt(db), 1700000000000);
});

test("normalizeHandle: US forms agree, and a number with a plus keeps its own country code", () => {
  for (const us of ["+1 (213) 555-0101", "2135550101", "12135550101", "(213) 555-0101"]) assert.equal(normalizeHandle(us), "+12135550101");
  assert.equal(normalizeHandle("+65 9123 4567"), "+6591234567");
  assert.equal(normalizeHandle("+6591234567"), "+6591234567");
  assert.equal(normalizeHandle("+47 12 34 56 78"), "+4712345678");
  assert.equal(normalizeHandle("+45 12 34 56 78"), "+4512345678");
  assert.equal(normalizeHandle("+44 7911 123456"), "+447911123456");
  assert.equal(normalizeHandle("Judge@Example.com"), "judge@example.com");
  for (const bad of ["", "hello", "+123", "12345", "442079460000", null, 5]) assert.equal(normalizeHandle(bad), null);
});

test("a foreign number is not allowed just because the same digits with +1 are on the list", () => {
  const db = openDb(":memory:");
  allowChat(db, { handle: "+16591234567", chatId: null, reason: "manual" });
  assert.equal(isAllowedChat(db, chat("+16591234567"), "+16591234567"), true);
  assert.equal(isAllowedChat(db, chat("+6591234567"), normalizeHandle("+6591234567")), false);
  assert.equal(sendAllowed(db, chat("+6591234567"), normalizeHandle("+6591234567")), false);
});

test("TROY_ENABLED fails closed: only true/1/on/yes (or unset) leave Troy on", () => {
  const db = openDb(":memory:");
  try {
    for (const off of ["false", "FALSE", "0", "off", "no", "", "disabled", "nope"]) {
      process.env.TROY_ENABLED = off;
      assert.equal(isEnabled(db), false, JSON.stringify(off));
    }
    for (const on of ["true", "TRUE", "1", "on", "yes", " true "]) {
      process.env.TROY_ENABLED = on;
      assert.equal(isEnabled(db), true, on);
    }
    delete process.env.TROY_ENABLED;
    assert.equal(isEnabled(db), true);
    for (const off of ["false", "0", "off", ""]) {
      setSetting(db, "troy_enabled", off);
      assert.equal(isEnabled(db), false, `setting ${JSON.stringify(off)}`);
    }
    setSetting(db, "troy_enabled", "true");
    assert.equal(isEnabled(db), true);
  } finally {
    process.env.TROY_ENABLED = "true";
  }
});
