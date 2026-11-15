// THE DEMO REHEARSAL. THIS TEST MUST STAY GREEN ON EVERY FUTURE BUILD.
//
// It is John's exact two-phone demo, run through the real pipeline with every check on (real intent detection, the
// real safety read, the real flows, the real verification) and nothing stubbed but the adapter and the model:
//
//   phone A (the finder) sends a photo of AirPods with "found these at leavey" and answers whatever Troy asks
//   phone B (the owner) texts "lost my airpods near leavey yesterday", is asked to describe them, describes the
//   sticker and passes
//   the FINDER is asked meet or DPS and picks meet; both consent; the group chat is created
//   "got it"; the thank-you is relayed; the confetti line goes to both
//
// Run once with a model that behaves well, and once with the model unavailable (then the finder decides, never the
// rule score). In both, the claimant never sees a hidden detail.
//
// If a change makes this fail, the change is wrong or the demo changed on purpose. Never delete or skip it:
// fix the code, or update the script here together with John's decision in CLAUDE.md ("Break-attempt plan").

import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { FlowState, IncomingEvent, IncomingImage, MessagingAdapter } from "../src/types.ts";
import { openDb, getOrCreateUser, updateUser, getFlowState } from "../src/db/index.ts";
import { createPipeline } from "../src/pipeline.ts";
import { fallbackIntent, setModelCall } from "../src/ai.ts";
import { COPY, LF_VOICE } from "../src/flows/lostfound/handler.ts";
import { TEMPLATES } from "../src/commands.ts";
import { afterOnboarding, setFirstTenDeps } from "../src/firstten.ts";
import { getUserById, saveMessage, setFlowState } from "../src/db/index.ts";
import type { FlowContext } from "../src/types.ts";

console.warn = () => {};
setFirstTenDeps({ timers: false });
after(() => {
  setModelCall(null);
  setFirstTenDeps(null);
});

const PHOTO: IncomingImage = { path: "/tmp/troy-test/airpods.jpg", mime: "image/jpeg" };
/** What only the owner would know. None of it may ever reach the claimant. */
const HIDDEN = ["pink dinosaur sticker on the lid", "engraved initials MK", "small crack near the hinge"];
const HIDDEN_WORDS = ["dinosaur", "engraved", "initials", "crack", "hinge"];
const AIRPODS = { category: "earbuds", title: "airpods pro case", brand: "Apple", color: "white", publicSummary: "white airpods case", distinguishing: HIDDEN, nameOnItem: null, isValuable: true, isDangerous: false };
const DESCRIPTION = "white case with a pink dinosaur sticker on the lid";
const THANKS = "thank u so much, u saved my week";

/** A model that behaves well: it routes like the keyword rules, reads the photo, ranks, scores and reads safety sensibly. */
function wellBehavedModel(calls: string[]) {
  return async (opts: { system: string; prompt: string }): Promise<string> => {
    const s = opts.system;
    if (s.startsWith("You route one text message")) {
      calls.push("intent");
      const text = JSON.parse(/^Message: (.*)$/m.exec(opts.prompt)![1]!) as string;
      const hasImage = /^Photo attached: yes$/m.test(opts.prompt);
      const open = /^Open conversation: flow "([a-z_]+)", step "([a-z_]+)"/m.exec(opts.prompt);
      const state = open ? ({ flow: open[1], step: open[2], data: {}, updatedAt: Date.now() } as FlowState) : null;
      const { flow, action, details } = fallbackIntent({ text, hasImage, state });
      return JSON.stringify({ flow, action, details });
    }
    if (s.startsWith("You read one text a USC student sent")) {
      calls.push("safety");
      return JSON.stringify({ read: "none" });
    }
    if (s.startsWith("You read one photo")) {
      calls.push("photo");
      return JSON.stringify(AIRPODS);
    }
    if (s.startsWith("You match lost-item")) {
      calls.push("rank");
      const { pairs } = JSON.parse(opts.prompt) as { pairs: { candidateId: number }[] };
      return JSON.stringify({ results: pairs.map((p) => ({ candidateId: p.candidateId, confidence: 91, reasons: ["same kind, place and day"] })) });
    }
    if (s.startsWith("You check whether")) {
      calls.push("verify");
      const { claimantDescription } = JSON.parse(opts.prompt) as { claimantDescription: string };
      return JSON.stringify({ score: /dinosaur/i.test(claimantDescription) ? 93 : 9, reasons: [] });
    }
    // Anything else (a free reply) is not part of the demo path. A model that is down for it falls back to fixed copy.
    calls.push("other");
    throw new Error("off");
  };
}

