import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { FlowState } from "../src/types.ts";
import { config } from "../src/config.ts";
import { askJson, composeReply, detectIntent, extractJson, fallbackIntent, setModelCall } from "../src/ai.ts";
import { countEmoji, limitEmoji, lowercase, polishBubbles, splitBubbles } from "../src/voice.ts";

// No test may reach the network.
config.anthropicKey = "";
afterEach(() => setModelCall(null));

const state = (flow: FlowState["flow"], step = "ask"): FlowState => ({ flow, step, data: {}, updatedAt: 0 });

type Case = [text: string, flow: string, action: string, opts?: { hasImage?: boolean; state?: FlowState }];
const CASES: Case[] = [
  // lost and found
  ["lost my wallet at leavey last night", "lost_found", "report_lost"],
  ["i think i left my airpods in thh", "lost_found", "report_lost"],
  ["cant find my usc id anywhere", "lost_found", "report_lost"],
  ["has anyone found my keys??", "lost_found", "report_lost"],
  ["found a black hydro flask outside doheny", "lost_found", "report_found"],
  ["someone left their laptop in sal", "lost_found", "report_found"],
  ["found this at the village", "lost_found", "report_found", { hasImage: true }],
  ["", "lost_found", "report_found", { hasImage: true }],
  ["found my keys nvm", "lost_found", "resolved"],
  ["nvm got it back", "lost_found", "resolved", { state: state("lost_found") }],
  ["still havent found my wallet", "lost_found", "answer", { state: state("lost_found") }],
  ["its black with a usc sticker", "lost_found", "answer", { state: state("lost_found") }],
  ["", "lost_found", "answer", { hasImage: true, state: state("lost_found") }],
  // food
  ["we have leftover pizza at tcc, like 20 slices", "food", "post_food"],
  ["free donuts outside leavey come grab", "food", "post_food"],
  ["3 boxes of sandwiches from our club meeting", "food", "post_food", { hasImage: true }],
  ["6 left", "food", "update_count"],
  ["we're out", "food", "update_count"],
  ["is the food at leavey still there", "food", "status"],
  ["any free food rn?", "food", "status"],
  ["ill take one", "food", "claim", { state: state("food", "alerted") }],
  ["can i grab some pizza", "food", "claim"],
  ["there was no food when i got there", "food", "report_fake"],
  ["about 10", "food", "answer", { state: state("food", "ask_count") }],
  // repair
  ["the water fountain on leavey 2nd floor is broken", "repair", "report"],
  ["sink is leaking in new north bathroom", "repair", "report", { hasImage: true }],
  ["elevator in parkside is out of order again", "repair", "report"],
  ["printer at leavey won't work", "repair", "report"],
  // usg
  ["what are the dining hall hours during finals", "usg", "question"],
  ["how do i get club funding", "usg", "question"],
  ["when does the lax shuttle run", "usg", "question"],
  ["usc should have more late night food options on campus", "usg", "concern"],
  ["is the farmers market this wednesday?", "usg", "question"],
  // rides
  ["anyone going to lax friday around 3pm", "rides", "find"],
  ["need to split an uber to the airport tmrw", "rides", "find"],
  // notes
  ["what do u know about me", "notes", "recall"],
  ["forget that", "notes", "forget"],
  ["only alert me for food within 5 min", "notes", "set_alert_distance"],
  ["dont text me after 10pm", "notes", "set_quiet_hours"],
  ["from now on keep it short", "notes", "add_note"],
  // smalltalk
  ["hey whats up", "smalltalk", "chat"],
  ["are you a real person", "smalltalk", "chat"],
  ["thats fire lol", "smalltalk", "chat"],
  ["thanks troy", "smalltalk", "chat"],
  // new topic while another flow is open
  ["lost my wallet", "lost_found", "report_lost", { state: state("food", "alerted") }],
];

test("keyword fallback classifies varied messages", () => {
  assert.ok(CASES.length >= 25);
  const wrong: string[] = [];
  for (const [text, flow, action, opts] of CASES) {
    const got = fallbackIntent({ text, hasImage: opts?.hasImage ?? false, state: opts?.state ?? null });
    assert.equal(got.source, "fallback");
    if (got.flow !== flow || got.action !== action) wrong.push(`"${text}" -> ${got.flow}/${got.action}, wanted ${flow}/${action}`);
  }
  assert.deepEqual(wrong, []);
});

test("fallback pulls details", () => {
  const lost = fallbackIntent({ text: "lost my black apple airpods at Leavey last night", hasImage: false, state: null }).details;
  assert.deepEqual({ category: lost.category, color: lost.color, brand: lost.brand, place: lost.place, time: lost.time }, { category: "earbuds", color: "black", brand: "apple", place: "leavey", time: "last night" });
  assert.equal(fallbackIntent({ text: "6 left", hasImage: false, state: null }).details.count, 6);
  assert.equal(fallbackIntent({ text: "we're out", hasImage: false, state: null }).details.count, 0);
  const ride = fallbackIntent({ text: "anyone going to lax friday around 3pm", hasImage: false, state: null }).details;
  assert.equal(ride.destination, "LAX");
  assert.equal(ride.count, undefined);
  assert.equal(fallbackIntent({ text: "", hasImage: true, state: null }).details.photoOnly, true);
});

