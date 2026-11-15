// Shared shapes and small text helpers for the lost and found flow.
// The listings.details JSON column holds an ItemProfile for type 'found' and a LostReport for type 'lost'.

export const CATEGORIES = [
  "phone",
  "earbuds",
  "laptop",
  "tablet",
  "wallet",
  "id_card",
  "keys",
  "water_bottle",
  "bag",
  "clothing",
  "jewelry",
  "glasses",
  "charger",
  "book",
  "umbrella",
  "scooter",
  "footwear",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface ItemProfile {
  category: Category;
  title: string;
  brand: string | null;
  color: string | null;
  /** Safe to show anyone ("black airpods case"). */
  publicSummary: string;
  /** HIDDEN from claimants until verified. */
  distinguishing: string[];
  /** HIDDEN from claimants until verified. */
  nameOnItem: string | null;
  isValuable: boolean;
  isDangerous: boolean;
}

export interface LostReport {
  category: Category | null;
  description: string;
  color: string | null;
  brand: string | null;
  locationText: string | null;
  happenedAt: number | null;
}

// ---------- categories ----------

/** Words other parts of Troy (intent details, the vision model, students) use for a category. */
const CATEGORY_ALIASES: Record<string, Category> = {
  id: "id_card",
  idcard: "id_card",
  usccard: "id_card",
  studentid: "id_card",
  license: "id_card",
  driverslicense: "id_card",
  passport: "id_card",
  card: "wallet",
  creditcard: "wallet",
  debitcard: "wallet",
  cardholder: "wallet",
  purse: "bag",
  backpack: "bag",
  tote: "bag",
  pouch: "bag",
  bottle: "water_bottle",
  waterbottle: "water_bottle",
  hydroflask: "water_bottle",
  tumbler: "water_bottle",
  wheels: "scooter",
  bike: "scooter",
  bicycle: "scooter",
  skateboard: "scooter",
  watch: "jewelry",
  ring: "jewelry",
  necklace: "jewelry",
  bracelet: "jewelry",
  headphones: "earbuds",
  airpods: "earbuds",
  airpod: "earbuds",
  iphone: "phone",
  macbook: "laptop",
  ipad: "tablet",
  key: "keys",
  keychain: "keys",
  lanyard: "keys",
  jacket: "clothing",
  hoodie: "clothing",
  sweater: "clothing",
  hat: "clothing",
  sunglasses: "glasses",
  cable: "charger",
  notebook: "book",
  textbook: "book",
  shoe: "footwear",
  shoes: "footwear",
  flipflop: "footwear",
  flipflops: "footwear",
  sandal: "footwear",
  sandals: "footwear",
  slides: "footwear",
  sneaker: "footwear",
  sneakers: "footwear",
  croc: "footwear",
  crocs: "footwear",
  boot: "footwear",
  boots: "footwear",
  cleat: "footwear",
  cleats: "footwear",
  heels: "footwear",
  slipper: "footwear",
  slippers: "footwear",
  loafers: "footwear",
};

/** Any value to a Category. Unknown, empty or non-string values become 'other'. */
export function normalizeCategory(raw: unknown): Category {
  if (typeof raw !== "string") return "other";
  const snake = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((CATEGORIES as readonly string[]).includes(snake)) return snake as Category;
  const squashed = snake.replace(/[^a-z]/g, "");
  return CATEGORY_ALIASES[squashed] ?? "other";
}

// ---------- words ----------

const STOP_WORDS = new Set(
  (
    "a an the and or but of on in at to for from with without by near my mine its it is was were are be been i im me we you u ur your " +
    "this that these those there here has have had got one some any very really kinda sort like just also so think thinks maybe probably " +
    "lost found left dropped missing item thing stuff looks look pretty not no yes ya yeah idk lol pls please thanks its it's has"
  ).split(" "),
);

/** Lowercase word list with stop words removed and a light plural strip, for overlap checks. */
export function tokens(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
    .map((w) => (w === "grey" ? "gray" : w))
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

const COLOR_WORDS: Record<string, string> = {
  black: "black",
  white: "white",
  gray: "gray",
  grey: "gray",
  charcoal: "gray",
  silver: "silver",
  gold: "gold",
  red: "red",
  cardinal: "red",
  maroon: "red",
  burgundy: "red",
  crimson: "red",
  blue: "blue",
  navy: "blue",
  green: "green",
  olive: "green",
  sage: "green",
  yellow: "yellow",
  orange: "orange",
  purple: "purple",
  lavender: "purple",
  violet: "purple",
  pink: "pink",
  brown: "brown",
  tan: "tan",
  beige: "tan",
  cream: "tan",
  khaki: "tan",
  clear: "clear",
  transparent: "clear",
  teal: "teal",
  turquoise: "teal",
};

/** The basic colors a piece of text mentions ("navy" and "blue" are the same color). */
export function colorsIn(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const w of text.toLowerCase().split(/[^a-z]+/)) {
    const c = COLOR_WORDS[w];
    if (c) out.add(c);
  }
  return out;
}

export function isColorWord(word: string): boolean {
  return word in COLOR_WORDS;
}

const BRAND_PATTERNS: [RegExp, string][] = [
  [/\b(?:apple|air ?pods?|iphones?|mac ?books?|ipads?|magsafe|apple ?watch)\b/, "apple"],
  [/\b(?:samsung|galaxy)\b/, "samsung"],
  [/\b(?:google|pixel)\b/, "google"],
  [/\bhydro ?flasks?\b/, "hydroflask"],
  [/\bstanley\b/, "stanley"],
  [/\bowala\b/, "owala"],
  [/\byeti\b/, "yeti"],
  [/\bnalgene\b/, "nalgene"],
  [/\bnike\b/, "nike"],
  [/\badidas\b/, "adidas"],
  [/\bnorth ?face\b/, "northface"],
  [/\bpatagonia\b/, "patagonia"],
  [/\blululemon\b/, "lululemon"],
  [/\bjansport\b/, "jansport"],
  [/\bherschel\b/, "herschel"],
  [/\bfjallraven|kanken\b/, "fjallraven"],
  [/\bcarhartt\b/, "carhartt"],
  [/\bray.?bans?\b/, "rayban"],
  [/\bsony\b/, "sony"],
  [/\bbose\b/, "bose"],
  [/\bbeats\b/, "beats"],
  [/\bjbl\b/, "jbl"],
  [/\banker\b/, "anker"],
  [/\bdell\b/, "dell"],
  [/\b(?:lenovo|thinkpad)\b/, "lenovo"],
  [/\bhp\b/, "hp"],
  [/\b(?:microsoft|surface)\b/, "microsoft"],
  [/\bcasio\b/, "casio"],
  [/\b(?:segway|ninebot)\b/, "segway"],
  [/\bxiaomi\b/, "xiaomi"],
  [/\boakleys?\b/, "oakley"],
  [/\bwarby(?: ?parker)?\b/, "warbyparker"],
  [/\bchampion\b/, "champion"],
  [/\bcolumbia\b/, "columbia"],
  [/\bcarhart\b/, "carhartt"],
  [/\basus\b/, "asus"],
  [/\bacer\b/, "acer"],
  [/\buniqlo\b/, "uniqlo"],
];

/** Known brands a piece of text names, including through product names ("airpods" means apple). */
export function brandsIn(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const t = text.toLowerCase();
  for (const [re, brand] of BRAND_PATTERNS) if (re.test(t)) out.add(brand);
  return out;
}

/** Letters and digits only, lowercase. For comparing brand names that aren't on the known list. */
export function squash(text: string | null | undefined): string {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function clampInt(n: unknown, min: number, max: number, fallback = min): number {
  const v = typeof n === "number" ? n : typeof n === "string" && n.trim() !== "" ? Number(n) : NaN;
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}


// ---------- comparing two descriptions of the same thing ----------
// Used by the verifier's and the matcher's rule scores. Everything here is plain code:
// no model, same answer every time.

/** Different words students use for the same thing. Values are the canonical word. */
const SYNONYMS: Record<string, string> = {
  pic: "photo",
  picture: "photo",
  photograph: "photo",
  cover: "case",
  shell: "case",
  otterbox: "case",
  pouch: "case",
  topper: "case",
  skin: "case",
  holder: "sleeve",
  decal: "sticker",
  spot: "stain",
  blotch: "stain",
  pole: "stem",
  post: "stem",
  neck: "stem",
  popgrip: "popsocket",
  ding: "dent",
  licence: "license",
  kitty: "cat",
  kitten: "cat",
  puppy: "dog",
  doggo: "dog",
  ripped: "torn",
  tear: "torn",
  med: "medium",
  bookbag: "backpack",
  sweatshirt: "hoodie",
  keyring: "keychain",
  busted: "broken",
};

/** A specific word and the general word an owner might use for it. One direction only: two different breeds never match. */
const HYPERNYM_WORDS: Record<string, string> = {
  retriever: "dog",
  labrador: "dog",
  corgi: "dog",
  poodle: "dog",
  husky: "dog",
  pug: "dog",
  bulldog: "dog",
  beagle: "dog",
  terrier: "dog",
  dachshund: "dog",
  shepherd: "dog",
  tabby: "cat",
  siamese: "cat",
  sunflower: "flower",
  daisy: "flower",
  rose: "flower",
  tulip: "flower",
};

/** Filled in below, keyed by comparison form. */
const HYPERNYMS: Record<string, string> = {};

/** Light stemming so "engraved", "engraving" and "engrave" compare equal. Only ever compared against itself. */
export function stem(word: string): string {
  let w = word;
  if (w.length >= 7 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length >= 6 && w.endsWith("ed")) w = w.slice(0, -2);
  if (w.length >= 5 && w.endsWith("e")) w = w.slice(0, -1);
  if (w.length >= 5 && w[w.length - 1] === w[w.length - 2] && !/[aeiou]/.test(w[w.length - 1]!)) w = w.slice(0, -1);
  return w;
}

/** One word in its comparison form: basic color, synonym, then stem. Null for stop words. */
export function canonWord(raw: string): string | null {
  const t = tokens(raw);
  if (t.length !== 1) return null;
  const w = t[0]!;
  if (COLOR_WORDS[w]) return COLOR_WORDS[w]!;
  if (SYNONYMS[w]) return SYNONYMS[w]!;
  const s = stem(w);
  return SYNONYMS[s] ?? s;
}

/** Comparison-form words of a text, in order. */
export function canonTokens(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const w of tokens(text)) {
    const c = canonWord(w);
    if (c) out.push(c);
  }
  return out;
}

for (const [specific, general] of Object.entries(HYPERNYM_WORDS)) HYPERNYMS[canonWord(specific) ?? specific] = general;

/**
 * Words that fit almost any item of a kind, so sharing one proves nothing:
 * item parts and accessories, positions, vague adjectives and filler verbs.
 * Kept in comparison form (see canonWord).
 */
const GENERIC_WORDS = new Set(
  (
    // parts and accessories nearly every item has
    "case sticker screen lock card cash money key ring pocket strap zipper handle lid cap bell shop store name logo label thing part piece stuff " +
    "button charger cable battery item kind type wallpaper background " +
    // positions and vague adjectives
    "small medium xs xl xxl little lil tiny mini big large huge back front side corner left right top bottom inside outside middle center old new worn slightly bit edge " +
    "couple few color colored size sized dark light plain normal regular basic nice whole half other another same different " +
    "scratch scratched " +
    // filler verbs and chat words
    "say said read written write shape wear tuck hang attach stuck put made make come came goe went need want know remember sure might could would should " +
    "about around behind under over along onto into near next still almost bc cuz tbh btw tho though w asap mine own back"
  )
    .split(" ")
    .map((w) => canonWord(w) ?? w),
);

/** Extra generic words per kind of item ("fob" on keys, "license" in a wallet). */
const GENERIC_BY_CATEGORY: Partial<Record<Category, string>> = {
  keys: "keychain fob lanyard car house apartment door home room dorm",
  wallet: "license id debit credit student usc bill receipt leather",
  id_card: "license id student usc photo picture lanyard",
  phone: "pro max plus mini",
  earbuds: "pod bud pro charging",
  water_bottle: "straw bottle water",
  clothing: "hood sleeve",
  bag: "pocket zipper strap",
  scooter: "wheel brake electric",
  footwear: "shoe flip flop sandal slide sneaker croc boot cleat heel slipper loafer pair sole strap lace size foot left right",
  glasses: "lens frame",
  laptop: "keyboard pro air",
  tablet: "pro air",
};

const GENERIC_BY_CATEGORY_SETS = new Map<Category, Set<string>>(
  Object.entries(GENERIC_BY_CATEGORY).map(([c, words]) => [c as Category, new Set(words!.split(" ").map((w) => canonWord(w) ?? w))]),
);

/** True for a comparison-form word that can't count as a distinctive detail (for that kind of item). */
export function isGenericWord(word: string, category?: Category | null): boolean {
  if (GENERIC_WORDS.has(word)) return true;
  if (!category) return false;
  if (GENERIC_BY_CATEGORY_SETS.get(category)?.has(word)) return true;
  return canonTokens(category.replace(/_/g, " ")).includes(word);
}

/**
 * Marks and add-ons a guesser can name without knowing the item ("a dent", "a stain", "a pin").
 * Matching one is worth a little; which one and where is what counts.
 */
const COMMON_FEATURES = new Set("pin stain dent crack hole patch tape chip scuff torn fray faded fade bent mark".split(" ").map((w) => canonWord(w) ?? w));

export function isCommonFeature(word: string): boolean {
  return COMMON_FEATURES.has(word);
}

/** The general word for a specific one ("dog" for "retriever"), or null. */
export function generalWord(word: string): string | null {
  return HYPERNYMS[word] ?? null;
}

/** Edit distance with swaps of neighbors counted as one step, cut off above max. */
export function editDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push([i]);
    for (let j = 1; j <= b.length; j++) {
      if (i === 0) {
        rows[0]![j] = j;
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = v;
    }
  }
  return rows[a.length]![b.length]!;
}

