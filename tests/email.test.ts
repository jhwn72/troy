import { test } from "node:test";
import assert from "node:assert/strict";
import { sendVerificationEmail } from "../src/email.ts";

const TO = "tommy.trojan@usc.edu";
const CODE = "482913";

function logs() {
  const lines: string[] = [];
  return { lines, log: (line: string) => void lines.push(line) };
}

test("sent: the provider took it, and the message carries the code", async () => {
  const seen: { to: string; subject: string; text: string }[] = [];
  const l = logs();
  const result = await sendVerificationEmail(TO, CODE, { key: "k", dev: false, log: l.log, send: async (m) => (seen.push(m), {}) });
  assert.equal(result, "sent");
  assert.equal(seen[0]!.to, TO);
  assert.match(seen[0]!.subject, /482913/);
  assert.match(seen[0]!.text, /482913/);
  assert.deepEqual(l.lines, []);
});

test("no_key: production with no provider key says so, development still counts as sent", async () => {
  const l = logs();
  assert.equal(await sendVerificationEmail(TO, CODE, { key: "", dev: false, log: l.log }), "no_key");
  assert.equal(l.lines.length, 1);
  assert.match(l.lines[0]!, /no_key/);
  assert.equal(await sendVerificationEmail(TO, CODE, { key: "", dev: true, log: l.log }), "sent");
});

test("rejected: the provider's error name and status are logged, never the address or the code", async () => {
  const l = logs();
  const result = await sendVerificationEmail(TO, CODE, {
    key: "k",
    dev: false,
    log: l.log,
    send: async () => ({ error: { name: "validation_error", statusCode: 403, message: `cannot send to ${TO} with ${CODE}` } as { name: string; statusCode: number } }),
  });
  assert.equal(result, "rejected");
  assert.equal(l.lines.length, 1);
  assert.match(l.lines[0]!, /rejected name=validation_error status=403/);
  assert.ok(!l.lines[0]!.includes(TO) && !l.lines[0]!.includes("tommy") && !l.lines[0]!.includes(CODE));
});

test("error: a thrown send never escapes, and a name that could carry text is not logged", async () => {
  const l = logs();
  const boom = new Error(`timeout sending ${CODE} to ${TO}`);
  boom.name = `Weird ${TO}`;
  const result = await sendVerificationEmail(TO, CODE, {
    key: "k",
    dev: false,
    log: l.log,
    send: async () => {
      throw boom;
    },
  });
  assert.equal(result, "error");
  assert.equal(l.lines[0], "verification email failed: error name=unknown");

  const typed = await sendVerificationEmail(TO, CODE, {
    key: "k",
    dev: false,
    log: l.log,
    send: async () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.equal(typed, "error");
  assert.equal(l.lines[1], "verification email failed: error name=TypeError");
});
