import {
  createEmfPublisher,
  type EmfPublisher,
  type MetricDefinition as EmfMetricDefinition,
} from '@oxy.so/telemetry/metrics';
import { logger } from './logger';

/**
 * Mention's operational metrics, published to CloudWatch (`Mention/Backend`)
 * through the shared Oxy EMF publisher (`@oxy.so/telemetry/metrics`).
 *
 * This used to be a prom-client registry that nothing scraped: the only reader
 * was an IP-locked `/internal/metrics`, so every counter reset on every deploy
 * and no history existed anywhere (the discovery gate's shadow measurement
 * among them). Now each metric is aggregated in memory and written once a
 * minute as CloudWatch EMF on stdout, which the task's `awslogs` driver already
 * ships, so it has history with no agent, sidecar or scraper.
 *
 * Every metric is ONE billed CloudWatch metric (dimension `Service` only), and
 * its labels are free properties of the log line: break a metric down in Logs
 * Insights, e.g. `filter ispresent(feed_discovery_gated_total) | stats
 * sum(feed_discovery_gated_total) by reason, source, shadow`. Route x method as
 * dimensions once cost ~80 % of the account's CloudWatch bill (#1334), which
 * is why no label here is promoted to a dimension.
 */

export interface MetricLabels {
  [key: string]: string | number;
}

type MetricKind = 'counter' | 'gauge' | 'histogram';

interface MetricDefinition {
  kind: MetricKind;
  help: string;
  labelNames: readonly string[];
  /**
   * Series ceiling for this metric alone, when {@link MAX_SERIES_PER_METRIC} is
   * the wrong bound.
   *
   * The default cap protects against label values derived from TRAFFIC, where
   * the ceiling is whatever a caller can invent. It is the wrong instrument for
   * a metric whose label values come from a set fixed at COMPILE time — there
   * the real bound is countable, and collapsing to `other` on crossing it
   * destroys the metric instead of protecting the registry. Raise this only
   * with that argument, and state the arithmetic where it is raised.
   */
  maxSeries?: number;
}