test("detectIntent falls back with no key, on bad output and on errors", async () => {
  const input = { text: "lost my wallet at leavey", hasImage: false, state: null, notes: [] };
  assert.equal((await detectIntent(input)).source, "fallback");
  setModelCall(async () => "sorry, no idea");
  assert.deepEqual(await detectIntent(input), fallbackIntent(input));
  setModelCall(async () => '{"flow":"pizza_party","action":"x"}');
  assert.equal((await detectIntent(input)).source, "fallback");
  setModelCall(async () => { throw new Error("boom"); });
  assert.equal((await detectIntent(input)).flow, "lost_found");
});

test("detectIntent uses the model's answer and keeps code-found details", async () => {
  setModelCall(async () => '```json\n{"flow":"lost_found","action":"report_lost","details":{"category":"wallet","color":"brown"}}\n```');
  const got = await detectIntent({ text: "lost my wallet at leavey", hasImage: false, state: null, notes: [] });
  assert.equal(got.source, "ai");
  assert.equal(got.action, "report_lost");
  assert.equal(got.details.color, "brown");
  assert.equal(got.details.place, "leavey");
});

test("askJson returns null with no key and never throws", async () => {
  assert.equal(await askJson({ model: "fast", system: "s", prompt: "p" }), null);
  setModelCall(async () => { throw new Error("secret prompt text"); });
  assert.equal(await askJson({ model: "smart", system: "s", prompt: "p" }), null);
  setModelCall(async () => "not json");
  assert.equal(await askJson({ model: "fast", system: "s", prompt: "p" }), null);
  setModelCall(() => new Promise(() => {}));
  assert.equal(await askJson({ model: "fast", system: "s", prompt: "p", timeoutMs: 20 }), null);
});

test("extractJson finds the first balanced object", () => {
  assert.deepEqual(extractJson('here you go: {"a": {"b": "} tricky"}, "c": [1, 2]} thanks'), { a: { b: "} tricky" }, c: [1, 2] });
  assert.deepEqual(extractJson('{broken} then {"ok": true}'), { ok: true });
  assert.equal(extractJson("nothing here"), undefined);
});

const reply = { goal: "tell the claimer their pickup details", facts: { code: "K7Q2", place: "Leavey Library", minutes: 6 }, notes: [], fallback: ["your code is K7Q2. pickup at Leavey Library, about 6 min away"] };

test("composeReply returns the fallback when a fact is missing", async () => {
  assert.deepEqual(await composeReply(reply), reply.fallback); // no key
  setModelCall(async () => '{"bubbles":["got you 👀","head to Leavey Library, about 6 min away"]}');
  assert.deepEqual(await composeReply(reply), reply.fallback); // code missing
  setModelCall(async () => '{"bubbles":["code is K7Q2","Leavey Library, about 16 min away"]}');
  assert.deepEqual(await composeReply(reply), reply.fallback); // 16 is not 6
  setModelCall(async () => '{"bubbles":["code is K7Q2 at Leavey Library, 6 min away","call 213-740-4321 if lost"]}');
  assert.deepEqual(await composeReply(reply), reply.fallback); // invented number
  setModelCall(async () => "lol");
  assert.deepEqual(await composeReply(reply), reply.fallback);
});

test("composeReply keeps facts exact and enforces the voice", async () => {
  setModelCall(async () => '{"bubbles":["On it 👀🔥 Your code is K7Q2","Pickup is at Leavey Library — about 6 min away 🎉🎉","Fight on","extra bubble"]}');
  const got = await composeReply(reply);
  assert.deepEqual(got, ["on it 👀 your code is K7Q2", "pickup is at Leavey Library, about 6 min away 🎉", "fight on"]);
  setModelCall(async () => '{"bubbles":["So sorry 😢 your code is K7Q2, Leavey Library, 6 min"]}');
  const calm = await composeReply({ ...reply, goal: "tell them the wallet verification failed" });
  assert.equal(countEmoji(calm.join("")), 0);
});

test("voice helpers enforce lowercase and the emoji limit", () => {
  assert.equal(lowercase("Hey THERE, Code ABC123 At Tommy Trojan", ["ABC123", "Tommy Trojan"]), "hey there, code ABC123 at Tommy Trojan");
  assert.equal(lowercase("A Plan For ALL"), "a plan for all");
  assert.equal(limitEmoji("yes 🎉 fight on ✌️ 🔥"), "yes 🎉 fight on");
  assert.equal(limitEmoji("no 👀 emoji 🙏", 0), "no emoji");
  assert.equal(countEmoji("👨‍👩‍👧 and 🇺🇸 and 👍🏽"), 3);
  assert.deepEqual(splitBubbles("**one**\n\n- two\n\"three\""), ["one", "two", "three"]);
  const long = polishBubbles("x".repeat(200));
  assert.equal(long, null);
  const split = polishBubbles(`${"This is a sentence that goes on for a while. ".repeat(5)}`);
  assert.ok(split && split.every((b) => b.length <= 160 && b === b.toLowerCase()));
  assert.equal(polishBubbles(["a", "b", "c", "d", "e"]), null);
});
