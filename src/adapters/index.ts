// Picks the messaging provider. Nothing outside src/adapters knows which one is in use.

import type { DatabaseSync } from "node:sqlite";
import type { Hono } from "hono";
import type { IncomingEvent, MessagingAdapter } from "../types.ts";
import { config } from "../config.ts";
import { createWebchatAdapter } from "./webchat.ts";

export type AdapterDeps = {
  db: DatabaseSync;
  /** Called once per gated incoming event. */
  onEvent: (e: IncomingEvent) => Promise<void>;
};

export async function createAdapter(deps: AdapterDeps): Promise<{ adapter: MessagingAdapter; routes: Hono }> {
  switch (config.provider) {
    case "webchat":
      return createWebchatAdapter(deps);
    case "bluebubbles": {
      // Loaded lazily so webchat mode never touches the BlueBubbles code.
      const { createBluebubblesAdapter } = await import("./bluebubbles.ts");
      return createBluebubblesAdapter(deps);
    }
    case "linq":
      throw new Error("MESSAGING_PROVIDER=linq is not built. Use webchat or bluebubbles.");
    default:
      throw new Error(`Unknown MESSAGING_PROVIDER "${config.provider}". Use webchat or bluebubbles.`);
  }
}
