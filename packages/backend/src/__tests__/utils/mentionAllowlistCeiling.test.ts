import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The server-side half of the per-post mention ceiling: the LOG that keeps it from
 * being a silent drop.
 *
 * `reconcileMentionIds` lives in `@mention/shared-types` because the client uses it
 * too, so it cannot log — it reports the pre-cap `total` instead, and
 * `reconcileMentionIdsForPost` is the wrapper every backend write boundary
 * (`PostCreationService.create`, the reply and boost paths in `feed.controller`,
 * `posts.controller`'s edit, `postEditSource.controller`) uses to turn that into a
 * warning. Its own truncation behaviour is pinned in the shared-types suite; what
 * is pinned here is that a truncation is never invisible.
 */

const mocks = vi.hoisted(() => ({ loggerWarn: vi.fn() }));

vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: mocks.loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { MAX_MENTIONS_PER_POST as CEILING } from '@mention/shared-types/mentions';
import { reconcileMentionIdsForPost } from '../../utils/textProcessing';

const body = (count: number): string =>
  Array.from({ length: count }, (_, i) => `[mention:u${i}]`).join(' ');
const ids = (count: number): string[] => Array.from({ length: count }, (_, i) => `u${i}`);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reconcileMentionIdsForPost', () => {
  it(`says nothing AT the ceiling (${CEILING})`, () => {
    const kept = reconcileMentionIdsForPost([body(CEILING)], ids(CEILING));

    expect(kept).toEqual(ids(CEILING));
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });

  it(`logs the truncation one over the ceiling (${CEILING + 1})`, () => {
    const kept = reconcileMentionIdsForPost([body(CEILING + 1)], ids(CEILING + 1));

    expect(kept).toHaveLength(CEILING);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      '[Mentions] truncated a post mention allowlist above the per-post ceiling',
      { mentioned: CEILING + 1, kept: CEILING },
    );
  });

  it('reports the real pre-cap count, not just "over"', () => {
    // A 25,000-character body has room for roughly 750 placeholders. The log has to
    // carry how many were actually dropped, or the cap tells nobody anything.
    reconcileMentionIdsForPost([body(700)], ids(700));

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      '[Mentions] truncated a post mention allowlist above the per-post ceiling',
      { mentioned: 700, kept: CEILING },
    );
  });

  it('does not warn when the surplus placeholders were never authorized', () => {
    // 700 placeholders, 3 authorized: nothing was truncated, so nothing is claimed.
    const kept = reconcileMentionIdsForPost([body(700)], ['u0', 'u5', 'u9']);

    expect(kept).toEqual(['u0', 'u5', 'u9']);
    expect(mocks.loggerWarn).not.toHaveBeenCalled();
  });
});
