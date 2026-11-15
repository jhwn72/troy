// Server entry: db, pipeline, the chosen messaging adapter, static pages.
// Run: npm run dev

import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { MessagingAdapter } from "./types.ts";
import { config, isEnabled } from "./config.ts";
import { getDb } from "./db/index.ts";
import { createAdapter } from "./adapters/index.ts";
import { createPipeline, describe } from "./pipeline.ts";
import { getGoLiveAt } from "./adapters/gate.ts";
import { seed, seedMatches } from "./db/seed.ts";
import { createNotifier } from "./outbox.ts";
import { startFoodTimers } from "./flows/food.ts";
import { completeHandoff } from "./flows/lostfound/handler.ts";
import { createLandingRoutes } from "./web/landing.ts";
import { createWebRoutes } from "./web/api.ts";
import { createLocationRefresher, ensureLocationColumns } from "./location.ts";
import { setStaffNotifier } from "./staff.ts";

const db = getDb();
// Go-live is fixed the first time Troy ever starts (and kept after that), never by the first incoming text.
getGoLiveAt(db);
// The "forget my location" columns, for a database file made before they existed.
ensureLocationColumns(db);
// Labeled example data for demos. Adds only what is missing.
if (process.env.SEED_EXAMPLES === "true") {
  seed(db);
  // Candidate matches between the example listings, from the rule score only (no AI call). Safe to repeat.
  await seedMatches(db);
}

let adapter: MessagingAdapter | null = null;
const pipeline = createPipeline({
  db,
  getAdapter: () => {
    if (!adapter) throw new Error("adapter not ready");
    return adapter;
  },
});

const created = await createAdapter({ db, onEvent: pipeline.handleEvent });
adapter = created.adapter;

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true, provider: config.provider, enabled: isEnabled(db) }));
app.route("/", created.routes);

// Texts Troy starts on his own from the dashboard (status updates, a completed DPS pickup) go to the person's
// own 1:1 chat. Stopped users get nothing. Someone paused or inside their quiet hours gets a status update when
// that ends (src/outbox.ts). The adapter enforces the gate and kill switch.
const { notify, flush: flushOutbox } = createNotifier({ db, getAdapter: () => adapter, enabled: () => isEnabled(db) });
// Texts to an assigned technician or usg member, and the status texts their answers send to students, use the same
// outbox: quiet hours and pause hold them back instead of dropping them.
setStaffNotifier(db, notify);

// Flow 2: holds that ran out go back to the pool and old drops end, every 30 seconds.
const stopFoodTimers = startFoodTimers({ db, getAdapter: () => adapter! });
// Flow 1 and the queues: stale claims are released, parked questions go to whoever is free, and texts held
// for quiet hours go out once they end. Same 30 second beat as the food sweep.
let sweeping = false;
const sweepTimer = setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    await pipeline.sweep();
    await flushOutbox();
  } catch (err) {
    console.error("sweep failed:", describe(err));
  } finally {
    sweeping = false;
  }
}, 30_000);
sweepTimer.unref();
// One sweep right away, so anything that learns how to send from its first sweep (the first-ten follow-ups) has it
// before the first 30 second beat.
void pipeline.sweep().catch((err) => console.error("sweep failed:", describe(err)));

// The first-ten scheduler and topic expiry run inside pipeline.sweep above. If either module also exports its own
// starter, it is called once here; a module or export that isn't there is simply skipped.
const stopExtras: (() => void)[] = [];
for (const [path, names] of [
  ["./firstten.ts", ["startFirstTen", "startFirstTenTimers", "startFirstTenSweep"]],
  ["./flows/topics.ts", ["startTopicTimers", "startTopicSweep", "startTopics"]],
] as const) {
  try {
    const mod = (await import(path)) as Record<string, unknown>;
    const name = names.find((n) => typeof mod[n] === "function");
    if (!name) continue;
    const stop = (mod[name] as (d: { db: typeof db; getAdapter: () => MessagingAdapter | null; notify: typeof notify }) => unknown)({ db, getAdapter: () => adapter, notify });
    if (typeof stop === "function") stopExtras.push(stop as () => void);
  } catch (err) {
    console.error("optional sweep not started:", describe(err));
  }
}

// Saved locations stay current while someone shares through Find My: every 45 seconds, a few students at a time.
// Real phones: only with the patched helper connected (it is what reads Find My). The simulator always can.
// Nobody who said "forget my location" is looked up, and nothing here logs a place or a handle.
const helperConnected = () => (adapter as (MessagingAdapter & { helperConnected?: () => boolean }) | null)?.helperConnected?.() === true;
const locationRefresh = createLocationRefresher({
  db,
  getAdapter: () => adapter,
  ready: () => config.provider === "webchat" || (config.provider === "bluebubbles" && helperConnected()),
});
// TROY_LOCATION_REFRESH=off stops the 45 second background reads (each one can bring the Find My app forward on the Mac).
if ((config.provider === "webchat" || config.provider === "bluebubbles") && process.env.TROY_LOCATION_REFRESH !== "off") locationRefresh.start();

app.route("/", createLandingRoutes());
app.route("/", createWebRoutes({ db, getAdapter: () => adapter!, notify, completeHandoff: (handoffId) => completeHandoff({ db, notify: (userId, bubbles) => notify(userId, bubbles, { owed: true }) }, handoffId) }));
app.use("/*", serveStatic({ root: join(import.meta.dirname, "..", "public") }));
app.onError((err, c) => {
  console.error("request error:", describe(err));
  return c.json({ ok: false }, 500);
});

// Loopback only, on both addresses: BlueBubbles resolves "localhost" to IPv6 ::1, browsers often use 127.0.0.1.
// Nothing is exposed to the network.
const servers = ["::1", "127.0.0.1"].map((hostname) => serve({ fetch: app.fetch, port: config.port, hostname }));
for (const s of servers) {
  s.on("error", (err) => {
    // Usually the port is taken. Better to stop than to run half-bound.
    console.error("server error:", (err as NodeJS.ErrnoException).code ?? "unknown");
    process.exit(1);
  });
}
console.log(`troy listening on http://localhost:${config.port} (::1 and 127.0.0.1), provider ${config.provider}`);
console.log(isEnabled(db) ? "troy is ENABLED" : "troy is DISABLED (kill switch): nothing is processed or sent");
if (config.provider === "bluebubbles" && !config.webhookSecret) {
  console.log("note: BLUEBUBBLES_WEBHOOK_SECRET is not set, so the webhook accepts any local JSON post");
}

// One bad message or request never takes the process down. No message text or handles here.
process.on("unhandledRejection", (err) => console.error("unhandled rejection:", describe(err)));
process.on("uncaughtException", (err) => console.error("uncaught exception:", describe(err)));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopFoodTimers();
    clearInterval(sweepTimer);
    for (const stop of stopExtras) {
      try {
        stop();
      } catch {
        /* shutting down anyway */
      }
    }
    locationRefresh.stop();
    // BlueBubbles mode with a helper token: closes the helper listener. Nothing to do otherwise.
    try {
      created.stop?.();
    } catch {
      /* shutting down anyway */
    }
    for (const s of servers) s.close();
    process.exit(0);
  });
}
