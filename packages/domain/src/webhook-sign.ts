import crypto from "node:crypto";

export function signWebhookBody(secret: string, body: string): string {
  const hex = crypto.createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hex}`;
}

export function verifyWebhookSignature(secret: string, body: string, header: string): boolean {
  const expected = signWebhookBody(secret, body);
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