type Sent = { chatId: string; text: string; raw: string; effect?: string };
const canon = (text: string): string => LF_VOICE.canonical(text);

function world() {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO directory (kind, name, topics, contactMethod, url, details) VALUES ('office', 'DPS Lost & Found', '[]', ?, ?, ?)").run(
    "213-740-9759 or lostandfound@dps.usc.edu",
    "https://dps.usc.edu/services/lost-and-found/",
    "University Park Campus: 3667 McClintock Ave, Los Angeles, CA 90089.",
  );
  const place = db.prepare("INSERT OR IGNORE INTO campus_places (name, nicknames, lat, lng, kind) VALUES (?, ?, ?, ?, 'campus')");
  place.run("Leavey Library", '["leavey"]', 34.0217, -118.2829);
  place.run("Tutor Campus Center", '["tcc"]', 34.0203, -118.2863);

  const sent: Sent[] = [];
  const groups: { members: string[]; first: string }[] = [];
  let n = 0;
  const adapter: MessagingAdapter = {
    provider: "webchat",
    capabilities: () => ({ tapbacks: true, typing: true, readReceipts: true, edits: false, effects: true, polls: false, groupChats: true, contactCard: true, liveLocation: false }),
    async sendMessage(chatId, text, o) {
      sent.push({ chatId, text: canon(text), raw: text, effect: o?.effect });
      return { messageId: `out-${++n}` };
    },
    sendImage: async () => ({ messageId: `out-${++n}` }),
    sendContactCard: async () => ({ messageId: `out-${++n}` }),
    markRead: async () => {},
    startTyping: async () => {},
    stopTyping: async () => {},
    react: async () => true,
    editMessage: async () => false,
    sendPoll: async (_c, _q, options) => ({ optionMessageIds: options.map(() => null), mode: "numbered" }),
    async createGroupChat(members, first) {
      groups.push({ members, first });
      return "group-1";
    },
    getLiveLocation: async () => null,
    requestLocation: async () => false,
    chatIdForHandle: (h) => `chat-${h}`,
  };
  // Every check on: nothing is injected but the adapter and instant pauses. Intent detection, the safety read,
  // the flows, matching and verification are the real ones.
  const pipeline = createPipeline({ db, getAdapter: () => adapter, pause: async () => {}, ackAfterMs: 60_000 });

  let m = 0;
  function phone(handle: string, name: string, email: string) {
    const chatId = `chat-${handle}`;
    const u = getOrCreateUser(db, handle, chatId);
    updateUser(db, u.id, { verifiedAt: Date.now(), verifiedVia: "usc_email", name, uscEmail: email });
    const mine = () => sent.filter((s) => s.chatId === chatId);
    const texts = () => mine().map((s) => s.text);
    const say = async (text: string, images: IncomingImage[] = []) => {
      const before = texts().length;
      const event: IncomingEvent = { provider: "webchat", userHandle: handle, chatId, isGroup: false, messageId: `in-${++m}`, text, images, receivedAt: Date.now() };
      await pipeline.handleEvent(event);
      return texts().slice(before);
    };
    /** Onboarding just ended for this phone: the "what else" line and the "near u" bubbles go out and the first-ten plan is live. */
    const justOnboarded = async () => {
      const ctx: FlowContext = {
        db,
        user: getUserById(db, u.id)!,
        event: { provider: "webchat", userHandle: handle, chatId, isGroup: false, messageId: `in-${++m}`, text: "", images: [], receivedAt: Date.now() },
        intent: { flow: "onboarding", action: "", details: {}, source: "fallback" },
        state: null,
        adapter,
        async say(...bubbles) {
          const ids: (string | null)[] = [];
          for (const b of bubbles) {
            const text = typeof b === "string" ? b : b.text;
            const res = await adapter.sendMessage(chatId, text);
            saveMessage(db, { userId: u.id, chatId, direction: "out", providerMessageId: res!.messageId, text });
            ids.push(res!.messageId);
          }
          return ids;
        },
        sayTo: async (_id, ...b) => b.map(() => null),
        sayToOwed: async (_id, ...b) => b.map(() => null),
        setState: (st) => setFlowState(db, u.id, st),
        setStateFor: (id, st) => setFlowState(db, id, st),
      };
      await afterOnboarding(ctx);
    };
    return { id: u.id, handle, say, texts, sent: mine, raw: () => mine().map((s) => s.raw), state: () => getFlowState(db, u.id), justOnboarded };
  }
  return { db, groups, finder: phone("+12135550101", "Fiona Finder", "fiona.finder@usc.edu"), owner: phone("+12135550102", "Owen Owner", "owen.owner@usc.edu") };
}

