// Code commands and fixed copy. These run before any AI and the model never writes them.

import type { User } from "./types.ts";
import { BUILT_IN_TOPICS } from "./topics.ts";

// USC Department of Public Safety numbers.
// Source: https://dps.usc.edu/contact/ (checked Nov 14, 2026).
export const DPS = {
  upcEmergency: "213-740-4321",
  upcNonEmergency: "213-740-6000",
  hscEmergency: "323-442-1000",
  hscNonEmergency: "323-442-1200",
} as const;

export type CommandKind = "stop" | "start" | "help" | "pause" | "resume" | "human" | "delete_data" | "settings" | "forget_location" | "emergency" | "crisis";

/** Whole-message commands, after lowercasing and trimming punctuation. */
const COMMANDS: Record<string, CommandKind> = {
  stop: "stop",
  stopall: "stop",
  unsubscribe: "stop",
  "stop texting me": "stop",
  start: "start",
  unstop: "start",
  help: "help",
  pause: "pause",
  resume: "resume",
  unpause: "resume",
  human: "human",
  "delete my data": "delete_data",
  settings: "settings",
  "forget my location": "forget_location",
  "forget location": "forget_location",
  "delete my location": "forget_location",
  "erase my location": "forget_location",
};

// Emergency detection matches phrases, not bare words, so "that's fire" or "my feet hurt" never trigger it.
// Text is lowercased with apostrophes removed before matching ("there's" becomes "theres", "building's" becomes "buildings").
const PERSON = "(?:i|we|he|she|they|someone|somebody|my (?:friend|roommate|roomie|gf|bf|girlfriend|boyfriend|sister|brother|mom|dad))";
const BE = "(?:am|m|is|s|are|re|was|were|got|just got|been|ve been|have been|has been|is being|m being|am being|was being)";
// Everyday uses that share a word with a real emergency: "hurt feelings", "shot down", "jumped by that exam".
const NOT_SLANG = "(?! (?:feelings|down|by (?:that|this|the|my|a|an) (?:exam|test|midterm|final|quiz|class|assignment|professor|prof|curve|hw|homework|essay|paper|deadline|crush)))";
const PLACE = "(?:building|room|dorm|hall|hallway|house|apartment|apt|kitchen|car|floor|lab|library|stove|oven|microwave|trash|trash can|dumpster|something|roof|place|suite|garage)";
const EMERGENCY_PATTERNS: RegExp[] = [
  // fire
  /\b(?:theres|there is|there was|i see|we have|weve got) (?:a|an) (?:\w+ )?fire\b(?! (?:emoji|drill|sale|playlist|fit|outfit|song|album|party|deal|alarm test))/,
  new RegExp(`\\b${PLACE}s? (?:is |s |are |was )?(?:literally |actually )?on fire\\b`),
  /\bfire in (?:my|the|our|a) (?!soul|heart|belly|eyes|veins|bones|chat|comments|gc|group chat|blood|spirit)\w+/,
  /\b(?:caught|catching) (?:on )?fire\b/,
  /\bsmell (?:gas|smoke)\b/,
  /\b(?:theres|there is) (?:so much |a lot of |lots of |some )?smoke\b(?! (?:shop|break|sesh|session|spot|show|machine|detector))/,
  // hurt
  new RegExp(`\\b(?:im|${PERSON} ?${BE}) (?:just )?(?:really |badly |seriously |so )?(?:hurt|injured|bleeding|stabbed|shot|attacked|assaulted|raped|robbed|mugged|jumped|drugged|roofied|unconscious|unresponsive|choking)\\b${NOT_SLANG}`),
  new RegExp(`\\b${PERSON} (?:is |s |isnt |is not |wont |will not |cant |cannot |stopped )?(?:not )?(?:breathing|breathe|wake up|waking up|responding)\\b(?! (?:in time|on time|for|early|before|at|til|till|until))`),
  /\b(?:just )?(?:robbed|mugged|attacked|stabbed|jumped|assaulted|raped|drugged|roofied) (?:me|us)\b/,
  new RegExp(`\\b${PERSON} (?:just )?(?:hit|punched|choked|grabbed) me\\b(?! (?:up|with|back|that|like))`),
  /\b(?:sexual assault|sexually assaulted)\b/,
  /(?<!feel like i (?:got|was) )(?<!like i got )\bhit by (?:a |an |the )?(?:car|truck|bus|scooter|bike|vehicle|van|motorcycle)\b/,
  /\b(?:having|had|has) (?:a |an )(?:seizure|stroke|allergic reaction)\b/,
  /\b(?:having|had|has) a heart attack\b(?! (?:over|about|bc|because|from|when|every))/,
  /\b(?:passed out|collapsed|fainted|knocked out) and (?:wont|will not|isnt|is not|not|cant|cannot) (?:wake up|waking up|respond|responding|breathing|moving)\b/,
  /\b(?:he|she|they|someone|somebody|friend|roommate|roomie|guy|girl|person) (?:just |literally )?(?:collapsed|fainted)\b/,
  /\b(?:wont|will not|isnt|is not) (?:wake up|waking up)\b(?! (?:in time|on time|for|early|before|at|til|till|until))/,
  // break-ins
  /\b(?:broke|breaking|broken) into (?:my|our|the) (?:\w+ )?(?:apartment|apt|room|dorm|house|place|car|suite|building|home)\b/,
  /\btrying to break in(?:to)?\b(?! (?:the|a|to) (?:industry|field|scene|market|business|game))/,
  // being followed, in danger
  /\b(?:being|getting|im|i am|were|we are) (?:followed|stalked)\b/,
  /(?:\b(?:is|are|keeps|was)|s) following (?:me|us)\b(?! (?:on|back)\b)/,
  /\b(?:im|i am|were|we are|shes|hes|theyre|someone is|someones|my \w+ is) in danger\b/,
  /\b(?:i dont|i do not|dont) feel safe\b(?! (?:posting|sharing|giving|sending|putting|texting|saying|telling|using|about (?:posting|sharing|giving)))/,
  /\b(?:im|i am) not safe\b/,
  // weapons
  /\b(?:has|have|had|with|pulled|pulled out|holding|carrying) (?:a |an )?(?:gun|knife|weapon)\b/,
  /\bactive shooter\b/,
  /\b(?:theres|there is) (?:a|an) shooter\b/,
  /\ba shooter (?:on|in|at|near|outside|by)\b/,
  /\bshooter on campus\b/,
  /\bgun ?shots?\b/,
  // asking for help outright
  /\b(?:this is|its|it is|theres|there is|i have|im having|we have|got) (?:a |an )(?:real |actual |medical |serious )?emergency\b(?! (?:meeting|contact|fund|exit|kit|study|session|snack|coffee|nap))/,
  /\b(?:call|dial|calling|need) (?:911|9 1 1|the police|the cops|an ambulance|the ambulance|paramedics)\b(?! (?:report|reports|station|office|department|dept))/,
  /\bneed (?:an ambulance|a medic|the police)\b(?! (?:report|reports|station|office|department|dept))/,
  /\boverdos(?:e|ed|ing)\b/,
  /\balcohol poisoning\b/,
];

