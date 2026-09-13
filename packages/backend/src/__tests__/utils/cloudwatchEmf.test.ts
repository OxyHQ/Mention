/**
 * `emitRequestMetrics` writes a raw stdout line, deliberately bypassing
 * `logger.info`'s sanitizer — see `utils/cloudwatchEmf.ts`'s module doc for
 * why (the sanitizer's depth cap would truncate exactly the `Dimensions`/
 * `Metrics` arrays CloudWatch's EMF parser needs). This pins the shape of
 * that line and the enabled/disabled gate, not the sanitizer itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../config';
import { emitRequestMetrics } from '../../utils/cloudwatchEmf';

describe('emitRequestMetrics', () => {
  let previousEnabled: boolean;
  let writeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    previousEnabled = config.cloudwatch.emfEnabled;
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    config.cloudwatch.emfEnabled = previousEnabled;
    writeSpy.mockRestore();
  });

  it('writes nothing when disabled', () => {
    config.cloudwatch.emfEnabled = false;

    emitRequestMetrics({ route: '/posts/:id', method: 'GET', durationMs: 12.3 });

    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('writes one EMF line naming every metric it was given', () => {
    config.cloudwatch.emfEnabled = true;

    emitRequestMetrics({
      route: '/posts/:id',
      method: 'GET',
      durationMs: 12.3,
      queryCount: 4,
      oxyCallCount: 2,
    });

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse((writeSpy.mock.calls[0]?.[0] as string).trim());

    expect(line.route).toBe('/posts/:id');
    expect(line.method).toBe('GET');
    expect(line.HttpRequestDurationMs).toBe(12.3);
    expect(line.QueryCount).toBe(4);
    expect(line.OxyCallCount).toBe(2);

    const [emfMetric] = line._aws.CloudWatchMetrics;
    expect(emfMetric.Namespace).toBe('Mention/Backend');
    expect(emfMetric.Dimensions).toEqual([['route', 'method']]);
    expect(emfMetric.Metrics).toEqual(expect.arrayContaining([
      { Name: 'HttpRequestDurationMs', Unit: 'Milliseconds' },
      { Name: 'QueryCount', Unit: 'Count' },
      { Name: 'OxyCallCount', Unit: 'Count' },
    ]));
  });

  it('omits QueryCount/OxyCallCount when the caller has no tally for them', () => {
    config.cloudwatch.emfEnabled = true;

    emitRequestMetrics({ route: '/health', method: 'GET', durationMs: 1 });

    const line = JSON.parse((writeSpy.mock.calls[0]?.[0] as string).trim());
    expect(line.QueryCount).toBeUndefined();
    expect(line.OxyCallCount).toBeUndefined();
    expect(line._aws.CloudWatchMetrics[0].Metrics).toEqual([
      { Name: 'HttpRequestDurationMs', Unit: 'Milliseconds' },
    ]);
  });
});
