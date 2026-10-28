import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Delivery tokens are authenticated-encrypted (AES-256-GCM) so they are both
 * tamper-proof (signed) and opaque: campaign, creative and pricing details
 * never appear in readable form in publisher pages.
 *
 * Format: <keyId>.<base64url(iv | ciphertext | authTag)>
 * Keys: TRACKING_TOKEN_KEYS="k2:<base64 32 bytes>,k1:<base64 32 bytes>" — the
 * first key signs new tokens, the others are accepted for verification so
 * keys can be rotated without invalidating tokens in flight.
 */
export interface DeliveryClaims {
  d: string;   // delivery id (uuid)
  c: string;   // campaign id
  cr: string;  // creative id
  ao: string;  // advertiser org id
  s: string;   // site id
  u: string;   // ad unit id
  po: string;  // publisher org id
  pm: 'cpm' | 'cpc' | 'flat';
  r: string;   // rate micros (string to preserve bigint precision)
  cur: string;
  sh: number;  // publisher revenue share bps at decision time
  ph: string;  // page host the ad was served to
  pp?: string; // page path (no query or fragment), for per-page reports
  co: string;  // country
  dv: string;  // device category
  os?: string; // operating system family
  br?: string; // browser family
  src?: string; // traffic source of the page view (see trafficSource)
  ct: boolean; // contextual (non-personalized) delivery
  v?: string;  // pseudonymous visitor hash (only with consent)
  iat: number; // issued at, epoch ms
  exp: number; // expiry, epoch ms
}

export interface TokenKeyring { activeKid: string; keys: Map<string, Buffer> }

export function parseKeyring(spec: string): TokenKeyring {
  const keys = new Map<string, Buffer>();
  let activeKid = '';
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf(':');
    if (idx < 1) throw new Error('TRACKING_TOKEN_KEYS entries must be kid:base64key');
    const kid = part.slice(0, idx);
    const key = Buffer.from(part.slice(idx + 1), 'base64');
    if (key.length !== 32) throw new Error(`Tracking key ${kid} must be 32 bytes (base64-encoded)`);
    if (!/^[a-zA-Z0-9_-]{1,16}$/.test(kid)) throw new Error(`Invalid key id ${kid}`);
    keys.set(kid, key);
    if (!activeKid) activeKid = kid;
  }
  if (!activeKid) throw new Error('TRACKING_TOKEN_KEYS must contain at least one key');
  return { activeKid, keys };
}

export function signDeliveryToken(ring: TokenKeyring, claims: DeliveryClaims): string {
  const key = ring.keys.get(ring.activeKid)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(ring.activeKid));
  const ct = Buffer.concat([cipher.update(JSON.stringify(claims), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ring.activeKid}.${Buffer.concat([iv, ct, tag]).toString('base64url')}`;
}

export type TokenResult =
  | { ok: true; claims: DeliveryClaims }
  | { ok: false; reason: 'token_invalid' | 'token_expired'; claims?: DeliveryClaims };

export function verifyDeliveryToken(ring: TokenKeyring, token: string, now = Date.now(), graceMs = 0): TokenResult {
  if (typeof token !== 'string' || token.length > 4096) return { ok: false, reason: 'token_invalid' };
  const dot = token.indexOf('.');
  if (dot < 1) return { ok: false, reason: 'token_invalid' };
  const kid = token.slice(0, dot);
  const key = ring.keys.get(kid);
  if (!key) return { ok: false, reason: 'token_invalid' };
  let raw: Buffer;
  try {
    raw = Buffer.from(token.slice(dot + 1), 'base64url');
  } catch {
    return { ok: false, reason: 'token_invalid' };
  }
  if (raw.length < 12 + 16 + 2) return { ok: false, reason: 'token_invalid' };
  try {
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(kid));
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    const claims = JSON.parse(json) as DeliveryClaims;
    if (claims.exp + graceMs < now) return { ok: false, reason: 'token_expired', claims };
    return { ok: true, claims };
  } catch {
    return { ok: false, reason: 'token_invalid' };
  }
}

export function generateTokenKey(): string {
  return randomBytes(32).toString('base64');
}