// Self-harm. The model tells a joke from real distress, not word patterns (John, "Jokes versus real distress"):
// only a plain first-person statement with nothing light around it gets the fixed 988 reply by pattern alone.
// Everything else that touches the subject is "ambiguous" and is read in its conversation (readSafety in src/ai.ts).
const CRISIS_PATTERNS: RegExp[] = [
  /\bkill(?:ing)? myself\b/,
  /\bend(?:ing)? (?:my life|it all)\b/,
  /\bsuicid(?:e|al)\b(?! (?:squad|prevention (?:week|event|club|training)))/,
  /\b(?:want|wanna|wanted) to die\b/,
  /\bdont (?:want|wanna) to? ?(?:be alive|live|be here) anymore\b/,
  /\b(?:hurt|harm|cut|cutting|hurting|harming) myself\b/,
  /\bself harm(?:ing)?\b/,
];

/** Words about hurting oneself that students also use as slang. Never the fixed line by themselves: the model reads them. */
const SELF_HARM_SLANG: RegExp[] = [
  /\bkms\b/,
  /\bkys\b/,
  /\bwanna die\b/,
  /\bunalive (?:myself|me)\b/,
  /\b(?:off|offing) myself\b/,
  /\bwish i (?:was|were) dead\b/,
  /\bbetter off (?:dead|without me)\b/,
  /\b(?:dont|do not) (?:want|wanna) (?:to )?wake up\b/,
  /\bno reason to (?:live|be here|keep going)\b/,
  /\bjump(?:ing)? off (?:a |the |my )?(?:\w+ )?(?:bridge|roof|building|balcony|parking structure|leavey|library)\b/,
];

