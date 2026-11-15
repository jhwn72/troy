// Local preview of the web simulator, without Vercel: serves public/ and mounts the same handler the
// serverless function uses at /api/sim. For preview and tests only.
// Run: npm run sim            (node --env-file=.env scripts/sim-dev.ts, port 3220)
//      PORT=3221 npm run sim
// It talks to the Claude API with ANTHROPIC_API_KEY from .env and to nothing else: no Troy server, no database.

import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createSimHandler } from "../simulator/api/_handler.js";
import { simData } from "./build-sim.ts";

const port = Number(process.env.PORT) || 3220;
const app = new Hono();
// The prompt is rebuilt per request here, so an edit to brain/ shows up without a restart. The handler (and its
// in-memory rate counts) is only made again when the prompt actually changed.
let made: { system: string; handle: (r: Request) => Promise<Response> } | null = null;
app.all("/api/sim", (c) => {
  const data = simData();
  if (!made || made.system !== data.system) made = { system: data.system, handle: createSimHandler({ data }) };
  return made.handle(c.req.raw);
});
app.use("/*", serveStatic({ root: join(import.meta.dirname, "..", "public") }));

// Loopback only, on both families, like the main server.
for (const hostname of ["::1", "127.0.0.1"]) serve({ fetch: app.fetch, port, hostname });
console.log(`simulator: http://localhost:${port}/simulator.html`);
