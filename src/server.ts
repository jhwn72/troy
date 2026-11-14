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
import { getUserById, saveMessage } from "./db/index.ts";
import { seed } from "./db/seed.ts";
import { createLandingRoutes } from "./web/landing.ts";
import { createWebRoutes } from "./web/api.ts";

const db = getDb();
// Go-live is fixed the first time Troy ever starts (and kept after that), never by the first incoming text.
getGoLiveAt(db);
// Labeled example data for demos. Adds only what is missing.
if (process.env.SEED_EXAMPLES === "true") seed(db);

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

/** Dashboard status updates go to the person's own 1:1 chat. Stopped users get nothing; the adapter enforces the gate and kill switch. */
async function notify(userId: number, bubbles: string[]): Promise<boolean> {
  if (!adapter || !isEnabled(db)) return false;
  let delivered = false;
  for (const text of bubbles) {
    const user = getUserById(db, userId);
    if (!user || user.stopped) break;
    const sent = await adapter.sendMessage(user.chatId, text);
    if (!sent) continue;
    delivered = true;
    saveMessage(db, { userId: user.id, chatId: user.chatId, direction: "out", providerMessageId: sent.messageId, text });
  }
  return delivered;
}
app.route("/", createLandingRoutes());
app.route("/", createWebRoutes({ db, getAdapter: () => adapter!, notify }));
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
    for (const s of servers) s.close();
    process.exit(0);
  });
}
