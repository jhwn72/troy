import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import { buildLanding, vercelConfig } from "../scripts/build-landing.ts";
import { createLandingRoutes, troyNumber, smsLink } from "../src/web/landing.ts";

const saved = process.env.TROY_NUMBER;
afterEach(() => {
  if (saved === undefined) delete process.env.TROY_NUMBER;
  else process.env.TROY_NUMBER = saved;
});

// Example number from the 555-01XX range reserved for fiction. Not Troy's real number.
const EXAMPLE = "+12135550123";

test("GET /api/landing returns nulls when TROY_NUMBER is unset", async () => {
  delete process.env.TROY_NUMBER;
  const res = await createLandingRoutes().request("/api/landing");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { smsLink: null, number: null });
});

test("GET /api/landing returns the sms link when TROY_NUMBER is set", async () => {
  process.env.TROY_NUMBER = EXAMPLE;
  const res = await createLandingRoutes().request("/api/landing");
  assert.deepEqual(await res.json(), { smsLink: "sms:+12135550123&body=hey%20troy", number: EXAMPLE });
});

test("a number that is not a phone number counts as unset", async () => {
  process.env.TROY_NUMBER = "soon";
  const res = await createLandingRoutes().request("/api/landing");
  assert.deepEqual(await res.json(), { smsLink: null, number: null });
});

test("troyNumber normalizes to E.164", () => {
  assert.equal(troyNumber("(213) 555-0123"), EXAMPLE);
  assert.equal(troyNumber("1 213 555 0123"), EXAMPLE);
  assert.equal(troyNumber("+1 213-555-0123"), EXAMPLE);
  assert.equal(troyNumber(""), null);
  assert.equal(troyNumber("12345"), null);
  assert.equal(smsLink(EXAMPLE), "sms:+12135550123&body=hey%20troy");
  assert.equal(smsLink(EXAMPLE, "hey troy, i have a question"), "sms:+12135550123&body=hey%20troy%2C%20i%20have%20a%20question");
});

test("GET /qr.svg returns an SVG when the number is set", async () => {
  process.env.TROY_NUMBER = EXAMPLE;
  const res = await createLandingRoutes().request("/qr.svg");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /image\/svg\+xml/);
  const body = await res.text();
  assert.match(body, /^<svg/);
  assert.match(body, /<path/);
});

test("GET /qr.svg is a 404 when the number is unset", async () => {
  delete process.env.TROY_NUMBER;
  const res = await createLandingRoutes().request("/qr.svg");
  assert.equal(res.status, 404);
});

const PUBLIC = join(import.meta.dirname, "..", "public");
const page = () => readFileSync(join(PUBLIC, "index.html"), "utf8");

