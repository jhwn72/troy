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

export interface WebDeps {
  db: DatabaseSync;
  getAdapter: () => MessagingAdapter;
  notify: (userId: number, bubbles: string[]) => Promise<void>;
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

/** One line a status text can use to say which report it is about. Built from stored fields, all lowercase. */
export function reportReference(report: { kind: string; category: unknown; description: unknown; locationText: unknown }): string {
  const clean = (v: unknown) => (str(v) ?? "").replace(/\s+/g, " ").replace(/—|–/g, "-").trim().toLowerCase();
  let what = clean(report.description) || clean(report.category);
  if (what.length > 60) what = `${what.slice(0, 57).trimEnd()}...`;
  const where = clean(report.locationText);
  if (report.kind === "repair") {
    if (what && where) return `update on "${what}" at ${where}`;
    if (what) return `update on "${what}"`;
    return where ? `update on the repair report at ${where}` : "update on the repair report";
  }
  return what ? `update on the usg concern "${what}"` : "update on the usg concern";
}

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
    return (await mod.latestEval()) ?? null;
  } catch {
    return null;
  }
}

// ---------- routes ----------

export function createWebRoutes(deps: WebDeps): Hono {
  const { db } = deps;
  const app = new Hono();

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

    const matchRows = db.prepare("SELECT * FROM matches ORDER BY createdAt DESC, id DESC LIMIT 40").all() as Row[];
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
      const now = Date.now();
      db.prepare("UPDATE handoffs SET completedAt = ? WHERE id = ?").run(now, id);
      const match = db.prepare("SELECT foundListingId, lostListingId FROM matches WHERE id = ?").get(h.matchId as number) as Row | undefined;
      if (match) db.prepare("UPDATE listings SET status = 'returned' WHERE id IN (?, ?)").run(match.foundListingId as number, match.lostListingId as number);
    }
    const fresh = db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as Row;
    return c.json({ ok: true, alreadyCompleted: h.completedAt !== null, handoff: handoffView(fresh) });
  });

  // ----- reports (repairs and USG concerns) -----

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
    };
  };

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
          await deps.notify(userId, [text]);
          notified++;
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
    return c.json({ ok: true, drops });
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
    return { enabled, settingOn, envSet, envOff };
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
