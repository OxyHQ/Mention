/**
 * Oxy egress instrumentation.
 *
 * Answers the question the backend could not answer at all: how much of a
 * request's wall clock is spent waiting on Oxy. `db/queryMetrics.ts` already
 * proves Postgres is batched — `postHydrationStatementBudget.test.ts` pins one
 * hydration at seven statements whether it hydrates one post or twenty — so a
 * route that is slow and issues seven statements is slow somewhere else. This
 * names the somewhere else, per route, as a number rather than as a guess.
 *
 * ## Where it attaches, and why the prototype
 *
 * Every Oxy call in the process funnels through `HttpService.request(config)`:
 * `get`/`post`/`put`/`patch`/`delete` all delegate to it, `OxyServices.makeRequest`
 * delegates to it, and the SDK's own 401/CSRF retries re-enter it. One seam
 * reaches 100% of egress.
 *
 * It is patched on the PROTOTYPE, reached once through an instance, rather than
 * on each instance. There are seven `new OxyServices(...)` sites in this
 * codebase and two of them construct PER REQUEST (`createScopedOxyClient`,
 * `createUserScopedOxyServices`), so per-instance patching would have to be
 * threaded through every construction site and an eighth added later would go
 * silently unmeasured. Prototypes are shared, so patching once covers every
 * instance built before or after — the same argument `queryMetrics.ts` makes
 * for mutating the client object drizzle already holds.
 *
 * ## What a "call" means here
 *
 * The SDK's response cache and in-flight dedupe are both checked INSIDE
 * `request()`, so a cache hit is recorded as a call of near-zero duration. That
 * is deliberate: this counts LOGICAL Oxy calls — the number the viewer-graph
 * consolidation is trying to move — and the histogram's bottom bucket separates
 * the hits from the round trips. It matters less than it sounds, because
 * `createScopedOxyClient` builds a fresh instance per request and the SDK's
 * cache is per-instance, so on the request path it is nearly always cold.
 *
 * ## Cost when disabled
 *
 * `OXY_REQUEST_METRICS_ENABLED=false` leaves the prototype completely unpatched
 * and `requestObservability` outside the async context. There is no wrapper and
 * no store on any path — the cost is not "small", it is absent.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config';
import { logger } from './logger';
import { metrics } from './metrics';

/**
 * How many distinct route templates may hold their own series.
 *
 * Unlike a database table name, an Oxy path is not drawn from a set fixed at
 * compile time — it is whatever this codebase calls, which is countable but not
 * enumerable from here. The cap is what keeps the series arithmetic in
 * `metrics.ts` honest; the 25th distinct template and beyond collapse to
 * `/other`, which reads as "the interesting ones are already named".
 */
const MAX_ROUTE_TEMPLATES = 24;

/**
 * Templates seen so far, which is what the cap is counted against.
 *
 * Deliberately NOT paired with a raw-url → template memo, the way
 * `describeStatement` caches statement text. That cache pays off because
 * drizzle compiles one query builder to one string with `$n` placeholders, so a
 * hot route reuses the same key on every request. An Oxy url is the opposite:
 * it carries the id, so almost every call is a distinct key and the memo would
 * be a near-total miss rate plus eviction churn. Templating is a split and a
 * regex over a handful of short segments — free next to the HTTP call it wraps.
 */
const routeTemplates = new Set<string>();

/**
 * A path segment that is an identifier rather than a route name.
 *
 * Covers uuid, 24-character hex (Mongo-era ids still in circulation), all
 * digits, and anything longer than a plausible route word. Each becomes `:id`,
 * because a metric label carrying a user id is a cardinality bomb AND a
 * privacy leak.
 */
const IDENTIFIER_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{24}|\d+|.{33,})$/i;

