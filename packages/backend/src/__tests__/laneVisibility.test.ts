import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The two curation rules — and they are exactly the pair somebody collapses into
 * one later, so each is asserted on its own:
 *
 *  - `tab` removes a post from the MAIN tab only. The lane still has its own tab.
 *  - `hidden` removes it from EVERY profile tab, the owner's own view included.
 *
 * Plus the fail-soft direction, which is not arbitrary: a lookup failure must
 * degrade to an UNCURATED profile, never an empty one.
 */

const laneFind = vi.fn();
const laneExists = vi.fn();
vi.mock('../models/Lane', () => ({
  Lane: {
    find: (...args: unknown[]) => laneFind(...args),
    exists: (...args: unknown[]) => laneExists(...args),
  },
}));

import {
  excludedDisplayModesForTab,
  loadExcludedLaneIds,
  ownerHasProfileAffectingLane,
} from '../services/laneVisibility';

function findResolves(docs: Array<{ _id: string }>): void {
  laneFind.mockReturnValue({ lean: () => Promise.resolve(docs) });
}

beforeEach(() => {
  laneFind.mockReset();
  laneExists.mockReset();
  findResolves([]);
  laneExists.mockResolvedValue(null);
});

describe('excludedDisplayModesForTab', () => {
  it('takes BOTH tab and hidden off the main tab', () => {
    expect(excludedDisplayModesForTab('posts')).toEqual(['tab', 'hidden']);
  });

  it.each(['replies', 'media', 'videos', 'boosts', 'likes'] as const)(
    'takes only hidden off the %s tab — a `tab` lane is still on the profile',
    (filter) => {
      expect(excludedDisplayModesForTab(filter)).toEqual(['hidden']);
    },
  );

  it('never returns mixed — a mixed lane is indistinguishable from no lane', () => {
    for (const filter of ['posts', 'replies', 'media', 'videos', 'boosts', 'likes'] as const) {
      expect(excludedDisplayModesForTab(filter)).not.toContain('mixed');
    }
  });
});

describe('loadExcludedLaneIds', () => {
  it('queries the publisher\'s lanes in the requested modes and returns their ids', async () => {
    findResolves([{ _id: 'lane-1' }, { _id: 'lane-2' }]);

    const ids = await loadExcludedLaneIds('user', 'u1', ['tab', 'hidden']);

    expect(laneFind).toHaveBeenCalledWith(
      { ownerType: 'user', ownerId: 'u1', displayMode: { $in: ['tab', 'hidden'] } },
      { _id: 1 },
    );
    expect(ids).toEqual(['lane-1', 'lane-2']);
  });

  it('scopes by owner TYPE, so a channel lane never curates a user profile', async () => {
    await loadExcludedLaneIds('channel', 'c1', ['hidden']);
    expect(laneFind).toHaveBeenCalledWith(
      { ownerType: 'channel', ownerId: 'c1', displayMode: { $in: ['hidden'] } },
      { _id: 1 },
    );
  });

  it('skips the query entirely for a missing owner or an empty mode set', async () => {
    expect(await loadExcludedLaneIds('user', '', ['hidden'])).toEqual([]);
    expect(await loadExcludedLaneIds('user', 'u1', [])).toEqual([]);
    expect(laneFind).not.toHaveBeenCalled();
  });

  it('fails soft toward an UNCURATED profile, never an empty one', async () => {
    laneFind.mockReturnValue({ lean: () => Promise.reject(new Error('mongo down')) });

    // `[]` means "exclude nothing", so a lookup failure shows a post the owner
    // meant to tuck away — far smaller harm than showing them nothing at all.
    await expect(loadExcludedLaneIds('user', 'u1', ['hidden'])).resolves.toEqual([]);
  });
});

describe('ownerHasProfileAffectingLane', () => {
  it('probes only the modes that remove posts from a profile', async () => {
    laneExists.mockResolvedValue({ _id: 'lane-1' });

    await expect(ownerHasProfileAffectingLane('u1')).resolves.toBe(true);
    expect(laneExists).toHaveBeenCalledWith({
      ownerType: 'user',
      ownerId: 'u1',
      displayMode: { $in: ['tab', 'hidden'] },
    });
  });

  it('answers false when the author has no curated lane', async () => {
    laneExists.mockResolvedValue(null);
    await expect(ownerHasProfileAffectingLane('u1')).resolves.toBe(false);
  });

  it('answers false without a query for a missing owner', async () => {
    await expect(ownerHasProfileAffectingLane('')).resolves.toBe(false);
    expect(laneExists).not.toHaveBeenCalled();
  });

  it('fails soft to false, leaving the pre-lane sync behaviour intact', async () => {
    laneExists.mockRejectedValue(new Error('mongo down'));
    await expect(ownerHasProfileAffectingLane('u1')).resolves.toBe(false);
  });
});