const DEFINITIONS = {
  federation_import_content_total: {
    kind: 'counter',
    help: 'ActivityPub content normalization decisions by bounded ingest path',
    labelNames: ['path', 'decision'],
  },
  post_equivalence_decision_total: {
    kind: 'counter',
    help: 'Cross-post equivalence decisions, by outcome and the evidence (or the refusal) behind it',
    labelNames: ['outcome', 'reason'],
  },
  feed_discovery_gated_total: {
    kind: 'counter',
    help: 'Feed discovery candidates rejected by the discovery gate',
    labelNames: ['reason', 'source', 'shadow'],
  },
  feed_author_gate_neutral_total: {
    kind: 'counter',
    help: 'Feed candidates an author-aware gate filter could not judge, and therefore kept',
    labelNames: ['reason', 'source'],
  },
  feed_federated_share: {
    kind: 'gauge',
    help: 'Federated share of a feed candidate pool',
    labelNames: ['descriptor'],
  },
  feed_impression_total: {
    kind: 'counter',
    help: 'Deduplicated feed impressions',
    labelNames: ['origin', 'descriptor'],
  },
  feed_interaction_signal_total: {
    kind: 'counter',
    help: 'Derived feed view and skip signals',
    labelNames: ['signal', 'descriptor'],
  },
  feed_report_total: {
    kind: 'counter',
    help: 'Reports originating from feed surfaces',
    labelNames: ['descriptor', 'origin'],
  },
  feed_interstitial_events_total: {
    kind: 'counter',
    help: 'Feed interstitial engagement events',
    labelNames: ['kind', 'event', 'descriptor'],
  },
  federated_media_delete_stuck: {
    kind: 'gauge',
    help: 'Federated media deletions still owed after many attempts (Oxy keeps failing to answer)',
    labelNames: [],
  },
  oxy_file_reference_stuck: {
    kind: 'gauge',
    help: 'Oxy file references still owed after many attempts (Oxy keeps failing to answer)',
    labelNames: [],
  },
  federated_actor_upsert_failed_total: {
    kind: 'counter',
    help: 'Federated actor cache rows that could not be written, by protocol and refusing constraint',
    labelNames: ['protocol', 'reason'],
  },
  account_erasure_completed_total: {
    kind: 'counter',
    help: 'Oxy account erasures that completed, by where the request came from',
    labelNames: ['source'],
  },
  account_erasure_failed_total: {
    kind: 'counter',
    help: 'Oxy account erasure attempts that failed and will be retried, by source',
    labelNames: ['source'],
  },
  account_event_refused_total: {
    kind: 'counter',
    help: 'Oxy account-event tokens that failed verification, by intake path',
    labelNames: ['source'],
  },
  oxy_account_event_webhook_total: {
    kind: 'counter',
    help: 'Oxy account-event webhook deliveries, by outcome',
    labelNames: ['outcome'],
  },
  post_deletion_side_effect_failed_total: {
    kind: 'counter',
    help: 'Best-effort work after a committed post deletion that did not complete, by step',
    labelNames: ['step'],
  },
  trend_events_total: {
    kind: 'counter',
    help: 'Trending-topic impressions and presses, by surface and batch freshness',
    labelNames: ['type', 'event', 'surface', 'freshness'],
  },
  trending_calculation_total: {
    kind: 'counter',
    help: 'Trending batch calculations by outcome (success, partial, failure)',
    labelNames: ['result'],
  },
  trend_summary_total: {
    kind: 'counter',
    help: 'On-demand trend summary generations, by outcome (generated, failed)',
    labelNames: ['result'],
  },
  trending_batch_age_seconds: {
    kind: 'gauge',
    help: 'Age of the trending batch being served, observed on a cache miss',
    labelNames: [],
  },
  feed_ranking_duration_ms: {
    kind: 'histogram',
    help: 'Feed ranking latency in milliseconds',
    labelNames: [],
  },
  feed_ranking_posts_processed: {
    kind: 'gauge',
    help: 'Posts processed by the latest feed ranking operation',
    labelNames: [],
  },
  http_request_duration_ms: {
    kind: 'histogram',
    help: 'HTTP request latency by normalized route and result',
    labelNames: ['method', 'route', 'status'],
  },
  legacy_post_payload_total: {
    kind: 'counter',
    help: 'Bounded use of transitional post-create request aliases',
    labelNames: ['variant'],
  },
  web_vital_lcp_ms: {
    kind: 'histogram',
    help: 'Real-user Largest Contentful Paint in milliseconds',
    labelNames: ['route', 'rating', 'navigation'],
  },
  web_vital_inp_ms: {
    kind: 'histogram',
    help: 'Real-user Interaction to Next Paint in milliseconds',
    labelNames: ['route', 'rating', 'navigation'],
  },
  web_vital_cls_ratio: {
    kind: 'histogram',
    help: 'Real-user Cumulative Layout Shift score',
    labelNames: ['route', 'rating', 'navigation'],
  },
  web_shell_fetch_ms: {
    kind: 'histogram',
    help: 'Fetching the SPA shell from its origin (only on a cold or stale process cache)',
    labelNames: ['status'],
  },
  web_boot_milestone_ms: {
    kind: 'histogram',
    help: 'Real-user milliseconds from navigation start to each step of a document load',
    labelNames: ['milestone', 'route', 'navigation'],
  },
  web_runtime_events_total: {
    kind: 'counter',
    help: 'Bounded browser load, navigation and runtime error events',
    labelNames: ['kind', 'route', 'result'],
  },
  /**
   * CrowdSource moderation integration. Every label value below is a closed set
   * this codebase produces — a rejection reason from the webhook middleware, a
   * delivery outcome, an enforcement action and mode. None is caller-supplied, so
   * none can mint unbounded series.
   */
  crowdsource_webhook_rejected_total: {
    kind: 'counter',
    help: 'CrowdSource webhook deliveries refused, by reason',
    labelNames: ['rejection'],
  },
  crowdsource_report_delivery_total: {
    kind: 'counter',
    help: 'Report delivery attempts to CrowdSource, by outcome',
    labelNames: ['result'],
  },
  crowdsource_enforcement_total: {
    kind: 'counter',
    help: 'Enforcement actions planned or applied from a CrowdSource decision',
    labelNames: ['action', 'mode', 'result'],
  },
  /**
   * Community-note lookups and writes that CrowdSource refused or never
   * answered. `operation` is one of this module's own six calls and `code` is
   * the SDK's closed error vocabulary plus `transport`, so the series count is
   * fixed by the code rather than by traffic.
   *
   * There is deliberately no success counter: a note is attached on the ordinary
   * hydration path, which is already measured, and a per-post counter there
   * would be one increment per row of every feed page served.
   */
  crowdsource_community_notes_failure_total: {
    kind: 'counter',
    help: 'Community-note calls to CrowdSource that failed, by operation and code',
    labelNames: ['operation', 'code'],
  },
  /**
   * Database instrumentation (`db/queryMetrics.ts`).
   *
   * `table` is validated against the drizzle schema's own table names before it
   * arrives here, and `operation` is a closed set of eight — so the ceiling is
   * 8 x (88 tables + `other`) = 712 series, a number fixed by the schema rather
   * than by traffic. That is above the default cap and below `maxSeries`.
   */
  db_query_duration_ms: {
    kind: 'histogram',
    help: 'Database statement latency in milliseconds, by operation and primary table',
    labelNames: ['operation', 'table'],
    maxSeries: 1_024,
  },
  db_query_errors_total: {
    kind: 'counter',
    help: 'Database statements that rejected, by operation and primary table',
    labelNames: ['operation', 'table'],
    maxSeries: 1_024,
  },
  db_request_queries: {
    kind: 'histogram',
    help: 'Database statements issued while serving one HTTP request',
    labelNames: ['method', 'route'],
  },
  db_request_duration_ms: {
    kind: 'histogram',
    help: 'Milliseconds one HTTP request spent inside database statements',
    labelNames: ['method', 'route'],
  },
  post_evaluation_total: {
    kind: 'counter',
    help: 'Jev shadow evaluations, by outcome and the model that answered (`none` when no model did)',
    labelNames: ['outcome', 'model'],
  },
  /**
   * Oxy egress instrumentation (`utils/oxyMetrics.ts`).
   *
   * `route` is templated and capped at 24 distinct values by that module before
   * it arrives here, and `method` and `status` are the closed sets
   * `boundedLabelValue` already enforces — so the ceiling is
   * 7 methods x 25 templates x 6 status classes = 1 050 series, a number fixed
   * by the cap rather than by traffic. Only a fraction is ever populated: this
   * codebase calls a handful of Oxy routes and almost all of them are GET.
   */
  oxy_call_duration_ms: {
    kind: 'histogram',
    help: 'Oxy API call latency in milliseconds, by route template',
    labelNames: ['method', 'route', 'status'],
    maxSeries: 1_024,
  },
  oxy_request_calls: {
    kind: 'histogram',
    help: 'Oxy API calls issued while serving one HTTP request',
    labelNames: ['method', 'route'],
  },
  oxy_request_duration_ms: {
    kind: 'histogram',
    help: 'Milliseconds one HTTP request spent waiting on Oxy',
    labelNames: ['method', 'route'],
  },
} as const satisfies Record<string, MetricDefinition>;

