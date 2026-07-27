import { Router, text, type Request } from 'express';
import * as z from 'zod';
import { config } from '../config';
import { isAllowedOrigin } from '../utils/allowedOrigins';
import { metrics } from '../utils/metrics';

const RUM_ROUTES = new Set([
  '/',
  '/compose',
  '/explore',
  '/feed',
  '/feeds',
  '/oauth',
  '/post',
  '/profile',
  '/search',
  '/settings',
  '/videos',
  '/other',
]);

const VitalEvent = z.object({
  type: z.literal('vital'),
  name: z.enum(['CLS', 'INP', 'LCP']),
  value: z.number().finite().nonnegative(),
  rating: z.enum(['good', 'needs-improvement', 'poor']),
  navigation: z.enum(['navigate', 'reload', 'back-forward', 'prerender', 'restore', 'other']),
  route: z.string().max(160),
});

const RuntimeEvent = z.object({
  type: z.literal('runtime'),
  kind: z.enum(['load', 'navigation', 'resource-error', 'runtime-error', 'unhandled-rejection']),
  result: z.enum(['ok', 'error']),
  route: z.string().max(160),
});

const TelemetryBatch = z.object({
  events: z.array(z.discriminatedUnion('type', [VitalEvent, RuntimeEvent])).min(1).max(10),
});

function normalizeRoute(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0]?.toLowerCase() || '/';
  let route = '/other';
  if (pathname === '/') route = '/';
  else if (pathname === '/compose' || pathname.startsWith('/compose/')) route = '/compose';
  else if (pathname === '/explore' || pathname.startsWith('/explore/')) route = '/explore';
  else if (pathname === '/feed' || pathname.startsWith('/feed/')) route = '/feed';
  else if (pathname === '/feeds' || pathname.startsWith('/feeds/')) route = '/feeds';
  else if (pathname.startsWith('/oauth/')) route = '/oauth';
  else if (pathname.startsWith('/p/')) route = '/post';
  else if (pathname.startsWith('/@')) route = '/profile';
  else if (pathname === '/search' || pathname.startsWith('/search/')) route = '/search';
  else if (pathname === '/settings' || pathname.startsWith('/settings/')) route = '/settings';
  else if (pathname === '/videos' || pathname.startsWith('/videos/')) route = '/videos';
  return RUM_ROUTES.has(route) ? route : '/other';
}

function isTrustedBrowserOrigin(req: Request): boolean {
  const origin = req.header('origin');
  if (!origin) return !config.runtime.isProduction;
  return isAllowedOrigin(origin);
}

export function createWebTelemetryRouter(): Router {
  const router = Router();
  // `sendBeacon` can reliably send a CORS-safelisted text/plain payload during
  // page teardown. Normal fetches still arrive through the global JSON parser.
  router.use('/telemetry/web', text({ type: 'text/plain', limit: '16kb' }));
  router.post('/telemetry/web', (req, res) => {
    if (!isTrustedBrowserOrigin(req)) {
      res.status(403).end();
      return;
    }

    let body: unknown = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        res.status(400).json({ message: 'Invalid telemetry batch' });
        return;
      }
    }
    const parsed = TelemetryBatch.safeParse(body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid telemetry batch' });
      return;
    }

    for (const event of parsed.data.events) {
      const route = normalizeRoute(event.route);
      if (event.type === 'runtime') {
        metrics.incrementCounter('web_runtime_events_total', 1, {
          kind: event.kind,
          route,
          result: event.result,
        });
        continue;
      }

      const upperBound = event.name === 'CLS' ? 10 : event.name === 'INP' ? 60_000 : 120_000;
      if (event.value > upperBound) continue;
      const metricName =
        event.name === 'CLS'
          ? 'web_vital_cls_ratio'
          : event.name === 'INP'
            ? 'web_vital_inp_ms'
            : 'web_vital_lcp_ms';
      metrics.recordLatency(metricName, event.value, {
        route,
        rating: event.rating,
        navigation: event.navigation,
      });
    }

    res.status(204).end();
  });
  return router;
}

export { normalizeRoute as normalizeWebTelemetryRoute };
export default createWebTelemetryRouter();
