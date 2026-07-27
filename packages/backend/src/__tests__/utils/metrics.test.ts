import { afterEach, describe, expect, it } from 'vitest';
import { metrics } from '../../utils/metrics';

afterEach(() => {
  metrics.reset();
});

describe('bounded metrics registry', () => {
  it('rejects undeclared metric names at runtime', () => {
    const incrementUnknown = metrics.incrementCounter.bind(metrics) as (
      name: string,
    ) => void;

    expect(() => incrementUnknown('request_for_user_123')).toThrow(
      'Unknown metric',
    );
  });

  it('reserves a collapsed series before reaching the cardinality cap', async () => {
    for (let index = 0; index < 400; index += 1) {
      metrics.incrementCounter('feed_discovery_gated_total', 1, {
        reason: `reason_${index}`,
        source: `source_${index}`,
        shadow: 'false',
      });
    }

    const output = await metrics.getPrometheusFormat();
    const series = output
      .split('\n')
      .filter((line) => line.startsWith('feed_discovery_gated_total{'));

    expect(series.length).toBeLessThanOrEqual(256);
    expect(series.some((line) => line.includes('reason="other"'))).toBe(true);
  });
});
