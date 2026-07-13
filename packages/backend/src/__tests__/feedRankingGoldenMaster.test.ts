import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Redis is unavailable in unit tests; calculatePostScore never touches it (the
// engagement cache is either pinned in-context or computed pure), but mock it to
// match the other ranking suites' environment.
vi.mock('../utils/redis', () => ({
  getRedisClient: vi.fn().mockReturnValue({
    isReady: false,
    isOpen: false,
    connect: vi.fn().mockRejectedValue(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })),
    ping: vi.fn().mockRejectedValue(new Error('not connected')),
    get: vi.fn(),
    set: vi.fn(),
    setEx: vi.fn(),
    del: vi.fn(),
  }),
}));

import { FeedRankingService } from '../services/FeedRankingService';
import {
  FIXED_NOW,
  GOLDEN_CASES,
  runGoldenCase,
  type GoldenResult,
} from './fixtures/rankingGoldenMaster';
// The committed baseline is loaded at runtime (rather than a static JSON import)
// so it stays out of the `tsc` project file graph — the tsconfig `include`
// pattern is `**/*.ts` only.
const baseline: Record<string, GoldenResult> = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'rankingGoldenMaster.baseline.json'), 'utf8'),
);

/**
 * GOLDEN-MASTER parity test for the Phase 3 ranking-registry refactor.
 *
 * The committed baseline (`rankingGoldenMaster.baseline.json`) was captured by
 * running the PRE-refactor `FeedRankingService.calculatePostScore` over the exact
 * {@link GOLDEN_CASES} under the system clock pinned to {@link FIXED_NOW}. This
 * suite runs the REFACTORED orchestrator over the same cases under the same clock
 * and asserts EXACT (bit-for-bit, `Object.is`) equality of the finalScore and
 * every `_rank*` breakdown field.
 *
 * The refactor is deliberately behavior-preserving: signal multipliers are folded
 * in the same order (IEEE-754 multiplication is non-associative), and the sole
 * intended change — dropping the dead in-score diversity factor — was always
 * `× 1.0` on this path, so the output is unchanged. Any mismatch here means the
 * refactor altered ranking output and must be fixed (not re-baselined).
 */

const expected: Record<string, GoldenResult> = baseline;
const service = new FeedRankingService();

const FIELDS: (keyof GoldenResult)[] = [
  'finalScore',
  'engagement',
  'recency',
  'relationship',
  'personalization',
  'quality',
  'diversity',
];

describe('FeedRankingService Phase 3 registry — golden-master parity', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(FIXED_NOW));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  it('covers every fixture in the committed baseline (no silent drift)', () => {
    expect(GOLDEN_CASES.length).toBeGreaterThanOrEqual(40);
    expect(Object.keys(expected).length).toBe(GOLDEN_CASES.length);
    for (const testCase of GOLDEN_CASES) {
      expect(expected[testCase.name], `missing baseline for "${testCase.name}"`).toBeDefined();
    }
  });

  for (const testCase of GOLDEN_CASES) {
    it(`reproduces "${testCase.name}" exactly`, async () => {
      const actual = await runGoldenCase(service, testCase);
      const want = expected[testCase.name];
      for (const field of FIELDS) {
        // Exact equality (Object.is via toBe): the refactor is bit-for-bit
        // behavior-preserving, so no epsilon is needed.
        expect(actual[field], `${testCase.name}.${field}`).toBe(want[field]);
      }
    });
  }
});
