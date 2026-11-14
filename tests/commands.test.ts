import { test } from "node:test";
import assert from "node:assert/strict";
import { matchCommand, isEmergency, TEMPLATES, DPS } from "../src/commands.ts";

const kind = (t: string) => matchCommand(t)?.kind ?? null;
const EMOJI = /\p{Extended_Pictographic}/u;

test("whole-message commands, any case, trailing punctuation", () => {
  assert.equal(kind("STOP"), "stop");
  assert.equal(kind("stop."), "stop");
  assert.equal(kind(" Unsubscribe "), "stop");
  assert.equal(kind("START"), "start");
  assert.equal(kind("Help"), "help");
  assert.equal(kind("HELP!"), "help");
  assert.equal(kind("pause"), "pause");
  assert.equal(kind("Resume"), "resume");
  assert.equal(kind("human"), "human");
  assert.equal(kind("Delete my data"), "delete_data");
  assert.equal(kind("settings"), "settings");
});

test("commands only match the whole message", () => {
  for (const t of ["stop by leavey later", "can u help me find my keys", "please pause the music", "i need a human touch", "start looking for my wallet", "", "hey troy"]) {
    assert.equal(kind(t), null, t);
  }
});

test("emergency phrases trigger", () => {
  const yes = [
    "there's a fire",
    "There’s a fire in my dorm",
    "the building is on fire",
    "building is on fire",
    "i'm hurt",
    "im hurt really bad",
    "someone is hurt",
    "someone's hurt",
    "i was assaulted",
    "i think i'm being followed",
    "being followed",
    "someone is following me",
    "i'm in danger",
    "someone has a gun",
    "this is an emergency",
    "call 911",
    "my friend is overdosing",
    "overdose",
    "my roommate is not breathing",
  ];
  for (const t of yes) assert.equal(kind(t), "emergency", t);
});

test("slang and everyday texts do not trigger emergency", () => {
  const no = [
    "that's fire",
    "this food is fire",
    "my feet hurt",
    "fire emoji",
    "emergency meeting for my club",
    "we have an emergency meeting tonight",
    "fight on",
    "that fit is fire",
    "he's on fire tonight",
    "theres fire tacos at the village",
    "i lost my wallet",
    "it hurt my feelings",
    "follow me on insta",
    "free food at leavey",
    "the fire alarm test is tomorrow",
  ];
  for (const t of no) assert.equal(kind(t), null, t);
});

test("emergency wins over other commands", () => {
  assert.equal(kind("help there's a fire"), "emergency");
});

test("emergency reply has 911 and the DPS numbers, and no emoji", () => {
  const all = TEMPLATES.emergency.join(" ");
  assert.match(all, /911/);
  assert.ok(all.includes(DPS.upcEmergency));
  assert.ok(all.includes(DPS.upcNonEmergency));
  assert.equal(DPS.upcEmergency, "213-740-4321");
  assert.equal(DPS.upcNonEmergency, "213-740-6000");
  assert.ok(!EMOJI.test(all));
  assert.ok(!EMOJI.test(TEMPLATES.stop.join(" ")));
});

test("welcome is the fixed spec text", () => {
  assert.deepEqual(TEMPLATES.welcome, ["hey i'm troy", "i'm an ai that connects trojans. lost something, found something, free food nearby? i know a guy", "reply STOP anytime"]);
});

test("no em dashes in any template", () => {
  assert.ok(!JSON.stringify(TEMPLATES).includes("—"));
});

test("emergency: contractions glued to a noun still trigger", () => {
  for (const t of ["the building's on fire", "someone's following me", "my dorm's on fire", "kitchen’s on fire", "he's following me"]) {
    assert.equal(kind(t), "emergency", t);
  }
});

test("emergency: more danger phrases", () => {
  const yes = [
    "i was just robbed",
    "somebody just robbed me",
    "someone broke into my apartment",
    "someone is trying to break in",
    "there's smoke in the hallway",
    "my friend is having a seizure",
    "my friend passed out and wont wake up",
    "i got hit by a car",
    "he hit me",
    "there's an active shooter",
    "i need the police",
    "i don't feel safe",
    "i got jumped",
  ];
  for (const t of yes) assert.equal(kind(t), "emergency", t);
});

test("emergency: ordinary texts that share a word stay quiet", () => {
  const no = [
    "she is following us on insta",
    "my professor is following me on linkedin",
    "i need the police report office",
    "i got hurt feelings",
    "i got jumped by that exam",
    "i was shot down by my crush",
    "the fire in my soul",
    "shooter mcgavin is a great character",
    "who's the shooter in the photo club",
    "dont feel safe posting my number",
    "that food was fire",
    "there's a fire drill",
    "hit me up",
    "he hit me up about the notes",
    "i feel like i got hit by a truck",
    "i cant wake up for my 8am",
    "theres a smoke shop on fig",
    "trying to break into the industry",
  ];
  for (const t of no) {
    assert.equal(kind(t), null, t);
    assert.equal(isEmergency(t), false, t);
  }
});

test("self-harm texts get the crisis reply with 988, 911 and DPS, and no emoji", () => {
  for (const t of ["i want to kill myself", "im going to kill myself", "suicidal", "i wanna end it all", "i don't want to be alive anymore"]) {
    assert.equal(kind(t), "crisis", t);
  }
  const all = TEMPLATES.crisis.join(" ");
  assert.match(all, /\b988\b/);
  assert.match(all, /911/);
  assert.ok(all.includes(DPS.upcEmergency));
  assert.ok(!EMOJI.test(all));
  assert.equal(all, all.toLowerCase());
});
