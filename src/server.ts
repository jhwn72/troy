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

const db = getDb();
// Go-live is fixed the first time Troy ever starts (and kept after that), never by the first incoming text.
getGoLiveAt(db);

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
