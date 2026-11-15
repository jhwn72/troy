// Sends the USC verification code. Never throws.

import { Resend } from "resend";
import { config } from "./config.ts";

/**
 * How a send went, so the reply can fit what happened:
 * - "sent": handed to the provider (or logged to the console in development with no key).
 * - "no_key": no email provider is set up on this server. Trying again won't help until it is.
 * - "rejected": the provider answered and said no (a bad address, a sending domain that isn't verified, a limit).
 * - "error": the provider couldn't be reached or the call blew up. Trying again in a minute may work.
 */
export type EmailSendResult = "sent" | "no_key" | "rejected" | "error";

type ProviderError = { name?: unknown; statusCode?: unknown } | null | undefined;
type SendFn = (message: { from: string; to: string; subject: string; text: string }) => Promise<{ error?: ProviderError }>;

/** Test hooks. Defaults: the real provider, the key and sender from config, development unless NODE_ENV is production. */
export type EmailDeps = { send?: SendFn; key?: string; dev?: boolean; log?: (line: string) => void };

function mask(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain ?? ""}`;
}

/** Letters, digits and underscores only, so an error name can never carry an address or a code into the log. */
function safeName(value: unknown): string {
  const name = typeof value === "string" ? value : "";
  return /^[A-Za-z][A-Za-z_]{0,48}$/.test(name) ? name : "unknown";
}

/** The provider's own subject and body. Plain and specific: the sending domain is new, so anything fancy lands in spam. */
function codeMessage(to: string, code: string) {
  return {
    from: config.emailFrom,
    to,
    subject: `${code} is your Troy code`,
    text: [
      `Your Troy verification code is ${code}.`,
      "",
      "Text this code back to Troy in iMessage to confirm your USC email. It expires in 15 minutes.",
      "",
      "If you didn't text Troy, ignore this email and nothing happens.",
      "",
      "Troy is a student project built at the AI@USC Hackathon. It is not an official USC service.",
    ].join("\n"),
  };
}

/**
 * Sends the code and says how it went. A failure logs one line with the reason and the provider's error name
 * (and status when it gave one), never the address and never the code.
 */
export async function sendVerificationEmail(to: string, code: string, deps: EmailDeps = {}): Promise<EmailSendResult> {
  const dev = deps.dev ?? process.env.NODE_ENV !== "production";
  const key = deps.key ?? config.resendKey;
  const log = deps.log ?? ((line: string) => console.error(line));
  // So development works without a Resend key.
  if (dev) console.log(`verification code for ${mask(to)}: ${code}`);
  if (!key && !deps.send) {
    if (dev) return "sent";
    log("verification email failed: no_key (RESEND_API_KEY is not set)");
    return "no_key";
  }
  try {
    const send: SendFn = deps.send ?? ((message) => new Resend(key).emails.send(message));
    const { error } = await send(codeMessage(to, code));
    if (error) {
      const status = typeof error.statusCode === "number" ? ` status=${error.statusCode}` : "";
      log(`verification email failed: rejected name=${safeName(error.name)}${status}`);
      return "rejected";
    }
    return "sent";
  } catch (err) {
    log(`verification email failed: error name=${safeName(err instanceof Error ? err.name : "")}`);
    return "error";
  }
}
