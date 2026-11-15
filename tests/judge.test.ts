// Judge mode (src/judge.ts) and the plain-tone conversion (src/voice.ts). No network: the composer is injected.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import type { FlowContext, IncomingEvent, MessagingAdapter } from "../src/types.ts";
import type { Brief } from "../src/brain.ts";
import { openDb, getOrCreateUser, getUserById, updateUser } from "../src/db/index.ts";
import { ASIDE_MAX, JOHN_EMAIL, findDecision, forgetJudge, isJudge, judgeAside, judgeIntro, judgeWrapUp, leaksAnswerKey, loadDecisions, parseDecisions, plainTone, readToneSwitch, setJudgeDeps, setPlainTone, tourFinished } from "../src/judge.ts";
import { isVerbatim, toPlain } from "../src/voice.ts";
import { COMMAND_POOLS, TEMPLATES } from "../src/commands.ts";
import { COPY } from "../src/flows/lostfound/handler.ts";
import { DANGER_LINE } from "../src/flows/repair.ts";
import { RIDE_WARNING } from "../src/flows/rides.ts";
import { CONTACT_WARNING } from "../src/staff.ts";
import { REFERENCE_LINES } from "../src/onboarding.ts";
// Registers the rest of the safety list, as the running server does.
import "../src/pipeline.ts";

afterEach(() => setJudgeDeps(null));

let seq = 0;
function world(kind: "judge" | "student") {
  const db: DatabaseSync = openDb(":memory:");
  const handle = `+1213555${String(1000 + ++seq)}`;
  const u = getOrCreateUser(db, handle, `chat-${handle}`);
  updateUser(db, u.id, { verifiedAt: Date.now(), verifiedVia: kind === "judge" ? "judge_skip" : "usc_email" });
  const said: string[] = [];
  let n = 0;
  let m = 0;
  /** A context for one incoming message. Each call is a new message unless an id is passed. */
  const ctx = (messageId = `in-${++m}`): FlowContext => {
    const user = getUserById(db, u.id)!;
    const event: IncomingEvent = { provider: "webchat", userHandle: handle, chatId: user.chatId, isGroup: false, messageId, text: "", images: [], receivedAt: Date.now() };
    return {
      db,
      user,
      event,
      intent: { flow: "smalltalk", action: "chat", details: {}, source: "fallback" },
      state: null,
      adapter: {} as MessagingAdapter,
      async say(...bubbles) {
        return bubbles.map((b) => {
          said.push(typeof b === "string" ? b : b.text);
          return `out-${++n}`;
        });
      },
      sayTo: async () => [],
      sayToOwed: async () => [],
      setState: () => {},
      setStateFor: () => {},
    };
  };
  return { db, id: u.id, said, ctx };
}

const PHOTO = { did: "i read ur photo, pulled {details} details and checked them against {reports} open reports", numbers: { details: 6, reports: 30 } };

// ---------- who is a judge ----------

test("isJudge is the hackathon skip and nothing else", () => {
  const j = world("judge");
  const s = world("student");
  assert.equal(isJudge(getUserById(j.db, j.id)!), true);
  assert.equal(isJudge(getUserById(s.db, s.id)!), false);
  assert.equal(plainTone(j.db, j.id), false);
  setPlainTone(j.db, j.id, true);
  assert.equal(plainTone(j.db, j.id), true);
  forgetJudge(j.db, j.id);
  assert.equal(plainTone(j.db, j.id), false);
});

// ---------- asides ----------

test("a behind-the-scenes aside is one parenthetical bubble with the real numbers, and a student gets nothing", async () => {
  const j = world("judge");
  await judgeAside(j.ctx(), { step: "lost_found:photo", behind: PHOTO });
  assert.equal(j.said.length, 1);
  assert.match(j.said[0]!, /^\(.+\)$/);
  assert.match(j.said[0]!, /pulled 6 details and checked them against 30 open reports/);

  const s = world("student");
  await judgeAside(s.ctx(), { step: "lost_found:photo", behind: PHOTO, decision: "photo" });
  await judgeAside(s.ctx(), { step: "food:post", decision: 4 });
  assert.deepEqual(s.said, []);
});

