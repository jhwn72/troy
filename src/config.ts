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
  // A leading plus means the country code is already there. Never put a US "1" in front of it:
  // "+65 9123 4567" (Singapore) is a different person from "+1 659 123 4567".
  if (s.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

const env = process.env;

export const config = {
  port: Number(env.PORT || 3000),
  appUrl: env.APP_URL || `http://localhost:${env.PORT || 3000}`,
  provider: (env.MESSAGING_PROVIDER || "webchat") as Provider,
  bluebubblesUrl: (env.BLUEBUBBLES_URL || "http://localhost:1234").replace(/\/$/, ""),
  bluebubblesPassword: env.BLUEBUBBLES_PASSWORD || "",
  /** Optional. When set, the webhook only answers at /webhooks/bluebubbles/<secret>. */
  webhookSecret: env.BLUEBUBBLES_WEBHOOK_SECRET || "",
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

/** Which model free chat uses. TROY_CHAT_MODEL = "smart" (default) or "fast". Read on every call so it can change without a restart. */
export function chatModelSetting(): "fast" | "smart" {
  return (process.env.TROY_CHAT_MODEL || "").trim().toLowerCase() === "fast" ? "fast" : "smart";
}

/** How Troy explains his own workings. TROY_EXPLAIN = "detailed" (default, the hackathon setting) or "generic" (a real campus launch). */
export function explainMode(): "detailed" | "generic" {
  return (process.env.TROY_EXPLAIN || "").trim().toLowerCase() === "generic" ? "generic" : "detailed";
}

/** Quick web lookup for campus facts the directory can't answer. Off unless TROY_LOOKUP is exactly "on". */
export function lookupOn(): boolean {
  return (process.env.TROY_LOOKUP || "").trim().toLowerCase() === "on";
}

const ON_WORDS = ["true", "1", "on", "yes"];

/** Fail closed: a switch that is set to anything other than a clear "on" word counts as off. Unset means on. */
function switchOn(value: string | null | undefined): boolean {
  if (value === undefined || value === null) return true;
  return ON_WORDS.includes(value.trim().toLowerCase());
}

/** Kill switch. Off when TROY_ENABLED in the environment or the dashboard toggle (troy_enabled) is set to anything but true/1/on/yes. */
export function isEnabled(db: DatabaseSync): boolean {
  if (!switchOn(process.env.TROY_ENABLED)) return false;
  return switchOn(getSetting(db, "troy_enabled"));
}

/** Scripted demo mode (src/demo-script.ts): TROY_DEMO_SCRIPT is exactly "on". Read on every call. */
export function demoScriptOn(): boolean {
  return (process.env.TROY_DEMO_SCRIPT || "").trim().toLowerCase() === "on";
}

/** The demo script is on and this handle is listed in TROY_DEMO_HANDLES (comma separated). */
export function isDemoHandle(handle: string | null | undefined): boolean {
  if (!demoScriptOn() || !handle) return false;
  const h = normalizeHandle(handle);
  if (!h) return false;
  return (process.env.TROY_DEMO_HANDLES || "").split(",").map(normalizeHandle).includes(h);
}
