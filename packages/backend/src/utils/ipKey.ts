import crypto from 'node:crypto';
import { ipKeyGenerator } from 'express-rate-limit';
import type { Request } from 'express';
import { getIpHashSalt } from '../config';

/**
 * Privacy-preserving rate-limit key for anonymous callers.
 *
 * The raw client IP must never reach a store at rest — not Redis key names, not
 * logs, not the database. We normalize the IP first via express-rate-limit's
 * `ipKeyGenerator` (buckets IPv6 to its /56 prefix so a single v6 host can't
 * rotate through its allocation to mint fresh keys), then HMAC the result with a
 * server-side salt. The `rl|` namespace prevents these keys from ever being
 * correlated with other derivations that reuse the same salt.
 *
 * The IP is `req.ip`, which the app's `oxyTrustProxy` resolves to the real
 * client behind the ALB and Cloudflare; a forged X-Forwarded-For never moves it.
 *
 * Returns 'unknown' when no IP is resolvable (the socket already closed). The salt is read at call time so
 * tests and rotations don't require a module reload.
 */
export function hashedIpKey(req: Request): string {
  const ip = req.ip;
  if (!ip) {
    return 'unknown';
  }
  const normalized = ipKeyGenerator(ip);
  const salt = getIpHashSalt() ?? '';
  return crypto.createHmac('sha256', salt).update(`rl|${normalized}`).digest('hex').slice(0, 24);
}
