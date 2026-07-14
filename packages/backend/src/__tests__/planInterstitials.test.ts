import { describe, it, expect } from 'vitest';
import { MtnConfig } from '@mention/shared-types';
import type { FeedPostSlice } from '@mention/shared-types';
import { planInterstitials } from '../mtn/feed/interstitials/planInterstitials';

const INTERSTITIALS = MtnConfig.feed.interstitials;

/**
 * Slices carrying only what the planner reads (`_sliceKey`). The planner never
 * looks inside `items`, which is exactly why it can run with zero I/O.
 */
function makeSlices(count: number): FeedPostSlice[] {
  return Array.from({ length: count }, (_, index) => ({
    _sliceKey: `slice-${index}`,
    items: [],
    isIncompleteThread: false,
  }));
}

/** Follow counts that land squarely in each graph temperature. */
const COLD_FOLLOWING = INTERSTITIALS.coldMaxFollowing - 1;
const WARM_FOLLOWING = INTERSTITIALS.coldMaxFollowing;
const DENSE_FOLLOWING = INTERSTITIALS.denseMinFollowing + 1;

const FULL_PAGE = 30;

const VIEWER_ID = 'viewer-1';
const SUBJECT_ID = 'author-1';

describe('planInterstitials', () => {
  describe('descriptor allowlist', () => {
    it('plans slots for every allowed descriptor', () => {
      for (const descriptor of INTERSTITIALS.allowedDescriptors) {
        const slots = planInterstitials({
          descriptor,
          slices: makeSlices(FULL_PAGE),
          followingCount: WARM_FOLLOWING,
          isFirstPage: true,
        });
        expect(slots.length).toBeGreaterThan(0);
      }
    });

    it('plans nothing for a descriptor outside the allowlist', () => {
      // The author feed is absent here on purpose: it is not on the home
      // allowlist, but it carries its own card via the profile path below.
      for (const descriptor of ['saved', 'videos', 'hashtag|cats', 'list|list-1', 'topic|space']) {
        expect(
          planInterstitials({
            descriptor,
            slices: makeSlices(FULL_PAGE),
            followingCount: WARM_FOLLOWING,
            isFirstPage: true,
          }),
        ).toEqual([]);
      }
    });

    it('never plans a similarAccounts card on a non-author feed', () => {
      const descriptors = [
        ...INTERSTITIALS.allowedDescriptors,
        'saved',
        'videos',
        'hashtag|cats',
        'custom|feed-1',
      ];

      for (const descriptor of descriptors) {
        for (const followingCount of [COLD_FOLLOWING, WARM_FOLLOWING, DENSE_FOLLOWING]) {
          const slots = planInterstitials({
            descriptor,
            slices: makeSlices(FULL_PAGE),
            followingCount,
            isFirstPage: true,
            currentUserId: VIEWER_ID,
          });
          expect(slots.every((slot) => slot.kind !== 'similarAccounts')).toBe(true);
          expect(slots.every((slot) => slot.subjectId === undefined)).toBe(true);
        }
      }
    });

    it('matches on the BASE descriptor, ignoring a parameter suffix', () => {
      const slots = planInterstitials({
        descriptor: 'explore|trending',
        slices: makeSlices(FULL_PAGE),
        followingCount: WARM_FOLLOWING,
        isFirstPage: true,
      });
      expect(slots.length).toBeGreaterThan(0);
    });
  });

  describe('profile (author) feed', () => {
    const [PROFILE_POSITION] = INTERSTITIALS.profile.positions.firstPage;

    it('carries one similarAccounts card about the profile being read', () => {
      const slots = planInterstitials({
        descriptor: `author|${SUBJECT_ID}`,
        slices: makeSlices(FULL_PAGE),
        followingCount: WARM_FOLLOWING,
        isFirstPage: true,
        currentUserId: VIEWER_ID,
      });

      expect(slots).toEqual([
        {
          key: `int:similarAccounts:slice-${PROFILE_POSITION}`,
          kind: 'similarAccounts',
          afterSliceKey: `slice-${PROFILE_POSITION}`,
          subjectId: SUBJECT_ID,
        },
      ]);
    });

    it('plans nothing on the viewer OWN profile', () => {
      expect(
        planInterstitials({
          descriptor: `author|${VIEWER_ID}`,
          slices: makeSlices(FULL_PAGE),
          followingCount: WARM_FOLLOWING,
          isFirstPage: true,
          currentUserId: VIEWER_ID,
        }),
      ).toEqual([]);
    });

    it('carries the card on every author filter variant', () => {
      for (const filter of ['posts', 'replies', 'media', 'likes']) {
        const slots = planInterstitials({
          descriptor: `author|${SUBJECT_ID}|${filter}`,
          slices: makeSlices(FULL_PAGE),
          followingCount: WARM_FOLLOWING,
          isFirstPage: true,
          currentUserId: VIEWER_ID,
        });
        expect(slots).toHaveLength(1);
        expect(slots[0].subjectId).toBe(SUBJECT_ID);
      }
    });

    it('drops the card on the viewer own profile whatever the filter', () => {
      for (const filter of ['posts', 'replies', 'media', 'likes']) {
        expect(
          planInterstitials({
            descriptor: `author|${VIEWER_ID}|${filter}`,
            slices: makeSlices(FULL_PAGE),
            followingCount: WARM_FOLLOWING,
            isFirstPage: true,
            currentUserId: VIEWER_ID,
          }),
        ).toEqual([]);
      }
    });

    it('ignores the graph temperature — the card is about the subject, not the viewer', () => {
      const forTemperature = (followingCount: number) =>
        planInterstitials({
          descriptor: `author|${SUBJECT_ID}`,
          slices: makeSlices(FULL_PAGE),
          followingCount,
          isFirstPage: true,
          currentUserId: VIEWER_ID,
        });

      expect(forTemperature(COLD_FOLLOWING)).toEqual(forTemperature(DENSE_FOLLOWING));
      expect(forTemperature(WARM_FOLLOWING)).toEqual(forTemperature(DENSE_FOLLOWING));
    });

    it('plans nothing when the page never reaches the configured position', () => {
      expect(
        planInterstitials({
          descriptor: `author|${SUBJECT_ID}`,
          slices: makeSlices(PROFILE_POSITION),
          followingCount: WARM_FOLLOWING,
          isFirstPage: true,
          currentUserId: VIEWER_ID,
        }),
      ).toEqual([]);
    });

    it('follows the configured nextPage positions on a paginated page', () => {
      const slots = planInterstitials({
        descriptor: `author|${SUBJECT_ID}`,
        slices: makeSlices(FULL_PAGE),
        followingCount: WARM_FOLLOWING,
        isFirstPage: false,
        cursor: 'cursor-page-2',
        currentUserId: VIEWER_ID,
      });

      const positions: readonly number[] = INTERSTITIALS.profile.positions.nextPage;
      expect(slots.map((slot) => slot.afterSliceKey)).toEqual(
        positions.map((position) => `slice-${position}`),
      );
      expect(slots.every((slot) => slot.kind === 'similarAccounts')).toBe(true);
    });

    it('plans nothing for an author descriptor with no subject', () => {
      expect(
        planInterstitials({
          descriptor: 'author|',
          slices: makeSlices(FULL_PAGE),
          followingCount: WARM_FOLLOWING,
          isFirstPage: true,
          currentUserId: VIEWER_ID,
        }),
      ).toEqual([]);
    });
  });

  describe('graph temperature', () => {
    it('bootstraps a COLD graph with two cards, starter packs first', () => {
      const slices = makeSlices(FULL_PAGE);
      const slots = planInterstitials({
        descriptor: 'for_you',
        slices,
        followingCount: COLD_FOLLOWING,
        isFirstPage: true,
      });

      const [firstPosition, secondPosition] = INTERSTITIALS.positions.cold.firstPage;
      expect(slots).toEqual([
        {
          key: `int:${INTERSTITIALS.rotation.cold[0]}:slice-${firstPosition}`,
          kind: INTERSTITIALS.rotation.cold[0],
          afterSliceKey: `slice-${firstPosition}`,
        },
        {
          key: `int:${INTERSTITIALS.rotation.cold[1]}:slice-${secondPosition}`,
          kind: INTERSTITIALS.rotation.cold[1],
          afterSliceKey: `slice-${secondPosition}`,
        },
      ]);
    });

    it('gives a WARM graph one card, individual accounts first', () => {
      const slots = planInterstitials({
        descriptor: 'following',
        slices: makeSlices(FULL_PAGE),
        followingCount: WARM_FOLLOWING,
        isFirstPage: true,
      });

      const [position] = INTERSTITIALS.positions.warm.firstPage;
      expect(slots).toEqual([
        {
          key: `int:${INTERSTITIALS.rotation.warm[0]}:slice-${position}`,
          kind: INTERSTITIALS.rotation.warm[0],
          afterSliceKey: `slice-${position}`,
        },
      ]);
    });

    it('gives a DENSE graph one card on its first page', () => {
      const slots = planInterstitials({
        descriptor: 'for_you',
        slices: makeSlices(FULL_PAGE),
        followingCount: DENSE_FOLLOWING,
        isFirstPage: true,
      });

      const [position] = INTERSTITIALS.positions.dense.firstPage;
      expect(slots).toEqual([
        {
          key: `int:${INTERSTITIALS.rotation.dense[0]}:slice-${position}`,
          kind: INTERSTITIALS.rotation.dense[0],
          afterSliceKey: `slice-${position}`,
        },
      ]);
    });
  });

  describe('pagination', () => {
    it('uses the nextPage positions once a cursor is present', () => {
      const slots = planInterstitials({
        descriptor: 'for_you',
        slices: makeSlices(FULL_PAGE),
        followingCount: WARM_FOLLOWING,
        isFirstPage: false,
        cursor: 'cursor-page-2',
      });

      const [position] = INTERSTITIALS.positions.warm.nextPage;
      expect(slots).toHaveLength(1);
      expect(slots[0].afterSliceKey).toBe(`slice-${position}`);
    });

    it('never re-opens a later page with the kind the first page led with', () => {
      const firstKind = INTERSTITIALS.rotation.warm[0];
      for (let page = 2; page <= 40; page += 1) {
        const slots = planInterstitials({
          descriptor: 'for_you',
          slices: makeSlices(FULL_PAGE),
          followingCount: WARM_FOLLOWING,
          isFirstPage: false,
          cursor: `cursor-${page}`,
        });
        expect(slots[0].kind).not.toBe(firstKind);
      }
    });

    it('shows a DENSE graph a card only every densePageInterval-th page', () => {
      const results = Array.from({ length: 60 }, (_, page) =>
        planInterstitials({
          descriptor: 'for_you',
          slices: makeSlices(FULL_PAGE),
          followingCount: DENSE_FOLLOWING,
          isFirstPage: false,
          cursor: `cursor-${page}`,
        }),
      );

      const withCard = results.filter((slots) => slots.length > 0);
      const withoutCard = results.filter((slots) => slots.length === 0);
      // The cadence gate is a deterministic hash, not a counter, so the split is
      // approximate — it just has to actually skip pages (and not skip all).
      expect(withCard.length).toBeGreaterThan(0);
      expect(withoutCard.length).toBeGreaterThan(0);
    });
  });

  describe('short pages', () => {
    it('drops a slot whose position the page never reaches', () => {
      const [firstPosition, secondPosition] = INTERSTITIALS.positions.cold.firstPage;
      const slots = planInterstitials({
        descriptor: 'for_you',
        slices: makeSlices(secondPosition), // reaches the first position, not the second
        followingCount: COLD_FOLLOWING,
        isFirstPage: true,
      });

      expect(slots).toHaveLength(1);
      expect(slots[0].afterSliceKey).toBe(`slice-${firstPosition}`);
    });

    it('plans nothing when the page is shorter than every position', () => {
      const [position] = INTERSTITIALS.positions.warm.firstPage;
      expect(
        planInterstitials({
          descriptor: 'for_you',
          slices: makeSlices(position),
          followingCount: WARM_FOLLOWING,
          isFirstPage: true,
        }),
      ).toEqual([]);
    });

    it('plans nothing for an empty page', () => {
      expect(
        planInterstitials({
          descriptor: 'for_you',
          slices: [],
          followingCount: COLD_FOLLOWING,
          isFirstPage: true,
        }),
      ).toEqual([]);
    });
  });

  it('leaves the home surfaces untouched when the viewer id is supplied', () => {
    for (const descriptor of INTERSTITIALS.allowedDescriptors) {
      for (const followingCount of [COLD_FOLLOWING, WARM_FOLLOWING, DENSE_FOLLOWING]) {
        const params = {
          descriptor,
          slices: makeSlices(FULL_PAGE),
          followingCount,
          isFirstPage: true,
        };
        expect(planInterstitials({ ...params, currentUserId: VIEWER_ID })).toEqual(
          planInterstitials(params),
        );
      }
    }
  });

  it('is deterministic — the same request always plans the same slots', () => {
    const params = {
      descriptor: 'for_you',
      slices: makeSlices(FULL_PAGE),
      followingCount: COLD_FOLLOWING,
      isFirstPage: false,
      cursor: 'opaque-cursor-value',
    };
    expect(planInterstitials(params)).toEqual(planInterstitials(params));
  });

  it('anchors every slot to a slice that is actually on the page', () => {
    const slices = makeSlices(FULL_PAGE);
    const sliceKeys = new Set(slices.map((slice) => slice._sliceKey));

    for (const followingCount of [COLD_FOLLOWING, WARM_FOLLOWING, DENSE_FOLLOWING]) {
      const slots = planInterstitials({
        descriptor: 'for_you',
        slices,
        followingCount,
        isFirstPage: true,
      });
      for (const slot of slots) {
        expect(sliceKeys.has(slot.afterSliceKey)).toBe(true);
        expect(slot.key).toBe(`int:${slot.kind}:${slot.afterSliceKey}`);
      }
    }
  });
});
