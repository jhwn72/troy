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
