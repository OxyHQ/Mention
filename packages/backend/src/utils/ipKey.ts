import crypto from 'crypto';
import { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';

/**
 * Privacy-preserving rate-limit key for anonymous callers.
 *
 * The raw client IP must never reach a store at rest — not Redis key names, not
 * logs, not Mongo. We normalize the IP first via express-rate-limit's
 * `ipKeyGenerator` (buckets IPv6 to its /56 prefix so a single v6 host can't
 * rotate through its allocation to mint fresh keys), then HMAC the result with a
 * server-side salt. The `rl|` namespace prevents these keys from ever being
 * correlated with other derivations that reuse the same salt.
 *
 * Returns 'unknown' when no IP is resolvable. The salt is read at call time so
 * tests and rotations don't require a module reload.
 */
export function hashedIpKey(req: Request): string {
  const ip = req.ip || req.socket.remoteAddress;
  if (!ip) {
    return 'unknown';
  }
  const normalized = ipKeyGenerator(ip);
  const salt = process.env.IP_HASH_SALT || process.env.DEVICE_ID_SALT || '';
  return crypto.createHmac('sha256', salt).update(`rl|${normalized}`).digest('hex').slice(0, 24);
}
