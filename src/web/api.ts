// JSON API for the staff dashboard (public/dashboard.html) and the demo panel (public/panel.html).
// Reads and writes the database tables directly, so it works before the flows exist and when tables are empty.
//
// What people can see (a hard rule, decided here in code):
// - The main payload of every endpoint never contains the hidden item details (distinguishing, nameOnItem),
//   the lost report's own words, the owner's verification answers or pickup codes.
// - Those are returned only under a separate "staff" key, and only when the request asks for it with ?staff=1.
// - Phone numbers and emails are never returned in full: handles are masked to their last characters.

import { existsSync, realpathSync, statSync, createReadStream } from "node:fs";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import type { MessagingAdapter } from "../types.ts";
import { config, isEnabled, normalizeHandle } from "../config.ts";
import { getSetting, setSetting } from "../db/index.ts";
import { setSignupCap, setSignupsOpen, signupsView } from "../signups.ts";
import { reportReference } from "../flows/reports-shared.ts";
import { assignStaff, closeJobsFor, exampleTextFor, listStaff, removeStaff, reportRole, roleLabel, staffFor, staffLogFor, staffRoles } from "../staff.ts";
import { createTopic, openTopicRequests, removeTopic, subscribe } from "../topics.ts";

export interface WebDeps {
  db: DatabaseSync;
  getAdapter: () => MessagingAdapter;
  /** Resolves false when nothing was delivered (stopped user, kill switch, chat not allowed), so it isn't counted as texted. */
  notify: (userId: number, bubbles: string[]) => Promise<boolean | void>;
  /** Optional: the lost and found flow's own close (marks both listings returned and asks the owner for a thank-you note). */
  completeHandoff?: (handoffId: number) => Promise<boolean>;
}

type Row = Record<string, unknown>;

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");
const PHOTO_ROOTS = [join(PROJECT_ROOT, "tmp-downloads"), join(PROJECT_ROOT, "public")];
const PHOTO_MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };

const DAY_MS = 24 * 60 * 60 * 1000;
export const DPS_HOLD_DAYS = 90;

export const REPORT_STATUSES = {
  repair: ["received", "in_progress", "fixed", "closed"],
  usg_concern: ["received", "on_agenda", "acted_on", "closed"],
} as const;
type ReportKind = keyof typeof REPORT_STATUSES;

/** Fixed status copy. The model never writes these. "received" is a reset and sends nothing. */
export const STATUS_COPY: Record<string, string | null> = {
  received: null,
  in_progress: "in progress 🔧",
  fixed: "fixed ✅",
  on_agenda: "on the agenda",
  acted_on: "acted on ✅",
  closed: "closed",
};

/** Categories whose photos are blurred on every page and only served to staff. */
const SENSITIVE_CATEGORIES = ["wallet", "id_card"];
const SENSITIVE_WORDS = /\b(wallet|id|ids|card|cards|license|licence|passport|usc ?card)\b/i;

// ---------- small helpers ----------

function parseJson<T>(text: unknown, fallback: T): T {
  if (typeof text !== "string" || !text) return fallback;
  try {
    const v = JSON.parse(text);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isStaff(c: Context): boolean {
  return c.req.query("staff") === "1";
}

async function body(c: Context): Promise<Row> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" ? (b as Row) : {};
  } catch {
    return {};
  }
}

/** "+12135550101" becomes "•••• 0101"; "someone@usc.edu" becomes "s•••@usc.edu". */
export function maskHandle(handle: string | null): string | null {
  if (!handle) return null;
  if (handle.includes("@")) {
    const [local, domain] = handle.split("@");
    return `${local.slice(0, 1)}•••@${domain}`;
  }
  return `•••• ${handle.slice(-4)}`;
}

function firstName(name: unknown): string | null {
  const s = str(name);
  return s ? s.trim().split(/\s+/)[0] : null;
}

function isSensitive(category: unknown, title: unknown, summary: unknown): boolean {
  if (typeof category === "string" && SENSITIVE_CATEGORIES.includes(category)) return true;
  return SENSITIVE_WORDS.test(`${str(title) ?? ""} ${str(summary) ?? ""}`);
}

export { reportReference };

