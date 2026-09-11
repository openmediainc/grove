import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { signWebhookBody, verifyWebhookSignature } from "../src/webhook-sign.js";

describe("webhook HMAC", () => {
  it("signs body as sha256=hex", () => {
    const body = JSON.stringify({ event: "wake", agent_id: "agt_1" });
    const secret = "s3cret";
    const header = signWebhookBody(secret, body);
    const hex = crypto.createHmac("sha256", secret).update(body).digest("hex");
    expect(header).toBe(`sha256=${hex}`);
    expect(verifyWebhookSignature(secret, body, header)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const header = signWebhookBody("s3cret", '{"a":1}');
    expect(verifyWebhookSignature("s3cret", '{"a":2}', header)).toBe(false);
    expect(verifyWebhookSignature("other", '{"a":1}', header)).toBe(false);
  });
});
