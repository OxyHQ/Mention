import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The two curation rules — and they are exactly the pair somebody collapses into
 * one later, so each is asserted on its own:
 *
 *  - `tab` removes a post from the MAIN tab only. The lane still has its own tab.
 *  - `hidden` removes it from EVERY profile tab, the owner's own view included.
 *
 * Plus the fail-soft direction, which is not arbitrary: a lookup failure must
 * degrade to an UNCURATED profile, never an empty one.
 *
 * The two lookups run against REAL rows. They used to assert the Mongo filter
 * object each function built, which proved the helper returned the shape someone
 * typed into the test and nothing about which lanes came back — and the reads
 * are Postgres now, so there is no filter object left to inspect. The fail-soft
 * cases still need an induced failure, which is what the `getDb` spy below is
 * for; nothing else is mocked.
 */

import { eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import * as postgres from '../db/postgres';
import { lanes } from '../db/schema/channels';
import {
  excludedDisplayModesForTab,
  loadExcludedLaneIds,
  ownerHasProfileAffectingLane,
} from '../services/laneVisibility';
import type { LaneDisplayMode } from '@mention/shared-types';

const OWNER = 'lanevis-owner';
/**
 * A CHANNEL account. Nothing distinguishes it from {@link OWNER} but the id — a
 * channel is an Oxy account, so its curation runs through the same single
 * `ownerId` scoping a person's does.
 */
const CHANNEL_ACCOUNT = 'lanevis-channel';
const seeded: string[] = [];
let seq = 0;

/** One lane, cleaned with the rest. Returns its id. */
async function lane(displayMode: LaneDisplayMode, ownerId: string = OWNER): Promise<string> {
  const name = `lanevis-${seq++}`;
  const [row] = await getDb()
    .insert(lanes)
    .values({ ownerId, name, nameLower: name, displayMode })
    .returning({ id: lanes.id });
  seeded.push(row.id);
  return row.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  vi.restoreAllMocks();
  const ids = seeded.splice(0);
  if (ids.length > 0) await getDb().delete(lanes).where(inArray(lanes.id, ids));
});

afterAll(async () => {
  await closePostgres();
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
  it('returns exactly the publisher\'s lanes in the requested modes', async () => {
    const tabbed = await lane('tab');
    const hidden = await lane('hidden');
    // Present and NOT returned, which is what makes the case non-vacuous: a
    // query matching every lane would pass an assertion that only listed two.
    await lane('mixed');

    const ids = await loadExcludedLaneIds(OWNER, ['tab', 'hidden']);
    expect([...ids].sort()).toEqual([tabbed, hidden].sort());

    const hiddenOnly = await loadExcludedLaneIds(OWNER, ['hidden']);
    expect(hiddenOnly).toEqual([hidden]);
  });

  it('scopes by OWNER, so one publisher\'s lane never curates another\'s profile', async () => {
    // A channel account is just another publisher — there is no owner TYPE left
    // to conflate, so the whole of the scoping is this one id comparison.
    const channelLane = await lane('hidden', CHANNEL_ACCOUNT);
    const ownerLane = await lane('hidden');

    expect(await loadExcludedLaneIds(CHANNEL_ACCOUNT, ['hidden'])).toEqual([channelLane]);
    expect(await loadExcludedLaneIds(OWNER, ['hidden'])).toEqual([ownerLane]);
  });

  it('skips the query entirely for a missing owner or an empty mode set', async () => {
    await lane('hidden');
    expect(await loadExcludedLaneIds('', ['hidden'])).toEqual([]);
    expect(await loadExcludedLaneIds(OWNER, [])).toEqual([]);
  });

  it('fails soft toward an UNCURATED profile, never an empty one', async () => {
    await lane('hidden');
    vi.spyOn(postgres, 'getDb').mockImplementation(() => {
      throw new Error('postgres down');
    });

    // `[]` means "exclude nothing", so a lookup failure shows a post the owner
    // meant to tuck away — far smaller harm than showing them nothing at all.
    await expect(loadExcludedLaneIds(OWNER, ['hidden'])).resolves.toEqual([]);
  });
});

describe('ownerHasProfileAffectingLane', () => {
  it('answers true for a lane that removes posts from the profile', async () => {
    await lane('tab');
    await expect(ownerHasProfileAffectingLane(OWNER)).resolves.toBe(true);
  });

  it('answers false when the author\'s only lane is `mixed`', async () => {
    // `mixed` is on the main tab, so it affects no profile surface — the exact
    // distinction the probe exists to draw.
    await lane('mixed');
    await expect(ownerHasProfileAffectingLane(OWNER)).resolves.toBe(false);
  });

  it('answers false when the author has no lane at all', async () => {
    await expect(ownerHasProfileAffectingLane(OWNER)).resolves.toBe(false);
  });

  it('answers false without a query for a missing owner', async () => {
    await expect(ownerHasProfileAffectingLane('')).resolves.toBe(false);
  });

  it('fails soft to false, leaving the pre-lane sync behaviour intact', async () => {
    await lane('hidden');
    vi.spyOn(postgres, 'getDb').mockImplementation(() => {
      throw new Error('postgres down');
    });
    await expect(ownerHasProfileAffectingLane(OWNER)).resolves.toBe(false);
  });

  it('does not confuse one publisher\'s lanes with another\'s', async () => {
    await lane('hidden', 'lanevis-somebody-else');
    await expect(ownerHasProfileAffectingLane(OWNER)).resolves.toBe(false);
    // The other publisher's lane is really there — without this the case above
    // would pass just as well against a seeding failure.
    const [row] = await getDb()
      .select({ id: lanes.id })
      .from(lanes)
      .where(eq(lanes.ownerId, 'lanevis-somebody-else'));
    expect(row).toBeDefined();
  });
});
