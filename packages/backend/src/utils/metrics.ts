import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  type CounterConfiguration,
  type GaugeConfiguration,
  type HistogramConfiguration,
} from 'prom-client';
import { logger } from './logger';

export interface MetricLabels {
  [key: string]: string | number;
}

type MetricKind = 'counter' | 'gauge' | 'histogram';

interface MetricDefinition {
  kind: MetricKind;
  help: string;
  labelNames: readonly string[];
  buckets?: readonly number[];
}

const DEFINITIONS: Record<string, MetricDefinition> = {
  feed_discovery_gated_total: {
    kind: 'counter',
    help: 'Feed discovery candidates rejected by the discovery gate',
    labelNames: ['reason', 'source', 'shadow'],
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
  http_requests_total: {
    kind: 'counter',
    help: 'HTTP requests by normalized route and result',
    labelNames: ['method', 'route', 'status'],
  },
  web_vital_lcp_ms: {
    kind: 'histogram',
    help: 'Real-user Largest Contentful Paint in milliseconds',
    labelNames: ['route', 'rating', 'navigation'],
    buckets: [250, 500, 1_000, 1_500, 2_000, 2_500, 4_000, 6_000, 10_000, 30_000],
  },
  web_vital_inp_ms: {
    kind: 'histogram',
    help: 'Real-user Interaction to Next Paint in milliseconds',
    labelNames: ['route', 'rating', 'navigation'],
    buckets: [25, 50, 100, 150, 200, 300, 500, 1_000, 2_500, 10_000],
  },
  web_vital_cls_ratio: {
    kind: 'histogram',
    help: 'Real-user Cumulative Layout Shift score',
    labelNames: ['route', 'rating', 'navigation'],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  },
  web_runtime_events_total: {
    kind: 'counter',
    help: 'Bounded browser load, navigation and runtime error events',
    labelNames: ['kind', 'route', 'result'],
  },
};

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
const MAX_SERIES_PER_METRIC = 256;
const METRIC_NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_VALUE_PATTERN = /^[a-zA-Z0-9_.:-]{1,64}$/;
const HISTOGRAM_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000];

type PromMetric = Counter<string> | Gauge<string> | Histogram<string>;

function seriesKey(labels: Record<string, string>): string {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('|');
}

function summaryKey(metricName: string, labels: Record<string, string>): string {
  const key = seriesKey(labels);
  return key ? `${metricName}{${key}}` : metricName;
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
  return LABEL_VALUE_PATTERN.test(value) ? value : 'other';
}

class MetricsCollector {
  readonly registry = new Registry();
  readonly contentType = this.registry.contentType;

  private readonly collectors = new Map<string, PromMetric>();
  private readonly series = new Map<string, Set<string>>();
  private readonly counterValues = new Map<string, number>();
  private readonly gaugeValues = new Map<string, number>();
  private readonly histogramValues = new Map<string, number[]>();

  constructor() {
    collectDefaultMetrics({
      register: this.registry,
      prefix: 'mention_',
    });
  }

  recordLatency(metricName: string, durationMs: number, labels?: MetricLabels): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const definition = this.definitionFor(metricName, 'histogram');
    const normalized = this.normalizeLabels(metricName, definition, labels);
    const histogram = this.collectorFor(metricName, definition) as Histogram<string>;
    histogram.observe(normalized, durationMs);

    const key = summaryKey(metricName, normalized);
    const samples = this.histogramValues.get(key) ?? [];
    samples.push(durationMs);
    if (samples.length > 1_000) samples.shift();
    this.histogramValues.set(key, samples);

