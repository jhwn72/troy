import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";
import { setModelCall } from "../src/ai.ts";
import type { ItemProfile } from "../src/flows/lostfound/types.ts";
import { THRESHOLDS, generatePickupCode, nameMatches, scoreDescription } from "../src/flows/lostfound/verify.ts";
import { countServings, profileItem, sameItem, sanitizeProfile } from "../src/flows/lostfound/vision.ts";

// No test may reach the network.
config.anthropicKey = "";
afterEach(() => setModelCall(null));

// Example item, made up for these tests.
const airpods: ItemProfile = {
  category: "earbuds",
  title: "airpods pro case",
  brand: "Apple",
  color: "black",
  publicSummary: "black airpods case",
  distinguishing: ["small USC sticker on the back", "initials KT engraved on the lid", "green carabiner clip"],
  nameOnItem: null,
  isValuable: true,
  isDangerous: false,
};

const off = { useAi: false };

test("thresholds", () => {
  assert.deepEqual(THRESHOLDS, { verify: 80, clarify: 50, descriptionPass: 70, maxAttempts: 2 });
});

// ---------- blind description, fallback ----------

test("fallback: a correct owner description passes", async () => {
  const full = await scoreDescription(airpods, "black airpods pro case, theres a usc sticker on the back, my initials KT are engraved on it and it has a green carabiner", off);
  assert.equal(full.source, "fallback");
  assert.ok(full.score >= 85, `got ${full.score}`);
  const partial = await scoreDescription(airpods, "its black, has a usc sticker and a green clip thing (carabiner)", off);
  assert.ok(partial.score >= THRESHOLDS.descriptionPass, `got ${partial.score}`);
});

test("fallback: an item with one hidden detail passes when the owner names it", async () => {
  const bottle: ItemProfile = { ...airpods, category: "water_bottle", title: "hydro flask", brand: "Hydro Flask", color: "blue", publicSummary: "blue hydro flask", distinguishing: ["dented bottom with a climbing gym sticker"] };
  const r = await scoreDescription(bottle, "blue hydroflask, big dent on the bottom and a sticker from my climbing gym", off);
  assert.ok(r.score >= THRESHOLDS.descriptionPass, `got ${r.score}`);
});

test("fallback: vague answers fail and are capped at 30", async () => {
  for (const answer of ["black airpods", "its a black apple airpods case", "airpods in a case", "they're mine i swear", "small black case with a sticker"]) {
    const r = await scoreDescription(airpods, answer, off);
    assert.ok(r.score <= 30, `"${answer}" got ${r.score}`);
    assert.ok(r.score < THRESHOLDS.descriptionPass);
  }
});

test("fallback: wrong answers fail, contradictions score very low", async () => {
  const wrong = await scoreDescription(airpods, "white samsung buds with a cat sticker", off);
  assert.ok(wrong.score <= 10, `got ${wrong.score}`);
  const wrongColor = await scoreDescription(airpods, "pink airpods case with glitter", off);
  assert.ok(wrongColor.score <= 10, `got ${wrongColor.score}`);
  const empty = await scoreDescription(airpods, "   ", off);
  assert.equal(empty.score, 0);
});

test("fallback: a right detail next to a wrong color still loses points", async () => {
  const right = await scoreDescription(airpods, "black case with a usc sticker", off);
  const mixed = await scoreDescription(airpods, "white case with a usc sticker", off);
  assert.ok(mixed.score < right.score);
  assert.ok(mixed.score < THRESHOLDS.descriptionPass, `got ${mixed.score}`);
});

test("fallback: mentioning a detail's color isn't a contradiction", async () => {
  const r = await scoreDescription(airpods, "black case, green carabiner on it, usc sticker", off);
  assert.ok(r.score >= THRESHOLDS.descriptionPass, `got ${r.score}`);
});

test("fallback: nothing hidden on file can't pass on generic words", async () => {
  const plain: ItemProfile = { ...airpods, distinguishing: [] };
  const r = await scoreDescription(plain, "black apple airpods case", off);
  assert.ok(r.score <= 30, `got ${r.score}`);
});

test("fallback: deterministic", async () => {
  const a = await scoreDescription(airpods, "usc sticker, green carabiner", off);
  const b = await scoreDescription(airpods, "usc sticker, green carabiner", off);
  assert.deepEqual(a, b);
});

// ---------- blind description, model path ----------

test("model score is used and clamped; bad output falls back", async () => {
  let prompt = "";
  setModelCall(async (opts) => {
    prompt = opts.prompt;
    return '{"score": 140, "reasons": ["sticker and engraving match"]}';
  });
  const ai = await scoreDescription(airpods, "usc sticker and KT engraved");
  assert.deepEqual([ai.score, ai.source], [100, "ai"]);
  assert.ok(prompt.includes("KT engraved") && prompt.includes("USC sticker"));

  setModelCall(async () => '{"score": "high"}');
  assert.equal((await scoreDescription(airpods, "usc sticker and KT engraved")).source, "fallback");
  setModelCall(async () => "no idea");
  assert.equal((await scoreDescription(airpods, "black airpods")).source, "fallback");
  setModelCall(async () => '{"score": 95}');
  assert.equal((await scoreDescription(airpods, "black airpods", off)).source, "fallback");
});

// ---------- names ----------

