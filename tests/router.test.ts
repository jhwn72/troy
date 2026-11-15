// The router: commands by meaning, the topics, rides and tour flows, and the playful messages that must do nothing.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { FlowState, IntentCommand } from "../src/types.ts";
import { config } from "../src/config.ts";
import { asksToPassOn, detectIntent, fallbackCommand, fallbackIntent, peopleOrPolicy, photoWords, setModelCall } from "../src/ai.ts";

// No test may reach the network.
config.anthropicKey = "";
afterEach(() => setModelCall(null));

const state = (flow: FlowState["flow"], step = "ask"): FlowState => ({ flow, step, data: {}, updatedAt: 0 });
const route = (text: string, s: FlowState | null = null) => fallbackIntent({ text, hasImage: false, state: s });

type CommandCase = [text: string, name: IntentCommand["name"], certainty: IntentCommand["certainty"], topic?: string];
const COMMANDS: CommandCase[] = [
  // goodbye
  ["stop talking to me", "stop", "clear"],
  ["leave me alone", "stop", "clear"],
  ["unsubscribe me", "stop", "clear"],
  ["i want to unsubscribe", "stop", "clear"],
  ["pls stop texting me", "stop", "clear"],
  ["Leave me alone please.", "stop", "clear"],
  ["don’t text me again", "stop", "clear"],
  ["can u stop messaging me", "stop", "clear"],
  ["stop the texts", "stop", "clear"],
  // could be a joke, could be about only some texts: ask
  ["stop texting me lol", "stop", "unsure"],
  ["stop the alerts", "stop", "unsure"],
  ["go away", "stop", "unsure"],
  // a break
  ["can u chill with the alerts for a bit", "pause", "clear"],
  ["stop texting me for a bit", "pause", "clear"],
  ["mute alerts until tomorrow", "pause", "clear"],
  ["i need a break from the texts", "pause", "clear"],
  // back again
  ["u can text me again", "resume", "clear"],
  ["turn alerts back on", "resume", "clear"],
  ["i want back in", "start", "clear"],
  // data
  ["delete my account", "delete_data", "clear"],
  ["erase everything u have on me", "delete_data", "clear"],
  ["can u delete all my data", "delete_data", "clear"],
  ["wipe everything you know about me", "delete_data", "clear"],
  ["delete my account lol", "delete_data", "unsure"],
  ["stop tracking my location", "forget_location", "clear"],
  ["forget where i am", "forget_location", "clear"],
  // one kind of text
  ["stop the food texts", "unsubscribe_topic", "clear", "food"],
  ["stop sending me food alerts", "unsubscribe_topic", "clear", "food"],
  ["no more pickup game alerts", "unsubscribe_topic", "clear", "pickup game"],
  ["unsubscribe from extra tickets", "unsubscribe_topic", "clear", "extra tickets"],
  ["i don't want the ride texts anymore", "unsubscribe_topic", "clear", "ride"],
  // how to
  ["what are the commands", "help", "clear"],
  ["how do i unsubscribe", "help", "clear"],
];

// Playful, mid-sentence, about someone or something else, or a question about what a command does: nothing happens.
const NOT_COMMANDS = [
  "stop lol",
  "stop ur so funny",
  "i can't stop laughing",
  "delete this class from my life",
  "my ex won't stop texting me",
  "stop it",
  "omg stop 😂",
  "what happens if i say stop?",
  "i need a break from econ",
  "delete that note",
  "dont text me after 10pm",
  "i lost my wallet and can't stop stressing",
  "he told me to leave him alone",
  "forget it",
  "that exam needs to leave me alone",
  "hey whats up",
  "found a black hydro flask outside doheny",
];

test("commands by meaning: the keyword fallback maps them and marks how sure it is", () => {
  const wrong: string[] = [];
  for (const [text, name, certainty, topic] of COMMANDS) {
    const got = route(text).command;
    if (!got || got.name !== name || got.certainty !== certainty || got.topic !== topic) wrong.push(`"${text}" -> ${JSON.stringify(got)}, wanted ${name}/${certainty}${topic ? `/${topic}` : ""}`);
  }
  assert.deepEqual(wrong, []);
});

