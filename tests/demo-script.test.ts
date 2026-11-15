// Scripted demo mode (src/demo-script.ts) through the real pipeline with a fake adapter and a faked model.

import { test, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IncomingEvent, IncomingImage, MessagingAdapter, TapbackType } from "../src/types.ts";
import { openDb, getOrCreateUser, updateUser, getUserById, getFlowState, setFlowState } from "../src/db/index.ts";
import { createPipeline } from "../src/pipeline.ts";
import { fallbackIntent, setModelCall } from "../src/ai.ts";
import { TEMPLATES } from "../src/commands.ts";
import { canAlert } from "../src/quiet.ts";
import { setFirstTenDeps } from "../src/firstten.ts";

console.warn = () => {};
setFirstTenDeps({ timers: false });

const DEMO = "+12135550111";
const OTHER = "+12135550122";
const MEMBER = "+12135550133";
const ENV_KEYS = ["TROY_DEMO_SCRIPT", "TROY_DEMO_HANDLES", "TROY_DEMO_MEMBER", "TROY_DEMO_MEMBER_NAME", "TROY_DEMO_WALLET_PHOTO"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

const dir = mkdtempSync(join(tmpdir(), "troy-demo-"));
const WALLET_PHOTO = join(dir, "wallet.jpg");
writeFileSync(WALLET_PHOTO, "jpeg");
const FOOD_PHOTO: IncomingImage = { path: join(dir, "food.jpg"), mime: "image/jpeg" };
let editsOn = false;
let photoIsFood = true;
const edited: string[] = [];

after(() => {
  rmSync(dir, { recursive: true, force: true });
  setFirstTenDeps(null);
});

let modelCalls: string[] = [];
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.TROY_DEMO_SCRIPT = "on";
  process.env.TROY_DEMO_HANDLES = "(213) 555-0111, someone@usc.edu";
  process.env.TROY_DEMO_MEMBER = "213-555-0133";
  process.env.TROY_DEMO_MEMBER_NAME = "maya";
  modelCalls = [];
  // Any model call fails except the demo food read, which says pizza.
  setModelCall(async (opts) => {
    modelCalls.push(opts.system.slice(0, 40));
    if (opts.system.includes("could be shared")) return JSON.stringify(photoIsFood ? { isFood: true, food: "Pizza", servings: 12 } : { isFood: false });
    throw new Error("off");
  });
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setModelCall(null);
});

