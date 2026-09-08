/**
 * `status: 'incomplete'` — the withheld state, and the two properties the rest
 * of this feature is built on.
 *
 * A federated post that declares a quote we could not resolve is text written
 * ABOUT a post we do not have. `importAnnounce` has always refused to create a
 * boost in that situation ("skipped boost whose object could not be resolved"),
 * so a repost never appears without its content; quotes were the inconsistent
 * case, and `incomplete` is them joining the rule.
 *
 * It lives on the `status` axis rather than in a flag of its own because every
 * feed source and the post-hydration ACL already require `status: 'published'`.
 * That claim is only worth making if it is TESTED, so this file tests the half
 * that decides whether the state is safe to write at all:
 *
 *   - an incomplete post cannot become anybody else's quote or boost target,
 *     because `resolvePostIdFromObjectUri` is the one function all thirteen
 *     inbound-reference call sites go through and it requires `published`;
 *   - promoting it back to `published` restores it completely.
 *
 * The second is not a formality. Withholding is only defensible BECAUSE it is
 * reversible — dropping the note instead (which is what the boost path does)
 * would be permanent, and Threads delivers by push exactly once with no
 * traversable outbox, so a dropped note can never be fetched again. A promotion
 * that did not fully restore the post would make this state a slower delete.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { PostType, PostVisibility } from '@mention/shared-types';

import { closePostgres, connectPostgres, getDb } from '../db/postgres';
import { posts } from '../db/schema';
import { POST_STATUSES } from '../db/schema/posts';
import { insertPostRecord } from '../db/posts/postRepository';
import { resolvePostIdFromObjectUri } from '../connectors/activitypub/helpers';

const OWNER = 'incomplete-status-owner';
const NOTE_URI = 'https://incomplete-status.test/users/bob/statuses/1';

const created: string[] = [];

async function seed(status: 'published' | 'incomplete'): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: OWNER,
    authorship: [{ oxyUserId: OWNER, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status,
    content: { variants: [{ source: 'author', text: 'Grifters all the way down' }] },
    federation: { activityId: NOTE_URI, actorUri: 'https://incomplete-status.test/users/bob' },
  });
  created.push(record.id);
  return record.id;
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

afterEach(async () => {
  if (created.length > 0) {
    await getDb().delete(posts).where(inArray(posts.id, [...created]));
    created.length = 0;
  }
});

describe("status: 'incomplete'", () => {
  it('is a real value of the status axis, not a string the CHECK rejects', () => {
    // The migration widens `posts_status_check`. If the list and the constraint
    // ever disagree, `seed()` below throws instead of failing an assertion —
    // which reads as an unrelated database error, so the list is pinned here too.
    expect(POST_STATUSES).toContain('incomplete');
  });

  it('CANNOT be reached as a quote or boost target', async () => {
    // `resolvePostIdFromObjectUri` is the single function every inbound
    // reference goes through — a Like, an Announce, a reply's parent lookup, a
    // quote. Requiring `published` there is what stops a withheld post from
    // being embedded in somebody else's post while it is withheld.
    const id = await seed('incomplete');

    expect(id).toBeTruthy();
    expect(await resolvePostIdFromObjectUri(NOTE_URI)).toBeNull();
  });

  it('CONTROL: the same row published IS reachable', async () => {
    // Same fixture, same URI, one field different. Without this the case above
    // would pass just as well if the URI simply never matched anything.
    const id = await seed('published');

    expect(await resolvePostIdFromObjectUri(NOTE_URI)).toBe(id);
  });

  it('is fully restored by promotion, which is why withholding beats dropping', async () => {
    // The whole argument for storing rather than discarding: the backfill
    // promotes the post once its quote resolves. If promotion did not restore
    // the post completely, `incomplete` would be a delete with extra storage.
    const id = await seed('incomplete');
    expect(await resolvePostIdFromObjectUri(NOTE_URI)).toBeNull();

    await getDb().update(posts).set({ status: 'published' }).where(eq(posts.id, id));

    expect(await resolvePostIdFromObjectUri(NOTE_URI)).toBe(id);
  });
});
