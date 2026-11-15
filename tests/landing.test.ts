import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import { buildLanding, vercelConfig, SITE_PAGES } from "../scripts/build-landing.ts";
import { buildDemoData, check as checkDemoData, DEMO_PICKUP_CODE } from "../scripts/build-demo-data.ts";
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
  assert.deepEqual(ids, ["hero", "problem", "demos", "lost-found", "concern", "food", "broken", "rides", "why", "engine", "safe", "purpose", "next", "faq"]);
  assert.ok(html.includes('<footer id="footer">'));
  // "A day at USC": one pinned scene (#demos) with five stops inside it, one map, and no tabs.
  const day = html.slice(html.indexOf('<section id="demos"'), html.indexOf('<section id="why"'));
  assert.ok(html.includes('<section id="demos" class="day"'));
  assert.ok(!html.includes("demo-tab"), "the tabbed demo stage is gone");
  const stops = [...day.matchAll(/<section id="([^"]+)" class="day-stop" data-day-minutes="(\d+)" data-day-tod="([\d.]+)"/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);
  assert.deepEqual(stops, ["lost-found 520 0", "concern 735 0.18", "food 1050 0.5", "broken 1270 0.78", "rides 1425 1"]);
  assert.deepEqual([...day.matchAll(/<p class="day-time">([^<]+)</g)].map((m) => m[1]), ["8:40 am", "12:15 pm", "5:30 pm", "9:10 pm", "11:45 pm"]);
  assert.deepEqual([...day.matchAll(/class="day-setup">([^<]+)</g)].map((m) => m[1]), [
    "You notice your AirPods aren't in your pocket",
    "Your shuttle is late. Again",
    "Your club meeting ends with 20 extra bowls",
    "Your door lock is broken",
    "You have a flight in the morning, but the Uber costs the same as the ticket",
  ]);
  assert.deepEqual([...day.matchAll(/<span class="chip">([^<]+)</g)].map((m) => m[1]), [
    "Connected you to: the student who found it",
    "Connected you to: USG and 4 students with the same issue",
    "Connected you to: 20 trojans within a 15-minute walk",
    "Connected you to: the closest technician",
    "Connected you to: 2 trojans leaving when you are",
  ]);
  assert.deepEqual([...day.matchAll(/<div class="convo" data-convo="([^"]+)"/g)].map((m) => m[1]), ["lost-found", "concern", "food", "broken", "rides"]);
  assert.equal([...day.matchAll(/<div class="phone" data-phone="(?:left|right)"/g)].length, 10, "two phones per stop");
  assert.deepEqual([...day.matchAll(/class="day-mark"[^>]*>([^<]+)</g)].map((m) => m[1]), ["I", "II", "III", "IV", "V"]);
  assert.equal(day.split('id="food-map"').length - 1, 1, "one connection picture for the whole day");
  assert.deepEqual([...day.matchAll(/class="map-layer" data-layer="([^"]+)"/g)].map((m) => m[1]), ["lost-found", "concern", "food", "broken", "rides"]);
  // The picture is circles, a gold line and one small fact per stop: no streets, no buildings.
  assert.ok(!day.includes("map-buildings") && !day.includes("map-paths"), "the street-grid map is gone");
  for (const label of ["you", "leavey", "the finder", "4 min apart", "USG", "5 students, same issue", "your club", "15 min walk", "your building", "the closest technician", "5 min away", "M", "J", "LAX", "same flight window"]) assert.ok(day.includes(`>${label}</text>`), label);
  assert.ok(day.includes('<tspan class="map-count-n">20</tspan> nearby</text>'));
  assert.ok(day.includes("Only students within a 15-minute walk get the text. Everyone else is left alone."));
  assert.ok(day.includes("that's the whole day. keep scrolling"));
  assert.equal(day.split('class="day-next"').length - 1, 1);
  assert.deepEqual([...day.matchAll(/<li data-step="([^"]+)">/g)].map((m) => m[1]), ["reported", "on-it", "fixed"]);
  // One phone on stage per stop: data-main says whose. The other side is a notification card on the map.
  assert.deepEqual([...day.matchAll(/class="day-stop"[^>]* data-main="(left|right)"/g)].map((m) => m[1]), ["right", "left", "left", "left", "left"]);
  assert.deepEqual([...day.matchAll(/<div class="day-card" data-card="([^"]+)">/g)].map((m) => m[1]), ["lost-found", "concern", "food", "broken", "rides"]);
  assert.deepEqual([...day.matchAll(/<p class="day-card-who"[^>]*>.*?<span>([^<]+)<\/span><\/p>/g)].map((m) => m[1]), [
    "the finder",
    "a USG member",
    "20 students nearby",
    "the closest technician",
    "2 trojans leaving when you are",
  ]);
  const technician = day.slice(day.indexOf('data-card="broken"'), day.indexOf('<section id="rides"'));
  assert.ok(technician.indexOf('class="repair-steps"') > 0 && technician.indexOf('class="repair-steps"') < technician.indexOf('class="pair-foot"'), "Reported, On it, Fixed sit on the technician's card");
  assert.equal(day.split('class="day-shell"').length - 1, 1, "one phone frame");
  // The problem section's example lines carry no trailing period.
  const pairs = [...html.matchAll(/<p class="pair-card">([^<]+)<\/p>/g)].map((m) => m[1]);
  assert.equal(pairs.length, 8);
  assert.deepEqual(pairs.slice(0, 2), ["You need a ride to LAX", "Three people in your building do too"]);
  for (const line of pairs) assert.ok(!line.endsWith("."), line);
  // Every link that opens a text draft has the "Available on iMessage" badge right after it.
  assert.equal([...html.matchAll(/<a class="btn" data-sms="[^"]+">[^<]+<\/a>(?:\s*<img id="qr"[^>]*>)?\s*<p class="badge-imessage">/g)].length, 3, "a badge with every Text Troy link");
  assert.equal(html.split('<span class="badge-name">iMessage</span>').length - 1, 3);
  assert.equal(html.split("Coming to non-Apple devices soon").length - 1, 3);
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
  for (const name of ["config", "day", "chat", "scene", "map", "widgets", "thread", "fontswitch"]) {
    assert.equal(html.split(`src="landing/${name}.js"`).length - 1, 1, `${name}.js once`);
  }
  for (const name of ["tokens", "page", "phone", "chat", "scene", "map", "widgets", "day", "hero", "thread", "fontswitch", "badge", "nav"]) {
    assert.equal(html.split(`href="landing/${name}.css"`).length - 1, 1, `${name}.css once`);
  }
});

test("every page links to the others, with links that work on a plain file server and on Vercel", () => {
  const html = page();
  // The landing page: a slim header over the painting (before the sky and the hero) and the same links in the footer.
  const header = html.slice(html.indexOf('<header class="site-nav">'), html.indexOf('<div id="sky"'));
  assert.ok(html.indexOf('<header class="site-nav">') > 0 && html.indexOf('<header class="site-nav">') < html.indexOf('<div id="sky"'), "the header is the first thing in the page");
  assert.ok(header.includes('<a class="site-nav-brand" href="./">Troy</a>'));
  assert.deepEqual([...header.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => `${m[2]} ${m[1]}`), ["For staff dashboard.html", "Under the hood panel.html", "Privacy privacy.html"]);
  const footer = html.slice(html.indexOf('<footer id="footer">'));
  const footerNav = footer.slice(footer.indexOf('<nav class="footer-links"'));
  assert.deepEqual([...footerNav.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((m) => `${m[2]} ${m[1]}`), ["Home ./", "For staff dashboard.html", "Under the hood panel.html", "Privacy privacy.html"]);

  for (const name of SITE_PAGES) {
    const other = readFileSync(join(PUBLIC, name), "utf8");
    const nav = other.slice(other.indexOf('<nav class="site-nav-links"'), other.indexOf("</nav>"));
    assert.deepEqual([...nav.matchAll(/<a href="([^"]+)"( aria-current="page")?>([^<]+)<\/a>/g)].map((m) => `${m[3]} ${m[1]}${m[2] ? " current" : ""}`), [
      "Home ./",
      `For staff dashboard.html${name === "dashboard.html" ? " current" : ""}`,
      `Under the hood panel.html${name === "panel.html" ? " current" : ""}`,
      `Privacy privacy.html${name === "privacy.html" ? " current" : ""}`,
    ], name);
    // Same look as the landing page: its tokens, the shared nav and tool styles, Space Grotesk and Inter.
    for (const sheet of ["tokens", "nav", "tool"]) assert.equal(other.split(`href="landing/${sheet}.css"`).length - 1, 1, `${name}: ${sheet}.css once`);
    assert.ok(other.includes("family=Space+Grotesk:wght@500&amp;family=Inter:wght@400;500;600"), `${name}: fonts`);
    assert.ok(!other.includes("Instrument"), `${name}: the old headline font is gone`);
    assert.equal(other.split('class="key-rule"').length - 1, 1, `${name}: the Greek key rule, once`);
    assert.ok(!/(?:src|href)="\/(?!\/)/.test(other), `${name}: paths are relative`);
    assert.ok(!other.includes("—"), `${name}: no em dashes`);
  }
  // The two working pages get their data through the shared layer (live server first, example data otherwise).
  for (const name of ["dashboard.html", "panel.html"]) {
    const other = readFileSync(join(PUBLIC, name), "utf8");
    assert.equal(other.split('<script src="landing/demo.js"></script>').length - 1, 1, name);
    assert.ok(other.includes("TroyData.api("), name);
    assert.ok(other.includes("!TroyData.isDemo()"), `${name}: no polling on example data`);
    assert.ok(!/\bfetch\(/.test(other), `${name}: every request goes through the data layer`);
  }
  const layer = readFileSync(join(PUBLIC, "landing", "demo.js"), "utf8");
  assert.ok(layer.includes("Example data. This is a demo of the staff view; nothing here is a real student or report."));
  assert.ok(layer.includes(`const SAMPLE_CODE = "${DEMO_PICKUP_CODE}";`));
  // The demo's only requests are the probe and the example files. No POST, PUT or DELETE leaves the page.
  assert.deepEqual([...layer.matchAll(/fetch\(([^,)]+)/g)].map((m) => m[1]), ["path", '"/api/settings"', '"demo-data/" + name + ".json"']);

  const privacy = readFileSync(join(PUBLIC, "privacy.html"), "utf8");
  for (const fact of ['"forget my location"', '"delete my data"', '"STOP"', '"hey troy"', "johnwang@usc.edu", "not an official USC service", "outside AI service", "This demo runs on its builder's Mac", "see nothing without your yes"]) assert.ok(privacy.includes(fact), fact);
});

test("the example data for the public pages holds nothing private", async () => {
  const files = await buildDemoData();
  assert.deepEqual(Object.keys(files).sort(), ["demo.json", "directory.json", "dps.json", "eval.json", "moderation.json", "panel.json", "reports-repair.json", "reports-usg.json", "settings.json", "staff.json"]);
  assert.deepEqual(await buildDemoData(), files, "two builds give the same bytes");
  const all = Object.values(files).join("\n");
  assert.ok(!all.includes("pickupCode"), "no pickup codes, not even the field");
  assert.ok(!all.includes(DEMO_PICKUP_CODE), "the sample code lives in the page, not in the data");
  assert.ok(!/\+1\d{10}/.test(all) && !/555-?01\d\d/.test(all), "no full handles");
  assert.ok(!/example@usc\.edu/.test(all), "no example user emails");
  for (const word of ["lastLat", "lastLng", "usualSpots", "chatId", "ALLOWED_HANDLES", "API_KEY"]) assert.ok(!all.includes(word), word);
  const settings = JSON.parse(files["settings.json"]);
  assert.deepEqual(settings.allowList.envEntries, [], "the .env allow-list never leaves the Mac");
  assert.equal(settings.provider, "demo");
  // Every handle is masked, every row about a person or an item is marked as an example, and no row has a photo.
  const panel = JSON.parse(files["panel.json"]);
  assert.ok(panel.listings.length > 10 && panel.listings.every((l: { isExample: boolean; hasPhoto: boolean }) => l.isExample && !l.hasPhoto));
  assert.ok(panel.matches.length > 0 && panel.verifications.length > 0 && panel.handoffs.length > 0);
  assert.deepEqual(Object.values(panel.staff.handoffs), panel.handoffs.map(() => ({})), "the staff view carries no code");
  const staff = JSON.parse(files["staff.json"]);
  assert.ok(staff.contacts.length > 0 && staff.contacts.every((c: { handle: string; isExample: boolean }) => /^•••• 01\d\d$/.test(c.handle) && c.isExample));
  const dps = JSON.parse(files["dps.json"]);
  const demo = JSON.parse(files["demo.json"]);
  assert.ok(dps.items.some((it: { handoffId: number | null }) => it.handoffId === demo.samplePickup.handoff.id), "the sample code opens an item in the DPS list");
  for (const kind of ["repair", "usg"]) {
    const reports = JSON.parse(files[`reports-${kind}.json`]);
    assert.ok(reports.total > 0);
    for (const g of reports.groups) for (const r of g.reports) assert.ok(typeof demo.reports[r.id].reference === "string" && demo.reports[r.id].recipients >= 1);
  }

  // The guard itself: it refuses a full number, a pickup code field, a row that is not an example and a named secret.
  const one = (json: unknown) => ({ "x.json": JSON.stringify(json) });
  assert.throws(() => checkDemoData(one({ handle: "+12135550123" }), []), /phone number/);
  assert.throws(() => checkDemoData(one({ handle: "•••• 9876" }), []), /handle/);
  assert.throws(() => checkDemoData(one({ pickupCode: "ABC234" }), []), /pickupCode/);
  assert.throws(() => checkDemoData(one({ isExample: false }), []), /example/);
  assert.throws(() => checkDemoData(one({ note: "the code is QWERTY" }), ["QWERTY"]), /private/);
  assert.doesNotThrow(() => checkDemoData(one({ handle: "•••• 0119", isExample: true, hasPhoto: false, createdAt: 1794686400000 }), ["QWERTY"]));
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
  // The hero plays the short version (the day scene has the full check of what is on the case).
  assert.deepEqual(said("hero-2", "left", "me"), ["lost my airpods near leavey 😭"]);
  assert.ok(data["hero-2"].steps.some((s: Step) => s.phone === "right" && s.from === "me" && s.image === "airpods"));
  assert.deepEqual(said("hero-2", "right", "me"), ["meet"]);
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
  assert.ok(html.includes("Never shown to anyone. One text erases it."));
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
  assert.ok(lines("hero-2").includes("right/troy: found the owner ✅ want to meet them or drop it at DPS?"));
  assert.ok(lines("hero-2").includes("right/me: meet"), "in the hero the finder is on the right, and chooses");
  assert.ok(!lines("hero-2").some((l: string) => l.startsWith("left/me: meet")), "the owner does not choose");
  assert.ok(html.includes("found the owner ✅ want to meet them or drop it at DPS?"));
  assert.ok(html.includes("that&#39;s them 🙌 asking the finder how they want to hand it off"));
  assert.ok(!html.includes("pick up at DPS?"));
  // Every line the animation plays is also in the page as plain text (hero scenarios 2 to 4 are added by the script).
  for (const key of ["hero-1", "lost-found", "concern", "food", "broken", "rides"]) {
    for (const step of data[key].steps) {
      // The live count ("20 left", "14 left") changes in place; the page shows where it ends.
      if (step.type === "count" && step.text !== "6 left") continue;
      if (step.text) assert.ok(html.includes(step.text.replace(/'/g, "&#39;")), `${key}: ${step.text}`);
    }
  }
  // The day's five conversations: who is on each side, and the lines the reference gives.
  const sides = (key: string) => [data[key].phones.left.label, data[key].phones.right.label];
  assert.deepEqual(sides("lost-found"), ["The finder", "The owner"]);
  assert.deepEqual(sides("concern"), ["A student", "A USG committee member"]);
  assert.deepEqual(sides("food"), ["A club officer", "A student nearby"]);
  assert.deepEqual(sides("broken"), ["The student", "An FMS technician"]);
  assert.deepEqual(sides("rides"), ["A student", "Another student"]);
  assert.deepEqual(data.food.steps.filter((s: { type?: string }) => s.type === "count").map((s: { text: string }) => s.text), ["20 left", "14 left", "6 left"]);
  assert.ok(data.food.steps.some((s: { phone: string; from?: string; tapback?: string }) => s.phone === "right" && s.from === "me" && s.tapback === "👍"));
  assert.ok(lines("rides").includes("left/me: find me people tryna go to lax first day of break"));
  assert.equal(data.rides.steps.filter((s: { type?: string }) => s.type === "switch-group").length, 2, "rides ends in the group chat on both phones");
});

test("static build bakes the number into the page, the QR and a Vercel config, and ships the other pages with example data", async () => {
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

    // Only the four pages, what they use and the example data are copied.
    assert.deepEqual(readdirSync(out).sort(), [".vercel", "assets", "dashboard.html", "demo-data", "img", "index.html", "landing", "panel.html", "privacy.html", "qr.svg", "vercel.json"]);
    assert.deepEqual(readdirSync(join(out, "demo-data")).sort(), ["demo.json", "directory.json", "dps.json", "eval.json", "moderation.json", "panel.json", "reports-repair.json", "reports-usg.json", "settings.json", "staff.json"]);
    const demoData = await buildDemoData();
    for (const [name, text] of Object.entries(demoData)) assert.equal(readFileSync(join(out, "demo-data", name), "utf8"), text, `demo-data/${name} is made by the build`);
    for (const name of ["nav.css", "tool.css", "demo.js"]) assert.ok(existsSync(join(out, "landing", name)), name);
    for (const name of SITE_PAGES) {
      const other = readFileSync(join(out, name), "utf8");
      assert.ok(other.includes(`href="landing/tool.css?v=${built.version}"`), `${name}: versioned stylesheet`);
      assert.ok(!other.includes("+12135550123"), `${name}: no number on this page`);
      assert.ok(built.files.includes(name));
    }
    assert.ok(readFileSync(join(out, "dashboard.html"), "utf8").includes(`<script src="landing/demo.js?v=${built.version}"></script>`));
    // Links between pages stay as written: a plain file server serves dashboard.html, and cleanUrls sends it on to /dashboard.
    assert.ok(html.includes('<a href="dashboard.html">For staff</a>') && html.includes('<a href="privacy.html">Privacy</a>'));
    assert.ok(html.includes(`href="landing/nav.css?v=${built.version}"`));
    assert.ok(existsSync(join(out, "assets", "troy-avatar.svg")));
    assert.ok(existsSync(join(out, "landing", "conversations.json")));
    for (const name of ["campus-day", "campus-golden", "campus-night"]) {
      assert.ok(existsSync(join(out, "img", `${name}.webp`)), name);
      assert.ok(existsSync(join(out, "img", `${name}-1600.webp`)), `${name}-1600`);
    }
    assert.ok(!existsSync(join(out, "webchat.html")), "the web chat is never copied");
    assert.ok(!existsSync(join(out, "webchat")), "the web chat is never copied");

    assert.deepEqual(JSON.parse(readFileSync(join(out, "vercel.json"), "utf8")), vercelConfig());
    assert.equal(vercelConfig().cleanUrls, true);
    // The pages and the example data are always revalidated; only versioned files are kept for a year.
    const cache = Object.fromEntries((vercelConfig().headers as { source: string; headers: { key: string; value: string }[] }[]).map((h) => [h.source, h.headers.find((x) => x.key === "Cache-Control")?.value]));
    for (const source of ["/", "/dashboard", "/panel", "/privacy", "/demo-data/(.*)", "/qr.svg"]) assert.equal(cache[source], "public, max-age=0, must-revalidate", source);
    for (const source of ["/landing/(.*)", "/img/(.*)", "/assets/(.*)"]) assert.equal(cache[source], "public, max-age=31536000, immutable", source);
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
