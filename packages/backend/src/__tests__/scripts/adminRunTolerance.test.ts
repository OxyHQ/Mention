import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The completion guard's EXPLICIT tolerance.
 *
 * `assertAdminRunComplete` used to fail a run on any non-zero counter. That is
 * right for a bounded sweep we fully control, and it stays the default. It is
 * unmeetable for a sweep over the open fediverse: across ~165,000 remote origins
 * some are always down, so a strict guard makes a full-scale run incapable of
 * ever completing cleanly.
 *
 * The two rules this file exists to pin down:
 *  - a kind the caller did NOT list stays strict — it fails at count 1, forever;
 *  - a kind the caller DID list passes only up to its stated fraction of scanned,
 *    and a tolerated-but-non-zero rate is still logged, so a sweep degrading from
 *    2% to 30% is visible in the log even though both runs "pass".
 */

vi.mock('../../queue/queues', () => ({ closeQueues: vi.fn() }));
vi.mock('../../queue/connection', () => ({ closeQueueConnection: vi.fn() }));

import { assertAdminRunComplete } from '../../scripts/lib/adminScriptLifecycle';
import { logger } from '../../utils/logger';

/** The tolerated-failure warnings the guard emitted. */
function toleranceWarnings(): Record<string, unknown>[] {
  return vi
    .mocked(logger.warn)
    .mock.calls.filter(([message]) => message === '[adminScript] run completed with tolerated failures')
    .map(([, context]) => context as Record<string, unknown>);
}

/** A sweep that allows unreachable origins up to 10% of scanned. */
const REMOTE_TOLERANCE = {
  scanned: 600,
  tolerate: {
    remoteUnavailable: {
      maxFraction: 0.1,
      reason: 'origins that are down or rate-limiting, unavoidable at fediverse scale',
    },
  },
} as const;

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
});

describe('assertAdminRunComplete — default (no options) stays strict', () => {
  it('passes when every counter is zero', () => {
    expect(() => assertAdminRunComplete('sweep', { failed: 0, skipped: 0 })).not.toThrow();
  });

  it('throws at a count of ONE, naming every non-zero counter', () => {
    expect(() => assertAdminRunComplete('sweep', { failed: 1 })).toThrow(
      '[sweep] run incomplete: failed=1',
    );
    expect(() => assertAdminRunComplete('sweep', { failed: 2, skipped: 1, partial: 0 })).toThrow(
      '[sweep] run incomplete: failed=2, skipped=1',
    );
  });

  it('logs no tolerance warning, because nothing was tolerated', () => {
    expect(() => assertAdminRunComplete('sweep', { failed: 1 })).toThrow();
    expect(toleranceWarnings()).toHaveLength(0);
  });
});

describe('assertAdminRunComplete — a tolerated kind', () => {
  it('passes UNDER the stated fraction', () => {
    // The measured production baseline: 12 of 600 = 2%, well inside 10%.
    expect(() =>
      assertAdminRunComplete('sweep', { remoteUnavailable: 12 }, REMOTE_TOLERANCE),
    ).not.toThrow();
  });

  it('passes exactly AT the stated fraction (the ceiling is inclusive)', () => {
    expect(() =>
      assertAdminRunComplete('sweep', { remoteUnavailable: 60 }, REMOTE_TOLERANCE),
    ).not.toThrow();
  });

  it('throws ABOVE the stated fraction, naming the rate, the ceiling and the reason', () => {
    expect(() =>
      assertAdminRunComplete('sweep', { remoteUnavailable: 61 }, REMOTE_TOLERANCE),
    ).toThrow(/remoteUnavailable=61 \(10\.17% of 600 scanned, over the 10\.00% allowed for: origins that are down/);
  });

  it('WARNS whenever a tolerated kind is non-zero, with the rate and the threshold', () => {
    assertAdminRunComplete('sweep', { remoteUnavailable: 12 }, REMOTE_TOLERANCE);

    const warnings = toleranceWarnings();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toEqual({
      script: 'sweep',
      scanned: 600,
      tolerated: [{ issue: 'remoteUnavailable', count: 12, rate: 0.02, threshold: 0.1 }],
    });
  });

  it('does not warn when the tolerated kind is zero', () => {
    assertAdminRunComplete('sweep', { remoteUnavailable: 0 }, REMOTE_TOLERANCE);
    expect(toleranceWarnings()).toHaveLength(0);
  });

  it('refuses to tolerate anything when NOTHING was scanned — a fraction of zero is undefined', () => {
    expect(() =>
      assertAdminRunComplete('sweep', { remoteUnavailable: 3 }, { ...REMOTE_TOLERANCE, scanned: 0 }),
    ).toThrow('nothing scanned; no rate to measure');
  });

  it('treats an explicit maxFraction of 0 as strict', () => {
    expect(() =>
      assertAdminRunComplete(
        'sweep',
        { remoteUnavailable: 1 },
        {
          scanned: 600,
          tolerate: { remoteUnavailable: { maxFraction: 0, reason: 'listed but not allowed' } },
        },
      ),
    ).toThrow('[sweep] run incomplete: remoteUnavailable=1');
  });
});

describe('assertAdminRunComplete — an UNTOLERATED kind alongside a tolerated one', () => {
  it('throws at a count of ONE even while the tolerated kind is within budget', () => {
    // Our side failing (a payload we could not parse) is never a matter of rate.
    expect(() =>
      assertAdminRunComplete(
        'sweep',
        { remoteUnavailable: 12, malformedPayload: 1 },
        REMOTE_TOLERANCE,
      ),
    ).toThrow('[sweep] run incomplete: malformedPayload=1');
  });

  it('still reports the tolerated kind in the warning when the run fails on another', () => {
    expect(() =>
      assertAdminRunComplete(
        'sweep',
        { remoteUnavailable: 12, malformedPayload: 1 },
        REMOTE_TOLERANCE,
      ),
    ).toThrow();

    expect(toleranceWarnings()[0].tolerated).toEqual([
      { issue: 'remoteUnavailable', count: 12, rate: 0.02, threshold: 0.1 },
    ]);
  });

  it('names BOTH kinds when the tolerated one is also over its ceiling', () => {
    const error = (() => {
      try {
        assertAdminRunComplete(
          'sweep',
          { remoteUnavailable: 300, malformedPayload: 2 },
          REMOTE_TOLERANCE,
        );
        return null;
      } catch (err) {
        return err as Error;
      }
    })();

    expect(error?.message).toContain('remoteUnavailable=300');
    expect(error?.message).toContain('malformedPayload=2');
  });
});
