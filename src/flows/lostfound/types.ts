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