export function templateOxyRoute(rawUrl: string): string {
  // Strip the query string BEFORE anything else. `HttpService` redacts query
  // strings from its own logs because an asset URL carries a scoped `mt=` media
  // token; that token must not reach a metric label either.
  const withoutQuery = rawUrl.split(/[?#]/)[0] ?? '';
  const path = withoutQuery.replace(/^https?:\/\/[^/]+/i, '');
  const templated = path
    .split('/')
    .map((segment) => (segment && IDENTIFIER_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
  const normalized = templated.startsWith('/') ? templated : `/${templated}`;

  if (!routeTemplates.has(normalized) && routeTemplates.size >= MAX_ROUTE_TEMPLATES) {
    return '/other';
  }
  routeTemplates.add(normalized);
  return normalized;
}

/**
 * The status class of a rejection. `HttpService` puts the HTTP status on the
 * error it throws; a rejection with no status is a transport failure (DNS,
 * timeout, socket), which is a 5xx from this side of the wire.
 */
function statusClass(error: unknown): string {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
  if (typeof status !== 'number') return '5xx';
  const bucket = Math.floor(status / 100);
  return bucket >= 1 && bucket <= 5 ? `${bucket}xx` : 'other';
}

/** What one HTTP request cost in Oxy calls. Mirrors `QueryTally`. */
export interface OxyTally {
  count: number;
  totalDurationMs: number;
  errorCount: number;
}

const requestTally = new AsyncLocalStorage<OxyTally>();

/** Whether Oxy calls are being timed at all. */
export function isOxyInstrumentationEnabled(): boolean {
  return config.oxy.requestMetricsEnabled;
}

/**
 * Run `handler` in an async context whose Oxy calls are counted against one
 * tally, and hand that tally to it.
 *
 * The tally propagates to everything `handler` awaits, which is what lets a
 * middleware at the top of the stack account for a call issued five service
 * layers down without either of them knowing about the other.
 */
export function runWithOxyAccounting<T>(handler: (tally: OxyTally) => T): T {
  const tally: OxyTally = { count: 0, totalDurationMs: 0, errorCount: 0 };
  return requestTally.run(tally, () => handler(tally));
}

/**
 * Instrumentation must never be able to fail an Oxy call, so the observer is
 * wrapped — but a silently swallowed fault would leave the metric quietly
 * empty, which is the failure this module exists to prevent. Logged once per
 * process: the fault would recur on every call.
 */
let instrumentationFaultReported = false;

function reportInstrumentationFault(error: unknown): void {
  if (instrumentationFaultReported) return;
  instrumentationFaultReported = true;
  logger.error('Oxy egress instrumentation failed', error);
}

function record(method: string, route: string, status: string, durationMs: number): void {
  try {
    const labels = { method, route, status };
    metrics.recordLatency('oxy_call_duration_ms', durationMs, labels);
    metrics.incrementCounter('oxy_calls_total', 1, labels);
    const tally = requestTally.getStore();
    if (tally) {
      tally.count += 1;
      tally.totalDurationMs += durationMs;
      if (status === '4xx' || status === '5xx') tally.errorCount += 1;
    }
  } catch (error) {
    reportInstrumentationFault(error);
  }
}

interface OxyRequestConfig {
  method?: unknown;
  url?: unknown;
}

type OxyRequest = (config: OxyRequestConfig) => Promise<unknown>;

/** Prototypes already patched, so a second install is a no-op rather than a double count. */
const patched = new WeakSet<object>();

/**
 * Patch `HttpService.request` in place on the prototype `client` uses.
 *
 * Call it once, with the first `OxyServices` the process builds. Every later
 * instance shares the prototype and is covered without knowing this exists.
 *
 * Typed on the one field it reads rather than on `OxyServices`: the parameter
 * says what the function actually needs, and `OxyServices` satisfies it
 * structurally.
 */
export function instrumentOxyEgress(client: { httpService: unknown }): void {
  if (!isOxyInstrumentationEnabled()) return;

  const service: unknown = client.httpService;
  if (!service || typeof service !== 'object') return;
  const prototype: unknown = Object.getPrototypeOf(service);
  if (!prototype || typeof prototype !== 'object') return;
  if (patched.has(prototype)) return;

  const target = prototype as { request?: OxyRequest };
  const original = target.request;
  if (typeof original !== 'function') return;

  patched.add(prototype);
  target.request = async function instrumentedRequest(
    this: unknown,
    requestConfig: OxyRequestConfig,
  ): Promise<unknown> {
    const startedAt = process.hrtime.bigint();
    const method = typeof requestConfig?.method === 'string' ? requestConfig.method : 'OTHER';
    const route = typeof requestConfig?.url === 'string'
      ? templateOxyRoute(requestConfig.url)
      : '/other';
    try {
      const result = await original.call(this, requestConfig);
      record(method, route, '2xx', Number(process.hrtime.bigint() - startedAt) / 1_000_000);
      return result;
    } catch (error) {
      record(method, route, statusClass(error), Number(process.hrtime.bigint() - startedAt) / 1_000_000);
      throw error;
    }
  };
}
