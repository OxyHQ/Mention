import { afterEach, describe, expect, it } from 'bun:test';
import type { EmfPublisher } from '@oxy.so/telemetry/metrics';
import { MetricsCollector, metrics } from '../../utils/metrics';

afterEach(() => {
  metrics.reset();
});

describe('bounded metrics registry', () => {
  it('rejects undeclared metric names at runtime', () => {
    const incrementUnknown = metrics.incrementCounter.bind(metrics) as (name: string) => void;

    expect(() => incrementUnknown('request_for_user_123')).toThrow('Unknown metric');
  });

  it('reserves a collapsed series before reaching the cardinality cap', async () => {
    for (let index = 0; index < 400; index += 1) {
      metrics.incrementCounter('feed_discovery_gated_total', 1, {
        reason: `reason_${index}`,
        source: `source_${index}`,
        shadow: 'false',
      });
    }

    const series = metrics.getSeries('feed_discovery_gated_total');

    expect(series.length).toBeLessThanOrEqual(256);
    expect(series.some(({ labels }) => labels.reason === 'other')).toBe(true);
  });

  it('publishes each observation to CloudWatch EMF with its labels as properties', () => {
    const published: unknown[] = [];
    const publisher: EmfPublisher = {
      record: (metric, value, labels) => published.push({ metric, value, labels }),
      flush: () => {},
      stop: () => {},
    };
    const collector = new MetricsCollector(publisher);

    collector.incrementCounter('trending_calculation_total', 1, { result: 'success' });
    collector.recordLatency('feed_ranking_duration_ms', 12);

    expect(published).toEqual([
      {
        metric: { name: 'trending_calculation_total', unit: 'Count', kind: 'sum' },
        value: 1,
        labels: { result: 'success' },
      },
      {
        metric: { name: 'feed_ranking_duration_ms', unit: 'Milliseconds', kind: 'distribution' },
        value: 12,
        labels: {},
      },
    ]);
  });
});