/** Low, heavy lines with no self-harm word in them. Worth one read by the model, never a hotline by pattern. */
const HEAVY: RegExp[] = [
  /\bcant (?:do this|go on|keep going|take (?:it|this)) anymore\b/,
  /\bwhats the point (?:of (?:anything|living|trying|any of (?:it|this))|anymore)\b/,
  /\b(?:nobody|no one) would (?:care|notice|miss me)\b/,
  /\b(?:want|wanna|wish i could) (?:to )?(?:just )?disappear\b/,
  /\btired of (?:living|being alive|being here|existing)\b/,
  /\b(?:give|giving|gave) up on (?:life|everything|myself)\b/,
  /\b(?:im|i am|i feel like) (?:a|such a) burden\b/,
  /\bnothing matters anymore\b/,
];

// What makes a dark line read as everyday talk: a laugh, a laughing emoji, or a small named cause (an exam, a class).
const LAUGH_WORDS = /\b(?:lol+|lo+l|lmao+|lmfao+|rofl|haha\w*|hehe\w*|jk|jks|joking|kidding|bruh|fr fr|ong|deadass)\b/;
const LAUGH_EMOJI = /[\u{1F602}\u{1F923}\u{1F480}\u{1F62D}\u{1F605}\u{1F643}\u{1F629}\u{1F92A}\u{1F606}\u{2620}]/u;
const SMALL_CAUSE =
  /\b(?:exam|exams|midterm|midterms|final|finals|quiz|test|class|lecture|homework|hw|essay|paper|pset|lab|professor|prof|ta|grade|grades|curve|8am|9am|group project|assignment|deadline|studying|study|chem|ochem|calc|econ|physics|writ|gesm|line|parking|wifi|charger|laundry|hangover|hungover|embarrass\w*|cringe|game|team|traffic)\b/;
const CONDITIONAL = /\bif (?:i|we|he|she|they|this|the|my)\b/;

function readsLight(raw: string, cleaned: string): boolean {
  return LAUGH_WORDS.test(cleaned) || LAUGH_EMOJI.test(raw) || SMALL_CAUSE.test(cleaned) || CONDITIONAL.test(cleaned);
}

function clean(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’'`]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isEmergency(text: string): boolean {
  const t = clean(text);
  return !!t && EMERGENCY_PATTERNS.some((p) => p.test(t));
}

/** Unmistakable only: a plain first-person statement with no laugh, no small cause and no "if" around it. */
export function isCrisis(text: string): boolean {
  const t = clean(text);
  return !!t && CRISIS_PATTERNS.some((p) => p.test(t)) && !readsLight(text, t);
}

export type SafetySignal = {
  /** "ambiguous": worth one read by the model in its conversation. "none": ordinary talk, slang included. */
  level: "emergency" | "crisis" | "ambiguous" | "none";
  /** The message has words about hurting oneself in it. With the model unavailable these fall back to the fixed line. */
  selfHarmWords: boolean;
};

/**
 * What code can tell about a message by itself. Obvious slang ("that exam killed me lol", "i'm dead", "this class is
 * killing me") is "none": none of it names self-harm. A self-harm phrase with a laugh or a small cause around it, a
 * bare "kms", and a few heavy lines are "ambiguous": the pipeline asks the model, and never sends the hotline on
 * the pattern alone.
 */
export function safetySignal(text: string): SafetySignal {
  if (typeof text !== "string") return { level: "none", selfHarmWords: false };
  const t = clean(text);
  if (!t) return { level: "none", selfHarmWords: false };
  if (isCrisis(text)) return { level: "crisis", selfHarmWords: true };
  if (EMERGENCY_PATTERNS.some((p) => p.test(t))) return { level: "emergency", selfHarmWords: false };
  if (CRISIS_PATTERNS.some((p) => p.test(t)) || SELF_HARM_SLANG.some((p) => p.test(t))) return { level: "ambiguous", selfHarmWords: true };
  if (HEAVY.some((p) => p.test(t))) return { level: "ambiguous", selfHarmWords: false };
  return { level: "none", selfHarmWords: false };
}

