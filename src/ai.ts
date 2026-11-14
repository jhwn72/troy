// The only file that calls the Claude API. Nothing here throws: every failure becomes null or a fallback.
// Never log prompts, message text or keys. Failures log a short reason only.

import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.ts";
import type { FlowName, FlowState, Intent } from "./types.ts";
import { TROY_VOICE, indexOfToken, isStressful, polishBubbles } from "./voice.ts";
// Used only inside fallbackIntent (at call time), so the import cycle with the flow files is harmless.
import { notesIntent } from "./flows/notes.ts";

export type AskOpts = {
  model: "smart" | "fast";
  system: string;
  prompt: string;
  images?: { path: string; mime: string }[];
  maxTokens?: number;
  timeoutMs?: number;
};

/** Returns the model's raw text, or throws. Tests swap this out with setModelCall. */
export type ModelCall = (opts: AskOpts) => Promise<string>;

let override: ModelCall | null = null;
let client: Anthropic | null = null;

/** Tests only: replace the network call with a fake. Pass null to restore the real one. */
export function setModelCall(fn: ModelCall | null): void {
  override = fn;
}

export function aiAvailable(): boolean {
  return Boolean(config.anthropicKey);
}

// ---------- the call ----------

type ImageMime = "image/jpeg" | "image/png";

/** Trust the file's first bytes over the mime we were told. Only JPEG and PNG go to the model. */
function sniffImage(buf: Buffer): ImageMime | null {
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  return null;
}

function failReason(err: unknown): string {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "timeout";
  if (err instanceof Anthropic.APIUserAbortError) return "timeout";
  if (err instanceof Anthropic.RateLimitError) return "rate limited";
  if (err instanceof Anthropic.AuthenticationError) return "auth";
  if (err instanceof Anthropic.BadRequestError) return "bad request";
  if (err instanceof Anthropic.APIConnectionError) return "connection";
  if (err instanceof Anthropic.APIError) return err.status === 529 ? "overloaded" : `status ${err.status ?? "unknown"}`;
  if (err instanceof Error && /^(bad image|refusal|empty reply|cut off|no json|timeout)$/.test(err.message)) return err.message;
  return "error";
}

function retryable(err: unknown): boolean {
  if (err instanceof Anthropic.RateLimitError) return true;
  return err instanceof Anthropic.APIError && (err.status === 529 || err.status === 503);
}

const realCall: ModelCall = async (opts) => {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const img of opts.images ?? []) {
    const buf = await readFile(img.path).catch(() => null);
    const mime = buf && sniffImage(buf);
    if (!buf || !mime) throw new Error("bad image");
    content.push({ type: "image", source: { type: "base64", media_type: mime, data: buf.toString("base64") } });
  }
  content.push({ type: "text", text: opts.prompt });

  const smart = opts.model === "smart";
  const hasImages = content.length > 1;
  const answerTokens = Math.max(opts.maxTokens ?? 1024, hasImages ? 2048 : 0);
  const deadline = Date.now() + (opts.timeoutMs ?? (smart ? 25_000 : 12_000));
  client ??= new Anthropic({ apiKey: config.anthropicKey });

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await client.beta.messages.create(
        {
          model: config.models[opts.model],
          // The smart model always thinks, and thinking shares this budget, so leave it room.
          max_tokens: smart ? answerTokens + 2048 : answerTokens,
          system: opts.system,
          messages: [{ role: "user", content }],
          // The fast model runs with thinking off for speed. The smart model can't turn it off.
          ...(smart ? {} : { thinking: { type: "disabled" as const } }),
          output_config: { effort: "low" },
          // If the model declines for policy reasons, the API retries on its default fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        },
        { timeout: Math.max(1000, deadline - Date.now()), maxRetries: 0 },
      );
      if (res.stop_reason === "refusal") throw new Error("refusal");
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      if (!text.trim()) throw new Error(res.stop_reason === "max_tokens" ? "cut off" : "empty reply");
      return text;
    } catch (err) {
      // One retry on overload or rate limit, and only if there's time left.
      if (attempt === 0 && retryable(err) && deadline - Date.now() > 2500) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      throw err;
    }
  }
};

