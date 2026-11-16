// Builds the static site for Vercel into vercel-landing/: the landing page, the staff dashboard and the
// "under the hood" panel running on example data, and the privacy page.
// Run: node scripts/build-landing.ts +1XXXXXXXXXX
//      TROY_NUMBER=+1XXXXXXXXXX node scripts/build-landing.ts
// The number is baked into index.html and qr.svg, so the output needs no server.
// This script never reads .env. Pass the number as an argument or set TROY_NUMBER in the shell.
// The output publishes that phone number to anyone who opens the page.
//
// Only these are copied: index.html, dashboard.html, panel.html, privacy.html, simulator.html, landing/, and the
// img/ and assets/ files those pages actually refer to. The web simulator's one serverless function goes to api/
// with a package.json beside it (scripts/build-sim.ts): it answers POST /api/sim and is connected to nothing else. demo-data/ is made fresh on every build (scripts/build-demo-data.ts):
// example rows only, so the dashboard and the panel work with no server. webchat.html and everything else stay behind.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import QRCode from "qrcode";
import { smsLink, troyNumber } from "../src/web/landing.ts";
import { buildDemoData, writeDemoData } from "./build-demo-data.ts";
import { writeSimFunction } from "./build-sim.ts";

const ROOT = join(import.meta.dirname, "..");
const TEXT_FILE = /\.(?:html|css|js|json|svg)$/;
// A reference to a file the page uses: landing/x.css, img/x.webp, assets/x.svg
const LOCAL_REF = /\b(?:landing|img|assets)\/[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g;
/** The pages that ship next to the landing page. Nothing else in public/ is ever copied (webchat.html stays home). */
export const SITE_PAGES = ["dashboard.html", "panel.html", "privacy.html", "simulator.html"];

export type LandingBuild = {
  outDir: string;
  number: string;
  /** The Text Troy link (body "hey troy"). The hero button, the footer button and the QR all use it. */
  smsLink: string;
  /** Every sms link on the page, in page order. */
  smsLinks: string[];
  version: string;
  files: string[];
};

/**
 * vercel.json for a plain static site with one function: clean URLs, a long cache for versioned files, none for the
 * pages themselves, and the simulator function (api/sim.js) with a short time limit and no caching at all.
 */
export function vercelConfig(): Record<string, unknown> {
  const year = "public, max-age=31536000, immutable";
  const fresh = "public, max-age=0, must-revalidate";
  return {
    $schema: "https://openapi.vercel.sh/vercel.json",
    cleanUrls: true,
    trailingSlash: false,
    // The simulator's model call is cut off at 20 seconds in code; this is the platform's ceiling above it.
    functions: { "api/sim.js": { maxDuration: 30 } },
    headers: [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Robots-Tag", value: "noindex" },
        ],
      },
      // The page and the QR carry the number, so a rebuild must show up right away.
      { source: "/", headers: [{ key: "Cache-Control", value: fresh }] },
      { source: "/qr.svg", headers: [{ key: "Cache-Control", value: fresh }] },
      // The other pages (served at /dashboard, /panel and /privacy by cleanUrls) and the example data they load.
      ...SITE_PAGES.map((page) => ({ source: `/${page.replace(/\.html$/, "")}`, headers: [{ key: "Cache-Control", value: fresh }] })),
      { source: "/demo-data/(.*)", headers: [{ key: "Cache-Control", value: fresh }] },
      // Troy's simulator replies are never stored by a browser or the CDN.
      { source: "/api/(.*)", headers: [{ key: "Cache-Control", value: "no-store, max-age=0" }] },
      // Every page asks for these with ?v=<build>, so a rebuild gets new addresses and the old ones can be kept.
      { source: "/landing/(.*)", headers: [{ key: "Cache-Control", value: year }] },
      { source: "/img/(.*)", headers: [{ key: "Cache-Control", value: year }] },
      { source: "/assets/(.*)", headers: [{ key: "Cache-Control", value: year }] },
    ],
  };
}

function replaceOnce(html: string, find: string, put: string): string {
  const at = html.indexOf(find);
  if (at < 0 || html.indexOf(find, at + find.length) >= 0) {
    throw new Error(`build-landing: expected exactly one ${find} in public/index.html. the page and this script are out of step.`);
  }
  return html.slice(0, at) + put + html.slice(at + find.length);
}

const attr = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const unattr = (s: string): string => s.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, "&");

/**
 * Writes index.html, the other pages, qr.svg, landing/, img/, assets/, demo-data/, api/ (the simulator function),
 * package.json and vercel.json into outDir.
 * Leaves anything else there alone (for example .vercel/).
 */