/** True when a message ends on a laugh or an emoji. A command read with less than full certainty is never acted on then. */
export function endsPlayful(text: string): boolean {
  const raw = (text ?? "").trim();
  if (!raw) return false;
  return /(?:\blol+|\blmao+|\blmfao+|\bhaha\w*|\bjk)[\s.!?]*$/i.test(raw) || /(?:\p{Extended_Pictographic}|\p{Regional_Indicator})[\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]*[\s.!?]*$/u.test(raw);
}

/** A stopped user who opens with "hey troy" is asking Troy back, same as START. */
export function isHeyTroy(text: string): boolean {
  return typeof text === "string" && /^hey+ troy\b/.test(clean(text));
}

/** Crisis and emergency are checked first. Everything else must be the whole message. */
export function matchCommand(text: string): { kind: CommandKind } | null {
  if (typeof text !== "string") return null;
  if (isCrisis(text)) return { kind: "crisis" };
  if (isEmergency(text)) return { kind: "emergency" };
  const kind = COMMANDS[clean(text)];
  return kind ? { kind } : null;
}

export const SUBSCRIPTION_LABELS: Record<string, string> = {
  free_food: "free food",
  free_stuff: "free stuff",
  events: "events",
  class_help: "help others with classes",
};

/** How a subscription reads in the settings line: the topic's poll text without its emoji, or the key in plain words. */
function subscriptionLabel(key: string): string {
  if (SUBSCRIPTION_LABELS[key]) return SUBSCRIPTION_LABELS[key]!;
  const topic = BUILT_IN_TOPICS.find((t) => t.key === key);
  const text = topic ? topic.label.replace(/[^\p{L}\p{N}\s'-]/gu, "") : key.replace(/[_-]+/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

/** Fixed copy. No emoji in the emergency or STOP replies. */
export const TEMPLATES = {
  // John's words (Nov 14). Don't reword.
  welcome: [
    "hey i'm troy",
    "i'm an ai, but i know a guy for everything",
    "send me a photo of anything on campus and i'll get it to the right person. or just text me like 'lost my airpods at leavey'",
    "reply STOP anytime and i'll leave u alone until u want to talk again",
  ],
  /** Goes out right before the contact card. */
  saveContact: "save my contact if u haven't so u know it's me",
  emergency: [
    "if ur in danger or someone is hurt, call 911 right now",
    `usc dps emergency line: ${DPS.upcEmergency} (university park) or ${DPS.hscEmergency} (health sciences)`,
    `i'm an ai and i can't send help myself. dps non-emergency is ${DPS.upcNonEmergency}`,
  ],
  // 988 is the US Suicide and Crisis Lifeline (call or text). Source: https://988lifeline.org
  crisis: [
    "i'm really glad u told me. u can call or text 988 right now to talk to a real person, any time, free",
    `if ur in danger right now call 911 or usc dps at ${DPS.upcEmergency}`,
    "i'm an ai so i can't help the way a person can. pls reach out to one of those",
  ],
  // Matches the welcome promise: quiet until they want to talk again. START or any text starting with "hey troy" brings Troy back.
  stop: ['ok, i\'ll leave u alone. text "START" or "hey troy" whenever u want to talk again'],
  start: ["welcome back. ur getting texts from me again"],
  startAlready: ["ur already in. text me whenever"],
  help: [
    "i'm troy, an ai that connects trojans",
    "text me a pic of something u found, tell me what u lost, post free food, report something broken, or ask who to talk to about a campus thing",
    'commands: "STOP" to opt out, "pause" to mute alerts, "resume" to unmute, "settings", "human", "forget my location", "delete my data"',
  ],
  pause: ['paused. no alerts till u text "resume". i\'ll still answer when u text me'],
  resume: ["ur back on. alerts are live again"],
  human: [
    "i'm an ai and there's no person reading this chat",
    `to reach a real person at usc dps call ${DPS.upcNonEmergency}. for an emergency call 911 or ${DPS.upcEmergency}`,
  ],
  deleteData: ["done. i deleted ur messages, notes, profile and saved location", 'text "hey troy" if u ever want back in'],
  // Says plainly that reading stops too (users.locationOptOut), not only that the saved fix is gone.
  forgetLocation: ["done, i erased ur saved location and i won't read it again until u share it with me again"],
  /** A location share with no words. */
  locationSaved: "got it, thx",
  settings(user: User): string[] {
    const subs = user.subscriptions.map(subscriptionLabel).join(", ") || "none";
    const quiet = user.quietHours ? `${user.quietHours.start} to ${user.quietHours.end}` : "off";
    return [
      `alerts: ${user.paused ? "paused" : "on"}. texts about: ${subs}`,
      `alert distance: ${user.alertMinutes} min walk. quiet hours: ${quiet}`,
      'to change one just tell me, like "only food within 5 min" or "no texts after midnight"',
    ];
  },
  acks: ["gimme a sec", "lemme check that", "on it 👀"],
  /** Asked before anything that destroys data, however the wish was worded. Needs a typed yes: a tapback never deletes. */
  confirmDelete: ['want me to delete everything i have on u? reply "yes"'],
};

/**
 * Wording for commands a student meant without typing the exact word (John, "Commands by meaning"). Code performs the
 * action; these only vary how the confirmation reads. Each entry is one reply and "|" splits it into bubbles. Picked
 * with pickVariant, so nobody gets the same one twice in a row. STOP, emergency, crisis and the delete question are
 * not here: those stay word for word.
 */
export const COMMAND_POOLS = {
  pause: [
    TEMPLATES.pause[0]!,
    'ok, alerts are muted. text "resume" when u want them back|i\'m still here if u text me',
    'muted. u won\'t get alerts till u text "resume"|u can still text me anytime',
    'got it, no alerts for now. "resume" turns them back on',
  ],
  resume: [TEMPLATES.resume[0]!, "alerts are back on", "ok, unmuted. u'll get alerts again", "back on. i'll text u when something's up"],
  // Every variant says both halves: the saved spot is gone, and nothing is read until they share again.
  forgetLocation: [
    TEMPLATES.forgetLocation[0]!,
    "erased. i don't have ur location anymore and i won't look at it again unless u share it",
    "done, ur saved location is gone. i won't read it again until u share it with me",
    "ok, wiped ur saved location. i'll only see it again if u share it again",
  ],
  /** {what} is the topic in plain words ("when there's a pickup game near u"). */
  unsubscribed: ["ok, i won't text u {what} anymore", "done. no more texts {what}", "got it, i'll stop texting u {what}", "off the list. i won't hit u up {what}"],
  notSubscribed: ["u weren't getting those from me, so ur good", "ur not on that one, nothing to turn off", "i wasn't texting u about that, so nothing changes"],
  whichTopic: ["which texts do u want me to stop?", "which ones should i stop sending?", "stop which texts? tell me the topic and it's off"],
  // One short question when it isn't clear the command was meant.
  askStop: ['want me to stop texting u completely? reply "yes" and i\'m gone', 'do u want me to stop texting u altogether? "yes" and i will', 'just checking, should i stop texting u? reply "yes" if so'],
  askPause: ['want me to mute alerts for now? reply "yes"', 'should i pause ur alerts? "yes" and they\'re muted', 'u want alerts off for a bit? reply "yes"'],
  askResume: ['want alerts back on? reply "yes"', 'should i turn ur alerts back on? reply "yes"', 'u want me to unmute alerts? "yes" and they\'re on'],
  askForgetLocation: ['want me to erase ur saved location? reply "yes"', 'should i wipe the location i have for u? reply "yes"', 'u want ur saved location gone? "yes" and it\'s erased'],
  askUnsubscribe: ['want me to stop texting u {what}? reply "yes"', 'should i stop the texts {what}? reply "yes"', 'u want me to quit texting u {what}? "yes" and it\'s off'],
  askStart: ['want me texting u again? reply "yes"', 'should i turn everything back on? reply "yes"'],
  /** They said no (or anything but yes) to one of the questions above. */
  kept: ["ok, leaving everything as is", "all good, nothing changed", "ok, i didn't change anything", "no worries, it stays how it was"],
  keptData: ["ok, i'm keeping everything as is", "all good, nothing was deleted", "ok, didn't delete anything"],
} as const;