/** The first balanced {...} or [...] in the text, parsed. Handles code fences and chatter around the JSON. */
export function extractJson(text: string): unknown {
  for (let start = text.search(/[{[]/); start !== -1 && start < text.length; ) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        if (--depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
    const next = text.slice(start + 1).search(/[{[]/);
    start = next === -1 ? -1 : start + 1 + next;
  }
  return undefined;
}

/** One call, parsed JSON back, or null on any failure. */
export async function askJson<T>(opts: AskOpts): Promise<T | null> {
  if (!override && !aiAvailable()) return null;
  const ms = opts.timeoutMs ?? (opts.model === "smart" ? 25_000 : 12_000);
  let timer: NodeJS.Timeout | undefined;
  try {
    // A hard stop on top of the SDK's timeout, so a slow file read or a stuck fake can't hang a reply.
    const text = await Promise.race([
      (override ?? realCall)(opts),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms + 500);
      }),
    ]);
    const parsed = extractJson(text);
    if (parsed === undefined || parsed === null) throw new Error("no json");
    return parsed as T;
  } catch (err) {
    console.warn(`ai call failed: ${failReason(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- intent ----------

const FLOWS: FlowName[] = ["lost_found", "food", "repair", "usg", "rides", "notes", "smalltalk"];

const INTENT_SYSTEM = `You route one text message sent to Troy, a campus assistant for USC students. Reply with JSON only, no other words:
{"flow": "...", "action": "...", "details": {...}}

Flows and actions:
- lost_found: report_found (they found an item, "found a ...", or sent a photo of an item), report_lost ("lost my ..."), resolved (they got their own item back, "found my keys nvm"), answer (replying to a question in an open lost_found conversation)
- food: post_food (free or leftover food to share, usually what and how many), claim (they want some), update_count ("6 left", "we're out"), status (asking if food is still there), report_fake (they went and there was no food)
- repair: report (something on campus is broken, leaking or out of order)
- usg: concern or question (campus policy, dining hours, club funding, the lax shuttle, thrift, farmers market, student government)
- rides: find (looking for people to share a ride, usually to lax)
- notes: add_note (a rule or preference about how Troy should treat them), recall ("what do u know about me"), forget ("forget that"), set_alert_distance, set_quiet_hours
- smalltalk: chat (everything else)

details: include only what the message actually says, using these keys: category (kind of item or food), color, brand, place, time, count (a number), destination. Leave out anything not stated. Never guess.

If there is an open conversation, keep its flow with action "answer" unless the message clearly starts something new.`;

const FOOD = "food|pizzas?|sandwich(?:es)?|donuts?|doughnuts?|bagels?|cookies?|tacos?|burritos?|boba|snacks?|catering|chipotle|cava|panda|sushi|wings|samosas?|cupcakes?|bur?gers?|pasta|salads?|wraps?|dumplings?|noodles|rice bowls?|croissants?|muffins?|pastries|fruit|chips|drinks|coffee|empanadas?|cake|brownies|subs|bowls|plates|trays?";
const FOOD_RE = new RegExp(`\\b(?:${FOOD})\\b`);

const CATEGORIES: [RegExp, string][] = [
  [/\bwallet|cardholder\b/, "wallet"],
  [/\bkeys?\b|keychain|key fob|lanyard/, "keys"],
  [/\bair ?pods?|earbuds?|headphones|beats\b/, "earbuds"],
  [/\b(?:i ?phone|phone|android|pixel)\b/, "phone"],
  [/\b(?:usc ?card|student id|id card|id|driver'?s license|license|passport)\b/, "id"],
  [/\blaptop|macbook|ipad|tablet|chromebook\b/, "laptop"],
  [/\b(?:water ?bottle|bottle|hydro ?flask|stanley|owala|tumbler)\b/, "bottle"],
  [/\bbackpack|bag|tote|purse|pouch\b/, "bag"],
  [/\bjacket|hoodie|sweater|sweatshirt|coat|hat|cap|beanie|scarf|shirt\b/, "clothing"],
  [/\bumbrella\b/, "umbrella"],
  [/\bglasses|sunglasses\b/, "glasses"],
  [/\bcharger|cable|adapter\b/, "charger"],
  [/\bwatch\b/, "watch"],
  [/\b(?:ring|necklace|bracelet|earrings?)\b/, "jewelry"],
  [/\bcalculator\b/, "calculator"],
  [/\b(?:notebook|textbook|book|planner)\b/, "book"],
  [/\bskateboard|scooter|bike|bicycle\b/, "wheels"],
  [/\b(?:debit|credit) card\b/, "card"],
];
const COLORS = /\b(black|white|gr[ae]y|silver|gold|red|cardinal|maroon|blue|navy|green|yellow|orange|purple|pink|brown|tan|beige|clear|teal)\b/;
const BRANDS = /\b(apple|samsung|hydro ?flask|stanley|owala|nike|adidas|north ?face|patagonia|lululemon|jansport|herschel|ray.?ban|coach|kate spade|sony|bose|beats|dell|lenovo|hp|casio|ti-?84|yeti|carhartt|fjallraven|tumi)\b/;
const PLACES = /\b(leavey|doheny|tcc|tutor campus center|ronald tutor|usc village|the village|village|parkside|evk|everybody'?s kitchen|lyon center|village gym|fertitta|taper|sgm|thh|vkc|grace ford salvatori|mccarthy quad|tommy trojan|annenberg|wallis annenberg|marshall|viterbi|bookstore|cafe 84|popovich|jff|iovine|kaprielian|sal|new north|birnkrant|pardee|marks tower|cale|irani|cowlings|mccarthy honors|the row|gateway|lorenzo|trousdale|hahn plaza|alumni park|galen center|galen|bovard|hoffman|bridge hall|olin|seeley mudd|zumberge|ginsburg|salvatori|law school|cinema school|sca|dml|engemann|student union|seeds|burger crush|rtcc|mudd hall|founders park|argue plaza|cromwell|coliseum|expo park|figueroa|jefferson|vermont)\b/;
const TIME = /\b(just now|rn|right now|today|tonight|yesterday|last night|this morning|this afternoon|this evening|tomorrow|earlier|an hour ago|\d+ (?:min(?:ute)?s?|hours?|hrs?|days?) ago|(?:on |this |last |next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:around |at |by )?\d{1,2}(?::\d\d)? ?(?:am|pm)|noon|midnight)\b/;
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, dozen: 12 };

function pullCount(t: string): number | undefined {
  if (/\b(we'?re out|all gone|ran out|none left|no more left|it'?s gone)\b/.test(t)) return 0;
  if (/\blast one\b/.test(t)) return 1;
  // Skip clock times ("3pm", "3:30") and "x min/hours ago".
  const cleaned = t.replace(/\b\d{1,2}(?::\d\d)? ?(?:am|pm)\b|\b\d{1,2}:\d\d\b|\b\d+ (?:min(?:ute)?s?|hours?|hrs?|days?)\b/g, " ");
  const digits = cleaned.match(/\b(\d{1,3})\b/);
  if (digits) return Number(digits[1]);
  const word = cleaned.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|dozen)\b/);
  return word ? NUMBER_WORDS[word[1]!] : undefined;
}

/** Pull the details code can find on its own. Only what the text states. */
export function pullDetails(text: string): Record<string, unknown> {
  const t = text.toLowerCase();
  const d: Record<string, unknown> = {};
  const food = t.match(FOOD_RE);
  const cat = CATEGORIES.find(([re]) => re.test(t));
  if (cat) d.category = cat[1];
  else if (food && food[0] !== "food") d.category = food[0];
  const color = t.match(COLORS);
  if (color) d.color = color[1];
  const brand = t.match(BRANDS);
  if (brand) d.brand = brand[1];
  const place = t.match(PLACES) ?? t.match(/\b(?:at|in|near|by|outside|inside|behind) (?:the )?((?!my\b|a\b|an\b|all\b|around\b|\d)[a-z][a-z'&]*(?: (?:hall|library|center|quad|plaza|gym|lobby|cafe|lot|room|building|tower|field|floor|lounge|steps|fountain))?)/);
  if (place) d.place = place[1];
  const time = t.match(TIME);
  if (time) d.time = time[1];
  // A bare number only counts as a count when the text is about amounts ("6 left", "about 10").
  const count = pullCount(t);
  const aboutAmounts = food || /\b(?:left|servings?|people|slices|boxes|plates|of us|seats?|spots?|out|gone)\b/.test(t) || /^\D{0,12}\d{1,3}\D{0,12}$/.test(t);
  if (count !== undefined && aboutAmounts) d.count = count;
  if (/\blax\b/.test(t)) d.destination = "LAX";
  else if (/\b(burbank|bur airport)\b/.test(t)) d.destination = "Burbank";
  else if (/\b(john wayne|sna)\b/.test(t)) d.destination = "John Wayne";
  else if (/\bunion station\b/.test(t)) d.destination = "Union Station";
  else if (/\blong beach\b/.test(t)) d.destination = "Long Beach";
  return d;
}

/** Keyword rules, ignoring any open conversation. */
function classify(t: string, hasImage: boolean, inFood: boolean): { flow: FlowName; action: string } {
  const is = (re: RegExp) => re.test(t);
  const food = FOOD_RE.test(t);

  // notes: how Troy should treat them
  if (is(/what (?:do|did) (?:u|you|ya) (?:know|remember|have) (?:about|on) me|what'?s? (?:in )?my (?:notes|settings|preferences)/)) return { flow: "notes", action: "recall" };
  if (is(/\bforget (?:that|it|this|about|what i|everything|my)\b|delete (?:that|my) note/)) return { flow: "notes", action: "forget" };
  if (is(/quiet hours|(?:don'?t|do not|no|stop) (?:text|message|ping|alert|bother)(?:ing|s)? (?:me )?(?:after|before|between|at night|past|during)/)) return { flow: "notes", action: "set_quiet_hours" };
  if (is(/alert (?:distance|radius|range)|(?:only )?(?:alert|ping|text|tell) me (?:if|when|for) .*(?:within|under|less than|closer)|within \d+ ?(?:min|minutes?|blocks?)|\b\d+ ?(?:min|minute) walk\b.*(?:alerts?|only|max)/)) return { flow: "notes", action: "set_alert_distance" };
  if (is(/\bfrom now on\b|keep it short|no emojis?|(?:don'?t|do not|stop|never) (?:use|send|call|text|message|ping|alert|tell)|\bcall me [a-z]+|\bremember (?:that|i|my)\b|i (?:prefer|don'?t eat|am|'?m) (?:vegetarian|vegan|halal|kosher|gluten|allergic)|only (?:alert|text|ping|tell) me/)) return { flow: "notes", action: "add_note" };

  // lost and found. "found my ..." means they got their own thing back.
  if (is(/\b(?:found|got|have) (?:it|them|my [a-z ]+?)(?: back)?\b.*\b(?:nvm|never ?mind|thanks|ty|all good)\b|\bnvm\b.*\b(?:found|got) (?:it|them|my)\b|\b(?:i |just |already )?found (?:it|them|my)\b|\bgot (?:it|them|my [a-z]+) back\b|someone (?:returned|gave) (?:it|them|my)/) && !is(/any(?:one|body)|\bif (?:you|u|someone)\b|let me know|\blmk\b|(?:haven'?t|not|never|didn'?t|can'?t|couldn'?t)(?: [a-z]+)? (?:found|find|got|get)/)) return { flow: "lost_found", action: "resolved" };
  if (is(/\bstill (?:looking|lost|missing|haven'?t found|can'?t find)\b/)) return { flow: "lost_found", action: "still_looking" };
  if (is(/\b(?:i |i'?ve |just |think i )?(?:lost|misplaced)\b|can'?t find my|cannot find my|\bleft my\b|\bdropped my\b|\bmissing my\b|my [a-z ]+ (?:is|are|went) (?:missing|gone)|(?:has |did )?any(?:one|body) (?:seen|found|find|turn(?:ed)? in)|forgot my [a-z ]+ (?:at|in|on)\b/)) return { flow: "lost_found", action: "report_lost" };
  if (!food && is(/\bfound (?:a|an|some|this|these|the|someone'?s|somebody'?s|[a-z]+'s|\d)\b|\bpicked up (?:a|an|someone|somebody)|some(?:one|body) (?:left|dropped|forgot) (?:a|an|their|his|her|this)|\bturn(?:ed|ing)? (?:it |this |a |an )?in\b|\bwho(?:se| ?'?s) (?:is this|[a-z ]+ is this)/)) return { flow: "lost_found", action: "report_found" };

  // food
  if (is(/(?:there (?:was|is|were)|there'?s) (?:no|not any|nothing)\b.*(?:food|there|left)?|(?:wasn'?t|isn'?t|weren'?t) any (?:food|left)|\bfake (?:post|food|alert)|(?:food|post|alert|that|it|this) (?:was|is) (?:a )?fake|nothing (?:was )?there|no food (?:here|there|at)/) && (food || inFood || is(/fake|nothing (?:was )?there/))) return { flow: "food", action: "report_fake" };
  if (is(/\bleft ?overs?\b|\bextra (?:food|pizza|[a-z]+ (?:pizza|food))|\bfree (?:food|pizza|boba|donuts?|snacks?|bagels?|tacos?|cookies?)\b.*\b(?:at|in|outside|come|grab|here|for)\b|up for grabs|come (?:get|grab|thru|through)|\bservings?\b|feeds \d+|help yourself|\b(?:giving|gave) away\b|\bfree to (?:take|grab)\b/) || (food && is(/\bwe (?:have|got|'?ve got)\b|\bthere(?:'?s| is| are) (?:free|extra|a (?:bunch|ton|lot))/))) {
    if (!is(/\b(?:is|are|any|was) (?:there|the)\b.*\?$|still (?:there|left|available)/)) return { flow: "food", action: "post_food" };
  }
  if (is(/\b\d+ (?:left|remaining|more left)\b|\bonly (?:a few|\d+|one|two|three) left\b|\blast one\b|\b(?:we'?re|were|we are|it'?s|its) (?:all )?out\b|\ball gone\b|\bran out\b|\bnone left\b|\bno more left\b/) && !is(/\bout of order\b/)) return { flow: "food", action: "update_count" };
  if ((food || inFood) && is(/\b(?:i'?ll|ill|i will|can i|could i|lemme|let me|imma|i'?m gonna|i want to|i wanna) (?:take|grab|have|claim|get|come)\b|\bsave me\b|\bdibs\b|\bclaim\b|\bomw\b|on my way|\bi want (?:one|some|a|\d)/)) return { flow: "food", action: "claim" };
  if (is(/\b(?:any|is there|where'?s|where is)(?: any| the| some)? (?:free )?food\b/) || (food && is(/still (?:there|left|available|any)|any (?:left|more)|\bis (?:it|there|the)\b.*(?:left|gone)\??$/))) return { flow: "food", action: "status" };
  if (hasImage && food) return { flow: "food", action: "post_food" };
  // "3 bowls of chipotle at leavey": an amount of food at a place is a post, even with no "free" in it.
  if (food && !is(/\?\s*$/) && is(/\b(?:\d{1,3}|a few|some|a couple|couple|a bunch of|a ton of|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|dozen)\b.*\b(?:at|in|outside|by|near|inside)\b/)) return { flow: "food", action: "post_food" };
  // Asking where free things are ("where can i get free clothes?") is answered by the free food and items flow.
  if (is(/\bfree (?:clothes|clothing|stuff|things|items|furniture|merch|hoodies?|shirts?|t-?shirts?)\b/) && !is(/\bthrift\b/)) return { flow: "food", action: "status" };

  // rides (the lax shuttle is a usg program, so it goes to usg)
  if (!is(/shuttle/) && (is(/\blax\b|\bairport\b|\bburbank\b|union station|john wayne/) || is(/split (?:an? )?(?:uber|lyft|ride)|\bcarpool|ride ?share|share (?:an? )?(?:uber|lyft|ride)|need a ride|any(?:one|body) (?:going|heading|driving) to/))) return { flow: "rides", action: "find" };

  // repair
  if (is(/\bbroken\b|\bbroke\b|\bleak(?:ing|s|y|ed)?\b|out of order|(?:doesn'?t|does not|isn'?t|is not|not|stopped|won'?t|wont) (?:work(?:ing)?|flush(?:ing)?|open(?:ing)?|clos(?:e|ing)|turn(?:ing)? on|lock(?:ing)?|drain(?:ing)?|charg(?:e|ing)|dispens(?:e|ing))|\bclogged\b|\bflood(?:ed|ing)\b|\bbusted\b|\bcracked\b|\bflicker(?:ing|s)?\b|no hot water|\bjammed\b|overflow(?:ing|ed)?|\bstuck\b|light(?:s)? (?:is|are) out|needs? (?:to be )?(?:fix(?:ed|ing)|repair(?:ed|s)?)|\bshattered\b|\bbroken glass\b/)) return { flow: "repair", action: "report" };

  // usg
  if (is(/\busg\b|student government|\bsenat(?:e|or)\b|\bpolic(?:y|ies)\b|dining (?:hall )?(?:hours|dollars|plan)|meal (?:plan|swipes?)|(?:when|what time) (?:does|do|is|are) .*(?:open|close)|(?:club|org) funding|fund(?:ing|s)? (?:for )?(?:my|our|a|the) (?:club|org)|\b(?:clubs?|orgs?|rsos?|organizations?)\b.*\bfund|\bfunding\b|\bdining\b|(?:close|closes|closed|closing|open|opens) (?:so |too |way too )?(?:early|late)|\bshuttle\b|\bthrift\b|farmers'? market|\bcomplain(?:t)?\b|\bconcern(?:ed|s)?\b|\bpetition\b|\btuition\b|why (?:does|doesn'?t|is|isn'?t|can'?t|are|aren'?t) (?:usc|the school|campus|we)|(?:usc|campus|the school|they) should (?:really )?(?:have|add|fix|extend|open|make)|should (?:be )?open (?:later|longer|earlier)|\bfryft\b|free lyft|\bdps\b|\bfinals week\b.*hours/)) {
    const question = is(/\?\s*$|^(?:when|what|where|who|how|is|are|does|do|can|could|will|why)\b/);
    return { flow: "usg", action: question ? "question" : "concern" };
  }

  if (hasImage) return { flow: "lost_found", action: "report_found" };
  return { flow: "smalltalk", action: "chat" };
}

/** Deterministic intent from keywords. Good enough to run the demo with no API at all. */
export function fallbackIntent(input: { text: string; hasImage: boolean; state: FlowState | null }): Intent {
  const t = input.text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
  const open = input.state && input.state.flow !== "smalltalk" && input.state.flow !== "onboarding" ? input.state.flow : null;
  // Rules, settings and "what do u know about me" are read by the notes flow's own parser first.
  let { flow, action } = (t && !(input.hasImage && !t) ? notesIntent(input.text) : null) ?? classify(t, input.hasImage, open === "food");
  const details = pullDetails(t);

  if (open) {
    const photoOnly = input.hasImage && !t;
    if (flow === "smalltalk" || photoOnly) {
      // "nvm" inside a lost report means they don't need it anymore.
      if (open === "lost_found" && /^(?:nvm|never ?mind)\b/.test(t)) action = "resolved";
      else action = "answer";
      flow = open;
    } else if (flow === open && flow !== "food" && action !== "resolved" && action !== "forget" && action !== "recall") {
      action = "answer";
    }
  }
  if (input.hasImage && !t) details.photoOnly = true;
  return { flow, action, details, source: "fallback" };
}

export async function detectIntent(input: { text: string; hasImage: boolean; state: FlowState | null; notes: string[] }): Promise<Intent> {
  const fallback = fallbackIntent(input);
  try {
    // Nothing for the model to read in a bare photo.
    if (!input.text.trim() || (!override && !aiAvailable())) return fallback;
    const prompt = [
      `Message: ${JSON.stringify(input.text)}`,
      `Photo attached: ${input.hasImage ? "yes" : "no"}`,
      input.state ? `Open conversation: flow "${input.state.flow}", step "${input.state.step}"` : "Open conversation: none",
      input.notes.length ? `Notes about this student: ${JSON.stringify(input.notes.slice(0, 10))}` : "",
    ].filter(Boolean).join("\n");
    const out = await askJson<{ flow?: unknown; action?: unknown; details?: unknown }>({ model: "fast", system: INTENT_SYSTEM, prompt, maxTokens: 300, timeoutMs: 8000 });
    if (!out || typeof out.flow !== "string" || !FLOWS.includes(out.flow as FlowName)) return fallback;
    const action = typeof out.action === "string" && /^[a-z_]{2,30}$/.test(out.action) ? out.action : fallback.action;
    const aiDetails: Record<string, unknown> = {};
    if (out.details && typeof out.details === "object" && !Array.isArray(out.details)) {
      for (const [k, v] of Object.entries(out.details)) if (v !== null && v !== "" && v !== undefined) aiDetails[k] = v;
    }
    // Code-found details fill any gaps; the model's win where both exist.
    return { flow: out.flow as FlowName, action, details: { ...fallback.details, ...aiDetails }, source: "ai" };
  } catch {
    return fallback;
  }
}

// ---------- replies ----------

const REPLY_SYSTEM = `${TROY_VOICE}

you will get a goal, a list of facts and maybe notes about the student. write the reply as one to three short bubbles (each under 150 characters).
every fact value must appear in the reply exactly as given, character for character (keep its capital letters). do not add any other number, name, place, time, link or contact detail.
follow the student's notes when they are about style (for example "no emoji").
reply with json only: {"bubbles": ["...", "..."]}`;

/** Numbers, links and email-like things in the reply must come from the facts or the fallback copy. */
function addsValues(bubbles: string[], allowed: string): boolean {
  const text = bubbles.join(" ");
  const risky = text.match(/https?:\/\/\S+|www\.\S+|\S+@\S+\.\S+|\d+/g) || [];
  return risky.some((x) => !allowed.includes(x));
}

/**
 * Troy-voice bubbles for a goal. Code owns exact values: if any fact is missing from the model's
 * reply, or the reply breaks the voice rules beyond simple repair, the fallback bubbles are returned.
 */
export async function composeReply(input: { goal: string; facts: Record<string, string | number>; notes: string[]; fallback: string[] }): Promise<string[]> {
  try {
    if (!override && !aiAvailable()) return input.fallback;
    const values = Object.values(input.facts).map(String).filter(Boolean);
    const prompt = [
      `goal: ${input.goal}`,
      `facts: ${JSON.stringify(input.facts)}`,
      input.notes.length ? `notes about the student: ${JSON.stringify(input.notes.slice(0, 10))}` : "",
    ].filter(Boolean).join("\n");
    const out = await askJson<{ bubbles?: unknown } | unknown[]>({ model: "fast", system: REPLY_SYSTEM, prompt, maxTokens: 400, timeoutMs: 8000 });
    const raw = Array.isArray(out) ? out : out?.bubbles;
    if (typeof raw !== "string" && !(Array.isArray(raw) && raw.every((b) => typeof b === "string"))) return input.fallback;

    const noEmoji = isStressful(input.goal) || input.notes.some((n) => /no emoji/i.test(n));
    const bubbles = polishBubbles(raw as string | string[], { protect: values, noEmoji });
    if (!bubbles) return input.fallback;
    const joined = bubbles.join("\n");
    if (!values.every((v) => indexOfToken(joined, v) !== -1)) return input.fallback;
    if (addsValues(bubbles, `${values.join(" ")} ${input.fallback.join(" ")}`)) return input.fallback;
    return bubbles;
  } catch {
    return input.fallback;
  }
}