type World = ReturnType<typeof world>;
const row = <T>(db: DatabaseSync, sql: string) => db.prepare(sql).get() as T;
const found = (db: DatabaseSync) => row<{ id: number; status: string; locationText: string | null; category: string; photoUrl: string | null; isExample: number }>(db, "SELECT * FROM listings WHERE type = 'found' ORDER BY id DESC LIMIT 1");
const lost = (db: DatabaseSync) => row<{ id: number; status: string }>(db, "SELECT * FROM listings WHERE type = 'lost' ORDER BY id DESC LIMIT 1");
const match = (db: DatabaseSync) => row<{ status: string }>(db, "SELECT * FROM matches ORDER BY id DESC LIMIT 1");
const checks = (db: DatabaseSync) => (db.prepare("SELECT method, result FROM verifications ORDER BY id").all() as { method: string; result: string | null }[]).map((c) => `${c.method}:${c.result}`);
const handoff = (db: DatabaseSync) => row<{ method: string; chosenBy: string; completedAt: number | null; thankYouNote: string | null }>(db, "SELECT * FROM handoffs ORDER BY id DESC LIMIT 1");

/** Nothing Troy sent the claimant may contain a hidden detail, in the wording that went out. */
function assertClaimantSawNothingHidden(w: World): void {
  for (const text of w.owner.raw()) {
    const low = text.toLowerCase();
    for (const h of [...HIDDEN, ...HIDDEN_WORDS]) assert.ok(!low.includes(h.toLowerCase()), `the claimant saw "${h}" in: ${text}`);
    assert.ok(!text.includes("—"), "no em dashes");
  }
}

/** The finder answers whatever Troy asks about the find (what it is, where, any marks) until the listing is saved. */
async function finderReports(w: World): Promise<string[]> {
  const out = await w.finder.say("found these at leavey", [PHOTO]);
  const answers: Record<string, string> = { found_what: "airpods", found_place: "leavey library", found_marks: "white case with a pink dinosaur sticker on the lid, initials MK engraved" };
  for (let i = 0; i < 4; i++) {
    const step = w.finder.state()?.flow === "lost_found" ? w.finder.state()!.step : "";
    if (!answers[step]) break;
    out.push(...(await w.finder.say(answers[step]!)));
  }
  return out;
}

/** From the finder's choice to the confetti. The same for both runs. */
async function handoffToConfetti(w: World): Promise<void> {
  // The FINDER is the one asked meet or DPS, and picks meet.
  assert.equal(w.finder.texts().at(-1), COPY.handoffAsk, "the finder is asked how to hand it off");
  assert.ok(!w.owner.texts().includes(COPY.handoffAsk), "the owner is never asked to choose");
  assert.equal(w.groups.length, 0);
  await w.finder.say("meet");

  // Both get the contact-sharing warning, word for word, and nothing happens until both say yes.
  assert.equal(w.finder.sent().at(-1)!.raw, COPY.consent);
  assert.equal(w.owner.sent().at(-1)!.raw, COPY.consent);
  await w.finder.say("yes");
  assert.equal(w.groups.length, 0, "no group chat until both say yes");
  await w.owner.say("yes");

  // The group chat exists, with exactly these two people, and Troy steps back.
  assert.equal(w.groups.length, 1);
  assert.deepEqual(w.groups[0]!.members, [w.finder.handle, w.owner.handle]);
  assert.equal(w.groups[0]!.first, COPY.groupFirst);
  assert.deepEqual({ method: handoff(w.db).method, chosenBy: handoff(w.db).chosenBy }, { method: "group_chat", chosenBy: "finder" });
  assert.equal(found(w.db).status, "handed_off");

  // "got it" closes it out.
  await w.owner.say("got it");
  assert.equal(found(w.db).status, "returned");
  assert.equal(lost(w.db).status, "returned");
  assert.ok(handoff(w.db).completedAt);

  // The thank-you is relayed to the finder as a quote, and both get the confetti line.
  const before = w.finder.sent().length;
  const win = await w.owner.say(THANKS);
  assert.equal(win.at(-1), COPY.win);
  assert.equal(w.owner.sent().at(-1)!.effect, "confetti");
  const toFinder = w.finder.sent().slice(before);
  assert.ok(toFinder.some((s) => s.raw === `"${THANKS}"`), "the finder gets the owner's words");
  assert.equal(toFinder.at(-1)!.raw, COPY.win);
  assert.equal(toFinder.at(-1)!.effect, "confetti");
  assert.equal(handoff(w.db).thankYouNote, THANKS);
  assert.equal(w.owner.state(), null);
  assert.equal(w.finder.state(), null);
}

