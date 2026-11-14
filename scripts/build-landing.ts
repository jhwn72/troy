// Builds the static landing page for Vercel into vercel-landing/.
// Run: node scripts/build-landing.ts +1XXXXXXXXXX
//      TROY_NUMBER=+1XXXXXXXXXX node scripts/build-landing.ts
// The number is baked into index.html and qr.svg, so the output needs no server.
// This script never reads .env. Pass the number as an argument or set TROY_NUMBER in the shell.
// The output publishes that phone number to anyone who opens the page.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import QRCode from "qrcode";
import { smsLink, troyNumber } from "../src/web/landing.ts";

const ROOT = join(import.meta.dirname, "..");
const BAKED_MARK = "/*TROY_BAKED*/null/*END_TROY_BAKED*/";
const BUTTON_OFF = '<a class="btn" id="text-troy" role="link" aria-disabled="true">';
const NOTE_OFF = "Checking for Troy's number...";

export type LandingBuild = { outDir: string; number: string; smsLink: string; files: string[] };

/** vercel.json for a plain static site: clean URLs, short caches (file names are not hashed), basic security headers. */
export function vercelConfig(): Record<string, unknown> {
  return {
    $schema: "https://openapi.vercel.sh/vercel.json",
    cleanUrls: true,
    trailingSlash: false,
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
      { source: "/", headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }] },
      { source: "/qr.svg", headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }] },
      { source: "/assets/(.*)", headers: [{ key: "Cache-Control", value: "public, max-age=3600, stale-while-revalidate=86400" }] },
    ],
  };
}

function pretty(number: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(number);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : number;
}

function replaceOnce(html: string, find: string, put: string): string {
  const at = html.indexOf(find);
  if (at < 0 || html.indexOf(find, at + find.length) >= 0) {
    throw new Error(`build-landing: expected exactly one "${find}" in public/index.html. the page and this script are out of step.`);
  }
  return html.slice(0, at) + put + html.slice(at + find.length);
}

/** Writes index.html, qr.svg, assets/ and vercel.json into outDir. Leaves anything else there alone (for example .vercel/). */
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
  // Only "+" and digits can be in the number, so the JSON is safe inside the script tag.
  html = replaceOnce(html, BAKED_MARK, JSON.stringify({ smsLink: link, number }));
  // Bake the link into the markup too, so the button works before (or without) the script.
  html = replaceOnce(html, BUTTON_OFF, `<a class="btn" id="text-troy" href="${link.replace(/&/g, "&amp;")}">`);
  html = replaceOnce(html, NOTE_OFF, `Opens Messages with “hey troy” filled in. Or text it to <b>${pretty(number)}</b>.`);

  const qr = await QRCode.toString(link, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    color: { dark: "#1C1917", light: "#FFFFFF" },
  });

  mkdirSync(outDir, { recursive: true });
  rmSync(join(outDir, "assets"), { recursive: true, force: true });
  if (existsSync(join(publicDir, "assets"))) cpSync(join(publicDir, "assets"), join(outDir, "assets"), { recursive: true });
  writeFileSync(join(outDir, "index.html"), html);
  writeFileSync(join(outDir, "qr.svg"), qr);
  writeFileSync(join(outDir, "vercel.json"), JSON.stringify(vercelConfig(), null, 2) + "\n");

  return { outDir, number, smsLink: link, files: ["index.html", "qr.svg", "vercel.json", "assets/"] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const built = await buildLanding({ number: process.argv[2] ?? process.env.TROY_NUMBER });
    console.log(`built ${built.outDir}`);
    console.log(`  ${built.files.join(", ")}`);
    console.log(`  the button and the qr code open: ${built.smsLink}`);
    console.log("  heads up: this page publishes that phone number. see docs/deploy-landing.md to deploy.");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
