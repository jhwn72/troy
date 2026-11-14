import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("landing page copy follows the framing rules", () => {
  const html = readFileSync(join(import.meta.dirname, "..", "public", "index.html"), "utf8");
  assert.match(html, /He knows a guy\./);
  assert.match(html, /Troy is the front door\. The offices stay in charge\./);
  for (const partner of ["DPS Lost &amp; Found", "FMS", "USC Housing maintenance", "USG"]) assert.ok(html.includes(partner), partner);
  assert.ok(!html.includes("—"), "no em dashes");
  assert.ok(!/\breplaces?\b/i.test(html), "never says replace");
  assert.ok(!/one app for everything/i.test(html));
  assert.match(html, /not an official USC service/i);
  assert.match(html, /prefers-reduced-motion/);
  assert.ok(!/sms:\+?\d/.test(html), "no hard-coded number in the page");
});

test("landing page carries Troy's own lines and the privacy line", () => {
  const html = readFileSync(join(import.meta.dirname, "..", "public", "index.html"), "utf8");
  assert.ok(html.includes("i'm an ai, but i know a guy for everything"));
  assert.ok(html.includes("send me a photo of anything on campus and i'll get it to the right person. or just text me like 'lost my airpods at leavey'"));
  assert.match(html, /only answers people who text him first/);
  assert.match(html, /keeps the last location you share so alerts are accurate/);
  assert.match(html, /forget my location/);
  assert.match(html, /delete my data/);
  assert.match(html, /erase everything/);
  assert.match(html, /for this demo only/);
  assert.match(html, /mocked/);
  // Assets are relative so the same file works on the local server and on a static host.
  assert.ok(!/(?:src|href)="\/assets\//.test(html), "asset paths are relative");
  assert.ok(html.includes("/api/landing"), "keeps the local server fallback");
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

    const html = readFileSync(join(out, "index.html"), "utf8");
    assert.ok(html.includes('href="sms:+12135550123&amp;body=hey%20troy"'), "button link is in the markup");
    assert.ok(html.includes('{"smsLink":"sms:+12135550123&body=hey%20troy","number":"+12135550123"}'), "script has the baked number");
    assert.ok(html.includes("(213) 555-0123"));
    assert.ok(!html.includes("TROY_BAKED*/null"));
    assert.ok(!html.includes("—"), "no em dashes");

    const qr = readFileSync(join(out, "qr.svg"), "utf8");
    assert.equal(qr, await QRCode.toString(built.smsLink, { type: "svg", errorCorrectionLevel: "M", margin: 1, color: { dark: "#1C1917", light: "#FFFFFF" } }));

    assert.ok(existsSync(join(out, "assets", "troy-avatar.svg")));
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
