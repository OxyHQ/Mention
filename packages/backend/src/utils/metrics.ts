/**
 * Performance Metrics Utility
 * Collects and exports metrics for monitoring feed performance
 * Supports Prometheus/StatsD-style metrics
 */

import { logger } from './logger';

export interface MetricLabels {
  [key: string]: string | number;
}

export interface HistogramValue {
  value: number;
  labels?: MetricLabels;
}

class MetricsCollector {
  // Histograms for latency measurements (p50, p95, p99)
  private histograms: Map<string, number[]> = new Map();
  
  // Counters for event counting
  private counters: Map<string, number> = new Map();
  
  // Gauges for current values
  private gauges: Map<string, number> = new Map();
  
  // Maximum samples to keep per histogram (for percentile calculation)
  private readonly MAX_HISTOGRAM_SAMPLES = 1000;

  /**
   * Record a latency measurement (histogram)
   */
  recordLatency(metricName: string, durationMs: number, labels?: MetricLabels): void {
    const key = this.getMetricKey(metricName, labels);
    if (!this.histograms.has(key)) {
      this.histograms.set(key, []);
    }
    
    const samples = this.histograms.get(key)!;
    samples.push(durationMs);
    
    // Keep only recent samples to prevent memory bloat
    if (samples.length > this.MAX_HISTOGRAM_SAMPLES) {
      samples.shift(); // Remove oldest
    }
    
    // Log slow operations
    if (durationMs > 1000) {
      logger.warn(`Slow operation detected: ${metricName} took ${durationMs}ms`, labels);
    }
  }

  /**
   * Increment a counter
   */
  incrementCounter(metricName: string, value: number = 1, labels?: MetricLabels): void {
    const key = this.getMetricKey(metricName, labels);
    const current = this.counters.get(key) || 0;
    this.counters.set(key, current + value);
  }

  /**
   * Set a gauge value
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
    return sorted[Math.max(0, index)] || 0;
  }

  /**
   * Get counter value
   */
  getCounter(metricName: string, labels?: MetricLabels): number {
    const key = this.getMetricKey(metricName, labels);
    return this.counters.get(key) || 0;
  }

  /**
   * Get gauge value
   */
  getGauge(metricName: string, labels?: MetricLabels): number {
    const key = this.getMetricKey(metricName, labels);
    return this.gauges.get(key) || 0;
  }

  /**
   * Get all metrics as Prometheus-style format
   */
  getPrometheusFormat(): string {
    const lines: string[] = [];
    
    // Histograms
    for (const [key, samples] of this.histograms.entries()) {
      if (samples.length === 0) continue;
      
      const sorted = [...samples].sort((a, b) => a - b);
      const p50 = sorted[Math.ceil(0.5 * sorted.length) - 1] || 0;
      const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1] || 0;
      const p99 = sorted[Math.ceil(0.99 * sorted.length) - 1] || 0;
      const sum = samples.reduce((a, b) => a + b, 0);
      const count = samples.length;
      const avg = sum / count;
      
      const [name, labelStr] = this.parseMetricKey(key);
      lines.push(`# TYPE ${name}_duration_ms histogram`);
      lines.push(`${name}_duration_ms{quantile="0.5"${labelStr}} ${p50}`);
      lines.push(`${name}_duration_ms{quantile="0.95"${labelStr}} ${p95}`);
      lines.push(`${name}_duration_ms{quantile="0.99"${labelStr}} ${p99}`);
      lines.push(`${name}_duration_ms_sum${labelStr} ${sum}`);
      lines.push(`${name}_duration_ms_count${labelStr} ${count}`);
      lines.push(`${name}_duration_ms_avg${labelStr} ${avg}`);
    }
    
    // Counters
    for (const [key, value] of this.counters.entries()) {
      const [name, labelStr] = this.parseMetricKey(key);
      lines.push(`# TYPE ${name} counter`);
      lines.push(`${name}${labelStr} ${value}`);
    }
    
    // Gauges
    for (const [key, value] of this.gauges.entries()) {
      const [name, labelStr] = this.parseMetricKey(key);
      lines.push(`# TYPE ${name} gauge`);
      lines.push(`${name}${labelStr} ${value}`);
    }
    
    return lines.join('\n');
  }

  /**
   * Get metrics summary as JSON
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
      const sorted = [...samples].sort((a, b) => a - b);
      const p50 = sorted[Math.ceil(0.5 * sorted.length) - 1] || 0;
      const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1] || 0;
      const p99 = sorted[Math.ceil(0.99 * sorted.length) - 1] || 0;
      const sum = samples.reduce((a, b) => a + b, 0);
      const count = samples.length;
      const avg = sum / count;
      
      histograms[name] = { p50, p95, p99, avg, count };
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
    this.gauges.clear();
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
   * Parse metric key back to name and labels
   */
  private parseMetricKey(key: string): [string, string] {
    const match = key.match(/^([^{]+)(\{.*\})?$/);
    if (!match) {
      return [key, ''];
    }
    
    const name = match[1];
    const labels = match[2] || '';
    return [name, labels];
  }
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

