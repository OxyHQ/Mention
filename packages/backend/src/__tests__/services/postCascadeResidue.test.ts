import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * `collectPostCascadeResidue` — the check that says a post-deletion cascade
 * CLAIMED to remove a reference and did not.
 *
 * ## Why this suite exists at all
 *
 * A residue check that has never reported residue is indistinguishable from one
 * that cannot. Before this file, nothing had ever executed this function against
 * a row it was supposed to find, so "no residue" was a result nobody had earned
 * — the same object as a guard whose refusal has never been watched.
 *
 * ## Why these tables and not the obvious ones
 *
 * Thirteen references are probed; only SEVEN can ever produce residue. The other
 * six — `polls`, `articles`, `likes`, `bookmarks`, `post_recent_repliers`,
 * `engagement_outbox` — are `ON DELETE CASCADE` on `posts.id`, so Postgres
 * removes them with the post and no cascade leg can fail to. **A residue test
 * seeded into one of those would pass forever while proving nothing**, which is
 * precisely the shape this check exists to refuse.
 *
 * The seven that CAN strand are exactly the shapes a foreign key cannot express:
 * polymorphic (`notifications.entity_id`, `reports.reported_id`,
 * `content_labels.target_id`), URI-keyed rather than id-keyed
 * (`feed_interactions.post_uri`), a JSON blob
 * (`federation_delivery_queue.activity_json`), and the two gate tables whose
 * `post_id` is plain `text()` because a gate is upserted on `post_uri` without
 * proving the post exists. This suite seeds into that set.
 */

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { notifications } from '../../db/schema/discovery';
import { clearPostScope, postScope, seedPost } from '../helpers/postFixtures';
import { collectPostCascadeResidue } from '../../scripts/lib/adminDeletionPreflight';

const scope = postScope('cascade-residue');
const RECIPIENT = scope.user('recipient');
const ACTOR = scope.user('actor');

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await getDb().delete(notifications).where(eq(notifications.recipientId, RECIPIENT));
  await clearPostScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

/** A notification naming a post — the polymorphic reference no FK can carry. */
async function notifyAbout(postId: string): Promise<void> {
  await getDb().insert(notifications).values({
    recipientId: RECIPIENT,
    actorId: ACTOR,
    type: 'like',
    entityType: 'post',
    entityId: postId,
  });
}

describe('collectPostCascadeResidue', () => {
  it('REPORTS a claimed reference whose row was left behind, and names it', async () => {
    const post = await seedPost(scope);
    await notifyAbout(post.id);

    // The cascade CLAIMS it removes this reference. The row is still there.
    const residue = await collectPostCascadeResidue(
      [{ id: post.id }],
      ['notifications.entity_id'],
    );

    // Naming matters as much as detecting: "residue found" without saying WHERE
    // sends an operator hunting through thirteen probes at the worst moment.
    expect(residue).toEqual(['notifications.entity_id']);
  });

  it('reports NOTHING when the claimed reference really was removed', async () => {
    // The control. Without it, a check that returned every claimed probe
    // unconditionally would satisfy the assertion above and be useless.
    const post = await seedPost(scope);
    await notifyAbout(post.id);
    await getDb().delete(notifications).where(eq(notifications.entityId, post.id));

    await expect(
      collectPostCascadeResidue([{ id: post.id }], ['notifications.entity_id']),
    ).resolves.toEqual([]);
  });

  it('names ONLY the probe that found rows, not every probe claimed', async () => {
    const post = await seedPost(scope);
    await notifyAbout(post.id);

    const residue = await collectPostCascadeResidue(
      [{ id: post.id }],
      ['notifications.entity_id', 'postgates.post_id/post_uri', 'threadgates.post_id/post_uri'],
    );

    expect(residue).toEqual(['notifications.entity_id']);
  });

  it('is scoped to the target post — another post’s reference is not residue', async () => {
    // The failure this rules out is an unscoped probe: one that answers "does
    // ANY row reference ANY post", which reports residue forever once the table
    // is non-empty and is the residue-check equivalent of a stuck alarm.
    const deleted = await seedPost(scope);
    const other = await seedPost(scope);
    await notifyAbout(other.id);

    await expect(
      collectPostCascadeResidue([{ id: deleted.id }], ['notifications.entity_id']),
    ).resolves.toEqual([]);
  });

  it('claims nothing when the cascade claimed nothing', async () => {
    const post = await seedPost(scope);
    await notifyAbout(post.id);

    // An empty claim list is not "everything is fine" — it is "this cascade made
    // no claim", and the check must not invent one.
    await expect(collectPostCascadeResidue([{ id: post.id }], [])).resolves.toEqual([]);
  });
});
