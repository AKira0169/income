/* server/ratelimit.ts — a token bucket per key, in memory.

   Generous on purpose: a person clicking through the app, plus the burst a
   form save makes (upsert, link, catch-up), never comes near it. It is there
   for a script hammering the api. One instance, one map — see session.ts. */

export interface BucketOptions {
  capacity: number;
  perSecond: number;
  now?: () => number;
  maxKeys?: number;
}

export function tokenBucket(options: BucketOptions): (key: string) => boolean {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const buckets = new Map<string, { tokens: number; at: number }>();

  return (key: string): boolean => {
    const t = now();
    const bucket = buckets.get(key) ?? { tokens: options.capacity, at: t };
    bucket.tokens = Math.min(options.capacity, bucket.tokens + ((t - bucket.at) / 1000) * options.perSecond);
    bucket.at = t;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    buckets.delete(key);
    buckets.set(key, bucket);
    if (buckets.size > maxKeys) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
    return allowed;
  };
}
