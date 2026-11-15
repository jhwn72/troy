// Flow 3: broken things. A photo and/or a text about something broken becomes a row in `reports`
// (kind 'repair') that the staff dashboard lists. The dashboard's status buttons text the reporter and
// every follower, so this flow never sends status updates itself.
//
// MOCKED: Troy does not file anything in FMS's or USC Housing's own work order systems. A report is only
// logged on Troy's staff dashboard, grouped under the office it would go to. He says so in one short line the
// first time a person files anything, and not again.
//
// Only a physical thing that is broken, leaking, out of order or unsafe to use belongs here. Noise, roommates, an
// RA or staff not doing their job, rules, hours and prices are concerns: the guard at the top of `start` passes
// them to the concern flow, and nothing about them is ever filed with FMS.
//
// A chat never files anything on its own. When only the chat model read a message as a repair (`unconfirmed`),
// this flow offers to report it and waits for a yes. A report that began from an offer names the office it is
// going to before it is filed.
//
// Code decides: which office (from campus_places.kind), the office name (from the directory table),
// whether it joins an existing report, the follower count, and the DPS number. The model only reads the photo.

import type { FlowContext, FlowHandler, FlowState } from "../types.ts";
import { askJson, asksToPassOn, fallbackIntent, peopleOrPolicy } from "../ai.ts";
import { openQuestionId, readYesNo } from "../yes.ts";
import { DPS } from "../commands.ts";
import { getFlowState } from "../db/index.ts";
import { findPlace } from "../places.ts";
import type { Place } from "../places.ts";
import { CANCEL, CANCELLED, CANCELLED_POOL, DEMO_NOTE, DEMO_NOTE_POOL, OFFER_STEP, claimsDone, contentWords, directoryRows, firstFiling, follow, insertReport, isFresh, joinWords, makeVoice, newestOutId, noEmoji, offerLive, openReports, othersPhrase, ownWords, passToOtherFlow, rowForTopic, similarText, unvoiced, userNotes } from "./reports-shared.ts";
import type { Pools, ReportRow, Voice } from "./reports-shared.ts";
import { DECISION, STAFF_STEP, TALK_STEP, aside, handleStaffTurn, notifyStaffOfReport, restoreStaffPointer, simulateIfAlone, simulationTurn, tellerFor } from "../staff.ts";

type RouteKey = "fms" | "housing";

/** Used only if the directory has no matching office row (an unseeded database). */
const ROUTE_FALLBACK: Record<RouteKey, string> = { fms: "FMS", housing: "Housing" };

/** Every step this flow (or a staff contact's job) opens. Any other open step under this flow is a simulation's. */
const OWN_STEPS: ReadonlySet<string> = new Set(["ask_place", OFFER_STEP, "confirm", STAFF_STEP, TALK_STEP]);
/** The step after a report that began from an offer has its place: he names the office and waits for an ok. */
const CONFIRM_STEP = "confirm";

const ASK_WHERE = "which building and floor?";
const ASK_WHAT_AND_WHERE = "what's broken, and which building and floor?";
/** Fixed copy. No emoji: this is a stressful moment. */
export const DANGER_LINE = `that sounds dangerous. please call dps at ${DPS.upcNonEmergency} now and stay clear of it. if anyone's in danger, call 911.`;

const SAY = {
  alreadyReported: "u already reported that one and it's still open",
  whenItMoves: "i'll text u when it moves",
  notReported: "ok, i didn't report that one. text me the building whenever u want it sent",
  leftIt: "all good, i'll leave it",
  /** Said right after a report when an example technician was texted: nobody on the other end is real staff yet. */
  exampleTech: "(heads up: i texted a stand-in technician for the hackathon. no real facilities staff are on here yet)",
};

/** Lines with a value in them (the office, how many others). Code puts the value in; these only hold the words around it. */
const RT = {
  joined: (others: string, office: string) => `${others} already reported that to ${office}, so i added u to it`,
  reported: (office: string) => `reported to ${office} ✅ i'll text u when it moves.`,
  reportedPlain: (office: string) => `reported to ${office}. i'll text u when it moves.`,
  /** Before the filing step of a report that began from an offer: where it is going, and a last ok. */
  confirm: (office: string) => `sending this to ${office} as a repair report. ok?`,
};

