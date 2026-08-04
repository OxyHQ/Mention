import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostType, PostVisibility } from '@mention/shared-types';

/**
 * `resolvePostIdFromObjectUri` — the one function thirteen inbound-federation
 * call sites depend on, against REAL ROWS.
 *
 * ## Why this suite exists
 *
 * The function used to gate its local-post branch on
 * `mongoose.Types.ObjectId.isValid(localPostId)`. That check was free insurance
 * against a Mongo CastError and is now the exact opposite: `posts.id` is `text`
 * holding a 24-char ObjectId hex for pre-cutover rows and a **uuid v7** for
 * everything created after, so an ObjectId test rejects every post this instance
 * has made since the cutover.
 *
 * `handleLike`, `handleUndoLike`, `handleAnnounce`, `handleUndoAnnounce`,
 * `handlePollVote`, `handleCreate`'s quote resolution, `importAnnounce`,
 * `resolveThreadLink` and `ensureFederatedReplyLink` all read `null` as "we do
 * not have that post". So the failure mode is: every reply, like, boost and
 * quote the fediverse aims at one of our own recent posts stops resolving — with
 * no error, no log, and no exception anywhere. Nothing but a row assertion on a
 * REAL uuid-v7 id can tell that apart from a healthy instance.
 *
 * The `FEDERATION_DOMAIN` mock pins the actor-URL shape
 * `extractLocalPostIdFromApUri` parses, so the local branch is exercised rather
 * than skipped.
 */
vi.mock('../../../connectors/activitypub/constants', async () => {
  const actual = await vi.importActual<typeof import('../../../connectors/activitypub/constants')>(
    '../../../connectors/activitypub/constants',
  );
  return { ...actual, FEDERATION_DOMAIN: 'mention.earth' };
});

import { closePostgres, connectPostgres } from '../../../db/postgres';
import { deletePostRecord, insertPostRecord } from '../../../db/posts/postRepository';
import type { PostRecordInput } from '../../../db/posts/postRecord';
import { resolvePostIdFromObjectUri } from '../../../connectors/activitypub/helpers';

const AUTHOR = 'oxy-resolve-author';
const created: string[] = [];

async function seed(overrides: Partial<PostRecordInput> = {}): Promise<string> {
  const record = await insertPostRecord({
    oxyUserId: AUTHOR,
    authorship: [{ oxyUserId: AUTHOR, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: 'resolvable', tag: 'en' }] },
    ...overrides,
  });
  created.push(record.id);
  return record.id;
}

/** The canonical AP object id Mention advertises for one of its own posts. */
const localNoteUri = (postId: string): string =>
  `https://mention.earth/ap/users/alice/posts/${postId}`;

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  for (const id of created.splice(0).reverse()) {
    await deletePostRecord(id, undefined);
  }
});

afterAll(async () => {
  await closePostgres();
});

describe('resolvePostIdFromObjectUri', () => {
  it('resolves one of OUR OWN posts by its canonical AP note URI', async () => {
    const postId = await seed();

    // The id the repository minted — a uuid v7, the shape every post created
    // since the cutover has. An ObjectId-shape guard would return null here and
    // every inbound like/boost/reply/quote aimed at this post would be dropped.
    expect(postId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    await expect(resolvePostIdFromObjectUri(localNoteUri(postId))).resolves.toBe(postId);
  });

  it('resolves an IMPORTED federated post by its remote activity id', async () => {
    const activityId = 'https://remote.example/users/bob/statuses/9001';
    const postId = await seed({ federation: { activityId, actorUri: 'https://remote.example/users/bob' } });

    await expect(resolvePostIdFromObjectUri(activityId)).resolves.toBe(postId);
  });

  it('refuses a local post that is not publicly readable', async () => {
    const privatePost = await seed({ visibility: PostVisibility.PRIVATE });
    const draft = await seed({ status: 'draft' });

    await expect(resolvePostIdFromObjectUri(localNoteUri(privatePost))).resolves.toBeNull();
    await expect(resolvePostIdFromObjectUri(localNoteUri(draft))).resolves.toBeNull();
  });

  it('refuses an IMPORTED post that is not publicly readable', async () => {
    // The second branch needs its own fixture: the local branch is reached by
    // URI SHAPE, so a remote activity id never exercises it. Ungated, this
    // resolves — and the id then becomes a quote reference published to the
    // fediverse for a post that is not public here.
    const privateActivityId = 'https://remote.example/users/bob/statuses/9002';
    await seed({
      visibility: PostVisibility.PRIVATE,
      federation: { activityId: privateActivityId, actorUri: 'https://remote.example/users/bob' },
    });

    const draftActivityId = 'https://remote.example/users/bob/statuses/9003';
    await seed({
      status: 'draft',
      federation: { activityId: draftActivityId, actorUri: 'https://remote.example/users/bob' },
    });

    await expect(resolvePostIdFromObjectUri(privateActivityId)).resolves.toBeNull();
    await expect(resolvePostIdFromObjectUri(draftActivityId)).resolves.toBeNull();
  });

  it('answers null for a URI naming nothing here, whatever its id shape', async () => {
    // An id of any shape is a bound parameter that matches no row: a uuid we
    // never minted, a 24-char ObjectId hex, and a value that is neither.
    await expect(
      resolvePostIdFromObjectUri(localNoteUri('0195b2a6-0000-7000-8000-000000000000')),
    ).resolves.toBeNull();
    await expect(
      resolvePostIdFromObjectUri(localNoteUri('507f1f77bcf86cd799439011')),
    ).resolves.toBeNull();
    await expect(resolvePostIdFromObjectUri(localNoteUri('nonsense'))).resolves.toBeNull();
    await expect(resolvePostIdFromObjectUri('https://remote.example/never/seen')).resolves.toBeNull();
  });
});
