import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "../../src/slack/slack.js";

/**
 * Slack's request signature (slack.ts), on the edges the main tests leave
 * open: the replay window in both directions, and a timestamp that is not
 * plain digits, each with a signature that is otherwise correct.
 */

const SECRET = "acme-placeholder-signing-secret";
const BODY = JSON.stringify({ type: "event_callback", event_id: "E1" });
const NOW = 1_700_000_000;
const sign = (ts: string, secret = SECRET) => "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${BODY}`).digest("hex");
const verify = (ts: string, nowSec = NOW) => verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sign(ts), rawBody: BODY, nowSec });

describe("Slack signature: the replay window", () => {
  it("accepts a correctly signed request up to five minutes old or ahead", () => {
    for (const offset of [0, -299, 299, -300, 300]) {
      expect(verify(String(NOW + offset)), String(offset)).toBe(true);
    }
  });

  it("refuses a correctly signed request older or further ahead than five minutes", () => {
    for (const offset of [-301, 301, -3600, 3600, 86_400 * 365]) {
      expect(verify(String(NOW + offset)), String(offset)).toBe(false);
    }
  });
});

describe("Slack signature: the timestamp", () => {
  it("refuses a timestamp that is not plain digits, even when the signature covers it", () => {
    for (const ts of ["abc", "", " 1700000000", "1700000000 ", "1700000000.5", "-1700000000", "1.7e9", "0x6553f100", "NaN", "Infinity"]) {
      expect(verify(ts), JSON.stringify(ts)).toBe(false);
    }
  });

  it("refuses a missing timestamp or signature, and a signature made with another secret", () => {
    const ts = String(NOW);
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: undefined, signature: sign(ts), rawBody: BODY, nowSec: NOW })).toBe(false);
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: undefined, rawBody: BODY, nowSec: NOW })).toBe(false);
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sign(ts, "another-placeholder-secret"), rawBody: BODY, nowSec: NOW })).toBe(false);
    expect(verifySlackSignature({ signingSecret: SECRET, timestamp: ts, signature: sign(ts), rawBody: BODY, nowSec: NOW })).toBe(true);
  });
});