// ---------- wording variants (facts locked, wording varied) ----------
//
// Variant 0 of every pool is the line the code writes; the rest say the same thing with the same values.
// NOT in any pool, so always word for word: DANGER_LINE (the dangerous-thing line with the dps number).
export const REPAIR_POOLS: Pools = {
  askWhere: [ASK_WHERE, "what building and floor?", "which building is it in, and what floor?"],
  askWhatAndWhere: [ASK_WHAT_AND_WHERE, "what's broken, and what building and floor?", "what broke, and which building and floor?"],
  alreadyReported: [SAY.alreadyReported, "u reported that one already and it's still open", "that one's already reported by u, and it's still open"],
  whenItMoves: [SAY.whenItMoves, "i'll text u once it moves", "when it moves, i'll text u"],
  joined: (others, office) => [
    RT.joined(others, office),
    `${others} already reported that to ${office}, so i put u on it too`,
    `${others} reported that to ${office} already, so i added u to it`,
  ],
  // "on it 👀" only where the line already carries an emoji. The plain pool is for dangerous reports and "no emoji" notes.
  reported: (office) => [
    RT.reported(office),
    `on it 👀 reported to ${office}. i'll text u when it moves.`,
    `it's reported to ${office} ✅ i'll text u when it moves.`,
  ],
  reportedPlain: (office) => [
    RT.reportedPlain(office),
    `it's reported to ${office}. i'll text u when it moves.`,
    `reported to ${office}, and i'll text u when it moves.`,
  ],
  notReported: [
    SAY.notReported,
    "ok, i held off on reporting that one. text me the building whenever u want it sent",
    "ok, that one's not reported. whenever u want it sent, text me the building",
  ],
  cancelled: CANCELLED_POOL,
  leftIt: [SAY.leftIt, "no worries, i won't report it", "ok, leaving that one alone"],
  confirm: (office) => [
    RT.confirm(office),
    `this would go to ${office} as a repair report. ok to send?`,
    `i'd send this to ${office} as a repair report. good?`,
  ],
  demoNote: DEMO_NOTE_POOL,
  exampleTech: [
    SAY.exampleTech,
    "(heads up: the technician i texted is a stand-in for the hackathon. no real facilities staff are on here yet)",
    "(note: i texted an example technician for the hackathon, not real facilities staff yet)",
  ],
};

export const REPAIR_VOICE: Voice = makeVoice("repair", REPAIR_POOLS);