test("playful and mid-sentence uses are not commands", () => {
  const wrong = NOT_COMMANDS.filter((text) => route(text).command !== undefined).map((text) => `"${text}" -> ${JSON.stringify(route(text).command)}`);
  assert.deepEqual(wrong, []);
  assert.equal(fallbackCommand(""), undefined);
  assert.equal(fallbackCommand("x".repeat(500)), undefined);
  // An intent with no command has no command key at all.
  assert.equal("command" in route("hey whats up"), false);
});

type FlowCase = [text: string, flow: string, action: string, topic?: string];
const FLOWS: FlowCase[] = [
  // topics: a post for the people who follow it
  ["anyone want to play pickup at lyon at 6", "topics", "post_to_topic", "pickup games"],
  ["need 2 more for spikeball at mccarthy quad", "topics", "post_to_topic", "pickup games"],
  ["selling an extra ticket for saturday", "topics", "post_to_topic", "extra tickets"],
  ["anyone selling a ticket to the ucla game?", "topics", "post_to_topic", "extra tickets"],
  ["i can help with econ 351", "topics", "post_to_topic", "class help"],
  ["spanish tutor free thursdays", "topics", "post_to_topic", "class help"],
  // topics: which texts they get
  ["text me when there's a pickup game", "topics", "follow_topic", "pickup game"],
  ["sign me up for ticket alerts", "topics", "follow_topic", "ticket"],
  ["can u make a topic for study groups", "topics", "suggest_topic", "study groups"],
  ["u should have alerts for language exchange", "topics", "suggest_topic", "language exchange"],
  ["new topic: board game nights", "topics", "suggest_topic", "board game nights"],
  // rides
  ["find me people going to lax first day of break", "rides", "find"],
  ["anyone driving to the bay friday", "rides", "find"],
  ["anyone heading to san diego this weekend", "rides", "find"],
  ["looking for a ride to oc", "rides", "find"],
  ["need to split an uber to the airport tmrw", "rides", "find"],
  // tour
  ["show me how it works", "tour", "start"],
  ["can i try it", "tour", "start"],
  ["give me a demo", "tour", "start"],
  ["let me try it out", "tour", "start"],
  // still chat: mentioning a topic is not a request
  ["anyone going to the career fair", "smalltalk", "chat"],
  ["how do u work", "smalltalk", "chat"],
  ["what can u do", "smalltalk", "chat"],
  ["i got a parking ticket", "smalltalk", "chat"],
  ["is there a pickup game tonight?", "smalltalk", "chat"],
  ["i can help with that", "smalltalk", "chat"],
  ["text me when it's fixed", "smalltalk", "chat"],
  ["anyone want pizza", "smalltalk", "chat"],
  ["follow up on my report", "smalltalk", "chat"],
  ["that game was crazy", "smalltalk", "chat"],
  // the older flows did not move
  ["lost my wallet at leavey last night", "lost_found", "report_lost"],
  ["free donuts outside leavey come grab", "food", "post_food"],
  ["when does the lax shuttle run", "usg", "question"],
  ["the water fountain on leavey 2nd floor is broken", "repair", "report"],
  // repair is only a physical thing. people, noise, rules and prices are never repair, whatever words they use
  ["my door lock is broken", "repair", "report"],
  ["the elevator in parkside has been out of order for hours", "repair", "report"],
  ["the dryer on my floor is broken and so loud", "repair", "report"],
  ["my ra won't do anything about the noise", "smalltalk", "chat"],
  ["my ra doesn't work", "smalltalk", "chat"],
  ["my roommate is so loud and it's not working for me", "smalltalk", "chat"],
  ["the front desk staff is broken lol", "smalltalk", "chat"],
  ["the guest policy is broken", "usg", "concern"],
  // a concern only when they ask for it to go somewhere
  ["can u report my ra, he never does anything about the noise", "usg", "concern"],
  ["can someone do something about my roommates being so loud", "usg", "concern"],
  ["who do i complain to about my roommate", "usg", "question"],
];

