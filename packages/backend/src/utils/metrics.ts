/**
 * Performance Metrics Utility
 *
 * An in-process, allocation-light collector for the feed/observability signals.
 * Counters, gauges and histograms are kept in memory and NEVER perform I/O on the
 * write path — the discovery gate increments a counter per rejected candidate
 * (~150 per feed request), so a write here must stay a Map update.
 *
 * Because production runs several ECS tasks behind an ALB, the in-memory value of
 * a counter is only ever a FRAGMENT of the truth (a `GET /metrics` scrape lands on
 * one arbitrary task). Cross-instance aggregation therefore happens OUT of band:
 * {@link MetricsCollector.drainCounterDeltas} hands the counter deltas accumulated
 * since the last drain to `services/metricsAggregator`, which pushes them to Redis
 * on a timer and renders the fleet-wide totals for `/metrics`.
 *
 * Split of responsibilities:
 *  - COUNTERS are monotonic and additive → aggregated across the fleet in Redis.
 *  - GAUGES and HISTOGRAMS are point-in-time / per-process values that cannot be
 *    summed across instances, so they stay local and are rendered per-instance.
 *    A quantity that must survive aggregation has to be modelled as a counter
 *    (see `feed_pool_candidates_total` in `mtn/feed/feedMetrics.ts`).
 */

import { logger } from './logger';

export interface MetricLabels {
  [key: string]: string | number;
}

export interface HistogramValue {
  value: number;
  labels?: MetricLabels;
}

/**
 * One counter time series: the metric name plus its canonical serialized label set
 * (`{origin="local"}`, or an empty string when the metric has no labels).
 */
export interface CounterSample {
  name: string;
  labelSet: string;
  value: number;
}

/** Latency above which an operation is considered slow and worth a log line. */
const SLOW_OPERATION_THRESHOLD_MS = 1000;

/** Maximum samples retained per histogram (bounds memory, enough for percentiles). */
const MAX_HISTOGRAM_SAMPLES = 1000;

export class MetricsCollector {
  /** Histograms for latency measurements (p50, p95, p99). Per-process. */
  private readonly histograms: Map<string, number[]> = new Map();

  /** Running counter totals observed by THIS process since it booted. */
  private readonly counters: Map<string, number> = new Map();

  /** Counter increments accumulated since the last {@link drainCounterDeltas}. */
  private readonly counterDeltas: Map<string, number> = new Map();

  /** Gauges for current values. Per-process. */
  private readonly gauges: Map<string, number> = new Map();

  /**
   * Record a latency measurement (histogram)
   */
  recordLatency(metricName: string, durationMs: number, labels?: MetricLabels): void {
    const key = this.getMetricKey(metricName, labels);
    const samples = this.histograms.get(key) ?? [];
    if (samples.length === 0) {
      this.histograms.set(key, samples);
    }

    samples.push(durationMs);

    // Keep only recent samples to prevent memory bloat.
    if (samples.length > MAX_HISTOGRAM_SAMPLES) {
      samples.shift();
    }

    if (durationMs > SLOW_OPERATION_THRESHOLD_MS) {
      logger.warn(`Slow operation detected: ${metricName} took ${durationMs}ms`, labels);
    }
  }

