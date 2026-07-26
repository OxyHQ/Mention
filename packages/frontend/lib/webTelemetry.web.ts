import { API_URL } from '@/config';

type VitalName = 'CLS' | 'INP' | 'LCP';
type VitalRating = 'good' | 'needs-improvement' | 'poor';
type NavigationType =
  | 'navigate'
  | 'reload'
  | 'back-forward'
  | 'prerender'
  | 'restore'
  | 'other';
type RuntimeKind =
  | 'load'
  | 'navigation'
  | 'resource-error'
  | 'runtime-error'
  | 'unhandled-rejection';

type TelemetryEvent =
  | {
      type: 'vital';
      name: VitalName;
      value: number;
      rating: VitalRating;
      navigation: NavigationType;
      route: string;
    }
  | {
      type: 'runtime';
      kind: RuntimeKind;
      result: 'ok' | 'error';
      route: string;
    };

const ENDPOINT = `${API_URL.replace(/\/+$/, '')}/telemetry/web`;
const CAPABILITIES_ENDPOINT = `${API_URL.replace(/\/+$/, '')}/`;
const MAX_QUEUE_SIZE = 40;
const MAX_RUNTIME_EVENTS_PER_KIND = 5;
const FLUSH_DELAY_MS = 1_000;

let initialized = false;
let telemetryEnabled = false;
let cachedCapability: boolean | undefined;
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let queue: TelemetryEvent[] = [];
const runtimeCounts = new Map<RuntimeKind, number>();

function routeBucket(pathname: string = window.location.pathname): string {
  const path = pathname.toLowerCase();
  if (path === '/') return '/';
  if (path === '/compose' || path.startsWith('/compose/')) return '/compose';
  if (path === '/explore' || path.startsWith('/explore/')) return '/explore';
  if (path === '/feed' || path.startsWith('/feed/')) return '/feed';
  if (path === '/feeds' || path.startsWith('/feeds/')) return '/feeds';
  if (path.startsWith('/oauth/')) return '/oauth';
  if (path.startsWith('/p/')) return '/post';
  if (path.startsWith('/@')) return '/profile';
  if (path === '/search' || path.startsWith('/search/')) return '/search';
  if (path === '/settings' || path.startsWith('/settings/')) return '/settings';
  if (path === '/videos' || path.startsWith('/videos/')) return '/videos';
  return '/other';
}

function normalizeNavigation(value: string | undefined): NavigationType {
  if (
    value === 'navigate' ||
    value === 'reload' ||
    value === 'prerender' ||
    value === 'restore'
  ) {
    return value;
  }
  if (value === 'back-forward' || value === 'back-forward-cache') {
    return 'back-forward';
  }
  return 'other';
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    flush(false);
  }, FLUSH_DELAY_MS);
}

function enqueue(event: TelemetryEvent): void {
  if (!telemetryEnabled) return;
  if (queue.length >= MAX_QUEUE_SIZE) queue.shift();
  queue.push(event);
  if (queue.length >= 10) {
    flush(false);
  } else {
    scheduleFlush();
  }
}

function flush(useBeacon: boolean): void {
  if (queue.length === 0) return;
  const events = queue.splice(0, 10);
  const payload = JSON.stringify({ events });

  if (
    useBeacon &&
    typeof navigator.sendBeacon === 'function' &&
    navigator.sendBeacon(
      ENDPOINT,
      new Blob([payload], { type: 'text/plain;charset=UTF-8' }),
    )
  ) {
    return;
  }

  void fetch(ENDPOINT, {
    method: 'POST',
    // Keep the request CORS-safelisted so a low-value telemetry batch never
    // adds an OPTIONS round-trip. The backend's bounded text parser validates
    // and parses this exact payload shape.
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: payload,
    keepalive: true,
    credentials: 'omit',
  }).catch(() => {
    // Telemetry must never affect app execution or retry indefinitely.
  });
}

function recordRuntime(kind: RuntimeKind, result: 'ok' | 'error'): void {
  const count = runtimeCounts.get(kind) ?? 0;
  if (count >= MAX_RUNTIME_EVENTS_PER_KIND) return;
  runtimeCounts.set(kind, count + 1);
  enqueue({ type: 'runtime', kind, result, route: routeBucket() });
}

export function recordWebNavigation(pathname: string): void {
  enqueue({
    type: 'runtime',
    kind: 'navigation',
    result: 'ok',
    route: routeBucket(pathname),
  });
}

export function initializeWebTelemetry(): () => void {
  if (initialized) return () => undefined;
  initialized = true;
  let active = true;
  let listenersAttached = false;
  const probeController = new AbortController();

  const onError = (event: Event): void => {
    recordRuntime(
      event instanceof ErrorEvent ? 'runtime-error' : 'resource-error',
      'error',
    );
  };
  const onUnhandledRejection = (): void => {
    recordRuntime('unhandled-rejection', 'error');
  };
  const onPageHide = (): void => flush(true);

  const attachTelemetry = (): void => {
    if (!active || listenersAttached) return;
    telemetryEnabled = true;
    listenersAttached = true;
    window.addEventListener('error', onError, true);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    window.addEventListener('pagehide', onPageHide);
    recordRuntime('load', 'ok');

    void import('web-vitals')
      .then(({ onCLS, onINP, onLCP }) => {
        if (!active) return;
        const report = (metric: {
          name: VitalName;
          value: number;
          rating: VitalRating;
          navigationType?: string;
        }): void => {
          if (!active) return;
          enqueue({
            type: 'vital',
            name: metric.name,
            value: metric.value,
            rating: metric.rating,
            navigation: normalizeNavigation(metric.navigationType),
            route: routeBucket(),
          });
        };
        onCLS(report);
        onINP(report);
        onLCP(report);
      })
      .catch(() => {
        if (active) recordRuntime('resource-error', 'error');
      });
  };

  const probeCapabilities = async (): Promise<void> => {
    if (cachedCapability !== undefined) {
      if (cachedCapability) attachTelemetry();
      return;
    }

    try {
      const response = await fetch(CAPABILITIES_ENDPOINT, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        signal: probeController.signal,
      });
      if (!response.ok) {
        cachedCapability = false;
        return;
      }
      const payload = await response.json() as {
        capabilities?: { webTelemetry?: unknown };
      };
      cachedCapability = payload.capabilities?.webTelemetry === true;
      if (cachedCapability) attachTelemetry();
    } catch {
      if (!probeController.signal.aborted) cachedCapability = false;
    }
  };

  void probeCapabilities();

  return () => {
    active = false;
    probeController.abort();
    if (listenersAttached) {
      window.removeEventListener('error', onError, true);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      window.removeEventListener('pagehide', onPageHide);
    }
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (telemetryEnabled) flush(true);
    queue = [];
    runtimeCounts.clear();
    telemetryEnabled = false;
    initialized = false;
  };
}

export const __webTelemetryForTests = {
  capabilitiesEndpoint: CAPABILITIES_ENDPOINT,
  normalizeNavigation,
  reset: () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    queue = [];
    runtimeCounts.clear();
    cachedCapability = undefined;
    telemetryEnabled = false;
    initialized = false;
  },
  routeBucket,
};