/** The local file for a stored photo path, or null when it is missing or outside the two allowed folders. */
export function resolvePhoto(photoUrl: unknown, roots: string[] = PHOTO_ROOTS): { path: string; mime: string } | null {
  const raw = str(photoUrl);
  if (!raw || /^[a-z]+:\/\//i.test(raw) || raw.includes("\0")) return null;
  const candidates = isAbsolute(raw) ? [raw, join(PROJECT_ROOT, "public", raw)] : [resolve(PROJECT_ROOT, raw), resolve(PROJECT_ROOT, "public", raw)];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const real = realpathSync(candidate);
      if (!statSync(real).isFile()) continue;
      const inside = roots.some((root) => existsSync(root) && real.startsWith(realpathSync(root) + sep));
      if (!inside) continue;
      const mime = PHOTO_MIME[extname(real).toLowerCase()];
      if (!mime) continue;
      return { path: real, mime };
    } catch {
      // unreadable path: treat as missing
    }
  }
  return null;
}

function servePhoto(c: Context, photoUrl: unknown): Response {
  const file = resolvePhoto(photoUrl);
  if (!file) return c.json({ ok: false, error: "not_found" }, 404);
  const stream = Readable.toWeb(createReadStream(file.path)) as unknown as ReadableStream;
  return new Response(stream, { headers: { "content-type": file.mime, "cache-control": "private, max-age=60", "x-content-type-options": "nosniff" } });
}

// ---------- eval (owned by someone else, may not exist yet) ----------

async function loadLatestEval(): Promise<unknown> {
  try {
    const path = "../eval.ts"; // a variable on purpose: the file is optional
    const mod = (await import(path)) as { latestEval?: () => unknown };
    if (typeof mod.latestEval !== "function") return null;
    const result: unknown = await mod.latestEval();
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;
    // Summary only: the per-case list is long and the pages poll every few seconds.
    const { cases: _cases, ...summary } = result as Record<string, unknown>;
    return summary;
  } catch {
    return null;
  }
}

/** The chat brain's health number for the panel header. Null until src/brain.ts exports getChatHealth. */
async function loadChatHealth(db: DatabaseSync): Promise<unknown> {
  try {
    const path = "../brain.ts"; // a variable on purpose: the export is another builder's and may not be there yet
    const mod = (await import(path)) as { getChatHealth?: (db: DatabaseSync) => unknown };
    if (typeof mod.getChatHealth !== "function") return null;
    const health: unknown = await mod.getChatHealth(db);
    return health ?? null;
  } catch {
    return null;
  }
}

// ---------- routes ----------