  /**
   * Increment a counter. Hot path: two Map writes, zero I/O, zero allocation
   * beyond the metric key.
   */
  incrementCounter(metricName: string, value: number = 1, labels?: MetricLabels): void {
    const key = this.getMetricKey(metricName, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
    this.counterDeltas.set(key, (this.counterDeltas.get(key) ?? 0) + value);
  }

  /**
   * Set a gauge value. Per-process only — a gauge cannot be aggregated across the
   * fleet (summing or last-writing point-in-time values is meaningless).
   */
  setGauge(metricName: string, value: number, labels?: MetricLabels): void {
    const key = this.getMetricKey(metricName, labels);
    this.gauges.set(key, value);
  }

  /**
   * Get percentile from histogram (p50, p95, p99)
   */
  getPercentile(metricName: string, percentile: number, labels?: MetricLabels): number {
    const key = this.getMetricKey(metricName, labels);
    const samples = this.histograms.get(key);
    if (!samples || samples.length === 0) {
      return 0;
    }

    const sorted = [...samples].sort((a, b) => a - b);
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)] ?? 0;
  }

  /**
   * Get this process's counter value. NOTE: this is the local fragment, not the
   * fleet-wide total (see `services/metricsAggregator` for the aggregate).
   */
  getCounter(metricName: string, labels?: MetricLabels): number {
    const key = this.getMetricKey(metricName, labels);
    return this.counters.get(key) ?? 0;
  }

  /**
   * Get gauge value
   */
  getGauge(metricName: string, labels?: MetricLabels): number {
    const key = this.getMetricKey(metricName, labels);
    return this.gauges.get(key) ?? 0;
  }

  /**
   * Take the counter increments accumulated since the last drain and clear them.
   * Called by the metrics aggregator on its flush tick; the caller owns the
   * returned deltas and MUST hand them back via {@link restoreCounterDeltas} if
   * it fails to persist them.
   */
  drainCounterDeltas(): CounterSample[] {
    const drained: CounterSample[] = [];
    for (const [key, value] of this.counterDeltas.entries()) {
      if (value === 0) continue;
      const [name, labelSet] = this.parseMetricKey(key);
      drained.push({ name, labelSet, value });
    }
    this.counterDeltas.clear();
    return drained;
  }

  /**
   * Put drained deltas back into the pending set (merging with anything recorded
   * in the meantime) so a failed flush is retried on the next tick instead of
   * losing counts.
   */
  restoreCounterDeltas(samples: CounterSample[]): void {
    for (const sample of samples) {
      const key = sample.labelSet ? `${sample.name}${sample.labelSet}` : sample.name;
      this.counterDeltas.set(key, (this.counterDeltas.get(key) ?? 0) + sample.value);
    }
  }

  /** This process's counter series (the local fragment of each total). */
  getCounterSamples(): CounterSample[] {
    const samples: CounterSample[] = [];
    for (const [key, value] of this.counters.entries()) {
      const [name, labelSet] = this.parseMetricKey(key);
      samples.push({ name, labelSet, value });
    }
    return samples;
  }

  /**
   * Render a Prometheus exposition document from this process's histograms and
   * gauges plus the supplied counter series. The aggregator passes the Redis
   * (fleet-wide) counters; {@link getPrometheusFormat} passes the local ones.
   */
  buildPrometheusDocument(counterSamples: CounterSample[]): string {
    return [
      ...this.buildHistogramLines(),
      ...buildSeriesLines(counterSamples, 'counter'),
      ...buildSeriesLines(this.getGaugeSamples(), 'gauge'),
    ].join('\n');
  }

  /**
   * Get all metrics as Prometheus-style format, using THIS process's counters.
   * Used as the fail-soft fallback when Redis is unavailable or not configured.
   */
  getPrometheusFormat(): string {
    return this.buildPrometheusDocument(this.getCounterSamples());
  }

  /**
   * Get metrics summary as JSON (local values only).
   */
  getMetricsSummary(): {
    histograms: Record<string, { p50: number; p95: number; p99: number; avg: number; count: number }>;
    counters: Record<string, number>;
    gauges: Record<string, number>;
  } {
    const histograms: Record<string, { p50: number; p95: number; p99: number; avg: number; count: number }> = {};
    const counters: Record<string, number> = {};
    const gauges: Record<string, number> = {};

    for (const [key, samples] of this.histograms.entries()) {
      if (samples.length === 0) continue;
      const [name] = this.parseMetricKey(key);
      const stats = summarize(samples);
      histograms[name] = {
        p50: stats.p50,
        p95: stats.p95,
        p99: stats.p99,
        avg: stats.avg,
        count: stats.count,
      };
    }

    for (const [key, value] of this.counters.entries()) {
      const [name] = this.parseMetricKey(key);
      counters[name] = value;
    }

    for (const [key, value] of this.gauges.entries()) {
      const [name] = this.parseMetricKey(key);
      gauges[name] = value;
    }

    return { histograms, counters, gauges };
  }

  /**
   * Reset all metrics (useful for testing)
   */
  reset(): void {
    this.histograms.clear();
    this.counters.clear();
    this.counterDeltas.clear();
    this.gauges.clear();
  }

  /** This process's gauge series. */
  private getGaugeSamples(): CounterSample[] {
    const samples: CounterSample[] = [];
    for (const [key, value] of this.gauges.entries()) {
      const [name, labelSet] = this.parseMetricKey(key);
      samples.push({ name, labelSet, value });
    }
    return samples;
  }

  /** Prometheus lines for the local latency histograms (one TYPE line per metric). */
  private buildHistogramLines(): string[] {
    const seriesByName = new Map<string, string[]>();

    for (const [key, samples] of this.histograms.entries()) {
      if (samples.length === 0) continue;

      const [name, labelSet] = this.parseMetricKey(key);
      const metricName = `${name}_duration_ms`;
      const stats = summarize(samples);
      const quantileLabels = (quantile: string): string =>
        labelSet ? `{quantile="${quantile}",${labelSet.slice(1)}` : `{quantile="${quantile}"}`;

      const series = seriesByName.get(metricName) ?? [];
      if (series.length === 0) {
        seriesByName.set(metricName, series);
      }
      series.push(
        `${metricName}${quantileLabels('0.5')} ${stats.p50}`,
        `${metricName}${quantileLabels('0.95')} ${stats.p95}`,
        `${metricName}${quantileLabels('0.99')} ${stats.p99}`,
        `${metricName}_sum${labelSet} ${stats.sum}`,
        `${metricName}_count${labelSet} ${stats.count}`,
        `${metricName}_avg${labelSet} ${stats.avg}`,
      );
    }

    const lines: string[] = [];
    for (const [metricName, series] of seriesByName.entries()) {
      lines.push(`# TYPE ${metricName} histogram`);
      lines.push(...series);
    }
    return lines;
  }

  /**
   * Generate metric key from name and labels
   */
  private getMetricKey(metricName: string, labels?: MetricLabels): string {
    if (!labels || Object.keys(labels).length === 0) {
      return metricName;
    }

    const labelParts = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}="${value}"`);

    return `${metricName}{${labelParts.join(',')}}`;
  }

  /**
   * Parse metric key back to name and serialized label set
   */
  private parseMetricKey(key: string): [string, string] {
    const braceIndex = key.indexOf('{');
    if (braceIndex === -1) {
      return [key, ''];
    }
    return [key.slice(0, braceIndex), key.slice(braceIndex)];
  }
}

/** Percentiles + totals for a histogram's retained samples. */
function summarize(samples: number[]): {
  p50: number;
  p95: number;
  p99: number;
  sum: number;
  count: number;
  avg: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (quantile: number): number => sorted[Math.ceil(quantile * sorted.length) - 1] ?? 0;
  const sum = samples.reduce((total, sample) => total + sample, 0);
  const count = samples.length;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), sum, count, avg: sum / count };
}

/**
 * Render counter/gauge series, grouped so exactly ONE `# TYPE` line is emitted per
 * metric name (a repeated TYPE line for the same metric is a Prometheus parse
 * error). Series are sorted for a stable, diffable exposition.
 */