test("the router table covers at least 40 messages", () => {
  assert.ok(COMMANDS.length + NOT_COMMANDS.length + FLOWS.length >= 40);
});

test("topics, rides and the tour route by keywords, and chat stays the default", () => {
  const wrong: string[] = [];
  for (const [text, flow, action, topic] of FLOWS) {
    const got = route(text);
    if (got.flow !== flow || got.action !== action || (topic !== undefined && got.details.topic !== topic)) wrong.push(`"${text}" -> ${got.flow}/${got.action}/${String(got.details.topic)}, wanted ${flow}/${action}${topic ? `/${topic}` : ""}`);
  }
  assert.deepEqual(wrong, []);
});

test("a command that names a topic is not a post to that topic", () => {
  const got = route("no more pickup game alerts");
  assert.equal(got.flow, "smalltalk");
  assert.equal(got.details.topic, undefined);
  assert.deepEqual(got.command, { name: "unsubscribe_topic", topic: "pickup game", certainty: "clear" });
});

test("an open conversation keeps an ambiguous \"can i try it\", but an explicit tour request gets through", () => {
  assert.deepEqual([route("can i try it", state("food", "alerted")).flow, route("can i try it", state("food", "alerted")).action], ["food", "answer"]);
  assert.equal(route("give me the tour", state("lost_found")).flow, "tour");
  // A new topic post still starts something new, as other flows do.
  assert.equal(route("selling an extra ticket for saturday", state("food", "alerted")).flow, "topics");
});

test("detectIntent takes the model's command and checks it", async () => {
  const ask = (text: string) => detectIntent({ text, hasImage: false, state: null, notes: [] });
  setModelCall(async () => '{"flow":"smalltalk","action":"chat","details":{},"command":{"name":"unsubscribe_topic","topic":"Free  Food","certainty":"clear"}}');
  assert.deepEqual((await ask("honestly the food ones are too much")).command, { name: "unsubscribe_topic", topic: "free food", certainty: "clear" });
  // No certainty given means ask first. So does a topic command with no topic.
  setModelCall(async () => '{"flow":"smalltalk","action":"chat","command":{"name":"delete_data"}}');
  assert.deepEqual((await ask("i'd rather u not keep my stuff")).command, { name: "delete_data", certainty: "unsure" });
  setModelCall(async () => '{"flow":"smalltalk","action":"chat","command":{"name":"unsubscribe_topic","certainty":"clear"}}');
  assert.deepEqual((await ask("too many of those")).command, { name: "unsubscribe_topic", certainty: "unsure" });
  // A command that isn't one of ours is dropped.
  setModelCall(async () => '{"flow":"smalltalk","action":"chat","command":{"name":"self_destruct","certainty":"clear"}}');
  assert.equal((await ask("hey")).command, undefined);
});

test("the model decides that a playful stop is nothing, but a plain goodbye is never silently dropped", async () => {
  const ask = (text: string) => detectIntent({ text, hasImage: false, state: null, notes: [] });
  setModelCall(async () => '{"flow":"smalltalk","action":"chat","details":{},"command":null}');
  // The keywords read "unsure" here; the model says joke, so nothing.
  assert.equal((await ask("stop texting me lol")).command, undefined);
  assert.equal((await ask("stop ur so funny")).command, undefined);
  // The keywords read a clear goodbye and the model read nothing: Troy asks.
  assert.deepEqual((await ask("leave me alone")).command, { name: "stop", certainty: "unsure" });
  // With the model down, the keyword read stands.
  setModelCall(async () => { throw new Error("down"); });
  assert.deepEqual((await ask("leave me alone")).command, { name: "stop", certainty: "clear" });
});

