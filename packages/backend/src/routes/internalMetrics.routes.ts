import { createHash, timingSafeEqual } from 'crypto';
import { Router, type Request } from 'express';
import { config } from '../config';
import { metrics } from '../utils/metrics';

interface InternalMetricsOptions {
  enabled: boolean;
  token?: string;
  allowedIps: readonly string[];
}

function normalizedIp(rawIp: string | undefined): string {
  return (rawIp ?? '').trim().replace(/^::ffff:/, '');
}

function isPrivateOrLoopback(ip: string): boolean {
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('169.254.')) {
    return true;
  }
  const [first, second] = ip.split('.').map(Number);
  if (first === 172 && Number.isInteger(second) && second >= 16 && second <= 31) {
    return true;
  }
  const lower = ip.toLowerCase();
  return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
}

function requestComesFromAllowedNetwork(
  req: Request,
  allowedIps: readonly string[],
): boolean {
  const ip = normalizedIp(req.ip || req.socket.remoteAddress);
  if (isPrivateOrLoopback(ip)) return true;
  return allowedIps.includes(ip);
}

function bearerToken(req: Request): string | undefined {
  const authorization = req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) return undefined;
  const token = authorization.slice('Bearer '.length).trim();
  return token || undefined;
}

function tokensMatch(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const receivedDigest = createHash('sha256').update(received).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(receivedDigest, expectedDigest);
}

export function createInternalMetricsRouter(options: InternalMetricsOptions): Router {
  const router = Router();
  router.get('/internal/metrics', async (req, res) => {
    const expectedToken = options.token;
    if (
      !options.enabled ||
      !expectedToken ||
      !requestComesFromAllowedNetwork(req, options.allowedIps) ||
      !tokensMatch(bearerToken(req), expectedToken)
    ) {
      // Hide the operational surface instead of disclosing that metrics exist.
      res.status(404).end();
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', metrics.contentType);
    res.send(await metrics.getPrometheusFormat());
  });
  return router;
}

export default createInternalMetricsRouter(config.internalMetrics);
