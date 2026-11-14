// Flow registry. Each flow file exports a FlowHandler; register it here (or call registerFlow at startup).

import type { FlowHandler, FlowName } from "../types.ts";
import { smalltalk } from "./smalltalk.ts";

const flows = new Map<FlowName, FlowHandler>();

export function registerFlow(h: FlowHandler): void {
  flows.set(h.name, h);
}

export function getFlow(name: FlowName): FlowHandler | null {
  return flows.get(name) ?? null;
}

registerFlow(smalltalk);
