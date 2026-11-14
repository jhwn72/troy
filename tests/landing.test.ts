import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