function buildSeriesLines(samples: CounterSample[], type: 'counter' | 'gauge'): string[] {
  const seriesByName = new Map<string, CounterSample[]>();
  for (const sample of samples) {
    const series = seriesByName.get(sample.name) ?? [];
    if (series.length === 0) {
      seriesByName.set(sample.name, series);
    }
    series.push(sample);
  }

  const lines: string[] = [];
  for (const name of [...seriesByName.keys()].sort()) {
    const series = seriesByName.get(name) ?? [];
    lines.push(`# TYPE ${name} ${type}`);
    for (const sample of [...series].sort((a, b) => a.labelSet.localeCompare(b.labelSet))) {
      lines.push(`${name}${sample.labelSet} ${sample.value}`);
    }
  }
  return lines;
}

// Singleton instance
export const metrics = new MetricsCollector();

/**
 * Helper function to measure async operation duration
 */
export async function measureDuration<T>(
  metricName: string,
  operation: () => Promise<T>,
  labels?: MetricLabels
): Promise<T> {
  const start = Date.now();
  try {
    const result = await operation();
    const duration = Date.now() - start;
    metrics.recordLatency(metricName, duration, labels);
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    metrics.recordLatency(`${metricName}_error`, duration, labels);
    throw error;
  }
}

/**
 * Helper function to measure sync operation duration
 */
export function measureDurationSync<T>(
  metricName: string,
  operation: () => T,
  labels?: MetricLabels
): T {
  const start = Date.now();
  try {
    const result = operation();
    const duration = Date.now() - start;
    metrics.recordLatency(metricName, duration, labels);
    return result;
  } catch (error) {
    const duration = Date.now() - start;
    metrics.recordLatency(`${metricName}_error`, duration, labels);
    throw error;
  }
}
