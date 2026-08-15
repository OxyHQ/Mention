/**
 * The `has_links` repair, against real rows.
 *
 * The script's whole job is to make `posts.has_links` agree with the stored
 * renditions for rows written before the derivation moved to the repository. So
 * the fixtures are the four states such a row can be in — two that disagree in
 * either direction, and two that already agree — and the assertions read the
 * COLUMN back afterwards.
 *
 * ## The disagreement can only be written in SQL, and that is the point
 *
 * `PostRecordInput` no longer carries a `hasLinks` field, and both write paths
 * derive it, so `insertPostRecord` cannot produce a wrong row any more. The
 * historical state therefore has to be manufactured with a direct UPDATE. That
 * is not a shortcut around the API — it is a faithful reproduction of what
 * production holds, and of what the two direct-SQL body-repair scripts
 * (`normalizeFederatedText`, `repairFederatedMentions`) can still produce today.
 *
 * ## Why this file gets its own database
 *
 * `backfillPostHasLinks` sweeps EVERY disagreeing row in the `posts` table — it
 * takes no scope, by design, because a repair that only fixed the caller's rows
 * would repair nothing in production. Registered in `isolatedDatabaseFiles.ts`
 * for exactly that reason: run against the shared database it would rewrite the
 * deliberately-disagreeing rows `routes/searchPosts.test.ts` seeds to prove
 * `has:links` reads the column rather than the bodies.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';
import type { StoredPostContent } from '@mention/shared-types';

import { closePostgres, connectPostgres, type Database } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { insertPostRecord } from '../../db/posts/postRepository';
import { backfillPostHasLinks } from '../../scripts/backfillPostHasLinks';

let db: Database;
const created: string[] = [];

const AUTHOR = 'oxy-haslinks-backfill-author';

function body(text: string): StoredPostContent {
  return { variants: [{ source: 'author', text, tag: 'en' }] };
}

async function seed(content: StoredPostContent, storedFlag?: boolean): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content,
  });
  created.push(record.id);
  // The pre-fix state, which the write path can no longer produce.
  if (storedFlag !== undefined) {
    await db.update(posts).set({ hasLinks: storedFlag }).where(eq(posts.id, record.id));
  }
  return record.id;
}

async function flagsOf(ids: readonly string[]): Promise<Record<string, boolean>> {
  const rows = await db
    .select({ id: posts.id, hasLinks: posts.hasLinks })
    .from(posts)
    .where(inArray(posts.id, [...ids]));
  return Object.fromEntries(rows.map((row) => [row.id, row.hasLinks]));
}

beforeAll(async () => {
  db = await connectPostgres();
});

afterEach(async () => {
  while (created.length > 0) {
    const id = created.pop();
    if (id) await db.delete(posts).where(eq(posts.id, id));
  }
  await db.delete(posts).where(eq(posts.oxyUserId, AUTHOR));
});

afterAll(async () => {
  await closePostgres();
});

describe('backfillPostHasLinks', () => {
  it('counts both directions and writes nothing on a dry run', async () => {
    const stale = await seed(body('go to https://example.test'), false);
    const phantom = await seed(body('no url in here'), true);

    const result = await backfillPostHasLinks({ dryRun: true });

    expect(result.setTrue.candidates).toBe(1);
    expect(result.setFalse.candidates).toBe(1);
    expect(result.setTrue.written).toBe(0);
    expect(result.setFalse.written).toBe(0);
    expect(result.noOpWrites).toBe(false);

    // The rows are untouched — a dry run that repaired anything would make the
    // preview the operator reads before a live run a lie.
    expect(await flagsOf([stale, phantom])).toEqual({ [stale]: false, [phantom]: true });
  });

  it('repairs both directions and leaves the already-correct rows alone', async () => {
    const stale = await seed(body('go to https://example.test'), false);
    const phantom = await seed(body('no url in here'), true);
    const correctTrue = await seed(body('already right https://example.test'));
    const correctFalse = await seed(body('already right, no link'));

    const result = await backfillPostHasLinks({ dryRun: false });

    expect(result.setTrue.written).toBe(1);
    expect(result.setFalse.written).toBe(1);
    expect(result.noOpWrites).toBe(false);

    expect(await flagsOf([stale, phantom, correctTrue, correctFalse])).toEqual({
      [stale]: true,
      [phantom]: false,
      // The two that already agreed were never candidates, so they cannot have
      // been flipped by a repair that got its predicate backwards.
      [correctTrue]: true,
      [correctFalse]: false,
    });
  });

  it('is idempotent — a second run finds nothing left to do', async () => {
    await seed(body('go to https://example.test'), false);
    await seed(body('no url in here'), true);

    await backfillPostHasLinks({ dryRun: false });
    const second = await backfillPostHasLinks({ dryRun: false });

    expect(second.setTrue.candidates).toBe(0);
    expect(second.setFalse.candidates).toBe(0);
    expect(second.setTrue.written).toBe(0);
    expect(second.setFalse.written).toBe(0);
    // Zero written with zero candidates is the ONE case that is not a no-op bug,
    // which is why the flag is computed rather than inferred from `written`.
    expect(second.noOpWrites).toBe(false);
  });

  it('counts a natively-written candidate as native', async () => {
    // The breakdown is what tells an operator whether the corpus damage is the
    // native write path (all of it, before the fix) or a federated import.
    await seed(body('native, with https://example.test'), false);

    const result = await backfillPostHasLinks({ dryRun: true });

    expect(result.setTrue.candidates).toBe(1);
    expect(result.setTrue.nativeCandidates).toBe(1);
  });

  it('sees a link in a rendition that is not the primary', async () => {
    // The repair's SQL has to match `postTextHasHttpLink`, which reads EVERY
    // rendition. A predicate keyed on `position = 0` would leave these rows
    // wrong forever, and nothing downstream would say so.
    await seed(
      {
        variants: [
          { source: 'author', text: 'sin enlace', tag: 'es' },
          { source: 'author', text: 'link https://example.test', tag: 'en' },
        ],
      },
      false,
    );

    const result = await backfillPostHasLinks({ dryRun: true });

    expect(result.setTrue.candidates).toBe(1);
  });

  it('does not count a post whose only "link" is a bare domain', async () => {
    // Same rule as the detector: `example.com` in plain text is not a link, so a
    // repair that widened the predicate would set the flag on posts the write
    // path would never set it on — and the two would then disagree forever.
    await seed(body('example.com is plain text'), false);

    const result = await backfillPostHasLinks({ dryRun: true });

    expect(result.setTrue.candidates).toBe(0);
  });
});