test("the demo, model up: photo find, typed loss, blind description, the finder picks meet, group chat, got it, thank-you, confetti", async () => {
  const calls: string[] = [];
  setModelCall(wellBehavedModel(calls));
  const w = world();

  // Phone A: the photo.
  const logged = await finderReports(w);
  assert.ok(logged.some((t) => t.includes(AIRPODS.publicSummary)), logged.join(" / "));
  assert.deepEqual({ category: found(w.db).category, place: found(w.db).locationText, photo: found(w.db).photoUrl, example: found(w.db).isExample }, { category: "earbuds", place: "Leavey Library", photo: PHOTO.path, example: 0 });
  assert.ok(calls.includes("photo"), "the photo was really read");

  // Phone B: the loss. Troy asks for a description and gives nothing away.
  const asked = await w.owner.say("lost my airpods near leavey yesterday");
  assert.equal(asked.at(-1), COPY.describe);
  assert.equal(w.owner.state()?.step, "verify_describe");
  assertClaimantSawNothingHidden(w);

  // The owner describes the sticker and passes the real check.
  const passed = await w.owner.say(DESCRIPTION);
  assert.equal(passed[0], COPY.passed);
  assert.deepEqual(checks(w.db), ["blind_description:pass"]);
  assert.equal(match(w.db).status, "verified");
  assert.ok(calls.includes("verify"), "the description was really scored");

  await handoffToConfetti(w);
  assertClaimantSawNothingHidden(w);
  // No safety line, no canned error, nothing off script reached either phone.
  for (const t of [...w.owner.raw(), ...w.finder.raw()]) assert.ok(!TEMPLATES.crisis.includes(t) && !TEMPLATES.emergency.includes(t), t);
});

test("the demo, model unavailable: the same path, and the finder decides instead of the rule score", async () => {
  setModelCall(null);
  const w = world();

  // Phone A: with no photo read, Troy asks what it is and what only the owner would know.
  await finderReports(w);
  assert.deepEqual({ place: found(w.db).locationText, photo: found(w.db).photoUrl }, { place: "Leavey Library", photo: PHOTO.path });

  // Phone B.
  const asked = await w.owner.say("lost my airpods near leavey yesterday");
  assert.equal(asked.at(-1), COPY.describe);
  assertClaimantSawNothingHidden(w);

  // A description that fits is never passed on the rule score alone: the finder reads the owner's words and decides.
  const before = w.finder.texts().length;
  await w.owner.say(DESCRIPTION);
  assert.equal(match(w.db).status, "finder_check");
  assert.ok(!w.owner.texts().includes(COPY.passed), "not passed by the rules alone");
  const toFinder = w.finder.sent().slice(before);
  assert.ok(toFinder.some((s) => s.raw.includes(DESCRIPTION)), "the finder sees the owner's own description");
  assert.equal(toFinder.at(-1)!.text, COPY.finderCheck);
  assertClaimantSawNothingHidden(w);

  await w.finder.say("yes");
  assert.equal(match(w.db).status, "verified");
  assert.deepEqual(checks(w.db), ["blind_description:pass", "finder_confirm:pass"]);

  await handoffToConfetti(w);
  assertClaimantSawNothingHidden(w);
});

test("the demo on two phones that finished onboarding a moment ago: the first-ten-minutes bubbles never get in the way", async () => {
  const calls: string[] = [];
  setModelCall(wellBehavedModel(calls));
  const w = world();
  // Both phones still have the "near u" offer open ("want the spot?") when the demo starts.
  await w.finder.justOnboarded();
  await w.owner.justOnboarded();

  await finderReports(w);
  assert.equal(found(w.db).locationText, "Leavey Library");
  const asked = await w.owner.say("lost my airpods near leavey yesterday");
  assert.equal(asked.at(-1), COPY.describe);
  const passed = await w.owner.say(DESCRIPTION);
  assert.equal(passed[0], COPY.passed);
  await handoffToConfetti(w);
  // Every yes in the demo answered the demo's own question, never the example pizza.
  for (const t of [...w.owner.raw(), ...w.finder.raw()]) assert.ok(!/hackathon build/.test(t), t);
  assertClaimantSawNothingHidden(w);
});
