// Flow registry. Each flow file exports a FlowHandler; register it here (or call registerFlow at startup).

import type { FlowHandler, FlowName } from "../types.ts";
import { smalltalk } from "./smalltalk.ts";
import { lostFound } from "./lostfound/handler.ts";
import { food } from "./food.ts";
import { repair } from "./repair.ts";
import { usg } from "./usg.ts";
import { notes } from "./notes.ts";

const flows = new Map<FlowName, FlowHandler>();

export function registerFlow(h: FlowHandler): void {
  flows.set(h.name, h);
}

export function getFlow(name: FlowName): FlowHandler | null {
  return flows.get(name) ?? null;
}

// Flow files must not import this file at load time (they load it inside their handlers), or the list below
// would run before they finish loading.
for (const h of [smalltalk, lostFound, food, repair, usg, notes]) registerFlow(h);

// Newer flows are loaded by path, so a file that isn't there yet (or doesn't load) never takes the others down with
// it. Whatever FlowHandler the file exports is registered under its own name.
const OPTIONAL = ["./topics.ts", "./rides.ts", "./tour.ts"];

function isHandler(v: unknown): v is FlowHandler {
  return !!v && typeof v === "object" && typeof (v as FlowHandler).name === "string" && typeof (v as FlowHandler).handle === "function";
}

for (const file of OPTIONAL) {
  try {
    const mod = (await import(new URL(file, import.meta.url).href)) as Record<string, unknown>;
    for (const h of Object.values(mod)) if (isHandler(h) && !flows.has(h.name)) registerFlow(h);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    // A missing file is expected while a flow is still being built. Anything else is worth one line (never the message).
    if (code !== "ERR_MODULE_NOT_FOUND") console.error(`flow not loaded: ${file} (${err instanceof Error ? err.name : "error"})`);
  }
}
