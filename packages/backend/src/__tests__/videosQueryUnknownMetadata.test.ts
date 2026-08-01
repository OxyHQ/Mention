/**
 * UNKNOWN IS NOT A VALUE — the videos feed must not read MISSING metadata as a
 * failed match. Asserted against real rows.
 *
 * ## The production finding this encodes
 *
 * Measured 2026-07-30: 9,465 posts carried a video media item and the shipped
 * default query returned 147 of them. `durationSec` was present on 5.9% of the
 * corpus and on 0% of the last day's arrivals, because the entire video corpus is
 * federated (native video posts: 0), Mastodon advertises width/height but
 * essentially never duration, and `enrichFromOxy` cannot fill it in — federated
 * media is stored raw by `remoteUrl` and is not an Oxy asset.
 *
 * So a `>=` on a mostly-absent field was not enforcing a 20-second policy on the
 * corpus. It was discarding 94% of it and enforcing the policy on the remainder.
 * The correction has two halves and they are the SAME rule: a duration that was
 * never recorded is not a duration of zero, and an orientation that was never
 * recorded is not an orientation of "none".
 *
 * ## Why the row-level form is strictly stronger than the shape it replaces
 *
 * The predecessor asserted that the built Mongo object contained
 * `{durationSec: {$exists: false}}` inside an `$or`. That is a statement about a
 * literal, and it stayed green for any query that happened to spell those keys —
 * including one where a sibling clause re-narrowed the same field. In SQL the
 * equivalent hazard is sharper and completely invisible to a shape check:
 * `duration_sec >= 20` is NULL for an unrecorded duration, and a NULL predicate
 * DROPS the row with no error. The only way to see that is to insert the row and
 * ask for it back.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { MtnConfig, PostType, PostVisibility } from '@mention/shared-types';
import type { MediaItem } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../db/postgres';
import { posts } from '../db/schema/posts';
import { CHRONO_DESC, findPostRecords, insertPostRecord } from '../db/posts/postRepository';
import { FeedQueryBuilder, type VideosQueryOptions } from '../utils/feedQueryBuilder';

let db: Database;

/** Unique to this file: the suite runs in parallel against ONE database. */
const AUTHOR = 'videos-unknown-metadata-author';

/**
 * A federated-shaped video item: dimensions advertised, duration absent. This is
 * the SHAPE 94% of the real corpus has, so it is the shape most of this file
 * inserts.
 */
async function create(media: MediaItem): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.VIDEO,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'clip' }], media: [media] },
    federation: { activityId: `https://remote.example/notes/${media.id}` },
  });
  return record.id;
}

async function admitted(options: VideosQueryOptions): Promise<string[]> {
  const records = await findPostRecords(
    and(FeedQueryBuilder.buildVideosQuery([], options), eq(posts.oxyUserId, AUTHOR)),
    { orderBy: CHRONO_DESC },
  );
  return records.map((record) => record.id).sort();
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  await db.delete(posts).where(eq(posts.oxyUserId, AUTHOR));
});

afterAll(async () => {
  await closePostgres();
});

describe('duration applies when known and abstains when absent', () => {
  it('admits the federated majority — dimensions present, duration never recorded', async () => {
    const noDuration = await create({
      id: 'm-mastodon',
      type: 'video',
      width: 1080,
      height: 1920,
      orientation: 'portrait',
    });

    expect(await admitted({ minDurationSec: 20 })).toEqual([noDuration]);
  });

  it('still enforces the minimum on a video whose duration IS known', async () => {
    const tooShort = await create({
      id: 'm-short',
      type: 'video',
      width: 1080,
      height: 1920,
      orientation: 'portrait',
      durationSec: 5,
    });
    const longEnough = await create({
      id: 'm-long',
      type: 'video',
      width: 1080,
      height: 1920,
      orientation: 'portrait',
      durationSec: 45,
    });
    const unknown = await create({
      id: 'm-unknown',
      type: 'video',
      width: 1080,
      height: 1920,
      orientation: 'portrait',
    });

    // The whole rule in one set: known-and-short is OUT, known-and-long is IN,
    // and unknown is IN — abstention, not a default of zero.
    const ids = await admitted({ minDurationSec: 20 });
    expect(ids).toEqual([longEnough, unknown].sort());
    expect(ids).not.toContain(tooShort);
  });

  it('carries the configured minimum through, so the abstention is not a blanket pass', async () => {
    /**
     * The vacuity floor for this file. If the duration term were simply dropped,
     * every assertion above would still pass — a query that ignores duration
     * admits the unknown case too. Only a KNOWN duration moving across a
     * configurable threshold shows the term is still there and still reads its
     * argument.
     */
    const tenSeconds = await create({
      id: 'm-10',
      type: 'video',
      width: 1080,
      height: 1920,
      orientation: 'portrait',
      durationSec: 10,
    });

    expect(await admitted({ minDurationSec: 7 })).toEqual([tenSeconds]);
    expect(await admitted({ minDurationSec: 20 })).toEqual([]);
  });

  it('uses the shared config default when the caller states no minimum', async () => {
    const belowDefault = await create({
      id: 'm-below-default',
      type: 'video',
      width: 1080,
      height: 1920,
      orientation: 'portrait',
      durationSec: MtnConfig.videosFeed.minDurationSec - 1,
    });

    expect(await admitted({})).toEqual([]);
    expect(await admitted({ minDurationSec: 1 })).toEqual([belowDefault]);
  });
});

describe("orientation 'all' means no orientation filter, not a presence check", () => {
  it('admits a video whose orientation was never persisted', async () => {
    /**
     * The second half of the same rule. The regression it replaces compiled
     * `'all'` to `{$exists: true}`, which reads as "any orientation" and behaves
     * as "the column must be populated" — silently excluding exactly the
     * federated rows the setting exists to reach.
     */
    const unset = await create({ id: 'm-orientationless', type: 'video', width: 1080, height: 1920 });
    const portrait = await create({
      id: 'm-portrait',
      type: 'video',
      width: 1080,
      height: 1920,
      orientation: 'portrait',
    });

    expect(await admitted({ orientation: 'all' })).toEqual([unset, portrait].sort());
    // …and the DEFAULT still filters, so `'all'` is doing real work above.
    expect(await admitted({})).toEqual([portrait]);
  });

  it('keeps requiring real dimensions, which are not optional metadata', async () => {
    /**
     * Dimensions are NOT subject to the abstention rule, and the asymmetry is
     * deliberate: the player lays the clip out from width/height, so a video
     * without them cannot be rendered at all, whereas a missing duration only
     * means an unenforceable policy. Mastodon advertises dimensions, so requiring
     * them costs almost nothing against the real corpus.
     */
    const sized = await create({ id: 'm-sized', type: 'video', width: 1080, height: 1920 });
    await create({ id: 'm-unsized', type: 'video' });
    await create({ id: 'm-half-sized', type: 'video', width: 1080 });

    expect(await admitted({ orientation: 'all', minDurationSec: 1 })).toEqual([sized]);
  });
});