/**
 * How two comparison-form words relate:
 * "same" (equal, or a small typo in a long word), "general" (one is the general word for the other,
 * like "dog" for "retriever"), or null. Colors, sizes, numbers and short words must match exactly.
 */
export function wordMatch(a: string, b: string): "same" | "general" | null {
  if (a === b) return "same";
  if (HYPERNYMS[a] === b || HYPERNYMS[b] === a) return "general";
  const short = Math.min(a.length, b.length);
  if (short < 6 || a[0] !== b[0]) return null;
  if (/\d/.test(a) || /\d/.test(b) || isColorWord(a) || isColorWord(b)) return null;
  // a typo of one specific thing must not turn it into a different specific thing
  if (HYPERNYMS[a] || HYPERNYMS[b]) return null;
  const allowed = short >= 9 ? 2 : 1;
  return editDistance(a, b, allowed) <= allowed ? "same" : null;
}

const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const SIZE_WORDS: Record<string, string> = { xs: "xs", s: "s", small: "s", m: "m", medium: "m", med: "m", l: "l", large: "l", xl: "xl", xxl: "xxl" };
const FULL_SIZE_WORDS = new Set(["xs", "small", "medium", "med", "large", "xl", "xxl"]);

// "lost" only reaches a noun through "the" or "a" ("lost the top button"), never through "my" ("lost my keys").
const NEGATORS = new Set(["no", "without", "lacks", "minus", "zero", "missing", "lost"]);
const NEGATING_VERBS = new Set(["doesnt", "dont", "didnt", "hasnt", "never", "not", "wont"]);
const HAVE_WORDS = new Set(["have", "has", "had", "got"]);
const NEGATION_FILLER = new Set(["a", "an", "any", "the", "real", "visible", "more", "one"]);
const GONE_WORDS = new Set(["missing", "gone", "removed"]);
const OFF_VERBS = new Set(["broken", "broke", "fell", "fallen", "came", "ripped", "torn", "snapped", "worn", "rubbed", "peeled", "taken"]);
const LINKING = new Set(["is", "are", "was", "were", "has", "have", "got", "been", "its", "it"]);