function world(opts: { groupChat?: string | null } = {}) {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO directory (kind, name, topics, contactMethod, url, details) VALUES ('office', 'DPS Lost & Found', '[]', ?, ?, ?)").run(
    "213-740-9759",
    "https://dps.usc.edu/services/lost-and-found/",
    "University Park Campus: 3667 McClintock Ave, Los Angeles, CA 90089.",
  );
  const sent: { chatId: string; text: string }[] = [];
  const images: { chatId: string; path: string }[] = [];
  const groups: { members: string[]; first: string }[] = [];
  const typing: string[] = [];
  const reads: string[] = [];
  let n = 0;
  const adapter: MessagingAdapter = {
    provider: "webchat",
    capabilities: () => ({ tapbacks: true, typing: true, readReceipts: true, edits: false, effects: true, polls: false, groupChats: true, contactCard: true, liveLocation: false }),
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
      return { messageId: `out-${++n}` };
    },
    async sendImage(chatId, path) {
      images.push({ chatId, path });
      return { messageId: `out-${++n}` };
    },
    async sendContactCard() {
      return { messageId: `out-${++n}` };
    },
    async markRead(chatId) {
      reads.push(chatId);
    },
    async startTyping(chatId) {
      typing.push(chatId);
    },
    async stopTyping() {},
    async react() {
      return true;
    },
    async editMessage(_c, _id, text) {
      if (!editsOn) return false;
      edited.push(text);
      return true;
    },
    async sendPoll(_c, _q, options) {
      return { optionMessageIds: options.map(() => null), mode: "numbered" };
    },
    async createGroupChat(members, first) {
      groups.push({ members, first });
      return opts.groupChat === undefined ? "group-1" : opts.groupChat;
    },
    async getLiveLocation() {
      return null;
    },
    requestLocation: async () => false,
    chatIdForHandle: (h) => `chat-${h}`,
  };
  const pauses: number[] = [];
  const pipeline = createPipeline({ db, getAdapter: () => adapter, pause: async (ms) => void pauses.push(ms), ackAfterMs: 60_000, detectIntent: async (i) => fallbackIntent(i) });

  let m = 0;
  function person(handle: string, opts2: { verified?: boolean; name?: string } = {}) {
    const chatId = `chat-${handle}`;
    const u = getOrCreateUser(db, handle, chatId);
    if (opts2.verified !== false) updateUser(db, u.id, { verifiedAt: Date.now(), verifiedVia: "usc_email", name: opts2.name ?? "John Wang", uscEmail: "john@usc.edu" });
    const event = (over: Partial<IncomingEvent>): IncomingEvent => ({ provider: "webchat", userHandle: handle, chatId, isGroup: false, messageId: `in-${++m}`, text: "", images: [], receivedAt: Date.now(), ...over });
    const texts = () => sent.filter((s) => s.chatId === chatId).map((s) => s.text);
    const say = async (text: string, imgs: IncomingImage[] = []) => {
      const before = texts().length;
      await pipeline.handleEvent(event({ text, images: imgs }));
      return texts().slice(before);
    };
    const tap = async (text: string, type: TapbackType) => {
      const out = db.prepare("SELECT providerMessageId AS id, text FROM messages WHERE chatId = ? AND direction = 'out' ORDER BY id DESC").all(chatId) as { id: string; text: string }[];
      const target = out.find((r) => r.text === text)!;
      const before = texts().length;
      await pipeline.handleEvent(event({ reaction: { targetMessageId: target.id, type, removed: false } }));
      return texts().slice(before);
    };
    return { id: u.id, handle, chatId, say, tap, texts };
  }
  return { db, sent, images, groups, typing, reads, pauses, pipeline, person };
}

const HELLO = ["hey, i'm troy", "i'm an ai that knows a guy for everything on campus", "text me what u need, or send a photo, and i'll find the right person and connect u"];
const WALLET_OPEN = [
  "oh no, on it",
  "checking what's been turned in near u",
  "found something. someone turned in a wallet earlier today",
  "quick check first so i know it's urs",
  "describe it for me in ur own words. anything only the owner would know",
];
const USG_OFFER = ["sounds like something usg can hear u out on", "want me to connect u? i've got a board member who's all ears"];

/** Nothing in any scene may reach anyone but the demo handle. */
function onlyDemo(w: ReturnType<typeof world>): void {
  for (const s of w.sent) assert.equal(s.chatId, `chat-${DEMO}`, `sent to someone else: ${s.text}`);
}

test("off by default: a listed handle gets normal troy", async () => {
  delete process.env.TROY_DEMO_SCRIPT;
  const w = world();
  const john = w.person(DEMO);
  const out = await john.say("i lost my wallet. anyone got it?");
  assert.ok(!out.includes("checking what's been turned in near u"));
  assert.equal(w.db.prepare("SELECT value FROM settings WHERE key = ?").get(`demo:${john.id}`), undefined);
});

test("on, but a handle that isn't listed gets normal troy", async () => {
  const w = world();
  const other = w.person(OTHER);
  const out = await other.say("i lost my wallet. anyone got it?");
  assert.ok(out.length > 0);
  assert.ok(!out.includes("checking what's been turned in near u"));
  const hi = await other.say("hey troy");
  assert.notDeepEqual(hi, HELLO);
});

test("hello: exact bubbles, read receipt and typing, verified without an email", async () => {
  const w = world();
  const john = w.person(DEMO, { verified: false });
  setFlowState(w.db, john.id, { flow: "onboarding", step: "email", data: {} });
  const out = await john.say("Hey Troy!");
  assert.deepEqual(out, HELLO);
  const u = getUserById(w.db, john.id)!;
  assert.ok(u.verifiedAt);
  assert.equal(u.verifiedVia, "usc_email");
  assert.equal(getFlowState(w.db, john.id), null);
  assert.ok(w.reads.includes(john.chatId));
  assert.ok(w.typing.filter((c) => c === john.chatId).length >= 3);
  // Saved like any conversation.
  const rows = w.db.prepare("SELECT direction, text FROM messages WHERE chatId = ? ORDER BY id").all(john.chatId) as { direction: string; text: string }[];
  assert.equal(rows[0]!.direction, "in");
  assert.equal(rows.filter((r) => r.direction === "out").length, 3);
  // Nothing asks for an email afterwards either.
  const next = await john.say("what's up");
  assert.ok(!next.some((t) => /email|@usc\.edu/i.test(t)));
  onlyDemo(w);
});

