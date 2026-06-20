import { describe, it, expect } from 'vitest';
import { classifyUpstreamStatus, type UpstreamStatusClass } from '../../routes/mediaProxyStatus';

/**
 * The proxy used to relay ANY non-200/206 upstream status as our 502, so remote
 * 403/404 (deleted/forbidden/hotlink-protected media) inflated our 5xx rate.
 * These cases pin the corrected mapping: only genuine upstream 5xx (and
 * connection failures, handled at the route layer) are gateway errors.
 */
describe('classifyUpstreamStatus', () => {
  const cases: ReadonlyArray<[number, UpstreamStatusClass]> = [
    // Media bodies we relay.
    [200, 'media'],
    [206, 'media'],
    // Conditional + range special cases.
    [304, 'not-modified'],
    [416, 'range-not-satisfiable'],
    // Client-class → we answer 404 (the prod-dominant 403/404, plus 410/401/etc.).
    [400, 'client-error'],
    [401, 'client-error'],
    [403, 'client-error'],
    [404, 'client-error'],
    [410, 'client-error'],
    [429, 'client-error'],
    // Server-class → genuine upstream error → we answer 502.
    [500, 'upstream-error'],
    [502, 'upstream-error'],
    [503, 'upstream-error'],
    [504, 'upstream-error'],
    [599, 'upstream-error'],
    // Unrelayable / unexpected statuses → treated as a gateway problem.
    [0, 'upstream-error'],
    [100, 'upstream-error'],
    [301, 'upstream-error'],
    [600, 'upstream-error'],
  ];

  it.each(cases)('maps upstream %i → %s', (status, expected) => {
    expect(classifyUpstreamStatus(status)).toBe(expected);
  });

  it('classifies the full 4xx range as client-error (except 416)', () => {
    for (let status = 400; status <= 499; status++) {
      if (status === 416) continue;
      expect(classifyUpstreamStatus(status)).toBe('client-error');
    }
  });

  it('classifies the full 5xx range as upstream-error', () => {
    for (let status = 500; status <= 599; status++) {
      expect(classifyUpstreamStatus(status)).toBe('upstream-error');
    }
  });
});
