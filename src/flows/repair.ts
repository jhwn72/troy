// Flow 3: broken things. A photo and/or a text about something broken becomes a row in `reports`
// (kind 'repair') that the staff dashboard lists. The dashboard's status buttons text the reporter and
// every follower, so this flow never sends status updates itself.
//
// MOCKED: Troy does not file anything in FMS's or USC Housing's own work order systems. A report is only
// logged on Troy's staff dashboard, grouped under the office it would go to. The reply says so every time.
//
// Code decides: which office (from campus_places.kind), the office name (from the directory table),
// whether it joins an existing report, the follower count, and the DPS number. The model only reads the photo.

import type { FlowContext, FlowHandler } from "../types.ts";
import { askJson } from "../ai.ts";
import { DPS } from "../commands.ts";
import { findPlace } from "../places.ts";
import type { Place } from "../places.ts";
import { CANCEL, CANCELLED, CANCELLED_POOL, contentWords, directoryRows, follow, insertReport, isFresh, makeVoice, noEmoji, openReports, othersPhrase, passToOtherFlow, rowForTopic, similarText, userNotes } from "./reports-shared.ts";
import type { Pools, ReportRow, Voice } from "./reports-shared.ts";

type RouteKey = "fms" | "housing";

/** Used only if the directory has no matching office row (an unseeded database). */
const ROUTE_FALLBACK: Record<RouteKey, string> = { fms: "FMS", housing: "Housing" };

const ASK_WHERE = "which building and floor?";
const ASK_WHAT_AND_WHERE = "what's broken, and which building and floor?";
/** Fixed copy. No emoji: this is a stressful moment. */
export const DANGER_LINE = `that sounds dangerous. please call dps at ${DPS.upcNonEmergency} now and stay clear of it. if anyone's in danger, call 911.`;

const SAY = {
  alreadyReported: "u already reported that one and it's still open",
  whenItMoves: "i'll text u when it moves",
  notReported: "ok, i didn't report that one. text me the building whenever u want it sent",
};

/** Lines with a value in them (the office, how many others). Code puts the value in; these only hold the words around it. */
const RT = {
  joined: (others: string, office: string) => `${others} already reported that to ${office}, so i added u to it`,
  reported: (office: string) => `reported to ${office} ✅ i'll text u when it moves.`,
  reportedPlain: (office: string) => `reported to ${office}. i'll text u when it moves.`,
};

// ---------- wording variants (facts locked, wording varied) ----------
//
// Variant 0 of every pool is the line the code writes; the rest say the same thing with the same values.
// NOT in any pool, so always word for word: DANGER_LINE (the dangerous-thing line with the dps number) and
// the demo note (the honest "this is mocked" disclosure, which has to read the same every time).
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

/** Says the truth about the demo every time: the office's own system is not touched. */
function mockNote(short: RouteKey): string {
  return `demo note: it's logged on troy's staff dashboard for ${short}. the link into their real work order system is mocked, so nothing was filed there`;
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
    await ctx.say(...lead, RT.joined(othersPhrase(others), route.key), SAY.whenItMoves, mockNote(route.key));
    return;
  }

  insertReport(ctx.db, {
    userId: ctx.user.id,
    kind: "repair",
    category: draft.category,
    description: draft.description,
    locationText,
    photoUrl: draft.photoUrl,
    routedTo: route.name,
  });
  const confirm = plain ? RT.reportedPlain(route.key) : RT.reported(route.key);
  await ctx.say(...lead, confirm, mockNote(route.key));
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

async function start(ctx: FlowContext): Promise<void> {
  const text = ctx.event.text.trim();
  const photo = await readPhoto(ctx);
  const said = text.replace(/\s+/g, " ").slice(0, 300);
  // The student's own words win when they say enough; "this is broken" leans on what the photo shows.
  const description = (contentWords(said).size >= 3 ? said : photo.description) || said;
  const draft: Draft = {
    category: photo.category ?? categoryFromText(description),
    description,
    photoUrl: ctx.event.images[0]?.path ?? null,
    dangerous: DANGER.test(`${text} ${photo.description ?? ""}`),
  };
  const place = findPlace(ctx.db, text) ?? (photo.location ? findPlace(ctx.db, photo.location) : null);
  // `unconfirmed`: only the chat model read this as a repair (no keyword agreed, no photo). Nothing goes to staff
  // on that alone: the question below is asked even when a building was named, and their answer files it.
  if (place && ctx.intent.details.unconfirmed !== true) {
    await file(ctx, draft, place, `${text} ${photo.location ?? ""}`);
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
  };
  await file(ctx, draft, findPlace(ctx.db, text), text);
}

export const repair: FlowHandler = {
  name: "repair",
  async handle(plain) {
    // Everything this flow says goes out through REPAIR_VOICE: facts as written, wording from the pools.
    const ctx = REPAIR_VOICE.wrap(plain);
    // Tapbacks and poll votes mean nothing here.
    if (ctx.event.reaction || ctx.event.pollVote) return;
    const state = ctx.state?.flow === "repair" ? ctx.state : null;
    if (state?.step === "ask_place" && isFresh(state)) {
      await answer(ctx, state.data);
      return;
    }
    if (state) ctx.setState(null);
    if (!ctx.event.text.trim() && !ctx.event.images.length) return;
    await start(ctx);
  },
};
