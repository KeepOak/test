import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookHeaders = Record<string, string | string[] | undefined>;
export const webhookWindowSeconds = 300;

/** Original implementation of Standard Webhooks' symmetric v1 wire contract. No upstream code copied. */
export function webhookKey(secret: string): Buffer {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) throw new Error('Invalid webhook key');
  const encoded = secret.slice(6), key = Buffer.from(encoded, 'base64');
  if (key.length < 24 || key.length > 64 || key.toString('base64') !== encoded)
    throw new Error('Invalid webhook key');
  return key;
}

export function singleHeader(headers: WebhookHeaders, name: string, maximum = 200): string {
  const value = headers[name];
  if (typeof value !== 'string' || !value || value.length > maximum) throw new Error('Invalid webhook headers');
  return value;
}

export function standardSignature(secret: string, id: string, stamp: string, raw: Buffer): string {
  const digest = createHmac('sha256', webhookKey(secret)).update(`${id}.${stamp}.`).update(raw).digest('base64');
  return `v1,${digest}`;
}

export function verifyStandardWebhook(secret: string, headers: WebhookHeaders, raw: Buffer, now = Date.now()): string {
  if (raw.length > 262144) throw new Error('Webhook body exceeds limit');
  const id = singleHeader(headers, 'webhook-id'), stamp = singleHeader(headers, 'webhook-timestamp', 12);
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id) || !/^[0-9]{1,12}$/.test(stamp)
    || Math.abs(now / 1000 - Number(stamp)) > webhookWindowSeconds)
    throw new Error('Invalid webhook signature');
  const signatures = singleHeader(headers, 'webhook-signature', 2048).split(' ');
  if (signatures.length > 8) throw new Error('Invalid webhook signature');
  const expected = Buffer.from(standardSignature(secret, id, stamp, raw).slice(3), 'base64');
  let valid = false;
  for (const signature of signatures) {
    if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(signature)) continue;
    const candidate = Buffer.from(signature.slice(3), 'base64');
    if (candidate.length === 32 && candidate.toString('base64') === signature.slice(3))
      valid = timingSafeEqual(candidate, expected) || valid;
  }
  if (!valid) throw new Error('Invalid webhook signature');
  return id;
}