export interface TextFacts {
  /** Comparison-form content words, in order. */
  list: string[];
  /** Words said to be absent ("no bell", "drawstring is missing"). */
  negated: Set<string>;
  /** Words said to be present somewhere in the text. */
  asserted: Set<string>;
  /** noun to the colors it was given ("navy hard case" gives case: blue). */
  colorOf: Map<string, Set<string>>;
  /** noun to the counts it was given ("four keys" gives key: 4). */
  countOf: Map<string, Set<number>>;
  /** Clothing-style sizes stated ("size large", "its a medium"). */
  sizes: Set<string>;
}

function rawSegments(text: string): string[][] {
  return text
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .split(/[.,;:!?()\n/]+/)
    .map((seg) => seg.split(/[^a-z0-9]+/).filter(Boolean))
    .filter((seg) => seg.length);
}

const numberOf = (w: string): number | null => (/^\d{1,3}$/.test(w) ? Number(w) : (NUMBER_WORDS[w] ?? null));

/**
 * Pull the checkable facts out of a description: its words, what it says is absent,
 * which color and count go with which noun, and any stated size.
 */
export function textFacts(text: string | null | undefined): TextFacts {
  const facts: TextFacts = { list: [], negated: new Set(), asserted: new Set(), colorOf: new Map(), countOf: new Map(), sizes: new Set() };
  if (!text) return facts;

  for (const seg of rawSegments(text)) {
    const canon = seg.map((w) => canonWord(w));
    const negatedAt = new Set<number>();

    for (let i = 0; i < seg.length; i++) {
      const w = seg[i]!;

      // "no bell", "without a case", "doesnt have a case", "missing drawstring"
      let start = -1;
      if (NEGATORS.has(w)) start = i + 1;
      else if (NEGATING_VERBS.has(w) && HAVE_WORDS.has(seg[i + 1] ?? "")) start = i + 2;
      let forward = 0;
      if (start >= 0) {
        let j = start;
        while (j < seg.length && NEGATION_FILLER.has(seg[j]!)) j++;
        while (j < seg.length && forward < 2 && canon[j] && !isColorWord(canon[j]!)) {
          negatedAt.add(j);
          forward++;
          j++;
        }
        // "no black case": step over the color and take the noun
        if (!forward && j < seg.length && canon[j] && isColorWord(canon[j]!)) {
          j++;
          while (j < seg.length && forward < 2 && canon[j]) {
            negatedAt.add(j);
            forward++;
            j++;
          }
        }
      }

      // "drawstring is missing", "bell is broken off"
      const trailing = (GONE_WORDS.has(w) && !forward) || (OFF_VERBS.has(w) && seg[i + 1] === "off");
      if (trailing) {
        let j = i - 1;
        while (j >= 0 && LINKING.has(seg[j]!)) j--;
        // same reach as the forward form: up to two words ("top button is missing")
        for (let back = 0; back < 2 && j >= 0 && canon[j] && !isColorWord(canon[j]!); back++, j--) negatedAt.add(j);
      }

      // "navy hard case": the color goes with the words that follow it
      const c = canon[i];
      if (c && isColorWord(c)) {
        let taken = 0;
        for (let j = i + 1; j < seg.length && taken < 3; j++) {
          const n = canon[j];
          if (!n) break;
          if (isColorWord(n) || numberOf(seg[j]!) !== null) continue;
          if (!facts.colorOf.has(n)) facts.colorOf.set(n, new Set());
          facts.colorOf.get(n)!.add(c);
          taken++;
        }
      }

      // "four keys", "3 or 4 keys", "6 stamps"
      const n = numberOf(w);
      if (n !== null && n >= 2 && numberOf(seg[i - 1] ?? "") === null && seg[i - 1] !== "or" && seg[i - 1] !== "to") {
        const counts = [n];
        let j = i + 1;
        while (j + 1 < seg.length && (seg[j] === "or" || seg[j] === "to") && numberOf(seg[j + 1]!) !== null) {
          counts.push(numberOf(seg[j + 1]!)!);
          j += 2;
        }
        const noun = j < seg.length ? canon[j] : null;
        if (noun && !isColorWord(noun) && numberOf(seg[j]!) === null) {
          if (!facts.countOf.has(noun)) facts.countOf.set(noun, new Set());
          for (const x of counts) facts.countOf.get(noun)!.add(x);
        }
      }

      // sizes: "size large", "size: m", or a size word that isn't describing something else ("its a medium")
      if (w === "size" || w === "sized") {
        let j = i + 1;
        while (j < seg.length && (seg[j] === "is" || seg[j] === "a" || seg[j] === "an")) j++;
        const s = SIZE_WORDS[seg[j] ?? ""];
        if (s) facts.sizes.add(s);
      } else if (FULL_SIZE_WORDS.has(w) && seg[i + 1] !== "size") {
        const next = seg[i + 1];
        const nextCanon = next === undefined ? null : canon[i + 1];
        const describesSomethingElse = nextCanon !== null && nextCanon !== undefined && !CLOTHING_NOUNS.has(nextCanon);
        const afterSize = seg[i - 1] === "size" || seg[i - 2] === "size";
        if (!describesSomethingElse && !afterSize) facts.sizes.add(SIZE_WORDS[w]!);
      }
    }

    for (let i = 0; i < seg.length; i++) {
      const c = canon[i];
      if (!c) continue;
      facts.list.push(c);
      if (negatedAt.has(i)) facts.negated.add(c);
      else facts.asserted.add(c);
    }
  }
  return facts;
}

const CLOTHING_NOUNS = new Set("hoodie jacket shirt tee tshirt sweater coat crewneck pants shorts jersey vest top fit".split(" ").map((w) => canonWord(w) ?? w));

/** Nouns an item can have several of, so a second one in another color or count isn't a contradiction. */
const MANY_OF = new Set("sticker pin key card keychain charm patch button stain scratch dent".split(" ").map((w) => canonWord(w) ?? w));

/** True when a noun can't be used to call two descriptions contradictory (there may be more than one of it). */
export function canHaveSeveral(word: string): boolean {
  return MANY_OF.has(word);
}