type MetricName = keyof typeof DEFINITIONS;

const ALLOWED_DESCRIPTORS = new Set([
  'following',
  'for_you',
  'explore',
  'videos',
  'media',
  'saved',
  'trending',
  'mutuals',
  'friends_popular',
  'friends_of_friends',
  'author',
  'custom',
  'hashtag',
  'topic',
  'list',
  'feedgen',
  'unknown',
]);
const ALLOWED_ORIGINS = new Set(['local', 'federated']);
const ALLOWED_SIGNALS = new Set(['view', 'skip']);
const ALLOWED_SHADOW = new Set(['true', 'false']);
const ALLOWED_LEGACY_POST_VARIANTS = new Set([
  'content-images',
  'top-level-media',
  'top-level-text',
  'content-location-object',
  'post-location-object',
]);
const MAX_SERIES_PER_METRIC = 256;
const LABEL_VALUE_PATTERN = /^[a-zA-Z0-9_.:-]{1,64}$/;
const MODEL_REFERENCE_PATTERN =
  /^[a-z0-9][a-z0-9._-]{0,39}\/[a-zA-Z0-9._:-]{1,80}(?:@[a-zA-Z0-9._:-]{1,40})?$/;

function seriesKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('|');
}

function boundedLabelValue(label: string, rawValue: string): string {
  const value = rawValue.trim();
  if (label === 'method') {
    return ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(value)
      ? value
      : 'OTHER';
  }
  if (label === 'status') {
    return ['1xx', '2xx', '3xx', '4xx', '5xx'].includes(value) ? value : 'other';
  }
  if (label === 'route') {
    return /^\/[a-zA-Z0-9_./:*-]{0,119}$/.test(value) ? value : '/other';
  }
  if (label === 'descriptor') {
    return ALLOWED_DESCRIPTORS.has(value) ? value : 'unknown';
  }
  if (label === 'origin') {
    return ALLOWED_ORIGINS.has(value) ? value : 'unknown';
  }
  if (label === 'signal') {
    return ALLOWED_SIGNALS.has(value) ? value : 'unknown';
  }
  if (label === 'shadow') {
    return ALLOWED_SHADOW.has(value) ? value : 'false';
  }
  if (label === 'variant') {
    return ALLOWED_LEGACY_POST_VARIANTS.has(value) ? value : 'other';
  }
  if (label === 'model') {
    // `publisher/model@revision`: a handful per decisions profile, so the
    // default series cap bounds it; anything else collapses to `other`.
    return MODEL_REFERENCE_PATTERN.test(value) || value === 'none' ? value : 'other';
  }
  return LABEL_VALUE_PATTERN.test(value) ? value : 'other';
}