const DANGER = /\bgas\b.{0,20}\bsmell|\bsmell(?:s|ing)?\b.{0,20}\bgas\b|\bgas leak|carbon monoxide|exposed wir|live wire|bare wire|loose wires?|\bsparks?\b|\bsparking\b|\bflood(?:ed|ing|s)?\b|burning smell|smells? like (?:burning|smoke)|\bsmoking\b|ceiling (?:is |just )?(?:collaps|caving|falling)|electrocut|got shocked/i;
const NOT_A_SPOT = /^(?:thanks|thank u|thank you|thx|ty|tysm|ok|okay|k|kk|lol|lmao|cool|nice|bet|idk|i don'?t know|not sure|no idea|what|huh|\?+)(?:\s+\w+){0,2}[.!?]*$/i;
const DORM_WORDS = /\b(?:dorm|my room|my suite|my apartment|my apt|residence hall|residential college|housing)\b/i;

// ---------- what broke ----------

/** One word for the broken thing, so "light is out" and "broken light" count as the same thing. Narrow on purpose. */
const THINGS: [RegExp, string][] = [
  [/\belevators?\b/, "elevator"],
  [/\b(?:water )?fountains?\b|bottle filler/, "water fountain"],
  [/\btoilets?\b|\burinals?\b|won'?t flush/, "toilet"],
  [/\bshowers?\b/, "shower"],
  [/\bfaucets?\b|\bsinks?\b|\btaps?\b/, "faucet"],
  [/\bdrains?\b/, "drain"],
  [/\blights?\b|\blighting\b|\bbulbs?\b|\blamps?\b/, "light"],
  // Three different repairs, so three different things: a card reader, a lock, and the door itself.
  [/card ?reader|\bcard (?:swipe|scanner|access)\b|\bswipe (?:reader|access)\b/, "card reader"],
  [/\blocks?\b|\bdeadbolt\b|\blatch\b/, "lock"],
  [/\bdoors?\b|\bdoor handle\b/, "door"],
  [/\bac\b|a\/c|air con|\bheat(?:er|ing)?\b|thermostat/, "ac"],
  [/\boutlets?\b|\bsockets?\b|\bwires?\b|\bwiring\b/, "outlet"],
  [/\bwindows?\b/, "window"],
  [/\bwashers?\b|washing machine/, "washer"],
  [/\bdryers?\b/, "dryer"],
  [/\bprinters?\b/, "printer"],
  [/\bvending\b/, "vending machine"],
  [/\bwi-?fi\b/, "wifi"],
  [/\bleak(?:ing|s|y|ed)?\b|\bplumbing\b|\bpipes?\b/, "leak"],
];

export function thingOf(text: string): string | null {
  const t = text.toLowerCase();
  return THINGS.find(([re]) => re.test(t))?.[1] ?? null;
}

/** A short category from the words alone, used when there is no photo or no model. */
export function categoryFromText(text: string): string {
  const t = text.toLowerCase();
  const thing = thingOf(t);
  if (!thing) return "other";
  if (thing === "leak") return "leak";
  if (thing === "elevator") return "elevator out";
  if (thing === "wifi") return "wifi down";
  if (/\bleak|\bdrip/.test(t)) return `leaking ${thing}`;
  if (/\bclog|won'?t (?:drain|flush)|overflow/.test(t)) return `clogged ${thing}`;
  return `broken ${thing}`;
}

/** "2nd floor", "room 204", "lobby": the part of the spot a place name doesn't cover. Only what the text says. */
export function spotDetail(text: string): string | null {
  const t = text.toLowerCase();
  const parts: string[] = [];
  const floor = t.match(/\b(?:\d{1,2}(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ground|top) floor\b|\bfloor \d{1,2}\b|\bbasement\b/);
  if (floor) parts.push(floor[0]);
  const room = t.match(/\b(?:room|rm|suite|apt|unit) #?[a-z]?\d{1,4}[a-z]?\b/);
  if (room) parts.push(room[0]);
  const area = t.match(/\b(?:lobby|stairwell|stairs|hallway|bathroom|restroom|lounge|laundry room|kitchen|entrance|study room|courtyard)\b/);
  if (area) parts.push(area[0]);
  return parts.length ? parts.join(", ") : null;
}

function floorOf(text: string | null): string | null {
  const m = (text ?? "").toLowerCase().match(/\b(\d{1,2})(?:st|nd|rd|th)? floor\b|\bfloor (\d{1,2})\b|\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ground|basement)\b/);
  if (!m) return null;
  const wordsToNum: Record<string, string> = { first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6", seventh: "7", eighth: "8", ground: "1", basement: "b" };
  return m[1] ?? m[2] ?? wordsToNum[m[3]!] ?? null;
}

/** "room 204", "rm 12b", "suite 3", "apt 410": the unit a report names, as one comparable string. Null when it names none. */
export function roomOf(text: string | null): string | null {
  const m = (text ?? "").toLowerCase().match(/\b(?:room|rm|suite|apt|apartment|unit) #?([a-z]?\d{1,4}[a-z]?)\b/);
  return m ? m[1]! : null;
}

const AREA = /\b(lobby|stairwell|stairs|hallway|bathroom|restroom|lounge|laundry room|kitchen|entrance|study room|courtyard)\b/;

/** The named part of a building ("entrance", "bathroom"). "restroom" and "bathroom", "stairs" and "stairwell" are the same place. */
export function areaOf(text: string | null): string | null {
  const m = (text ?? "").toLowerCase().match(AREA);
  if (!m) return null;
  return m[1] === "restroom" ? "bathroom" : m[1] === "stairs" ? "stairwell" : m[1]!;
}

// ---------- routing ----------

function routeKeyOf(routedTo: string | null): RouteKey | null {
  const t = (routedTo ?? "").toLowerCase();
  if (/housing/.test(t)) return "housing";
  if (/\bfms\b|facilities/.test(t)) return "fms";
  return null;
}

/** Dorms go to USC Housing maintenance, everything else to FMS. The name is the directory row's, exactly as stored. */
function routeFor(ctx: FlowContext, place: Place | null, spokenSpot: string): { key: RouteKey; name: string } {
  const key: RouteKey = place ? (place.kind === "dorm" ? "housing" : "fms") : DORM_WORDS.test(spokenSpot) ? "housing" : "fms";
  const offices = directoryRows(ctx.db, "office");
  const row = rowForTopic(offices, key === "housing" ? "dorm" : "fms") ?? offices.find((o) => routeKeyOf(o.name) === key) ?? null;
  return { key, name: row?.name ?? ROUTE_FALLBACK[key] };
}

// ---------- duplicates ----------

interface Draft {
  category: string;
  description: string;
  photoUrl: string | null;
  dangerous: boolean;
  /** "read": the model said what the photo shows. "unread": there was a photo and it couldn't (the report then runs on their words). */
  photo: "read" | "unread" | "none";
}

function findDuplicate(ctx: FlowContext, draft: Draft, key: RouteKey, place: Place | null, locationText: string | null): ReportRow | null {
  const mine = `${draft.category} ${draft.description}`;
  const myThing = thingOf(mine);
  const mySpot = `${locationText ?? ""} ${draft.description}`;
  const myFloor = floorOf(mySpot);
  const myRoom = roomOf(mySpot);
  const myArea = areaOf(mySpot);
  for (const r of openReports(ctx.db, "repair")) {
    // Seeded rows say "FMS" / "Housing"; new rows carry the full directory name. Both mean the same office.
    if (routeKeyOf(r.routedTo) !== key) continue;
    const theirSpot = `${r.locationText ?? ""} ${r.description ?? ""}`;
    if (place) {
      const theirs = findPlace(ctx.db, r.locationText ?? "") ?? findPlace(ctx.db, r.description ?? "");
      if (!theirs || theirs.id !== place.id) continue;
    } else if (!locationText || !r.locationText || locationText.trim().toLowerCase() !== r.locationText.trim().toLowerCase()) {
      continue;
    }
    // Two different floors of one building are two different problems.
    const theirFloor = floorOf(theirSpot);
    if (myFloor && theirFloor && myFloor !== theirFloor) continue;
    // So are two different rooms. A report that names a room only joins one that names the same room:
    // "room 512" added to the report for room 204 would mean 512 never gets looked at.
    const theirRoom = roomOf(theirSpot);
    if ((myRoom || theirRoom) && myRoom !== theirRoom) continue;
    // And two different parts of the building ("entrance" and "bathroom").
    const theirArea = areaOf(theirSpot);
    if (myArea && theirArea && myArea !== theirArea) continue;
    const theirs = `${r.category ?? ""} ${r.description ?? ""}`;
    const theirThing = thingOf(theirs);
    // Two named things that differ (a card reader and a lock) are never the same problem, however alike the wording.
    if (myThing && theirThing) {
      if (myThing === theirThing) return r;
      continue;
    }
    if (similarText(draft.description, r.description ?? "")) return r;
  }
  return null;
}

// ---------- filing ----------

/**
 * The truth about the demo (it is logged on the staff dashboard, the office's own system isn't connected yet), as
 * one short line, the first time this person files anything. Never a paragraph and never said twice.
 */
function demoNote(ctx: FlowContext): string[] {
  return firstFiling(ctx.db, ctx.user.id) ? [DEMO_NOTE] : [];
}

async function file(ctx: FlowContext, draft: Draft, place: Place | null, spokenSpot: string): Promise<void> {
  const route = routeFor(ctx, place, spokenSpot);
  const detail = spotDetail(spokenSpot) ?? spotDetail(draft.description);
  const locationText = place ? (detail ? `${place.name}, ${detail}` : place.name) : spokenSpot.trim().replace(/\s+/g, " ").slice(0, 80) || null;
  // Emoji are dropped when it's dangerous (a stressful moment) or the student asked for none.
  const plain = draft.dangerous || noEmoji(userNotes(ctx.db, ctx.user.id));
  const lead = draft.dangerous ? [DANGER_LINE] : [];

  ctx.setState(null);
  const dup = findDuplicate(ctx, draft, route.key, place, locationText);
  if (dup) {
    const { result, others } = follow(ctx.db, dup, ctx.user.id);
    if (draft.photoUrl) ctx.db.prepare("UPDATE reports SET photoUrl = ? WHERE id = ? AND photoUrl IS NULL").run(draft.photoUrl, dup.id);
    if (result === "already") {
      await ctx.say(...lead, SAY.alreadyReported, SAY.whenItMoves);
      return;
    }
    await ctx.say(...lead, RT.joined(othersPhrase(others), route.key), SAY.whenItMoves, ...demoNote(ctx));
    // Never in a dangerous moment: the dps line is the only thing that matters then.
    if (!draft.dangerous) {
      await aside(ctx, {
        step: "repair_joined",
        behind: { did: "matched it to a report already open at the same spot, with {alreadyOnIt} already on it, instead of filing a second one with {office}", numbers: { alreadyOnIt: others, office: route.name } },
        decision: DECISION.officesStayInCharge,
      });
    }
    return;
  }

  const reportId = insertReport(ctx.db, {
    userId: ctx.user.id,
    kind: "repair",
    category: draft.category,
    description: draft.description,
    locationText,
    photoUrl: draft.photoUrl,
    routedTo: route.name,
  });
  const confirm = plain ? RT.reportedPlain(route.key) : RT.reported(route.key);
  // The assigned technician is texted (an example contact for now); with nobody assigned the dashboard shows the text.
  // Never allowed to cost the student their confirmation.
  let texted = false;
  try {
    texted = (await notifyStaffOfReport({ db: ctx.db, notify: tellerFor(ctx) }, reportId)).sentTo !== null;
  } catch {
    texted = false;
  }
  // A stand-in technician was texted: that line says it's a demo. Otherwise the one-time demo note does.
  await ctx.say(...lead, confirm, ...(texted ? [SAY.exampleTech] : demoNote(ctx)));
  // Never in a dangerous moment: no aside and no demo offer on top of the dps line.
  if (draft.dangerous) return;
  // Nobody is assigned to this office, so nothing would happen next. A judge (or a student with nobody else on here)
  // is offered the technician's side played out; a student in a live pilot just waits for the real status text.
  if (!texted && (await simulateIfAlone(ctx, "repair", { what: draft.category, description: draft.description, where: locationText ?? "", office: route.name, reportId: String(reportId) }))) return;
  const because = route.key === "housing" ? "it's in usc housing" : "it's a campus building";
  if (draft.photo === "unread") {
    await aside(ctx, {
      step: "repair_filed",
      behind: { did: "couldn't get the photo read by the ai, so i filed it from ur words and routed it to {office} because {because}", numbers: { office: route.name, because } },
      decision: DECISION.worksWhenAiDown,
    });
    return;
  }
  await aside(ctx, {
    step: "repair_filed",
    behind: { did: `${draft.photo === "read" ? "read ur photo, worked out what's broken" : "worked out what's broken from ur words"} and routed it to {office} because {because}`, numbers: { office: route.name, because } },
    decision: draft.photo === "read" ? DECISION.photoReplacesForm : DECISION.officesStayInCharge,
  });
}

// ---------- the photo ----------

const PHOTO_SYSTEM = `You look at a photo a USC student texted of something broken on campus. Reply with JSON only, no other words:
{"category": "...", "description": "...", "location": "..."}
category: two or three lowercase words for what is wrong, like "broken light", "leaking faucet", "elevator out".
description: one short lowercase line saying what is wrong.
location: the building, floor or room, only if a sign or number in the photo shows it or the student's text says it. Otherwise null. Never guess a location.`;

const line = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").replace(/[—–]/g, "-").trim().toLowerCase().slice(0, max) : null);

async function readPhoto(ctx: FlowContext): Promise<{ category: string | null; description: string | null; location: string | null }> {
  const none = { category: null, description: null, location: null };
  if (!ctx.event.images.length) return none;
  // One call. Null when there is no key, the call is slow or the answer isn't JSON: the text carries the report then.
  const out = await askJson<{ category?: unknown; description?: unknown; location?: unknown }>({
    model: "smart",
    system: PHOTO_SYSTEM,
    prompt: `Student's text with the photo: ${JSON.stringify(ctx.event.text.slice(0, 500))}`,
    images: ctx.event.images.slice(0, 1),
    maxTokens: 2048,
  });
  if (!out || typeof out !== "object" || Array.isArray(out)) return none;
  return { category: line(out.category, 40), description: line(out.description, 200), location: line(out.location, 80) };
}

// ---------- handler ----------

/**
 * People and policy are never a repair. Hands what they said to the concern flow, which offers to pass it to
 * housing, residential staff or student government and files nothing without a yes. True when it took it. When
 * that flow isn't there, this one still files nothing: the caller stays silent and the chat brain answers.
 */
async function toConcern(ctx: FlowContext, thread: string[], fromChat: boolean): Promise<boolean> {
  // Loaded here, not at the top: the registry imports this file.
  const { getFlow } = await import("./index.ts");
  const concerns = getFlow("usg");
  if (!concerns || concerns.name !== "usg") return false;
  // Their concern already has an offer open, and this is more of the same talk (the router read it as a repair, so
  // the pipeline brought it here). It goes to that offer as whatever it is, never into a second offer. When the
  // concern flow has nothing to say to it, the chat brain answers, as it would have had the message gone there first.
  const open = getFlowState(ctx.db, ctx.user.id);
  if (open && open.flow === "usg" && open.step === OFFER_STEP && offerLive(ctx.db, ctx.event.chatId, open)) {
    let spoke = false;
    const plain = unvoiced(ctx);
    const say: FlowContext["say"] = (...bubbles) => {
      spoke = true;
      return plain.say(...bubbles);
    };
    await concerns.handle({ ...plain, say, state: open, intent: { flow: "usg", action: "answer", details: {}, source: "fallback" } });
    const chat = getFlow("smalltalk");
    if (!spoke && chat && getFlowState(ctx.db, ctx.user.id)?.step === OFFER_STEP) await chat.handle({ ...plain, state: null, intent: { flow: "smalltalk", action: "chat", details: {}, source: "fallback" } });
    return true;
  }
  const { unconfirmed: _unconfirmed, ...details } = ctx.intent.details;
  await concerns.handle({
    ...unvoiced(ctx),
    state: null,
    intent: { flow: "usg", action: "concern", details: { ...details, words: thread, ...(fromChat ? { fromChat: true, meant: "concern" } : {}) }, source: ctx.intent.source },
  });
  return true;
}

/**
 * Only the chat model read this as a repair, and the student never asked for a report: he says what he could do
 * and waits. The offer is this flow's open step and holds what they said, so a yes never asks for it again. When
 * the place is already known the offer names the office, and a yes files it.
 */
async function offer(ctx: FlowContext, draft: Draft, place: Place | null, spot: string): Promise<void> {
  const to = place ? routeFor(ctx, place, spot).key : null;
  const fallback = to
    ? [[`want me to report that to ${to} so someone comes to fix it?`], [`i can report that to ${to} for u. want me to?`], [`sounds like one for ${to}. want me to send it in?`]]
    : [["want me to report that so someone comes to fix it?"], ["i can report that so it gets fixed. want me to?"], ["that sounds like something i can report. should i?"]];
  let bubbles: string[] = [];
  try {
    // Loaded here: the chat brain imports this folder's shared file.
    const { sayInHisWords } = await import("../brain.ts");
    bubbles = await sayInHisWords(unvoiced(ctx), {
      goal: "they mentioned something on campus that sounds broken. react in a few words, then offer to report it so someone comes to fix it, and ask if they want that. nothing has been reported, and nothing will be unless they say yes. do not ask where it is",
      mustCover: [to ? `troy could report it to ${to} so it gets fixed, if they want` : "troy could report it so it gets fixed, if they want"],
      facts: to ? { "who fixes it": to } : {},
      fallback,
    });
  } catch {
    bubbles = [];
  }
  // A question, about something that has not happened: wording that says it was reported never goes out.
  if (!bubbles.length || !bubbles[bubbles.length - 1]!.includes("?") || claimsDone(bubbles)) bubbles = fallback[0]!;
  const ids = await ctx.say(...bubbles);
  ctx.setState({ flow: "repair", step: OFFER_STEP, data: { ...draft, spot, qid: lastOf(ids), lastOut: newestOutId(ctx.db, ctx.event.chatId) } });
}

/** Whether this person still has an open step after the answer was read (a lapsed offer has been cleared by then). */
const getFlowStateNow = (ctx: FlowContext) => getFlowState(ctx.db, ctx.user.id);

const lastOf = (ids: (string | null)[]): string | null => [...ids].reverse().find((id) => !!id) ?? null;

function draftFrom(data: Record<string, unknown>): Draft {
  const description = typeof data.description === "string" ? data.description : "";
  return {
    category: typeof data.category === "string" ? data.category : categoryFromText(description),
    description,
    photoUrl: typeof data.photoUrl === "string" ? data.photoUrl : null,
    dangerous: data.dangerous === true,
    photo: data.photo === "read" || data.photo === "unread" ? data.photo : "none",
  };
}

/**
 * Their answer to an offer, or to the confirmation that names the office. Only a yes (typed, or a thumbs up on
 * that bubble) moves it forward. A no drops it with one easy line. True when the message was the answer; false
 * when the offer was dropped and the message still needs handling as whatever it is.
 */
async function answerOffer(ctx: FlowContext, state: FlowState): Promise<boolean> {
  const tap = !!(ctx.event.reaction || ctx.event.pollVote);
  if (!offerLive(ctx.db, ctx.event.chatId, state)) {
    // Lapsed, or he has said something else since: a "yes" now is not a yes to this.
    ctx.setState(null);
    return tap;
  }
  const answer = readYesNo({ event: ctx.event, questionMessageId: openQuestionId(ctx.db, ctx.user.id, state) });
  if (tap && !answer) return true;
  if (answer === "no" || (!tap && CANCEL.test(ctx.event.text.trim()))) {
    ctx.setState(null);
    await ctx.say(SAY.leftIt);
    return true;
  }
  if (answer === "yes") {
    const draft = draftFrom(state.data);
    const spot = typeof state.data.spot === "string" ? state.data.spot : "";
    const place = findPlace(ctx.db, spot);
    // The confirmation named the office, or the offer did (the place was already known) and it is still his last word.
    if (state.step === CONFIRM_STEP || (place && state.data.standing !== true)) {
      await file(ctx, draft, place, spot);
      return true;
    }
    // The offer has been standing through a reply or two of his: he names the office again and asks once more.
    if (place) {
      const ids = await ctx.say(...(draft.dangerous ? [DANGER_LINE] : []), RT.confirm(routeFor(ctx, place, spot).key));
      ctx.setState({ flow: "repair", step: CONFIRM_STEP, data: { ...draft, spot, qid: lastOf(ids), lastOut: newestOutId(ctx.db, ctx.event.chatId) } });
      return true;
    }
    // The one thing still missing. Its answer gets the confirmation that names the office, then it is filed.
    ctx.setState({ flow: "repair", step: "ask_place", data: { ...draft, needWhat: false, fromOffer: true } });
    await ctx.say(ASK_WHERE);
    return true;
  }
  // Not an answer. The caller decides what it is; the offer is still there until it does.
  return false;
}

async function start(ctx: FlowContext): Promise<void> {
  const text = ctx.event.text.trim();
  // `unconfirmed`: only the chat model read this as a repair (no keyword agreed, no photo). The same holds when
  // only the router model did: the keyword rules don't read a repair, there is no photo, and they never asked for
  // a report. Either way it is the model's word alone, so he offers and files nothing without a yes.
  const modelOnly = ctx.intent.source === "ai" && !ctx.event.images.length && !asksToPassOn(text) && fallbackIntent({ text, hasImage: false, state: null }).flow !== "repair";
  const fromChat = ctx.intent.details.unconfirmed === true || modelOnly;
  // Re-check what was handed over, with what they said just before when it came out of a chat.
  const thread = fromChat ? ownWords(ctx.db, ctx.event.chatId, text) : [text];
  if (!ctx.event.images.length && peopleOrPolicy(thread.join(". "))) {
    await toConcern(ctx, thread, fromChat);
    return;
  }
  const photo = await readPhoto(ctx);
  // From a chat, the thing may have been named a message or two back.
  const basis = fromChat ? joinWords(thread) || text : text;
  const said = basis.replace(/\s+/g, " ").slice(0, 300);
  // The student's own words win when they say enough; "this is broken" leans on what the photo shows.
  const description = (contentWords(said).size >= 3 ? said : photo.description) || said;
  const draft: Draft = {
    category: photo.category ?? categoryFromText(description),
    description,
    photoUrl: ctx.event.images[0]?.path ?? null,
    dangerous: DANGER.test(`${basis} ${photo.description ?? ""}`),
    photo: !ctx.event.images.length ? "none" : photo.category || photo.description ? "read" : "unread",
  };
  const place = findPlace(ctx.db, basis) ?? (photo.location ? findPlace(ctx.db, photo.location) : null);
  if (fromChat) {
    // They said yes to troy's own offer in the chat a moment ago: no second offer. Otherwise nothing is asked,
    // collected or sent on the model's word alone: he offers, and a yes starts it.
    if (ctx.intent.details.accepted !== true) {
      await offer(ctx, draft, place, basis);
      return;
    }
    if (!place) {
      ctx.setState({ flow: "repair", step: "ask_place", data: { ...draft, needWhat: false, fromOffer: true } });
      await ctx.say(ASK_WHERE);
      return;
    }
    // The offer they said yes to was in troy's own words, and code can't know what it named. So code names the
    // office and asks once itself: a yes to that is the yes that files it.
    const spot = `${basis} ${photo.location ?? ""}`;
    const ids = await ctx.say(...(draft.dangerous ? [DANGER_LINE] : []), RT.confirm(routeFor(ctx, place, spot).key));
    ctx.setState({ flow: "repair", step: CONFIRM_STEP, data: { ...draft, spot, qid: lastOf(ids), lastOut: newestOutId(ctx.db, ctx.event.chatId) } });
    return;
  }
  if (place) {
    await file(ctx, draft, place, `${basis} ${photo.location ?? ""}`);
    return;
  }
  // One question, then it gets filed with whatever they say.
  const needWhat = !description;
  ctx.setState({ flow: "repair", step: "ask_place", data: { ...draft, needWhat } });
  const ask = needWhat ? ASK_WHAT_AND_WHERE : ASK_WHERE;
  if (draft.dangerous) await ctx.say(DANGER_LINE, ask);
  else await ctx.say(ask);
}

async function answer(ctx: FlowContext, data: Record<string, unknown>): Promise<void> {
  const text = ctx.event.text.trim();
  if (CANCEL.test(text)) {
    ctx.setState(null);
    await ctx.say(CANCELLED);
    return;
  }
  // "found a wallet" in the middle of a repair question is a new request, not a building.
  if (await passToOtherFlow(ctx, "repair")) return;

  // "thanks" or "lol ok" is not a building. Nothing gets filed on a shrug.
  if (!ctx.event.images.length && NOT_A_SPOT.test(text) && !findPlace(ctx.db, text)) {
    ctx.setState(null);
    await ctx.say(SAY.notReported);
    return;
  }

  const needWhat = data.needWhat === true;
  const earlier = typeof data.description === "string" ? data.description : "";
  const said = text.replace(/\s+/g, " ").slice(0, 300);
  if (!said && !ctx.event.images.length) {
    ctx.setState(null);
    return;
  }
  const description = needWhat || !earlier ? said || "photo of something broken" : earlier;
  const draft: Draft = {
    category: needWhat || typeof data.category !== "string" ? categoryFromText(description) : data.category,
    description,
    photoUrl: (typeof data.photoUrl === "string" ? data.photoUrl : null) ?? ctx.event.images[0]?.path ?? null,
    dangerous: data.dangerous === true || DANGER.test(text),
    photo: data.photo === "read" || data.photo === "unread" ? data.photo : "none",
  };
  // It began from an offer: before anything is filed he names the office it is going to and waits for an ok.
  if (data.fromOffer === true) {
    const route = routeFor(ctx, findPlace(ctx.db, text), text);
    const ids = await ctx.say(...(draft.dangerous ? [DANGER_LINE] : []), RT.confirm(route.key));
    ctx.setState({ flow: "repair", step: CONFIRM_STEP, data: { ...draft, spot: text, qid: lastOf(ids), lastOut: newestOutId(ctx.db, ctx.event.chatId) } });
    return;
  }
  await file(ctx, draft, findPlace(ctx.db, text), text);
}

export const repair: FlowHandler = {
  name: "repair",
  async handle(plain) {
    // Everything this flow says goes out through REPAIR_VOICE: facts as written, wording from the pools.
    const ctx = REPAIR_VOICE.wrap(plain);
    // An open simulation (the technician's side, played out) gets the message first, taps included.
    if (await simulationTurn(plain, OWN_STEPS)) return;
    // A technician's "on it", "done" or "can't" (or a thumbs up on the job bubble) is theirs to answer first.
    if (await handleStaffTurn(plain)) return;
    const state = ctx.state?.flow === "repair" ? ctx.state : null;
    const offered = !!state && (state.step === OFFER_STEP || state.step === CONFIRM_STEP);
    // A thumbs up or down on troy's offer answers it. Any other tapback or poll vote means nothing here.
    if ((ctx.event.reaction || ctx.event.pollVote) && !offered) return;
    try {
      if (state && offered) {
        if (await answerOffer(ctx, state)) return;
        // The offer is gone and this message is something else. Another flow's request goes there, a new report
        // starts fresh, and plain chat is left alone (this flow stays silent, so the pipeline passes it on).
        const live = !!getFlowStateNow(ctx) && offerLive(ctx.db, ctx.event.chatId, state);
        if (await passToOtherFlow(ctx, "repair")) return;
        if (!ctx.event.images.length && fallbackIntent({ text: ctx.event.text, hasImage: false, state: null }).flow !== "repair") {
          // Plain talk. An offer that is still live stays open while the chat brain answers: it keeps it standing
          // only while they are still on this, and drops it when they have moved on (src/flows/smalltalk.ts). The
          // confirmation that names the office is not kept: anything but a yes to it ends it.
          if (!live || state.step === CONFIRM_STEP) ctx.setState(null);
          return;
        }
        ctx.setState(null);
        const { unconfirmed: _unconfirmed, accepted: _accepted, ...details } = ctx.intent.details;
        await start({ ...ctx, state: null, intent: { ...ctx.intent, details } });
        return;
      }
      if (state?.step === "ask_place" && isFresh(state)) {
        await answer(ctx, state.data);
        return;
      }
      if (state) ctx.setState(null);
      if (!ctx.event.text.trim() && !ctx.event.images.length) return;
      await start(ctx);
    } finally {
      // A technician who reported something of their own still holds their job afterwards.
      restoreStaffPointer(ctx.db, ctx.user.id);
    }
  },
};