test("lost wallet: any description passes, photo, dps, code, thank u", async () => {
  process.env.TROY_DEMO_WALLET_PHOTO = WALLET_PHOTO;
  const w = world();
  const john = w.person(DEMO);
  const open = await john.say("i lost my wallet. anyone got it?");
  assert.deepEqual(open, WALLET_OPEN);
  assert.ok(w.pauses.includes(2500), "the checking beat");
  const done = await john.say("it's a bright green plastic one, nothing in it");
  assert.equal(done[0], "that checks out. it's urs ✅");
  assert.equal(done[1], "the finder says they dropped it at dps lost and found earlier today");
  assert.equal(done[2], "dps lost and found is at 3667 mcclintock ave");
  assert.match(done[3]!, /^ur pickup code is [A-HJ-NP-Z2-9]{6}\. show it at the counter$/);
  assert.equal(done[4], "want me to send them a thank u?");
  assert.deepEqual(w.images, [{ chatId: john.chatId, path: WALLET_PHOTO }]);
  assert.ok(!done.some((t) => /line up|doesn't match/i.test(t)));
  assert.deepEqual(await john.say("yes pls, thank u so much"), ["sent ✅ they said glad it found its way back"]);
  // Scene over: the next thing is normal troy again.
  assert.equal(w.db.prepare("SELECT value FROM settings WHERE key = ?").get(`demo:${john.id}`)?.value ?? "", "");
  onlyDemo(w);
});

test("lost wallet: no photo when the env file is missing, anything else ends with anytime, nvm resets", async () => {
  process.env.TROY_DEMO_WALLET_PHOTO = join(dir, "missing.jpg");
  const w = world();
  const john = w.person(DEMO);
  await john.say("has anyone seen my wallet?? i think i lost it");
  const done = await john.say("brown");
  assert.equal(done[0], "that checks out. it's urs ✅");
  assert.equal(w.images.length, 0);
  assert.deepEqual(await john.say("cool"), ["anytime 🫡"]);
  await john.say("lost my wallet");
  assert.deepEqual(await john.say("nvm found it"), ["all good, lmk if it turns up"]);
  onlyDemo(w);
});

test("usg: offer, yes opens a real group with the member, first message names both", async () => {
  const w = world();
  const john = w.person(DEMO);
  const offer = await john.say("id like an upgrade on our public restroom toilet paper. can we add that to the budget");
  assert.deepEqual(offer, USG_OFFER);
  const yes = await john.say("yeah");
  assert.deepEqual(yes, ["u two are in a group chat now", "i'll step back, holler if u need anything else"]);
  assert.equal(w.groups.length, 1);
  assert.deepEqual(w.groups[0]!.members, [DEMO, MEMBER]);
  assert.equal(w.groups[0]!.first, "hey! connecting u two. john has an idea for the restroom budget, and maya is on usg's committee for it. i'll let u take it from here");
  onlyDemo(w);
});

test("usg: a thumbs up on the offer is a yes; null group falls back; no leaves it", async () => {
  const w = world({ groupChat: null });
  const john = w.person(DEMO, { name: "" });
  delete process.env.TROY_DEMO_MEMBER_NAME;
  await john.say("can usg add better bathrooms to the budget?");
  const out = await john.tap(USG_OFFER[1]!, "like");
  assert.deepEqual(out, ["couldn't open the group rn, so i'll pass messages between u two"]);
  assert.equal(w.groups[0]!.first, "hey! connecting u two. this trojan has an idea for the restroom budget, and our usg board member is on usg's committee for it. i'll let u take it from here");
  await john.say("i have a complaint for student government about the restrooms");
  assert.deepEqual(await john.say("no"), ["all good, i'll leave it"]);
  assert.equal(w.groups.length, 1);
  onlyDemo(w);
});

test("food: just the photo; counted, sent at once, counter ticks down as new bubbles when edits are off", async () => {
  const w = world();
  const john = w.person(DEMO);
  const other = w.person(OTHER);
  updateUser(w.db, other.id, { subscriptions: JSON.stringify(["food"]) });
  const out = await john.say("sweetgreen giveaway", [FOOD_PHOTO]);
  assert.deepEqual(out, [
    "looks like pizza, about 12 servings",
    "sent it to 14 students close enough to grab one",
    "pizza: 12 of 12 left",
    "11 left", "10 left", "9 left", "8 left", "7 left", "6 left", "5 left",
    "people are on their way. i'll text u when it's all gone",
  ]);
  assert.equal((w.db.prepare("SELECT COUNT(*) AS n FROM food_drops").get() as { n: number }).n, 0);
  onlyDemo(w);
});

test("food: a photo with no words still counts; with edits the one counter bubble is edited down", async () => {
  editsOn = true;
  edited.length = 0;
  try {
    const w = world();
    const john = w.person(DEMO);
    const out = await john.say("", [FOOD_PHOTO]);
    assert.deepEqual(out, ["looks like pizza, about 12 servings", "sent it to 14 students close enough to grab one", "pizza: 12 of 12 left", "people are on their way. i'll text u when it's all gone"]);
    assert.deepEqual(edited, ["pizza: 11 of 12 left", "pizza: 10 of 12 left", "pizza: 9 of 12 left", "pizza: 8 of 12 left", "pizza: 7 of 12 left", "pizza: 6 of 12 left", "pizza: 5 of 12 left"]);
    onlyDemo(w);
  } finally {
    editsOn = false;
  }
});

test("a bare photo that isn't food goes to normal Troy; with giveaway words it is always the food scene", async () => {
  photoIsFood = false;
  try {
    const w = world();
    const john = w.person(DEMO);
    const out = await john.say("", [FOOD_PHOTO]);
    assert.ok(!out.some((b) => /servings|left|students close enough/.test(b)), out.join(" | "));
    const forced = await john.say("give away", [FOOD_PHOTO]);
    assert.equal(forced[0], "looks like food, about 8 servings");
  } finally {
    photoIsFood = true;
  }
});

test("food: no model falls back to food, 8 servings", async () => {
  setModelCall(null);
  const w = world();
  const john = w.person(DEMO);
  const out = await john.say("i have extra food up for grabs");
  assert.equal(out[0], "looks like food, about 8 servings");
  assert.equal(out.at(-1), "people are on their way. i'll text u when it's all gone");
  onlyDemo(w);
});

test("demo reset clears the scene", async () => {
  const w = world();
  const john = w.person(DEMO);
  await john.say("i lost my wallet");
  assert.deepEqual(await john.say("demo reset"), ["reset ✅"]);
  // The wallet question is gone: a fresh hello plays.
  assert.deepEqual(await john.say("hey troy"), HELLO);
  onlyDemo(w);
});

test("safety still wins: an emergency gets the fixed reply with the script on", async () => {
  const w = world();
  const john = w.person(DEMO);
  await john.say("i lost my wallet");
  const out = await john.say("there's a fire in my building");
  assert.deepEqual(out, [...TEMPLATES.emergency]);
});

test("nothing unprompted goes to a demo handle: no first ten, no closing line, no alerts", async () => {
  const w = world();
  const john = w.person(DEMO, { verified: false });
  await john.say("hey troy");
  const u = getUserById(w.db, john.id)!;
  assert.equal(canAlert(u), false);
  const before = w.sent.length;
  for (const later of [30_000, 3 * 60_000, 10 * 60_000, 95 * 60_000]) await w.pipeline.sweep(Date.now() + later);
  assert.equal(w.sent.length, before);
  // A non-demo user is unaffected by the check.
  delete process.env.TROY_DEMO_SCRIPT;
  assert.equal(canAlert(u), true);
});
