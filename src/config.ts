import type { DatabaseSync } from "node:sqlite";
import type { Handle, Provider } from "./types.ts";
import { getSetting } from "./db/index.ts";

/**
 * Normalize a handle: emails lowercased, US phone numbers to E.164 ("+1XXXXXXXXXX").
 * Returns null for anything that isn't an email or a phone number.
 */
export function normalizeHandle(raw: unknown): Handle | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("@")) return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 11 && digits.length <= 15 && s.startsWith("+")) return `+${digits}`;
  return null;
}

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  appUrl: env.APP_URL || `http://localhost:${env.PORT || 3000}`,
  provider: (env.MESSAGING_PROVIDER || "webchat") as Provider,
  bluebubblesUrl: (env.BLUEBUBBLES_URL || "http://localhost:1234").replace(/\/$/, ""),
  bluebubblesPassword: env.BLUEBUBBLES_PASSWORD || "",
  /** The manual allow-list from the environment, normalized. */
  allowedHandles: (env.ALLOWED_HANDLES || "")
    .split(",")
    .map(normalizeHandle)
    .filter((h): h is Handle => h !== null),
  anthropicKey: env.ANTHROPIC_API_KEY || "",
  resendKey: env.RESEND_API_KEY || "",
  emailFrom: env.EMAIL_FROM || "Troy <troy@troy.johncwang.me>",
  models: { smart: "claude-sonnet-5-5", fast: "claude-haiku-5-5" },
};

/** Kill switch. False when TROY_ENABLED=false in the environment or the dashboard toggle is off. */
export function isEnabled(db: DatabaseSync): boolean {
  if ((env.TROY_ENABLED || "true").toLowerCase() === "false") return false;
  return getSetting(db, "troy_enabled") !== "false";
}