test("landing page follows the design reference's rules", () => {
  const html = page();
  assert.match(html, /<h1[^>]*>He knows a guy\.<\/h1>/);
  assert.ok(html.includes("ChatGPT gives you information. Troy gets you connected."));
  // Sections, in the reference's order.
  const ids = [...html.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["hero", "problem", "demos", "lost-found", "concern", "food", "broken", "why", "engine", "safe", "next", "faq"]);
  assert.ok(html.includes('<footer id="footer">'));
  // One demo stage: four tabs, each with its panel inside #demos.
  const tabs = [...html.matchAll(/<button class="demo-tab" type="button" data-demo="([^"]+)"><span class="demo-tab-label">([^<]+)</g)].map((m) => `${m[1]}: ${m[2]}`);
  assert.deepEqual(tabs, ["lost-found: Lost and found", "concern: Raise a concern", "food: Free food", "broken: Broken things"]);
  assert.equal([...html.matchAll(/<section id="[^"]+" class="demo"/g)].length, 4);
  assert.ok(html.includes("Campuses now rely on shouting. Group chats, story posts and mass emails nobody reads. You post and hope the right person sees it."));
  assert.ok(html.includes("<li>🏀 pickup basketball at Lyon Center</li>"));
  // Voice and the "never" list.
  assert.ok(!html.includes("—"), "no em dashes");
  for (const word of ["revolutionary", "seamless", "AI-powered"]) assert.ok(!html.toLowerCase().includes(word.toLowerCase()), word);
  // The number is never written into the source page.
  assert.ok(!/sms:\+?\d/.test(html), "no hard-coded number in the page");
  assert.ok(html.includes('<meta name="troy-number" content="">'));
  assert.equal([...html.matchAll(/data-sms="hey troy"/g)].length, 2, "two Text Troy buttons");
  assert.equal([...html.matchAll(/data-sms="hey troy, i have a question"/g)].length, 1, "one FAQ button");
  // Paths are relative so the same file works on the local server and on a static host.
  assert.ok(!/(?:src|href|srcset)="\//.test(html), "paths are relative");
  // Every script and stylesheet is there exactly once.
  for (const name of ["config", "chat", "scene", "map", "widgets", "thread", "fontswitch"]) {
    assert.equal(html.split(`src="landing/${name}.js"`).length - 1, 1, `${name}.js once`);
  }
  for (const name of ["tokens", "page", "phone", "chat", "scene", "map", "widgets", "hero", "thread", "fontswitch"]) {
    assert.equal(html.split(`href="landing/${name}.css"`).length - 1, 1, `${name}.css once`);
  }
});

test("the hero tells each scenario from both sides, on two phones", () => {
  const html = page();
  const hero = html.slice(html.indexOf('<section id="hero"'), html.indexOf('<section id="problem"'));
  // Two phones in one looping conversation, Troy and the connecting line between them.
  assert.ok(hero.includes('<div class="convo" data-convo="hero-1" data-convo-loop="hero-1 hero-2 hero-3 hero-4">'));
  assert.deepEqual([...hero.matchAll(/<div class="phone" data-phone="([^"]+)"/g)].map((m) => m[1]), ["left", "right"]);
  assert.equal(hero.split('id="troy-hero"').length - 1, 1);
  assert.equal(hero.split('class="hero-link"').length - 1, 1);
  assert.ok(hero.indexOf('id="troy-hero"') < hero.indexOf('class="convo"'), "Troy is outside the conversation, so scripts can move each alone");

  const data = JSON.parse(readFileSync(join(PUBLIC, "landing", "conversations.json"), "utf8"));
  type Step = { phone: string; from?: string; text?: string; type?: string; tapback?: string; image?: string; link?: boolean };
  const said = (key: string, phone: string, from: string) =>
    data[key].steps.filter((s: Step) => s.phone === phone && s.from === from && s.text).map((s: Step) => s.text);
  for (const key of ["hero-1", "hero-2", "hero-3", "hero-4"]) {
    const steps: Step[] = data[key].steps;
    assert.deepEqual(Object.keys(data[key].phones), ["left", "right"], key);
    for (const side of ["left", "right"]) {
      assert.ok(steps.some((s) => s.phone === side && s.type !== "clear"), `${key}: something happens on the ${side} phone`);
      assert.equal(steps.filter((s) => s.phone === side && s.type === "clear").length, 1, `${key}: the ${side} phone clears for the next scenario`);
    }
    assert.equal(steps.filter((s) => s.link === true).length, 1, `${key}: the gold line draws once, when the two are connected`);
    for (const s of steps) if (s.text) assert.ok(!s.text.includes("—"), "no em dashes");
  }
  // 1. LAX ride: the asker on the left, another student on the right, then one group chat.
  assert.deepEqual(said("hero-1", "left", "me"), ["find me people tryna go to lax first day of break"]);
  assert.deepEqual(said("hero-1", "right", "troy"), ["someone in ur building is headed to lax on the 19th around noon. want to split a ride?", "done. say hi 👋"]);
  assert.deepEqual(said("hero-1", "right", "me"), ["yes"]);
  assert.ok(said("hero-1", "left", "troy").includes("done. say hi 👋"));
  // 2. Lost AirPods: the owner on the left, the finder (with a photo) on the right.
  assert.deepEqual(said("hero-2", "left", "me"), ["lost my airpods near leavey 😭", "a trojan sticker"]);
  assert.ok(data["hero-2"].steps.some((s: Step) => s.phone === "right" && s.from === "me" && s.image === "airpods"));
  assert.deepEqual(said("hero-2", "right", "me"), ["found these at leavey", "meet"]);
  // 3. Free tacos: a club officer on the left, a nearby student on the right who taps 👍.
  assert.deepEqual(said("hero-3", "left", "me"), ["we have 12 extra tacos at the village"]);
  assert.equal(said("hero-3", "right", "troy")[0], "free tacos at the village 🌮 5 min from u. 12 left. react 👍 to claim");
  assert.ok(data["hero-3"].steps.some((s: Step) => s.phone === "right" && s.from === "me" && s.tapback === "👍"));
  // 4. Late shuttle: the student on the left, a USG member on the right.
  assert.equal(said("hero-4", "left", "me")[0], "the late shuttle to the village is always late");
  assert.deepEqual(said("hero-4", "right", "troy"), ["5 trojans raised late village shuttles this week. want a group chat with them?"]);
  assert.deepEqual(said("hero-4", "right", "me"), ["yes"]);
});

test("landing page carries the amended copy", () => {
  const html = page();
  // Amendment 3: location copy matches the product.
  assert.ok(html.includes("Troy keeps the last spot you share so walking times are right. It's never shown to another student, and 'forget my location' erases it."));
  assert.ok(html.includes("Only if you share it. He keeps the last spot you shared to work out walking distance, never shows it to anyone, and 'forget my location' erases it."));
  // Amendment 5.
  assert.ok(html.includes("No. A student built it at a hackathon. It isn't an official USC service yet."));
  // Amendment 6: the finder chooses the handoff, in the static page and in the script the animation plays.
  const data = JSON.parse(readFileSync(join(PUBLIC, "landing", "conversations.json"), "utf8"));
  const lines = (key: string) => data[key].steps.filter((s: { text?: string }) => s.text).map((s: { phone: string; from: string; text: string }) => `${s.phone}/${s.from}: ${s.text}`);
  const lost = lines("lost-found");
  assert.ok(lost.includes("right/troy: that's them 🙌 asking the finder how they want to hand it off"));
  assert.ok(lost.includes("left/troy: found the owner ✅ want to meet them or drop it at DPS?"));
  assert.ok(lost.includes("left/me: meet"));
  assert.ok(!lost.some((l: string) => l.startsWith("right/me: meet")), "the owner does not choose");
  assert.ok(lines("hero-2").includes("left/troy: that's them 🙌 checking how the finder wants to hand it off"));
  assert.ok(lines("hero-2").includes("right/me: meet"), "in the hero the finder is on the right, and chooses");
  assert.ok(!lines("hero-2").some((l: string) => l.startsWith("left/me: meet")), "the owner does not choose");
  assert.ok(html.includes("found the owner ✅ want to meet them or drop it at DPS?"));
  assert.ok(html.includes("that&#39;s them 🙌 asking the finder how they want to hand it off"));
  assert.ok(!html.includes("pick up at DPS?"));
  // Every line the animation plays is also in the page as plain text (hero scenarios 2 to 4 are added by the script).
  for (const key of ["hero-1", "lost-found", "concern", "broken"]) {
    for (const step of data[key].steps) {
      if (step.text) assert.ok(html.includes(step.text.replace(/'/g, "&#39;")), `${key}: ${step.text}`);
    }
  }
});

test("static build bakes the number into the page, the QR and a Vercel config", async () => {
  const out = mkdtempSync(join(tmpdir(), "troy-landing-"));
  try {
    // Something a deploy tool left behind must survive a rebuild.
    mkdirSync(join(out, ".vercel"));
    writeFileSync(join(out, ".vercel", "project.json"), "{}");

    const built = await buildLanding({ number: "(213) 555-0123", outDir: out });
    assert.equal(built.number, EXAMPLE);
    assert.equal(built.smsLink, "sms:+12135550123&body=hey%20troy");
    assert.deepEqual(built.smsLinks, [
      "sms:+12135550123&body=hey%20troy",
      "sms:+12135550123&body=hey%20troy%2C%20i%20have%20a%20question",
      "sms:+12135550123&body=hey%20troy",
    ]);

    const html = readFileSync(join(out, "index.html"), "utf8");
    assert.ok(html.includes('<meta name="troy-number" content="+12135550123">'));
    assert.ok(html.includes('<meta name="troy-sms" content="sms:+12135550123">'));
    assert.equal(html.split('href="sms:+12135550123&amp;body=hey%20troy" data-sms="hey troy"').length - 1, 2, "both Text Troy links are in the markup");
    assert.ok(html.includes('href="sms:+12135550123&amp;body=hey%20troy%2C%20i%20have%20a%20question"'), "the FAQ link is in the markup");
    assert.ok(html.includes('<meta name="robots" content="noindex">'));
    assert.ok(html.includes(`landing/chat.js?v=${built.version}`));
    assert.ok(html.includes(`img/campus-day-1600.webp?v=${built.version} 1600w`));
    assert.ok(html.includes(`"qr.svg?v=${built.version}"`));
    assert.ok(!html.includes("—"), "no em dashes");

    const qr = readFileSync(join(out, "qr.svg"), "utf8");
    assert.equal(qr, await QRCode.toString(built.smsLink, { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#1C1917", light: "#FFFFFF" } }));

    // Only the landing page is copied.
    assert.deepEqual(readdirSync(out).sort(), [".vercel", "assets", "img", "index.html", "landing", "qr.svg", "vercel.json"]);
    assert.ok(existsSync(join(out, "assets", "troy-avatar.svg")));
    assert.ok(existsSync(join(out, "landing", "conversations.json")));
    for (const name of ["campus-day", "campus-golden", "campus-night"]) {
      assert.ok(existsSync(join(out, "img", `${name}.webp`)), name);
      assert.ok(existsSync(join(out, "img", `${name}-1600.webp`)), `${name}-1600`);
    }
    for (const page of ["webchat.html", "dashboard.html", "panel.html"]) assert.ok(!existsSync(join(out, page)), page);

    assert.deepEqual(JSON.parse(readFileSync(join(out, "vercel.json"), "utf8")), vercelConfig());
    assert.equal(vercelConfig().cleanUrls, true);
    assert.ok(existsSync(join(out, ".vercel", "project.json")), "rebuild leaves .vercel alone");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("static build fails with a clear message when there is no number", async () => {
  const out = join(tmpdir(), `troy-landing-none-${process.pid}`);
  await assert.rejects(buildLanding({ number: undefined, outDir: out }), /no phone number/);
  await assert.rejects(buildLanding({ number: "soon", outDir: out }), /no phone number/);
  assert.ok(!existsSync(out), "nothing is written");
});