/** One label set of one metric, as recorded since the last {@link MetricsCollector.reset}. */
export interface MetricSeries {
  metric: MetricName;
  labels: Readonly<Record<string, string>>;
  /** Observations (histogram) or increments (counter) recorded. */
  count: number;
  /** Sum of the observed values or increments. */
  sum: number;
  /** Last value set (gauge) or observed. */
  value: number;
}

function emfDefinition(metricName: MetricName, definition: MetricDefinition): EmfMetricDefinition {
  if (definition.kind === 'counter') return { name: metricName, unit: 'Count', kind: 'sum' };
  if (definition.kind === 'gauge') return { name: metricName, unit: 'None', kind: 'gauge' };
  return {
    name: metricName,
    unit: metricName.endsWith('_ms') ? 'Milliseconds' : 'None',
    kind: 'distribution',
  };
}

export class MetricsCollector {
  private readonly emfDefinitions = new Map<MetricName, EmfMetricDefinition>();
  private readonly series = new Map<string, Set<string>>();
  private readonly recorded = new Map<MetricName, Map<string, MetricSeries>>();

  constructor(private readonly publisher: EmfPublisher | null) {}

  recordLatency(metricName: MetricName, durationMs: number, labels?: MetricLabels): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const normalized = this.observe(metricName, 'histogram', durationMs, labels);

