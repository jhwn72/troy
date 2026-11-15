import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMAND_POOLS, matchCommand, isCrisis, isEmergency, isHeyTroy, endsPlayful, safetySignal, TEMPLATES, DPS } from "../src/commands.ts";

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
  assert.equal(kind("Forget my location"), "forget_location");
  assert.equal(kind("forget my location."), "forget_location");
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
  // John's words after the first live test (Nov 14 evening).
  assert.deepEqual(TEMPLATES.welcome, [
    "hey i'm troy",
    "i'm an ai, but i know a guy for everything",
    "send me a photo of anything on campus and i'll get it to the right person. or just text me like 'lost my airpods at leavey'",
    "reply STOP anytime and i'll leave u alone until u want to talk again",
  ]);
  assert.equal(TEMPLATES.saveContact, "save my contact if u haven't so u know it's me");
});

test("the STOP confirmation keeps the welcome's promise and says how to come back", () => {
  const stop = TEMPLATES.stop.join(" ");
  assert.match(stop, /leave u alone/);
  assert.match(stop, /"START" or "hey troy"/);
  assert.ok(!EMOJI.test(stop));
  assert.ok(isHeyTroy("hey troy") && isHeyTroy("Hey Troy!") && isHeyTroy("heyy troy u there"));
  assert.ok(!isHeyTroy("hey") && !isHeyTroy("troy hey") && !isHeyTroy("hey troye"));
});

test("fixed copy fits in one bubble each, so none of it is ever split", () => {
  const all = [TEMPLATES.welcome, TEMPLATES.stop, TEMPLATES.start, TEMPLATES.help, TEMPLATES.emergency, TEMPLATES.crisis, TEMPLATES.deleteData, TEMPLATES.forgetLocation, [TEMPLATES.saveContact, TEMPLATES.locationSaved]].flat();
  for (const b of all) assert.ok(b.length <= 160, b);
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

test("forget my location: the reply says plainly that reading stops until they share again", () => {
  assert.equal(matchCommand("Forget my location.")?.kind, "forget_location");
  assert.equal(TEMPLATES.forgetLocation.length, 1);
  const reply = TEMPLATES.forgetLocation[0];
  assert.match(reply, /erased ur saved location/);
  assert.match(reply, /won't read it again until u share it with me again/);
  assert.equal(reply, reply.toLowerCase());
});

// ---------- jokes versus real distress ----------

test("obvious slang is nothing at all: no fixed line, and nothing for the model to read", () => {
  for (const t of ["that exam killed me lol", "i'm dead 😂", "im dead", "this class is killing me", "that midterm murdered me", "dying of laughter", "kill me now this line is so long", "that's fire", "this pset is the death of me"]) {
    assert.equal(kind(t), null, t);
    assert.equal(isCrisis(t), false, t);
    const s = safetySignal(t);
    assert.equal(s.selfHarmWords, false, t);
    assert.ok(s.level === "none" || s.level === "ambiguous", t);
    if (!/kill me now/.test(t)) assert.equal(s.level, "none", t);
  }
});

test("a self-harm phrase inside a joke, and a bare kms, are ambiguous: never the fixed line by pattern alone", () => {
  for (const t of ["kms", "kms lol", "kms i left my charger at home", "gonna kill myself if i fail this midterm lol", "i want to die this lecture is 3 hours", "i wanna die 💀", "if i fail ochem i'm jumping off leavey 💀", "this essay makes me want to kill myself lmao"]) {
    assert.equal(kind(t), null, t);
    assert.deepEqual(safetySignal(t), { level: "ambiguous", selfHarmWords: true }, t);
  }
});

test("heavy lines with no self-harm word get one read by the model, never a hotline by pattern", () => {
  for (const t of ["i can't do this anymore", "whats the point of anything", "nobody would care if i was gone", "i just want to disappear", "i feel like a burden"]) {
    assert.equal(kind(t), null, t);
    assert.deepEqual(safetySignal(t), { level: "ambiguous", selfHarmWords: false }, t);
  }
});

test("a plain first-person statement with nothing light around it is still unmistakable", () => {
  for (const t of ["i want to kill myself", "im going to kill myself tonight", "i'm suicidal", "i want to end my life", "i've been cutting myself", "i don't want to live anymore"]) {
    assert.equal(kind(t), "crisis", t);
    assert.equal(safetySignal(t).level, "crisis", t);
  }
  assert.equal(safetySignal("there's a fire in my dorm").level, "emergency");
  assert.equal(safetySignal("lost my wallet").level, "none");
});

test("endsPlayful: a laugh or an emoji at the end", () => {
  for (const t of ["stop lol", "omg stop 😂", "STOP LMAO", "stop ur so funny haha", "leave me alone 💀", "stop!! 😭😭"]) assert.equal(endsPlayful(t), true, t);
  for (const t of ["stop", "leave me alone", "stop texting me pls", "lol stop texting me", ""]) assert.equal(endsPlayful(t), false, t);
});

// ---------- commands by meaning: the wording pools ----------

test("command pools: lowercase, no em dashes, at most one emoji, and exact words to type sit in double quotes", () => {
  for (const [name, pool] of Object.entries(COMMAND_POOLS)) {
    assert.ok(pool.length >= 2, `${name} has variants`);
    assert.equal(new Set(pool).size, pool.length, `${name} has no repeats`);
    for (const line of pool) {
      assert.equal(line, line.toLowerCase(), line);
      assert.ok(!/[—–]/.test(line), line);
      assert.ok(!/\byou\b|\byour\b/.test(line), line);
      for (const b of line.split("|")) assert.ok(b.trim().length <= 160, b);
    }
  }
  // Each of these tells the student one exact word to text, so the word is quoted.
  for (const line of COMMAND_POOLS.pause) assert.match(line, /"resume"/, line);
  for (const name of ["askStop", "askPause", "askResume", "askForgetLocation", "askUnsubscribe", "askStart"] as const) for (const line of COMMAND_POOLS[name]) assert.match(line, /"yes"/, line);
  // The location confirmation always says both halves.
  for (const line of COMMAND_POOLS.forgetLocation) assert.match(line, /(?:won't|only).*(?:again|share)/, line);
});

test("fixed lines quote the exact words to type", () => {
  assert.match(TEMPLATES.stop[0], /text "START" or "hey troy"/);
  assert.match(TEMPLATES.pause[0], /text "resume"/);
  assert.match(TEMPLATES.deleteData[1], /text "hey troy"/);
  assert.match(TEMPLATES.help[2], /"STOP" to opt out, "pause" to mute alerts, "resume" to unmute, "settings", "human", "forget my location", "delete my data"/);
  assert.deepEqual(TEMPLATES.confirmDelete, ['want me to delete everything i have on u? reply "yes"']);
  // Variant 0 of a pool is the line the exact word gets.
  assert.equal(COMMAND_POOLS.pause[0], TEMPLATES.pause[0]);
  assert.equal(COMMAND_POOLS.resume[0], TEMPLATES.resume[0]);
  assert.equal(COMMAND_POOLS.forgetLocation[0], TEMPLATES.forgetLocation[0]);
});
