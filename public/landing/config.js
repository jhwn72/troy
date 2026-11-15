// Troy landing: the one place the phone number is read.
//
// Where the number comes from, in order:
//   1. <meta name="troy-number" content="+1XXXXXXXXXX">  (baked in by the build)
//   2. <meta name="troy-sms" content="sms:+1XXXXXXXXXX">  (same number, as a link)
//   3. GET api/landing  (the local Troy server reads TROY_NUMBER)
// With no number anywhere, every Text Troy button is disabled and says "number coming soon".
//
// Every <a data-sms="message body"> becomes an sms: link with that body filled in.

const OFF_LABEL = "number coming soon";

let numberPromise = null;

function meta(name) {
  const el = document.querySelector(`meta[name="${name}"]`);
  return el ? (el.getAttribute("content") || "").trim() : "";
}

/** "+1XXXXXXXXXX" from loose input, or null when it is not a phone number. */
function cleanNumber(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/^sms:/i, "").split(/[&?;]/)[0];
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Troy's number as E.164, or null. Asked for once per page load. */
export function getNumber() {
  if (!numberPromise) {
    numberPromise = (async () => {
      const baked = cleanNumber(meta("troy-number")) || cleanNumber(meta("troy-sms"));
      if (baked) return baked;
      try {
        const res = await fetch("api/landing", { headers: { Accept: "application/json" } });
        if (!res.ok) return null;
        const data = await res.json();
        return cleanNumber(data && data.number) || cleanNumber(data && data.smsLink);
      } catch {
        return null;
      }
    })();
  }
  return numberPromise;
}

/** sms:+1XXXXXXXXXX?&body=hey%20troy, or null when there is no number. */
export async function getSms(body = "hey troy") {
  const number = await getNumber();
  return number ? `sms:${number}?&body=${encodeURIComponent(body)}` : null;
}

/** Points every a[data-sms] at Messages, or disables it when there is no number. */
export async function wireSmsLinks(root = document) {
  const links = Array.from(root.querySelectorAll("a[data-sms]"));
  await Promise.all(
    links.map(async (a) => {
      if (!a.dataset.label) a.dataset.label = a.textContent.trim();
      const href = await getSms(a.dataset.sms || "hey troy");
      if (href) {
        a.setAttribute("href", href);
        a.removeAttribute("aria-disabled");
        a.textContent = a.dataset.label;
      } else {
        a.removeAttribute("href");
        a.setAttribute("aria-disabled", "true");
        a.textContent = OFF_LABEL;
      }
    }),
  );
}

/** The QR is a file next to the page (qr.svg). When it is missing, hide it instead of showing a broken image. */
function watchQr() {
  const qr = document.getElementById("qr");
  if (!qr) return;
  const hide = () => {
    qr.hidden = true;
  };
  if (qr.complete && qr.naturalWidth === 0) hide();
  qr.addEventListener("error", hide);
}

function start() {
  watchQr();
  wireSmsLinks();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();

// Apple devices can text Troy today, so they don't need the "coming to non-Apple devices" line.
// Everyone else keeps it. Detection is by platform; iPads report as Mac, which is fine here.
(() => {
  try {
    const ua = navigator.userAgent || '';
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    const apple = /iPhone|iPad|iPod|Macintosh|Mac OS X/i.test(ua) || /^(Mac|iPhone|iPad|iPod)/i.test(platform);
    document.documentElement.classList.add(apple ? 'is-apple' : 'not-apple');
  } catch (error) { /* leave both lines showing */ }
})();

// Visitors who aren't on an Apple device can't text Troy yet (he is iMessage only), so the button takes them to
// the web simulator instead of opening a text that would go nowhere. Apple visitors are untouched.
export const SIM_LABEL = 'Try the web simulator';
(() => {
  const apply = () => {
    if (!document.documentElement.classList.contains('not-apple')) return;
    for (const a of document.querySelectorAll('a[data-sms]')) {
      a.setAttribute('href', 'simulator.html');
      a.removeAttribute('aria-disabled');
      a.removeAttribute('role');
      a.classList.remove('is-soon');
      a.textContent = SIM_LABEL;
      a.title = 'Troy works on iMessage today. This opens a web simulator of texting him.';
    }
  };
  // wireSmsLinks (above) sets these links after the page is ready, so this runs after it each time.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(apply, 0));
  else setTimeout(apply, 0);
  window.addEventListener('load', () => setTimeout(apply, 50));
})();
