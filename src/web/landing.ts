// Landing page routes: the "Text Troy" link and its QR code.
// The number comes from TROY_NUMBER (E.164). It is read on every request so it can be set without a code change.
import { Hono } from "hono";
import QRCode from "qrcode";

const OPT_IN_BODY = "hey troy";

/** TROY_NUMBER as E.164 ("+1XXXXXXXXXX"), or null when it is unset or not a phone number. */
export function troyNumber(raw: string | undefined = process.env.TROY_NUMBER): string | null {
  if (!raw) return null;
  const s = raw.trim();
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** sms:+1XXXXXXXXXX&body=hey%20troy */
export function smsLink(number: string): string {
  return `sms:${number}&body=${encodeURIComponent(OPT_IN_BODY)}`;
}

export function createLandingRoutes(): Hono {
  const app = new Hono();

  app.get("/api/landing", (c) => {
    const number = troyNumber();
    c.header("Cache-Control", "no-store");
    return c.json({ smsLink: number ? smsLink(number) : null, number });
  });

  app.get("/qr.svg", async (c) => {
    const number = troyNumber();
    if (!number) return c.text("number coming soon", 404);
    const svg = await QRCode.toString(smsLink(number), {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      color: { dark: "#1C1917", light: "#FFFFFF" },
    });
    return c.body(svg, 200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "no-store" });
  });

  return app;
}
