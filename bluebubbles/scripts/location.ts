// Read the live location of ALLOWED_HANDLES people who share their location with this Mac's Apple ID.
// BlueBubbles returns EVERY Find My friend; this keeps only entries that exactly match an allowed handle
// and discards the rest before anything is printed or returned.
// Run: node --env-file=.env scripts/location.ts            (cached data)
//      node --env-file=.env scripts/location.ts --refresh  (asks BlueBubbles to refresh via the Find My app)

import { pathToFileURL } from "node:url";

const BASE = (process.env.BLUEBUBBLES_URL ?? "http://localhost:1234").replace(/\/$/, "");
const PW = process.env.BLUEBUBBLES_PASSWORD ?? "";

const norm = (h: string) => {
  const s = h.trim().toLowerCase();
  if (s.includes("@")) return s;
  const d = s.replace(/\D/g, "");
  return d.length > 10 ? d.slice(-10) : d;
};
const allowed = new Set((process.env.ALLOWED_HANDLES ?? "").split(",").map((h) => h.trim()).filter(Boolean).map(norm));

// True if any string anywhere in the entry is exactly an allowed handle (phone numbers compared by last 10 digits).
function matchesAllowed(o: unknown, depth = 0): boolean {
  if (depth > 6 || o == null) return false;
  if (typeof o === "string") {
    const s = o.replace(/^(mailto:|tel:)/i, "");
    return (s.includes("@") || /^\+?[\d\s().-]{7,}$/.test(s)) && allowed.has(norm(s));
  }
  if (Array.isArray(o)) return o.some((v) => matchesAllowed(v, depth + 1));
  if (typeof o === "object") return Object.values(o as Record<string, unknown>).some((v) => matchesAllowed(v, depth + 1));
  return false;
}

export async function getAllowedLocations(refresh = false): Promise<unknown[]> {
  const path = refresh ? "/api/v1/icloud/findmy/friends/refresh" : "/api/v1/icloud/findmy/friends";
  const res = await fetch(`${BASE}${path}?password=${encodeURIComponent(PW)}`, { method: refresh ? "POST" : "GET" });
  if (!res.ok) throw new Error(`Find My request failed: ${res.status}`);
  const body: any = await res.json();
  const all: unknown[] = Array.isArray(body?.data) ? body.data : [];
  return all.filter((e) => matchesAllowed(e)); // everyone else is dropped here
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (allowed.size === 0) { console.error("ALLOWED_HANDLES is empty"); process.exit(1); }
  getAllowedLocations(process.argv.includes("--refresh")).then(
    (list) => console.log(list.length ? JSON.stringify(list, null, 2) : "No location shared by the allowed handle(s) yet."),
    (e) => { console.error(e.message); process.exit(1); },
  );
}