test("asides never repeat for a person: not the same step, not the same decision, and never two for one message", async () => {
  const j = world("judge");
  await judgeAside(j.ctx(), { step: "lost_found:photo", behind: PHOTO });
  await judgeAside(j.ctx(), { step: "lost_found:photo", behind: PHOTO });
  await judgeAside(j.ctx(), { step: "lost_found:photo", decision: "photo" });
  assert.equal(j.said.length, 1, "one per step, ever");

  // Two calls while answering the same incoming message: only the first one speaks.
  const same = j.ctx("in-same");
  await judgeAside(same, { step: "food:post", decision: "location" });
  await judgeAside(same, { step: "food:alert", behind: { did: "texted the 4 people within a 10 min walk", numbers: {} } });
  assert.equal(j.said.length, 2);
  assert.match(j.said[1]!, /location decides who hears about it/);

  // The same decision under another step, by number or by key, is never told twice.
  await judgeAside(j.ctx(), { step: "food:claim", decision: "4" });
  await judgeAside(j.ctx(), { step: "topics:post", decision: "location" });
  assert.equal(j.said.length, 2);
  // A different one still goes out.
  await judgeAside(j.ctx(), { step: "repair:report", decision: "texts_first" });
  assert.equal(j.said.length, 3);
  assert.equal(new Set(j.said).size, 3);
});