test("detectIntent accepts the new flows from the model and still rejects unknown ones", async () => {
  const ask = (text: string) => detectIntent({ text, hasImage: false, state: null, notes: [] });
  setModelCall(async () => '{"flow":"topics","action":"post_to_topic","details":{"topic":"pickup games","place":"lyon"}}');
  const post = await ask("who's tryna hoop at lyon");
  assert.deepEqual([post.flow, post.action, post.source, post.details.topic], ["topics", "post_to_topic", "ai", "pickup games"]);
  setModelCall(async () => '{"flow":"tour","action":"start","details":{}}');
  assert.equal((await ask("ok show me")).flow, "tour");
  setModelCall(async () => '{"flow":"rides","action":"find","details":{"destination":"LAX"}}');
  assert.equal((await ask("tryna get to lax on the 19th with someone")).flow, "rides");
  setModelCall(async () => '{"flow":"parties","action":"find"}');
  assert.equal((await ask("hey whats up")).source, "fallback");
});

test("people and policy are told apart from a broken thing, and asking for it to be passed on is told apart from saying it", () => {
  for (const text of ["my ra won't do anything about the noise", "dorm mates are annoying. yeah and my ra doesn't enforce it", "the staff at the front desk is so rude", "the dining hall hours are a joke", "my roommate parties every night"]) {
    assert.equal(peopleOrPolicy(text), true, text);
  }
  // A physical thing named means it can be fixed, whoever else is in the sentence.
  for (const text of ["my door lock is broken", "my ra won't fix my broken door", "the elevator has been out for hours", "the sink is leaking", "lol that's wild"]) {
    assert.equal(peopleOrPolicy(text), false, text);
  }
  for (const text of ["report this", "can u tell usg the dining halls close too early", "can u report my ra", "pls pass this on", "who do i complain to about this", "can someone do something about it"]) {
    assert.equal(asksToPassOn(text), true, text);
  }
  for (const text of ["my ra won't do anything about the noise", "i told them but they didn't do anything", "my ta graded my lab report unfairly", "dining halls should be open later"]) {
    assert.equal(asksToPassOn(text), false, text);
  }
});

test("the router's instructions keep people, noise, rules, hours and prices out of repair", async () => {
  let system = "";
  setModelCall(async (opts) => {
    system = opts.system;
    return JSON.stringify({ flow: "smalltalk", action: "chat", details: {} });
  });
  await detectIntent({ text: "my ra won't do anything about the noise", hasImage: false, state: null, notes: [] });
  assert.match(system, /repair: report \(a physical thing/);
  assert.match(system, /Noise, roommates or dormmates, an RA or any staff member not doing their job, rules not being enforced, policies, hours, prices and service quality are never repair/);
});

// ---------- photos (John, 8pm lessons (4)) ----------

test("the words sent with a photo say what it is when they can", () => {
  assert.equal(photoWords("look at my lunch"), "own");
  assert.equal(photoWords("my sweetgreen order"), "own");
  assert.equal(photoWords("rate my fit"), "own");
  assert.equal(photoWords("found this at leavey"), "found");
  assert.equal(photoWords("is this anyone's? it was on the bench"), "found");
  assert.equal(photoWords("free pizza at tcc come grab"), "food");
  assert.equal(photoWords("leftovers up for grabs"), "food");
  assert.equal(photoWords("this sink is leaking"), "broken");
  assert.equal(photoWords(""), null);
  assert.equal(photoWords("yo"), null);
  assert.equal(photoWords("what is this"), null);
});

test("a photo of their own meal is chat, never a found item or a food post", () => {
  const photo = (text: string) => fallbackIntent({ text, hasImage: true, state: null });
  assert.deepEqual([photo("look at my lunch").flow, photo("look at my lunch").action], ["smalltalk", "chat"]);
  assert.equal(photo("look at my sweetgreen salad").flow, "smalltalk", "a food word does not make it a post");
  assert.equal(photo("pizza at leavey").flow, "food");
  assert.equal(photo("").flow, "lost_found", "a bare photo goes where it is read first");
  // "what" no longer reads as a hat.
  assert.equal(photo("what is this").details.category, undefined);
});
