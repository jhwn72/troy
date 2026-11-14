// Sends the USC verification code. Never throws.

import { Resend } from "resend";
import { config } from "./config.ts";

function mask(email: string): string {
  const [local, domain] = email.split("@");
  return `${local.slice(0, 1)}***@${domain ?? ""}`;
}

/** True when the code was handed to Resend, or logged to the console in development with no key. */
export async function sendVerificationEmail(to: string, code: string): Promise<boolean> {
  const dev = process.env.NODE_ENV !== "production";
  // So development works without a Resend key.
  if (dev) console.log(`verification code for ${mask(to)}: ${code}`);
  if (!config.resendKey) return dev;
  try {
    const { error } = await new Resend(config.resendKey).emails.send({
      from: config.emailFrom,
      to,
      subject: `${code} is your Troy code`,
      // Plain and specific: the sending domain is new, so anything fancy lands in spam.
      text: [
        `Your Troy verification code is ${code}.`,
        "",
        "Text this code back to Troy in iMessage to confirm your USC email. It expires in 15 minutes.",
        "",
        "If you didn't text Troy, ignore this email and nothing happens.",
        "",
        "Troy is a student project built at the AI@USC Hackathon. It is not an official USC service.",
      ].join("\n"),
    });
    if (error) {
      console.error("verification email failed");
      return false;
    }
    return true;
  } catch {
    console.error("verification email failed");
    return false;
  }
}