    if (durationMs > 1_000) {
      logger.warn('Slow operation detected', {
        metric: metricName,
        durationMs,
        labels: normalized,
      });
    }
  }

  incrementCounter(metricName: string, value = 1, labels?: MetricLabels): void {
    if (!Number.isFinite(value) || value < 0) return;
    const definition = this.definitionFor(metricName, 'counter');
    const normalized = this.normalizeLabels(metricName, definition, labels);
    const counter = this.collectorFor(metricName, definition) as Counter<string>;
    counter.inc(normalized, value);

    const key = summaryKey(metricName, normalized);
    this.counterValues.set(key, (this.counterValues.get(key) ?? 0) + value);
  }

  setGauge(metricName: string, value: number, labels?: MetricLabels): void {
    if (!Number.isFinite(value)) return;
    const definition = this.definitionFor(metricName, 'gauge');
    const normalized = this.normalizeLabels(metricName, definition, labels);
    const gauge = this.collectorFor(metricName, definition) as Gauge<string>;
    gauge.set(normalized, value);
    this.gaugeValues.set(summaryKey(metricName, normalized), value);
  }

  getPercentile(metricName: string, percentile: number, labels?: MetricLabels): number {
    const definition = this.definitionFor(metricName, 'histogram');
    const normalized = this.normalizeLabels(metricName, definition, labels, false);
    const samples = this.histogramValues.get(summaryKey(metricName, normalized));
    if (!samples?.length) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1);
    return sorted[index] ?? 0;
  }

  getCounter(metricName: string, labels?: MetricLabels): number {
    const definition = this.definitionFor(metricName, 'counter');
    const normalized = this.normalizeLabels(metricName, definition, labels, false);
    return this.counterValues.get(summaryKey(metricName, normalized)) ?? 0;
  }

  getGauge(metricName: string, labels?: MetricLabels): number {
    const definition = this.definitionFor(metricName, 'gauge');
    const normalized = this.normalizeLabels(metricName, definition, labels, false);
    return this.gaugeValues.get(summaryKey(metricName, normalized)) ?? 0;
  }

  async getPrometheusFormat(): Promise<string> {
    return this.registry.metrics();
  }

  getMetricsSummary(): {
    histograms: Record<string, { p50: number; p95: number; p99: number; avg: number; count: number }>;
    counters: Record<string, number>;
    gauges: Record<string, number>;
  } {
    const histograms: Record<
      string,
      { p50: number; p95: number; p99: number; avg: number; count: number }
    > = {};
    for (const [key, values] of this.histogramValues) {
      const metricName = key.split('{')[0];
      const sorted = [...values].sort((a, b) => a - b);
      const percentile = (fraction: number) =>
        sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
      histograms[metricName] = {
        p50: percentile(0.5),
        p95: percentile(0.95),
        p99: percentile(0.99),
        avg: values.reduce((sum, value) => sum + value, 0) / values.length,
        count: values.length,
      };
    }

    return {
      histograms,
      counters: this.collapseSummary(this.counterValues),
      gauges: this.collapseSummary(this.gaugeValues),
    };
  }

  reset(): void {
    this.registry.resetMetrics();
    this.counterValues.clear();
    this.gaugeValues.clear();
    this.histogramValues.clear();
    this.series.clear();
  }

  private collapseSummary(values: Map<string, number>): Record<string, number> {
    const output: Record<string, number> = {};
    for (const [key, value] of values) {
      output[key.split('{')[0]] = value;
    }
    return output;
  }

  private definitionFor(metricName: string, fallbackKind: MetricKind): MetricDefinition {
    if (!METRIC_NAME_PATTERN.test(metricName)) {
      throw new Error(`Invalid metric name: ${metricName}`);
    }
    return (
      DEFINITIONS[metricName] ?? {
        kind: fallbackKind,
        help: metricName,
        labelNames: [],
      }
    );
  }

  private normalizeLabels(
    metricName: string,
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
    if (!knownSeries.has(key) && knownSeries.size >= MAX_SERIES_PER_METRIC) {
      for (const label of definition.labelNames) normalized[label] = 'other';
    }
    knownSeries.add(seriesKey(normalized));
    this.series.set(metricName, knownSeries);
    return normalized;
  }

  private collectorFor(metricName: string, definition: MetricDefinition): PromMetric {
    const existing = this.collectors.get(metricName);
    if (existing) return existing;

    let collector: PromMetric;
    const common = {
      name: metricName,
      help: definition.help,
      labelNames: [...definition.labelNames],
      registers: [this.registry],
    };
    if (definition.kind === 'counter') {
      collector = new Counter(common as CounterConfiguration<string>);
    } else if (definition.kind === 'gauge') {
      collector = new Gauge(common as GaugeConfiguration<string>);
    } else {
      collector = new Histogram({
        ...common,
        buckets: definition.buckets ? [...definition.buckets] : HISTOGRAM_BUCKETS_MS,
      } as HistogramConfiguration<string>);
    }
    this.collectors.set(metricName, collector);
    return collector;
  }
}

export const metrics = new MetricsCollector();

export async function measureDuration<T>(
  metricName: string,
  operation: () => Promise<T>,
  labels?: MetricLabels,
): Promise<T> {
  const start = Date.now();
  try {
    return await operation();
  } finally {
    metrics.recordLatency(metricName, Date.now() - start, labels);
  }
}

export function measureDurationSync<T>(
  metricName: string,
  operation: () => T,
  labels?: MetricLabels,
): T {
  const start = Date.now();
  try {
    return operation();
  } finally {
    metrics.recordLatency(metricName, Date.now() - start, labels);
  }
}