    if (durationMs > 1_000) {
      logger.warn('Slow operation detected', {
        metric: metricName,
        durationMs,
        labels: normalized,
      });
    }
  }

  /**
   * Observe a histogram sample that is NOT a duration.
   *
   * Separate from {@link recordLatency} because that method reads its argument
   * as milliseconds and warns above a one-second threshold. Feeding it a COUNT
   * would make "a request issued 1 001 queries" arrive in the logs as "slow
   * operation, 1001 ms" — a wrong statement about a real problem.
   */
  observeValue(metricName: MetricName, value: number, labels?: MetricLabels): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.observe(metricName, 'histogram', value, labels);
  }

  incrementCounter(metricName: MetricName, value = 1, labels?: MetricLabels): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.observe(metricName, 'counter', value, labels);
  }

  setGauge(metricName: MetricName, value: number, labels?: MetricLabels): void {
    if (!Number.isFinite(value)) return;
    this.observe(metricName, 'gauge', value, labels);
  }

  /** Test-only synchronous view of a bounded counter series. */
  getCounter(metricName: MetricName, labels?: MetricLabels): number {
    return this.lookup(metricName, 'counter', labels)?.sum ?? 0;
  }

  /** Test-only synchronous view of a bounded gauge series. */
  getGauge(metricName: MetricName, labels?: MetricLabels): number {
    return this.lookup(metricName, 'gauge', labels)?.value ?? 0;
  }

  /** Every label set recorded since the last reset, for one metric or all (tests). */
  getSeries(metricName?: MetricName): MetricSeries[] {
    const metricsToRead = metricName ? [metricName] : [...this.recorded.keys()];
    return metricsToRead.flatMap((name) =>
      [...(this.recorded.get(name)?.values() ?? [])].map((entry) => ({
        ...entry,
        labels: { ...entry.labels },
      })),
    );
  }

  reset(): void {
    this.recorded.clear();
    this.series.clear();
  }

  /** Flush the last interval during graceful shutdown. */
  stop(): void {
    this.publisher?.stop();
  }

  private observe(
    metricName: MetricName,
    kind: MetricKind,
    value: number,
    labels: MetricLabels | undefined,
  ): Record<string, string> {
    const definition = this.definitionFor(metricName, kind);
    const normalized = this.normalizeLabels(metricName, definition, labels);
    const key = seriesKey(normalized);
    const byLabels = this.recorded.get(metricName) ?? new Map<string, MetricSeries>();
    this.recorded.set(metricName, byLabels);
    const entry = byLabels.get(key) ?? {
      metric: metricName,
      labels: normalized,
      count: 0,
      sum: 0,
      value: 0,
    };
    entry.count += 1;
    entry.sum += value;
    entry.value = value;
    byLabels.set(key, entry);

    let emf = this.emfDefinitions.get(metricName);
    if (!emf) {
      emf = emfDefinition(metricName, definition);
      this.emfDefinitions.set(metricName, emf);
    }
    this.publisher?.record(emf, value, normalized);
    return normalized;
  }

  private lookup(
    metricName: MetricName,
    kind: MetricKind,
    labels: MetricLabels | undefined,
  ): MetricSeries | undefined {
    const definition = this.definitionFor(metricName, kind);
    const normalized = this.normalizeLabels(metricName, definition, labels, false);
    return this.recorded.get(metricName)?.get(seriesKey(normalized));
  }

  private definitionFor(metricName: MetricName, expectedKind: MetricKind): MetricDefinition {
    const definition = DEFINITIONS[metricName] as MetricDefinition | undefined;
    if (!definition) {
      throw new Error(`Unknown metric: ${String(metricName)}`);
    }
    if (definition.kind !== expectedKind) {
      throw new Error(`Metric ${metricName} is a ${definition.kind}, not a ${expectedKind}`);
    }
    return definition;
  }

  private normalizeLabels(
    metricName: MetricName,
    definition: MetricDefinition,
    labels?: MetricLabels,
    registerSeries = true,
  ): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const label of definition.labelNames) {
      normalized[label] = boundedLabelValue(label, String(labels?.[label] ?? 'unknown'));
    }

    if (!registerSeries) return normalized;

    const key = seriesKey(normalized);
    const knownSeries = this.series.get(metricName) ?? new Set<string>();
    const ceiling = definition.maxSeries ?? MAX_SERIES_PER_METRIC;
    // Reserve the final slot for the collapsed `other` series. Otherwise the
    // first overflow could create a 257th series before later values converge.
    if (!knownSeries.has(key) && knownSeries.size >= ceiling - 1) {
      for (const label of definition.labelNames) normalized[label] = 'other';
    }
    knownSeries.add(seriesKey(normalized));
    this.series.set(metricName, knownSeries);
    return normalized;
  }
}

/**
 * Published only on ECS, where CloudWatch extracts EMF from the task's
 * `awslogs` stream; anywhere else the lines would be noise in a terminal.
 */
export const metrics = new MetricsCollector(
  process.env.ECS_CONTAINER_METADATA_URI_V4
    ? createEmfPublisher({ namespace: 'Mention/Backend', service: 'mention' })
    : null,
);
