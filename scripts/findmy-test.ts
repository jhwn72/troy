// Find My test for Troy. Checks whether BlueBubbles can see the location of the test handles.
// Run: node --env-file=.env scripts/findmy-test.ts            (reads the server's current cache)
//      node --env-file=.env scripts/findmy-test.ts --refresh  (also asks the server to refresh; this opens the Find My app)
// Prints a location ONLY for handles in ALLOWED_HANDLES. Everyone else sharing with John is counted, never shown.
// First, on the test phone: open the chat with Troy > tap the name > Share My Location.

import { normalizeHandle } from "../src/config.ts";

const BASE = (process.env.BLUEBUBBLES_URL ?? "http://localhost:1234").replace(/\/$/, "");
const PW = process.env.BLUEBUBBLES_PASSWORD ?? "";
const allowed = new Set((process.env.ALLOWED_HANDLES ?? "").split(",").map(normalizeHandle).filter((h) => h !== null));
if (!PW || allowed.size === 0) {
  console.error("Need BLUEBUBBLES_PASSWORD and ALLOWED_HANDLES in .env");
  process.exit(1);
}

async function api(method: string, path: string): Promise<any> {
  const res = await fetch(`${BASE}/api/v1${path}?password=${encodeURIComponent(PW)}`, { method, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
  return res.json();
}

function show(list: unknown): void {
  const entries: any[] = Array.isArray(list) ? list : [];
  let others = 0;
  let shown = 0;
  for (const e of entries) {
    const h = normalizeHandle(e?.handle);
    if (!h || !allowed.has(h)) {
      others++;
      continue;
    }
    shown++;
    const [lat, lng] = Array.isArray(e.coordinates) ? e.coordinates : [null, null];
    const t = Number(e.last_updated);
    const when = t ? new Date(t < 1e12 ? t * 1000 : t).toISOString() : "unknown time";
    console.log(`${h}: lat ${lat}, lng ${lng}, status ${e.status ?? "?"}, updated ${when}`);
  }
  if (shown === 0) console.log("No location for the test handles yet.");
  console.log(`Other entries (not shown): ${others}`);
}

const info = (await api("GET", "/server/info")).data ?? {};
console.log(`Private API ${info.private_api}, helper ${info.helper_connected}`);

if (process.argv.includes("--refresh")) {
  await api("POST", "/icloud/findmy/friends/refresh");
  console.log("Refresh requested. Waiting 20 seconds for Find My to update...");
  await new Promise((r) => setTimeout(r, 20_000));
}
show((await api("GET", "/icloud/findmy/friends")).data);