export function createWebRoutes(deps: WebDeps): Hono {
  const { db } = deps;
  const app = new Hono();

  // Every route here that changes something (the kill switch, sign-ups, the cap, the allow-list, staff, reports)
  // is for the dashboard served by this same server. A browser sends Origin on any cross-site POST or DELETE, so a
  // write whose Origin is another site is refused: a web page open on this Mac must not be able to flip a switch.
  // Requests with no Origin (curl, tests, scripts on this machine) pass as before.
  app.use("/api/*", async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    const origin = c.req.header("origin");
    if (origin === undefined) return next();
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = null;
    }
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!originHost || originHost !== host) return c.json({ ok: false, error: "forbidden" }, 403);
    return next();
  });

  // Privacy: a student's saved location (users.lastLat, lastLng, lastLocationAt, lastLocationSource) and their usual
  // spots never leave the server through this file. Every users query here names its columns; never SELECT * FROM users.
  const userNames = (): Map<number, Row> => {
    const map = new Map<number, Row>();
    for (const u of db.prepare("SELECT id, name, bannedFromPosting, isExample FROM users").all() as Row[]) map.set(u.id as number, u);
    return map;
  };

  /** Public view of a found or lost listing. Nothing hidden goes in here. */
  const publicListing = (r: Row) => {
    const details = parseJson<Row>(r.details, {});
    const found = r.type === "found";
    const summary = found ? str(details.publicSummary) : null;
    const title = str(r.title) ?? (found ? str(details.title) : null);
    return {
      id: r.id as number,
      type: r.type as string,
      category: str(r.category) ?? str(details.category),
      title,
      publicSummary: summary,
      color: str(details.color),
      brand: str(details.brand),
      locationText: str(r.locationText) ?? str(details.locationText),
      happenedAt: num(r.happenedAt),
      status: r.status as string,
      isValuable: !!r.isValuable,
      isDangerous: !!r.isDangerous,
      heldBy: str(r.heldBy),
      isExample: !!r.isExample,
      hasPhoto: !!resolvePhoto(r.photoUrl),
      photoSensitive: isSensitive(r.category ?? details.category, title, summary),
      hasHiddenDetails: found ? (Array.isArray(details.distinguishing) && details.distinguishing.length > 0) || !!str(details.nameOnItem) : !!str(details.description),
      createdAt: r.createdAt as number,
    };
  };

  // ----- panel -----

  app.get("/api/panel", async (c) => {
    const listingRows = db.prepare("SELECT * FROM listings WHERE type IN ('found','lost') ORDER BY createdAt DESC, id DESC LIMIT 60").all() as Row[];
    const listings = listingRows.map(publicListing);

    const titleOf = (id: unknown) => {
      const row = db.prepare("SELECT title, category, details, type FROM listings WHERE id = ?").get(id as number) as Row | undefined;
      if (!row) return null;
      const d = parseJson<Row>(row.details, {});
      return str(row.title) ?? (row.type === "found" ? str(d.publicSummary) ?? str(d.title) : null) ?? str(row.category) ?? null;
    };

    // Pairs in motion first, then the ones worth acting on (50 and up), newest first. Low scores stay listed
    // after those so staff can see what was considered.
    const matchRows = db
      .prepare(
        `SELECT * FROM matches
          ORDER BY (status NOT IN ('proposed','rejected')) DESC, (confidence >= 50) DESC, createdAt / 60000 DESC, confidence DESC, id DESC
          LIMIT 40`,
      )
      .all() as Row[];
    const matches = matchRows.map((m) => ({
      id: m.id as number,
      foundListingId: m.foundListingId as number,
      lostListingId: m.lostListingId as number,
      foundTitle: titleOf(m.foundListingId),
      lostTitle: titleOf(m.lostListingId),
      confidence: m.confidence as number,
      reasons: parseJson<unknown[]>(m.reasons, []).filter((x): x is string => typeof x === "string"),
      source: m.source as string,
      status: m.status as string,
      createdAt: m.createdAt as number,
    }));

    const verificationRows = db.prepare("SELECT * FROM verifications ORDER BY createdAt DESC, id DESC LIMIT 40").all() as Row[];
    const verifications = verificationRows.map((v) => ({
      id: v.id as number,
      matchId: v.matchId as number,
      method: v.method as string,
      score: num(v.score),
      result: str(v.result),
      attempts: v.attempts as number,
      hasAnswer: !!str(v.ownerAnswer),
      createdAt: v.createdAt as number,
    }));

    const handoffRows = db.prepare("SELECT * FROM handoffs ORDER BY createdAt DESC, id DESC LIMIT 40").all() as Row[];
    const handoffs = handoffRows.map((h) => ({
      id: h.id as number,
      matchId: h.matchId as number,
      method: h.method as string,
      chosenBy: h.chosenBy as string,
      hasPickupCode: !!str(h.pickupCode),
      completedAt: num(h.completedAt),
      thankYouNote: str(h.thankYouNote),
      createdAt: h.createdAt as number,
    }));

    const dropRows = db.prepare("SELECT * FROM food_drops ORDER BY createdAt DESC, id DESC LIMIT 20").all() as Row[];
    const claimCounts = db.prepare("SELECT foodDropId, status, COUNT(*) AS n FROM claims GROUP BY foodDropId, status").all() as Row[];
    const foodDrops = dropRows.map((d) => {
      const claims = { held: 0, picked_up: 0, released: 0 };
      for (const cc of claimCounts) if (cc.foodDropId === d.id && (cc.status as string) in claims) claims[cc.status as keyof typeof claims] = cc.n as number;
      return {
        id: d.id as number,
        clubName: str(d.clubName),
        description: str(d.description),
        locationText: str(d.locationText),
        servingsTotal: d.servingsTotal as number,
        servingsLeft: d.servingsLeft as number,
        status: d.status as string,
        reports: d.reports as number,
        isExample: !!d.isExample,
        claims,
        expiresAt: num(d.expiresAt),
        createdAt: d.createdAt as number,
      };
    });

    const payload: Row = {
      ok: true,
      now: Date.now(),
      enabled: isEnabled(db),
      counts: {
        found: (db.prepare("SELECT COUNT(*) AS n FROM listings WHERE type = 'found'").get() as Row).n,
        lost: (db.prepare("SELECT COUNT(*) AS n FROM listings WHERE type = 'lost'").get() as Row).n,
        matches: (db.prepare("SELECT COUNT(*) AS n FROM matches").get() as Row).n,
        returned: (db.prepare("SELECT COUNT(*) AS n FROM handoffs WHERE completedAt IS NOT NULL").get() as Row).n,
      },
      listings,
      matches,
      verifications,
      handoffs,
      foodDrops,
      eval: await loadLatestEval(),
      chatHealth: await loadChatHealth(db),
    };

    if (isStaff(c)) {
      const staffListings: Record<string, Row> = {};
      for (const r of listingRows) {
        const d = parseJson<Row>(r.details, {});
        staffListings[String(r.id)] =
          r.type === "found"
            ? { distinguishing: Array.isArray(d.distinguishing) ? d.distinguishing.filter((x) => typeof x === "string") : [], nameOnItem: str(d.nameOnItem) }
            : { description: str(d.description) };
      }
      const staffVerifications: Record<string, Row> = {};
      for (const v of verificationRows) staffVerifications[String(v.id)] = { ownerAnswer: str(v.ownerAnswer) };
      const staffHandoffs: Record<string, Row> = {};
      for (const h of handoffRows) staffHandoffs[String(h.id)] = { pickupCode: str(h.pickupCode) };
      payload.staff = { listings: staffListings, verifications: staffVerifications, handoffs: staffHandoffs };
    }
    return c.json(payload);
  });

  app.get("/api/eval", async (c) => c.json({ ok: true, eval: await loadLatestEval() }));

  // ----- photos -----

  app.get("/api/photo/:listingId", (c) => {
    const id = Number(c.req.param("listingId"));
    if (!Number.isInteger(id)) return c.json({ ok: false, error: "not_found" }, 404);
    const row = db.prepare("SELECT photoUrl, category, title, details FROM listings WHERE id = ?").get(id) as Row | undefined;
    if (!row) return c.json({ ok: false, error: "not_found" }, 404);
    const d = parseJson<Row>(row.details, {});
    // Wallets, IDs and cards can show a name or a number: staff only, and the pages blur them until clicked.
    if (isSensitive(row.category ?? d.category, row.title ?? d.title, d.publicSummary) && !isStaff(c)) return c.json({ ok: false, error: "staff_only" }, 403);
    return servePhoto(c, row.photoUrl);
  });

  app.get("/api/report-photo/:reportId", (c) => {
    const id = Number(c.req.param("reportId"));
    if (!Number.isInteger(id)) return c.json({ ok: false, error: "not_found" }, 404);
    const row = db.prepare("SELECT photoUrl FROM reports WHERE id = ?").get(id) as Row | undefined;
    if (!row) return c.json({ ok: false, error: "not_found" }, 404);
    return servePhoto(c, row.photoUrl);
  });

  // ----- DPS -----

  app.get("/api/dps", (c) => {
    const now = Date.now();
    const rows = db.prepare("SELECT * FROM listings WHERE type = 'found' AND heldBy = 'dps' ORDER BY createdAt ASC, id ASC").all() as Row[];
    const items = rows.map((r) => {
      const since = r.createdAt as number;
      const daysHeld = Math.max(0, Math.floor((now - since) / DAY_MS));
      const handoff = db
        .prepare("SELECT h.id, h.completedAt FROM handoffs h JOIN matches m ON m.id = h.matchId WHERE m.foundListingId = ? AND h.method = 'dps_code' ORDER BY h.id DESC LIMIT 1")
        .get(r.id as number) as Row | undefined;
      return {
        ...publicListing(r),
        heldSince: since,
        daysHeld,
        daysLeft: Math.max(0, DPS_HOLD_DAYS - daysHeld),
        holdExpired: daysHeld >= DPS_HOLD_DAYS,
        hasPickupCode: !!handoff,
        handoffId: handoff ? (handoff.id as number) : null,
        pickedUpAt: handoff ? num(handoff.completedAt) : null,
      };
    });
    return c.json({ ok: true, now, holdDays: DPS_HOLD_DAYS, items });
  });

  const handoffView = (h: Row) => {
    const match = db.prepare("SELECT * FROM matches WHERE id = ?").get(h.matchId as number) as Row | undefined;
    const found = match ? (db.prepare("SELECT * FROM listings WHERE id = ?").get(match.foundListingId as number) as Row | undefined) : undefined;
    const lost = match ? (db.prepare("SELECT userId FROM listings WHERE id = ?").get(match.lostListingId as number) as Row | undefined) : undefined;
    const owner = lost ? (db.prepare("SELECT name FROM users WHERE id = ?").get(lost.userId as number) as Row | undefined) : undefined;
    return {
      id: h.id as number,
      matchId: h.matchId as number,
      method: h.method as string,
      completedAt: num(h.completedAt),
      createdAt: h.createdAt as number,
      matchStatus: match ? (match.status as string) : null,
      item: found ? publicListing(found) : null,
      ownerFirstName: owner ? firstName(owner.name) : null,
    };
  };

  app.post("/api/dps/check-code", async (c) => {
    const b = await body(c);
    const code = typeof b.code === "string" ? b.code.replace(/[\s-]/g, "").toUpperCase() : "";
    if (!code) return c.json({ ok: false, found: false, error: "missing_code" }, 400);
    const h = db.prepare("SELECT * FROM handoffs WHERE method = 'dps_code' AND pickupCode IS NOT NULL AND UPPER(pickupCode) = ? ORDER BY id DESC LIMIT 1").get(code) as Row | undefined;
    if (!h) return c.json({ ok: true, found: false });
    return c.json({ ok: true, found: true, alreadyCompleted: h.completedAt !== null, handoff: handoffView(h) });
  });

  app.post("/api/dps/complete", async (c) => {
    const b = await body(c);
    const id = Number(b.handoffId);
    if (!Number.isInteger(id)) return c.json({ ok: false, error: "bad_handoff" }, 400);
    const h = db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as Row | undefined;
    if (!h) return c.json({ ok: false, error: "not_found" }, 404);
    if (h.completedAt === null) {
      // The flow closes it the same way as the owner texting "got it". A failure there never blocks the pickup being saved.
      if (deps.completeHandoff) await deps.completeHandoff(id).catch(() => false);
      const now = Date.now();
      db.prepare("UPDATE handoffs SET completedAt = ? WHERE id = ? AND completedAt IS NULL").run(now, id);
      const match = db.prepare("SELECT foundListingId, lostListingId FROM matches WHERE id = ?").get(h.matchId as number) as Row | undefined;
      if (match) db.prepare("UPDATE listings SET status = 'returned' WHERE id IN (?, ?)").run(match.foundListingId as number, match.lostListingId as number);
    }
    const fresh = db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as Row;
    return c.json({ ok: true, alreadyCompleted: h.completedAt !== null, handoff: handoffView(fresh) });
  });

  // ----- reports (repairs and USG concerns) -----

  /**
   * Who a report's office or committee is assigned to, and what Troy texted them about it. Every assignment is an
   * example for now. When nothing was sent, `exampleText` is the exact text Troy would have sent.
   */
  const staffView = (r: Row) => {
    const role = reportRole({ kind: r.kind, routedTo: r.routedTo });
    const contact = staffFor(db, role);
    const log = staffLogFor(db, r.id as number);
    const sent = log.some((l) => !l.example);
    return {
      role,
      roleLabel: role ? roleLabel(role) : null,
      assigned: contact ? { id: contact.id, label: contact.label, handle: maskHandle(contact.handle), isExample: true, reachable: !!contact.user && !contact.user.stopped } : null,
      log: log.filter((l) => !l.example),
      exampleText: sent ? null : exampleTextFor(db, r),
      exampleNote: sent ? null : contact ? "example: nothing was texted for this one" : "example: no one is assigned yet",
    };
  };

  const reportView = (r: Row, users: Map<number, Row>) => {
    const followers = parseJson<unknown[]>(r.followers, []).filter((x): x is number => typeof x === "number");
    const kind = r.kind as ReportKind;
    return {
      id: r.id as number,
      kind,
      anonymous: !!r.anonymous,
      // An anonymous concern never shows who sent it, not even to staff.
      reporterFirstName: r.anonymous ? null : firstName(users.get(r.userId as number)?.name),
      category: str(r.category),
      description: str(r.description),
      locationText: str(r.locationText),
      routedTo: str(r.routedTo),
      status: r.status as string,
      statusOptions: REPORT_STATUSES[kind] ?? [],
      duplicateOf: num(r.duplicateOf),
      followerCount: followers.length,
      hasPhoto: !!resolvePhoto(r.photoUrl),
      isExample: !!r.isExample,
      createdAt: r.createdAt as number,
      staff: staffView(r),
    };
  };

  app.get("/api/reports/:id/staff", (c) => {
    const id = Number(c.req.param("id"));
    const r = Number.isInteger(id) ? (db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as Row | undefined) : undefined;
    if (!r) return c.json({ ok: false, error: "not_found" }, 404);
    return c.json({ ok: true, reportId: id, ...staffView(r) });
  });

  app.get("/api/reports", (c) => {
    const kind = c.req.query("kind") ?? "";
    if (!(kind in REPORT_STATUSES)) return c.json({ ok: false, error: "bad_kind" }, 400);
    const users = userNames();
    const rows = db.prepare("SELECT * FROM reports WHERE kind = ? ORDER BY createdAt DESC, id DESC").all(kind) as Row[];
    const groups = new Map<string, ReturnType<typeof reportView>[]>();
    for (const r of rows) {
      const key = str(r.routedTo) ?? "Not routed yet";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(reportView(r, users));
    }
    return c.json({
      ok: true,
      kind,
      statuses: REPORT_STATUSES[kind as ReportKind],
      total: rows.length,
      groups: [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([routedTo, reports]) => ({ routedTo, reports })),
    });
  });

  app.post("/api/reports/:id/status", async (c) => {
    const id = Number(c.req.param("id"));
    const b = await body(c);
    const status = typeof b.status === "string" ? b.status : "";
    if (!Number.isInteger(id)) return c.json({ ok: false, error: "not_found" }, 404);
    const r = db.prepare("SELECT * FROM reports WHERE id = ?").get(id) as Row | undefined;
    if (!r) return c.json({ ok: false, error: "not_found" }, 404);
    const allowed: readonly string[] = REPORT_STATUSES[r.kind as ReportKind] ?? [];
    if (!allowed.includes(status)) return c.json({ ok: false, error: "bad_status", allowed }, 400);
    if (r.status === status) return c.json({ ok: true, changed: false, status, notified: 0 });

    db.prepare("UPDATE reports SET status = ? WHERE id = ?").run(status, id);
    // Settled from the dashboard: whoever was texted about it holds nothing anymore.
    if (["fixed", "acted_on", "closed"].includes(status)) closeJobsFor(db, id);

    // Every status change is a new text to the reporter and every follower. The copy is fixed, from code.
    let notified = 0;
    let failed = 0;
    const copy = STATUS_COPY[status];
    if (copy) {
      const text = `${reportReference({ kind: r.kind as string, category: r.category, description: r.description, locationText: r.locationText })}: ${copy}`;
      const recipients = new Set<number>([r.userId as number]);
      for (const f of parseJson<unknown[]>(r.followers, [])) if (typeof f === "number" && Number.isInteger(f)) recipients.add(f);
      for (const userId of recipients) {
        try {
          if ((await deps.notify(userId, [text])) !== false) notified++;
        } catch {
          failed++; // one failed text never blocks the others or the saved status
        }
      }
    }
    return c.json({ ok: true, changed: true, status, notified, failed });
  });

  // ----- moderation -----

  app.get("/api/moderation", (c) => {
    const users = userNames();
    const rows = db.prepare("SELECT * FROM food_drops WHERE reports > 0 ORDER BY reports DESC, createdAt DESC").all() as Row[];
    const drops = rows.map((d) => {
      const poster = users.get(d.posterUserId as number);
      return {
        id: d.id as number,
        clubName: str(d.clubName),
        description: str(d.description),
        locationText: str(d.locationText),
        servingsTotal: d.servingsTotal as number,
        servingsLeft: d.servingsLeft as number,
        status: d.status as string,
        reports: d.reports as number,
        isExample: !!d.isExample,
        createdAt: d.createdAt as number,
        poster: { id: d.posterUserId as number, firstName: firstName(poster?.name), bannedFromPosting: !!poster?.bannedFromPosting, isExample: !!poster?.isExample },
      };
    });
    // Topics students created (staff can take one down) and requests Troy couldn't judge, waiting for a person.
    let topics: Row[] = [];
    let topicRequests: Row[] = [];
    try {
      topics = (db.prepare("SELECT id, key, label, plain, suggestedBy, createdAt FROM topics WHERE builtIn = 0 AND status = 'active' ORDER BY id").all() as Row[]).map((t) => ({
        id: t.id as number,
        key: t.key as string,
        label: t.label as string,
        plain: t.plain as string,
        suggestedByFirstName: firstName(users.get(t.suggestedBy as number)?.name),
        createdAt: t.createdAt as number,
      }));
      topicRequests = openTopicRequests(db).map((q) => ({ id: q.id, text: q.text, requesterFirstName: firstName(users.get(q.userId)?.name), createdAt: q.createdAt }));
    } catch {
      // The topic tables belong to another module; a database without them just has nothing to moderate.
    }
    return c.json({ ok: true, drops, topics, topicRequests });
  });

  app.post("/api/moderation/topics/:id/remove", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ ok: false, error: "not_found" }, 404);
    try {
      const row = db.prepare("SELECT builtIn, status FROM topics WHERE id = ?").get(id) as Row | undefined;
      if (!row) return c.json({ ok: false, error: "not_found" }, 404);
      // The built-in topics are the poll itself and can't be taken down here.
      if (row.builtIn) return c.json({ ok: false, error: "built_in" }, 400);
      removeTopic(db, id);
      return c.json({ ok: true, id, removed: row.status === "active" });
    } catch {
      return c.json({ ok: false, error: "not_found" }, 404);
    }
  });

  const topicRequest = (idRaw: string): Row | null => {
    const id = Number(idRaw);
    if (!Number.isInteger(id)) return null;
    try {
      return (db.prepare("SELECT * FROM topic_requests WHERE id = ?").get(id) as Row | undefined) ?? null;
    } catch {
      return null;
    }
  };

  app.post("/api/moderation/topic-requests/:id/approve", async (c) => {
    const req = topicRequest(c.req.param("id"));
    if (!req) return c.json({ ok: false, error: "not_found" }, 404);
    if (req.status !== "open") return c.json({ ok: true, changed: false, status: req.status as string });
    const b = await body(c);
    // Staff may tidy the name; otherwise it is the student's own wording.
    const name = str(b.name) ?? (req.text as string);
    const topic = createTopic(db, name, req.userId as number);
    db.prepare("UPDATE topic_requests SET status = 'created' WHERE id = ?").run(req.id as number);
    subscribe(db, req.userId as number, topic.id);
    // Troy told them he'd text when something came of it. Quiet hours hold it back (the outbox), STOP drops it.
    let notified = false;
    try {
      notified = (await deps.notify(req.userId as number, [`good news, "${topic.label}" is a topic now and ur on it. i'll text u ${topic.plain}`])) !== false;
    } catch {
      notified = false;
    }
    return c.json({ ok: true, changed: true, status: "created", topic: { id: topic.id, key: topic.key, label: topic.label }, notified });
  });

  app.post("/api/moderation/topic-requests/:id/dismiss", (c) => {
    const req = topicRequest(c.req.param("id"));
    if (!req) return c.json({ ok: false, error: "not_found" }, 404);
    if (req.status !== "open") return c.json({ ok: true, changed: false, status: req.status as string });
    db.prepare("UPDATE topic_requests SET status = 'declined' WHERE id = ?").run(req.id as number);
    return c.json({ ok: true, changed: true, status: "declined" });
  });

  app.post("/api/moderation/ban", async (c) => {
    const b = await body(c);
    const userId = Number(b.userId);
    if (!Number.isInteger(userId) || typeof b.banned !== "boolean") return c.json({ ok: false, error: "bad_request" }, 400);
    const res = db.prepare("UPDATE users SET bannedFromPosting = ? WHERE id = ?").run(b.banned ? 1 : 0, userId);
    if (!res.changes) return c.json({ ok: false, error: "not_found" }, 404);
    return c.json({ ok: true, userId, banned: b.banned });
  });

  // ----- settings -----

  const settingsView = () => {
    const stored = getSetting(db, "troy_enabled");
    const envRaw = process.env.TROY_ENABLED;
    const envSet = envRaw !== undefined;
    // isEnabled is the single source of truth; this only explains why.
    const enabled = isEnabled(db);
    const settingOn = stored === null ? true : ["true", "1", "on", "yes"].includes(stored.trim().toLowerCase());
    const envOff = envSet && !["true", "1", "on", "yes"].includes(envRaw.trim().toLowerCase());
    // The demo sign-up switch and cap: { open, max, count }. count is chats let in by "hey troy" only.
    return { enabled, settingOn, envSet, envOff, signups: signupsView(db) };
  };

  const allowListView = () => {
    const rows = db.prepare("SELECT id, handle, chatId, reason, addedAt FROM allow_list ORDER BY addedAt DESC, id DESC").all() as Row[];
    return {
      entries: rows.map((r) => ({
        id: r.id as number,
        handle: maskHandle(str(r.handle)),
        isGroup: r.handle === null,
        reason: r.reason as string,
        removable: r.reason === "manual",
        addedAt: r.addedAt as number,
      })),
      // The env list can only be changed in .env; shown masked so staff know it exists.
      envEntries: config.allowedHandles.map((h) => ({ handle: maskHandle(h) })),
    };
  };

  app.get("/api/settings", (c) => c.json({ ok: true, ...settingsView(), provider: config.provider, allowList: allowListView() }));

  app.post("/api/settings/enabled", async (c) => {
    const b = await body(c);
    if (typeof b.enabled !== "boolean") return c.json({ ok: false, error: "bad_request" }, 400);
    setSetting(db, "troy_enabled", b.enabled ? "true" : "false");
    return c.json({ ok: true, ...settingsView() });
  });

  app.post("/api/settings/signups", async (c) => {
    const b = await body(c);
    if (typeof b.open !== "boolean") return c.json({ ok: false, error: "bad_request" }, 400);
    setSignupsOpen(db, b.open);
    return c.json({ ok: true, ...settingsView() });
  });

  // The page sends what its -10 / +10 buttons produce; anything out of range is clamped to 0..500.
  app.post("/api/settings/cap", async (c) => {
    const b = await body(c);
    if (typeof b.max !== "number" || !Number.isFinite(b.max)) return c.json({ ok: false, error: "bad_request" }, 400);
    const max = setSignupCap(db, b.max);
    return c.json({ ok: true, max, ...settingsView() });
  });

  app.get("/api/settings/allow-list", (c) => c.json({ ok: true, ...allowListView() }));

  app.post("/api/settings/allow-list", async (c) => {
    const b = await body(c);
    const handle = normalizeHandle(b.handle);
    if (!handle) return c.json({ ok: false, error: "bad_handle" }, 400);
    // UNIQUE (handle, chatId) does not catch a null chatId in SQLite, so check first.
    const exists = db.prepare("SELECT id FROM allow_list WHERE handle = ? AND chatId IS NULL AND reason = 'manual' LIMIT 1").get(handle) as Row | undefined;
    if (!exists) db.prepare("INSERT INTO allow_list (handle, chatId, reason, addedAt) VALUES (?, NULL, 'manual', ?)").run(handle, Date.now());
    return c.json({ ok: true, added: !exists, handle: maskHandle(handle), ...allowListView() });
  });

  const removeManual = async (c: Context) => {
    const b = await body(c);
    const idRaw = c.req.param("id") ?? b.id;
    let removed = 0;
    if (idRaw !== undefined && idRaw !== null && idRaw !== "") {
      const id = Number(idRaw);
      if (!Number.isInteger(id)) return c.json({ ok: false, error: "bad_request" }, 400);
      removed = Number(db.prepare("DELETE FROM allow_list WHERE id = ? AND reason = 'manual'").run(id).changes);
    } else {
      const handle = normalizeHandle(b.handle ?? c.req.query("handle"));
      if (!handle) return c.json({ ok: false, error: "bad_handle" }, 400);
      removed = Number(db.prepare("DELETE FROM allow_list WHERE handle = ? AND reason = 'manual'").run(handle).changes);
    }
    return c.json({ ok: true, removed, ...allowListView() });
  };
  app.delete("/api/settings/allow-list", removeManual);
  app.delete("/api/settings/allow-list/:id", removeManual);

  // ----- people: who a report's office or committee is assigned to (all examples for now) -----

  const staffListView = () => {
    const labels = new Map(staffRoles(db).map((r) => [r.role, r.label]));
    return {
      roles: staffRoles(db),
      contacts: listStaff(db).map((s) => {
        const live = staffFor(db, s.role);
        return {
          id: s.id,
          role: s.role,
          roleLabel: labels.get(s.role) ?? roleLabel(s.role),
          kind: s.role.startsWith("usg:") ? "usg" : "repair",
          handle: maskHandle(s.handle),
          label: s.label,
          isExample: true,
          // False until this phone has texted troy: there is no chat to send to yet.
          reachable: !!live?.user && !live.user.stopped,
          createdAt: s.createdAt,
        };
      }),
    };
  };

  app.get("/api/staff", (c) => c.json({ ok: true, ...staffListView() }));

  app.post("/api/staff", async (c) => {
    const b = await body(c);
    const res = assignStaff(db, { role: b.role, handle: b.handle, label: b.label });
    if (!res.ok) return c.json({ ok: false, error: res.error }, 400);
    return c.json({ ok: true, assigned: { id: res.contact.id, role: res.contact.role, handle: maskHandle(res.contact.handle), label: res.contact.label, isExample: true }, addedToAllowList: res.addedToAllowList, ...staffListView() });
  });

  app.delete("/api/staff/:id", (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return c.json({ ok: false, error: "bad_request" }, 400);
    const removed = removeStaff(db, id);
    return c.json({ ok: true, removed, ...staffListView() });
  });

  // ----- directory -----

  app.get("/api/directory", (c) => {
    const rows = db.prepare("SELECT * FROM directory ORDER BY kind, name").all() as Row[];
    return c.json({
      ok: true,
      entries: rows.map((r) => ({
        id: r.id as number,
        kind: r.kind as string,
        name: r.name as string,
        topics: parseJson<unknown[]>(r.topics, []).filter((x): x is string => typeof x === "string"),
        contactMethod: str(r.contactMethod),
        url: str(r.url),
        details: str(r.details),
        isExample: !!r.isExample,
      })),
    });
  });

  return app;
}