test("when a step offers both kinds he alternates: behind the scenes, then a decision note, then behind the scenes", async () => {
  const j = world("judge");
  const kinds: string[] = [];
  const steps = [
    { step: "a", behind: { did: "matched it against 12 open reports" }, decision: "prove_first" },
    { step: "b", behind: { did: "scored 3 candidates and kept the best one" }, decision: "finder_chooses" },
    { step: "c", behind: { did: "worked out the building from ur words" }, decision: "texts_first" },
    { step: "d", behind: { did: "checked 5 nearby people against quiet hours" }, decision: "location" },
  ];
  for (const note of steps) {
    const before = j.said.length;
    await judgeAside(j.ctx(), note);
    assert.equal(j.said.length, before + 1, "exactly one bubble per step, never both");
    kinds.push(/^\((?:behind the scenes|what just happened on my end|under the hood):/.test(j.said.at(-1)!) ? "behind" : "decision");
  }
  assert.deepEqual(kinds, ["behind", "decision", "behind", "decision"]);
});

test("a decision note is the choice and its reason from docs/design-decisions.md, in his voice", async () => {
  const list = loadDecisions();
  assert.ok(list.length >= 17, `parsed ${list.length} entries`);
  assert.deepEqual(list.map((d) => d.n), list.map((_, i) => i + 1), "numbered in order");
  assert.equal(findDecision(5)?.title, "The finder chooses the handoff");
  assert.equal(findDecision("finder_chooses")?.n, findDecision("5")?.n);
  assert.equal(findDecision("short")?.title, "Short on purpose");
  assert.equal(findDecision("no such thing"), null);
  assert.equal(findDecision(999), null);
  assert.deepEqual(parseDecisions("intro\n\n3. **A choice.** The reason. The proof.\nnot an entry"), [{ n: 3, title: "A choice", reason: "The reason.", body: "The reason. The proof." }]);

  const j = world("judge");
  await judgeAside(j.ctx(), { step: "handoff", decision: "finder_chooses" });
  assert.equal(j.said.length, 1);
  const note = j.said[0]!;
  assert.match(note, /^\(.+\)$/);
  assert.match(note, /the finder chooses the handoff/);
  assert.match(note, /the person holding the item picks/);
  assert.equal(note, note.toLowerCase());
  assert.ok(!/[—–]/.test(note) && !/\byou\b|\byour\b/.test(note), note);
  // A key that names nothing says nothing.
  await judgeAside(j.ctx(), { step: "other", decision: "no such thing" });
  assert.equal(j.said.length, 1);
});

test("nothing from the verification answer key is ever said in an aside", async () => {
  assert.equal(leaksAnswerKey("u get 2 tries and it passes at 70"), true);
  assert.equal(leaksAnswerKey("i hold back hidden details the owner has to name"), true);
  assert.equal(leaksAnswerKey("i read ur photo, pulled 6 details and checked them against 30 open reports"), false);
  const j = world("judge");
  await judgeAside(j.ctx(), { step: "verify", behind: { did: "scored the description, it needs 70 points and u get 2 tries" } });
  assert.deepEqual(j.said, [], "the caller's own text gives the key away: nothing is sent");

  // His own wording gives it away: the plain version built from the facts goes out instead.
  setJudgeDeps({ sayInHisWords: async () => ["(i compared it and u still have 1 try left before it fails)"] });
  await judgeAside(j.ctx(), { step: "verify:2", behind: { did: "compared ur description with what the finder's photo shows" } });
  assert.equal(j.said.length, 1);
  assert.ok(!leaksAnswerKey(j.said[0]!), j.said[0]);
  assert.match(j.said[0]!, /compared ur description with what the finder's photo shows/);
});

test("the wording is his own (the injected composer), kept to one parenthetical bubble with every number intact", async () => {
  const briefs: Brief[] = [];
  setJudgeDeps({
    sayInHisWords: async (_ctx, brief) => {
      briefs.push(brief);
      return ["so here's the thing,", "i looked at ur photo and found 6 details, then ran them past 30 open reports"];
    },
  });
  const j = world("judge");
  await judgeAside(j.ctx(), { step: "lost_found:photo", behind: PHOTO });
  assert.deepEqual(j.said, ["(so here's the thing, i looked at ur photo and found 6 details, then ran them past 30 open reports)"]);
  assert.deepEqual(briefs[0]!.facts, { details: "6", reports: "30" });
  assert.ok(briefs[0]!.fallback.every((v) => v.length === 1 && /^\(.*6 details.*30 open reports\)$/.test(v[0]!)));

  // A version that loses a number is not sent: the facts-first line goes out.
  setJudgeDeps({ sayInHisWords: async () => ["(i read ur photo and checked it against a bunch of reports)"] });
  await judgeAside(j.ctx(), { step: "lost_found:photo:2", behind: PHOTO });
  assert.match(j.said[1]!, /pulled 6 details and checked them against 30 open reports/);
});

// ---------- the intro and the tone switch ----------

test("the intro goes out once for a judge and never for a student", async () => {
  const j = world("judge");
  assert.equal(await judgeIntro(j.ctx()), true);
  assert.equal(await judgeIntro(j.ctx()), false);
  const all = j.said.join(" ");
  assert.match(all, /faster/);
  assert.match(all, /save u time/);
  assert.match(all, /normal texting pace/);
  assert.match(all, /built for students/);
  assert.match(all, /straight/);
  assert.match(j.said.at(-1)!, /drop the slang/);
  assert.equal(j.said.filter((b) => /drop the slang/.test(b)).length, 1);

  const s = world("student");
  assert.equal(await judgeIntro(s.ctx()), false);
  assert.deepEqual(s.said, []);
});

test("typed tone requests: formal and drop the slang turn it on, slang back on turns it off, ordinary talk does neither", () => {
  for (const t of ["formal", "Drop the slang", "drop the slang pls", "can u be more formal", "no slang", "plain english please", "talk normally", "say it straight"]) assert.equal(readToneSwitch(t), "plain", t);
  for (const t of ["slang back on", "Slang back on pls", "bring the slang back", "turn the slang back on", "casual again"]) assert.equal(readToneSwitch(t), "slang", t);
  for (const t of ["what's the formal process for filing a complaint", "i lost my wallet at leavey", "is the dress code formal", "that's slang for cool", "ok", ""]) assert.equal(readToneSwitch(t), null, t);
});

// ---------- plain tone in code ----------

test("plain tone turns real troy lines into standard english and keeps them short", () => {
  const cases: [string, string][] = [
    ["thanks for checking me out. i'll go ahead and skip verification for u", "Thanks for checking me out. I'll go ahead and skip verification for you."],
    ["great, what's ur usc email?", "Great, what's your USC email?"],
    ["ur verified. welcome in", "You're verified. Welcome in."],
    ["bet, i'll text u when there's a pickup game near u", "Got it, I'll text you when there's a pickup game near you."],
    ['paused. no alerts till u text "resume". i\'ll still answer when u text me', 'Paused. No alerts until you text "resume". I\'ll still answer when you text me.'],
    ["gimme a sec", "Give me a second."],
    ["lmk if u want details so u can keep an eye out", "Let me know if you want details so you can keep an eye out."],
    ["btw there's free pizza about 8 min from u. want the spot?", "By the way there's free pizza about 8 minutes from you. Want the spot?"],
    ["idk yet, i'm tryna find out rn. pls hold on", "I don't know yet, I'm trying to find out right now. Please hold on."],
    ["save my contact if u haven't so u know it's me", "Save my contact if you haven't so you know it's me."],
    ['text "forget my location" anytime and i\'ll erase it', 'Text "forget my location" anytime and I\'ll erase it.'],
    ["that's the one. ur verified", "That's the one. You're verified."],
    ["ur back on. alerts are live again", "You're back on. Alerts are live again."],
    ["(behind the scenes: i read ur photo, pulled 6 details and checked them against 30 open reports)", "(Behind the scenes: I read your photo, pulled 6 details and checked them against 30 open reports)"],
    ["that was the short version. john's around if u want the full walkthrough: johnwang@usc.edu", "That was the short version. John's around if you want the full walkthrough: johnwang@usc.edu"],
    ["on it 👀", "On it 👀"],
    ["usc dps can help u in person", "USC DPS can help you in person."],
  ];
  for (const [troy, plain] of cases) {
    assert.equal(toPlain(troy), plain);
    // Spelled out, never padded: a little longer at most.
    assert.ok(plain.length <= troy.length * 1.6 + 12, troy);
    assert.equal(toPlain(plain), plain, "already plain stays as it is");
  }
  // Whole pools and dictated lines: no "u/ur" left outside the quoted words to type.
  const lines = [...Object.values(COMMAND_POOLS).flat(), ...Object.values(REFERENCE_LINES).flat(2), ...TEMPLATES.help, ...TEMPLATES.deleteData].filter((l) => !isVerbatim(l));
  assert.ok(lines.length > 60);
  for (const line of lines) {
    for (const bubble of line.split("|")) {
      const out = toPlain(bubble.trim());
      assert.ok(!/\b(?:u|ur|urs|urself|rn|lmk|pls|idk|tryna|gonna|wanna|thx)\b/.test(out.replace(/"[^"]*"/g, "")), `${bubble} -> ${out}`);
      assert.match(out, /^[^a-z]/, out);
      // Every exact phrase to type survives letter for letter.
      for (const q of bubble.match(/"[^"]+"/g) ?? []) assert.ok(out.includes(q), `${q} in ${out}`);
    }
  }
});

test("plain tone leaves the safety list word for word", () => {
  // The contact-sharing warning is one line wherever it is asked: lost and found, rides, and the usg group chat.
  const safety = [...TEMPLATES.emergency, ...TEMPLATES.crisis, ...TEMPLATES.stop, COPY.dangerous, COPY.consent, COPY.consentHow, DANGER_LINE, RIDE_WARNING, CONTACT_WARNING];
  for (const line of safety) {
    assert.equal(isVerbatim(line), true, line);
    assert.equal(toPlain(line), line);
  }
  // A line that only looks similar is not on the list.
  assert.notEqual(toPlain("ok, i'll leave u alone for now"), "ok, i'll leave u alone for now");
});

test("plain tone never puts a period on the end of a pickup code", () => {
  assert.equal(toPlain("ur pickup code is M4WKYM"), "Your pickup code is M4WKYM");
  assert.equal(toPlain("tell them it's for pickup code K7P2XQ"), "Tell them it's for pickup code K7P2XQ");
  assert.equal(toPlain("ok, drop it at dps lost and found when u can"), "OK, drop it at DPS lost and found when you can.");
});

test("an aside is always ONE bubble: a long decision note goes out as the reason alone, never split in two", async () => {
  const j = world("judge");
  // Decision 9 with its title is over the 160 characters a bubble holds.
  await judgeAside(j.ctx(), { step: "sim_check", decision: "9" });
  assert.equal(j.said.length, 1);
  const line = j.said[0]!;
  assert.ok([...line].length <= ASIDE_MAX, `${[...line].length}: ${line}`);
  assert.ok(line.startsWith("(") && line.endsWith(")"), line);
  assert.match(line, /describes the item before seeing any photo/);
  // Every entry on the list fits one bubble one way or the other.
  for (const d of loadDecisions()) {
    const k = world("judge");
    await judgeAside(k.ctx(), { step: `s${d.n}`, decision: String(d.n) });
    assert.equal(k.said.length, 1, `decision ${d.n}`);
    assert.ok([...k.said[0]!].length <= ASIDE_MAX, `decision ${d.n}: ${k.said[0]}`);
  }
});

// ---------- the wrap-up ----------

test("the wrap-up after the tour: the short version, john for the full walkthrough, his email. once per judge, never for a student", async () => {
  const j = world("judge");
  assert.equal(await tourFinished(j.ctx()), true);
  const wrap = j.said.join(" ");
  assert.match(wrap, /short version/);
  assert.match(wrap, /john/);
  assert.match(wrap, /full walkthrough/);
  assert.ok(wrap.includes(JOHN_EMAIL));
  assert.equal(JOHN_EMAIL, "johnwang@usc.edu");
  const count = j.said.length;
  assert.equal(await judgeWrapUp(j.ctx()), false);
  assert.equal(j.said.length, count);

  const s = world("student");
  assert.equal(await tourFinished(s.ctx()), false);
  assert.deepEqual(s.said, []);

  // His own wording that drops the email is replaced by a version that has it.
  setJudgeDeps({ sayInHisWords: async () => ["that was the quick tour", "john can show u the rest"] });
  const k = world("judge");
  assert.equal(await judgeWrapUp(k.ctx()), true);
  assert.ok(k.said.join(" ").includes(JOHN_EMAIL), k.said.join(" / "));
});