test("nameMatches: user name, forgiving on case, order and middle names", () => {
  assert.equal(nameMatches("Tommy Trojan", null, "tommy trojan"), true);
  assert.equal(nameMatches("TROJAN, TOMMY", null, "Tommy Trojan"), true);
  assert.equal(nameMatches("Tommy A. Trojan", null, "Tommy Trojan"), true);
  assert.equal(nameMatches("Tommy Trojan", null, "Tommy Alexander Trojan"), true);
  assert.equal(nameMatches("José Núñez", null, "Jose Nunez"), true);
  assert.equal(nameMatches("Tommy Trojan", null, "Tommy Bruin"), false);
  assert.equal(nameMatches("Tommy Trojan", null, "Timmy Trojan"), false);
  assert.equal(nameMatches("Tommy Trojan", null, "Trojan"), false);
  assert.equal(nameMatches("Tommy Trojan", null, null), false);
  assert.equal(nameMatches("Tommy", null, "Tommy Trojan"), false);
  assert.equal(nameMatches("", "tommy.trojan@usc.edu", "Tommy Trojan"), false);
});

test("nameMatches: email local part", () => {
  assert.equal(nameMatches("Tommy Trojan", "tommy.trojan@usc.edu", null), true);
  assert.equal(nameMatches("Tommy Trojan", "Trojan_Tommy@usc.edu", null), true);
  assert.equal(nameMatches("Tommy Trojan", "tommytrojan@usc.edu", null), true);
  assert.equal(nameMatches("Tommy Trojan", "trojantommy27@usc.edu", null), true);
  assert.equal(nameMatches("Tommy A Trojan", "tommy.trojan@usc.edu", null), true);
  // First initial plus last name is not first and last name agreement.
  assert.equal(nameMatches("Tommy Trojan", "ttrojan@usc.edu", null), false);
  assert.equal(nameMatches("Tommy Trojan", "traveler@usc.edu", null), false);
  assert.equal(nameMatches("Tommy Trojan", "tommy.bruin@usc.edu", null), false);
  // Either source is enough.
  assert.equal(nameMatches("Tommy Trojan", "ttrojan@usc.edu", "Tommy Trojan"), true);
});

// ---------- pickup codes ----------

test("pickup codes: 6 characters, no ambiguous letters, no repeats to speak of", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i++) {
    const code = generatePickupCode();
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
    assert.ok(!/[0O1IL]/.test(code));
    seen.add(code);
  }
  // 31^6 codes: a single chance collision in 1000 draws is about 1 in 1800, two is practically never.
  assert.ok(seen.size >= 999, `only ${seen.size} unique`);
});

// ---------- vision validation (no network: fake model) ----------

const img = { path: "/nonexistent/example.jpg", mime: "image/jpeg" };

test("vision: null without AI", async () => {
  assert.equal(await profileItem(img), null);
  assert.equal(await sameItem(img, img), null);
  assert.equal(await countServings(img), null);
});

test("vision: profile is validated, clamped and kept private", async () => {
  let seen: { model: string; maxTokens?: number; images: number; system: string } | null = null;
  setModelCall(async (opts) => {
    seen = { model: opts.model, maxTokens: opts.maxTokens, images: opts.images?.length ?? 0, system: opts.system };
    return JSON.stringify({
      category: "student id",
      title: "  USC ID card  ",
      brand: "",
      color: "Cardinal",
      publicSummary: "USC ID for Example Person 1234567890",
      distinguishing: ["ID number 1234567890", "photo corner peeling", "", 7, ...Array.from({ length: 12 }, (_, i) => `detail ${i}`)],
      nameOnItem: " Example Person ",
      isValuable: false,
      isDangerous: "no",
    });
  });
  const p = (await profileItem(img, "found this at the village"))!;
  assert.deepEqual([seen!.model, seen!.maxTokens, seen!.images], ["smart", 2048, 1]);
  assert.match(seen!.system, /JSON only/);
  assert.equal(p.category, "id_card");
  assert.equal(p.title, "USC ID card");
  assert.equal(p.brand, null);
  assert.equal(p.color, "cardinal");
  assert.equal(p.nameOnItem, "Example Person");
  assert.equal(p.distinguishing.length, 8);
  assert.equal(p.distinguishing[0], "ID number ending 7890");
  assert.ok(!/example|person|\d{4,}/i.test(p.publicSummary), p.publicSummary);
  assert.equal(p.isValuable, true); // code marks IDs valuable whatever the model says
  assert.equal(p.isDangerous, false);
});

test("vision: unknown category becomes other, dangerous flag is enforced in code", async () => {
  const p = sanitizeProfile({ category: "sword", title: "pocket knife", publicSummary: "red pocket knife", distinguishing: "nope" })!;
  assert.equal(p.category, "other");
  assert.deepEqual(p.distinguishing, []);
  assert.equal(p.isDangerous, true);
  assert.equal(sanitizeProfile("a string"), null);
  assert.equal(sanitizeProfile(null), null);

  setModelCall(async () => '{"category":"other","title":"folding tool","publicSummary":"black folding tool","isDangerous":false}');
  assert.equal((await profileItem(img, "found a knife by the bike racks"))!.isDangerous, true);
});

test("vision: sameItem and countServings validate their output", async () => {
  setModelCall(async (opts) => (opts.images?.length === 2 ? '{"same": true, "confidence": 180}' : "{}"));
  assert.deepEqual(await sameItem(img, img), { same: true, confidence: 100 });
  setModelCall(async () => '{"same": "yes"}');
  assert.equal(await sameItem(img, img), null);

  setModelCall(async () => '{"count": 11.6, "item": "Pizza Slices", "confident": true}');
  assert.deepEqual(await countServings(img, "about a dozen left"), { count: 12, item: "pizza slices", confident: true });
  setModelCall(async () => '{"count": -4, "item": "", "confident": "yes"}');
  assert.deepEqual(await countServings(img), { count: 0, item: "servings", confident: false });
  setModelCall(async () => '{"item": "donuts"}');
  assert.equal(await countServings(img), null);
});
