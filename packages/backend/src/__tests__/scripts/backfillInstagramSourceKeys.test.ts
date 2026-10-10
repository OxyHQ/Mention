/**
 * `backfillInstagramSourceKeys` gives every post the kilogram.makeup bridge
 * delivered before `post_source_keys` existed its Instagram source key, and
 * validates the CHECKs migration 0054 added NOT VALID.
 *
 * It walks EVERY bridge actor and validates constraints on shared tables, so
 * this file runs against its own database (`isolatedDatabaseFiles.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { federatedActors, postSourceKeys } from '../../db/schema';
import { insertPostRecord } from '../../db/posts/postRepository';
import {
  NOT_VALID_CONSTRAINTS,
  backfillInstagramSourceKeys,
  EXIT_INCOMPLETE,
  sourceKeyBackfillExitCode,
} from '../../scripts/backfillInstagramSourceKeys';

const ACTOR = 'https://kilogram.makeup/users/igbackfill.acct';
const OWNER = 'oxy-igbackfill-owner';

async function bridgePost(shortcode: string, withKey = false): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: OWNER,
    authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: `bridge ${shortcode}`, tag: 'en' }] },
    federation: {
      activityId: `${ACTOR}/statuses/${shortcode}`,
      actorUri: ACTOR,
      ...(withKey ? { sourcePostKey: `instagram:${shortcode}` } : {}),
    },
  });
  return record.id;
}

async function keyOf(postId: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ key: postSourceKeys.sourceKey })
    .from(postSourceKeys)
    .where(eq(postSourceKeys.postId, postId));
  return row?.key;
}

beforeAll(async () => {
  await connectPostgres();
  await getDb().insert(federatedActors).values({
    protocol: 'activitypub',
    uri: ACTOR,
    username: 'igbackfill.acct',
    domain: 'kilogram.makeup',
    acct: 'igbackfill.acct@kilogram.makeup',
    networkAcct: 'igbackfill.acct@instagram.com',
    type: 'Service',
    oxyUserId: OWNER,
    lastFetchedAt: new Date(),
  });
});

afterAll(async () => {
  await closePostgres();
});

describe('backfillInstagramSourceKeys', () => {
  it('counts without writing on a dry run, then keys the legacy bridge posts and validates the CHECKs', async () => {
    const legacyA = await bridgePost('DqLegacyA01');
    const legacyB = await bridgePost('DqLegacyB02');
    const keyed = await bridgePost('DqKeyedC003', true);
    // Filled by another post (the Graph import got there first): a conflict.
    const conflicting = await bridgePost('DqTakenD004');
    const graphCopy = await bridgePost('DqGraphE005', true);
    await getDb()
      .update(postSourceKeys)
      .set({ sourceKey: 'instagram:DqTakenD004' })
      .where(eq(postSourceKeys.postId, graphCopy));
    // Claimed by a LIVE Graph import: reported, left for a re-run.
    const claimedByImport = await bridgePost('DqClaimF006');
    await getDb()
      .insert(postSourceKeys)
      .values({
        sourceKey: 'instagram:DqClaimF006',
        claimToken: 'live',
        claimedUntil: new Date(Date.now() + 60_000),
      });
    // Claimed by a DEAD import: taken over.
    const deadClaim = await bridgePost('DqDeadG0007');
    await getDb()
      .insert(postSourceKeys)
      .values({
        sourceKey: 'instagram:DqDeadG0007',
        claimToken: 'dead',
        claimedUntil: new Date(Date.now() - 60_000),
      });

    const dry = await backfillInstagramSourceKeys({ dryRun: true, pauseMs: 0 });
    expect(dry).toMatchObject({ candidates: 5, written: 0, validated: [] });
    expect(await keyOf(legacyA)).toBeUndefined();

    const run = await backfillInstagramSourceKeys({ dryRun: false, pauseMs: 0 });
    expect(run).toMatchObject({
      candidates: 5,
      written: 3,
      conflicts: 1,
      claimed: 1,
      unvalidated: [],
    });
    expect(await keyOf(legacyA)).toBe('instagram:DqLegacyA01');
    expect(await keyOf(legacyB)).toBe('instagram:DqLegacyB02');
    expect(await keyOf(keyed)).toBe('instagram:DqKeyedC003');
    expect(await keyOf(deadClaim)).toBe('instagram:DqDeadG0007');
    expect(await keyOf(conflicting)).toBeUndefined();
    expect(await keyOf(claimedByImport)).toBeUndefined();

    expect(run.validated.sort()).toEqual(NOT_VALID_CONSTRAINTS.map((c) => c.constraint).sort());
    const rows = await getDb().execute<{ convalidated: boolean }>(sql`
      select convalidated from pg_constraint
      where conname in ('federated_actors_protocol_check', 'federated_follows_network_check',
                        'federated_actors_instagram_graph_last_result_check')
    `);
    expect([...rows].every((row) => row.convalidated)).toBe(true);

    // Idempotent: a second run has nothing left to do.
    expect(await backfillInstagramSourceKeys({ dryRun: false, pauseMs: 0 })).toMatchObject({
      candidates: 2,
      written: 0,
      validated: [],
    });
  });
});

describe('backfillInstagramSourceKeys exit code (read by the one-shot workflow)', () => {
  it('is 0 when every key settled and every CHECK validated', () => {
    expect(sourceKeyBackfillExitCode({ claimed: 0, unvalidated: [] })).toBe(0);
  });

  it('is EXIT_INCOMPLETE (re-run later, not a failure) for a live claim or an unvalidated CHECK', () => {
    expect(sourceKeyBackfillExitCode({ claimed: 1, unvalidated: [] })).toBe(EXIT_INCOMPLETE);
    expect(
      sourceKeyBackfillExitCode({ claimed: 0, unvalidated: ['federated_actors_protocol_check'] }),
    ).toBe(EXIT_INCOMPLETE);
    expect(EXIT_INCOMPLETE).toBe(75);
  });
});