export async function buildLanding(opts: { number: string | undefined; outDir?: string; publicDir?: string }): Promise<LandingBuild> {
  const number = troyNumber(opts.number ?? "");
  if (!number) {
    throw new Error(
      "build-landing: no phone number. run it as: node scripts/build-landing.ts +1XXXXXXXXXX (or set TROY_NUMBER in the shell). nothing was written.",
    );
  }
  const outDir = resolve(opts.outDir ?? join(ROOT, "vercel-landing"));
  const publicDir = resolve(opts.publicDir ?? join(ROOT, "public"));
  const link = smsLink(number);

  let html = readFileSync(join(publicDir, "index.html"), "utf8");
  const pages = new Map<string, string>(SITE_PAGES.map((name) => [name, readFileSync(join(publicDir, name), "utf8")]));
  // Example data for the dashboard and the panel, made now from the seed. It throws before anything is written
  // if a row could carry something private.
  const demoData = await buildDemoData();

  // Which files the pages use: everything in landing/, plus whatever the pages and landing/ refer to in img/ and assets/.
  const landingFiles = readdirSync(join(publicDir, "landing")).filter((name) => statSync(join(publicDir, "landing", name)).isFile());
  const used = new Set<string>(landingFiles.map((name) => `landing/${name}`));
  const texts = [html, ...pages.values(), ...landingFiles.filter((name) => TEXT_FILE.test(name)).map((name) => readFileSync(join(publicDir, "landing", name), "utf8"))];
  for (const text of texts) {
    for (const ref of text.match(LOCAL_REF) ?? []) {
      if (existsSync(join(publicDir, ref))) used.add(ref);
    }
  }
  // Chat photos live one folder deeper and are loaded by name from the script, so copy the whole folder.
  const photosDir = join(publicDir, "img", "photos");
  if (existsSync(photosDir)) {
    for (const name of readdirSync(photosDir)) if (/\.webp$/i.test(name)) used.add(`img/photos/${name}`);
  }
  const files = [...used].sort();

  // One version for the whole build, from the number and the bytes of every file.
  const hash = createHash("sha256").update(number).update(html);
  for (const file of files) hash.update(file).update(readFileSync(join(publicDir, file)));
  for (const [name, text] of pages) hash.update(name).update(text);
  for (const name of Object.keys(demoData).sort()) hash.update(name).update(demoData[name]);
  const version = hash.digest("hex").slice(0, 10);

  // 1. The number, in the two meta tags landing/config.js reads.
  html = replaceOnce(html, '<meta name="troy-number" content="">', `<meta name="troy-number" content="${number}">`);
  html = replaceOnce(html, '<meta name="troy-sms" content="">', `<meta name="troy-sms" content="sms:${number}">`);

  // 2. The links themselves, so the buttons work before (or without) the script.
  const smsLinks: string[] = [];
  html = html.replace(/<a ([^>]*?)data-sms="([^"]*)"/g, (_all, before: string, body: string) => {
    const href = smsLink(number, unattr(body));
    smsLinks.push(href);
    return `<a ${before}href="${attr(href)}" data-sms="${body}"`;
  });
  // After the hackathon the page has no text links (iMessage is switched off), so zero is fine.

  // 3. Search engines are asked not to list a page with a phone number on it.
  html = replaceOnce(html, '<meta name="theme-color"', '<meta name="robots" content="noindex">\n<meta name="theme-color"');

  // 4. Version every local file address so they can be cached for a long time.
  html = html.replace(LOCAL_REF, (ref) => (used.has(ref) ? `${ref}?v=${version}` : ref));
  html = html.replace(/"qr\.svg"/g, `"qr.svg?v=${version}"`);
  // The other pages get the same versioned addresses. Their links to each other stay as written ("dashboard.html"):
  // that works on any plain file server, and Vercel's cleanUrls sends it on to /dashboard.
  for (const [name, text] of pages) pages.set(name, text.replace(LOCAL_REF, (ref) => (used.has(ref) ? `${ref}?v=${version}` : ref)));

  const qr = await QRCode.toString(link, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    color: { dark: "#1C1917", light: "#FFFFFF" },
  });

  mkdirSync(outDir, { recursive: true });
  for (const dir of ["landing", "img", "assets", "demo-data"]) rmSync(join(outDir, dir), { recursive: true, force: true });
  for (const file of files) {
    mkdirSync(dirname(join(outDir, file)), { recursive: true });
    cpSync(join(publicDir, file), join(outDir, file));
  }
  writeFileSync(join(outDir, "index.html"), html);
  for (const [name, text] of pages) writeFileSync(join(outDir, name), text);
  const demoFiles = writeDemoData(join(outDir, "demo-data"), demoData).map((name) => `demo-data/${name}`);
  writeFileSync(join(outDir, "qr.svg"), qr);
  writeFileSync(join(outDir, "vercel.json"), JSON.stringify(vercelConfig(), null, 2) + "\n");
  const simFiles = writeSimFunction(outDir);

  return { outDir, number, smsLink: link, smsLinks, version, files: ["index.html", ...SITE_PAGES, "qr.svg", "vercel.json", ...simFiles, ...demoFiles, ...files] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const built = await buildLanding({ number: process.argv[2] ?? process.env.TROY_NUMBER });
    // Keep the copy in public/ in step, so the pages also run from any plain file server pointed at public/.
    writeDemoData(join(ROOT, "public", "demo-data"), await buildDemoData());
    console.log(`built ${built.outDir}`);
    for (const file of built.files) console.log(`  ${file}`);
    console.log("  links on the page:");
    for (const href of built.smsLinks) console.log(`    ${href}`);
    console.log("  heads up: this page publishes that phone number. see docs/deploy-landing.md to deploy.");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
