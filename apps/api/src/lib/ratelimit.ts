import type { Redis } from 'ioredis';

// Atomic fixed-window counter: INCR and set expiry on first hit in one round trip.
const SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('PTTL', KEYS[1])}
`;

export interface RateResult { allowed: boolean; count: number; remaining: number; retryAfterSec: number }

export async function hit(redis: Redis, key: string, limit: number, windowSec: number): Promise<RateResult> {
  const [count, ttl] = (await redis.eval(SCRIPT, 1, `rl:${key}`, String(windowSec * 1000))) as [number, number];
  return { allowed: count <= limit, count, remaining: Math.max(0, limit - count), retryAfterSec: Math.max(1, Math.ceil(ttl / 1000)) };
}
