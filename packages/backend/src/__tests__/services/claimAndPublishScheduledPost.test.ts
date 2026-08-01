import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The claim that makes "publish now" safe.
 *
 * `publishScheduledPost` flips the status on a document it was HANDED, so two
 * callers holding the same document both run the whole pipeline: federating
 * twice, writing two MTN records, notifying twice. That is reachable — the 60s
 * sweep can load a due post moments before its author taps "post now".
 *
 * The mutual exclusion is a `findOneAndUpdate` filtered on
 * `status: 'scheduled'`, which is also the filter the sweep selects on. These
 * cases pin the three properties that follow from it: exactly one caller
 * publishes, a non-owner never does, and an already-published post cannot be
 * published again.
 */
const hoisted = vi.hoisted(() => ({
  findOneAndUpdate: vi.fn(),
  publishScheduledPost: vi.fn(),
}));

vi.mock('../../models/Post', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Post: { findOneAndUpdate: hoisted.findOneAndUpdate },
}));

vi.mock('../../runtime/socketServer', () => ({ getRuntimeSocketServer: () => undefined }));

import { postCreationService } from '../../services/PostCreationService';

const POST_ID = '650000000000000000000010';
const OWNER = 'oxy-author';
const STRANGER = 'oxy-someone-else';

/**
 * A Mongo-like conditional update over ONE in-memory post: it matches only while
 * the stored status still satisfies the filter, which is exactly the property
 * the claim relies on.
 */
function stubStore(initialStatus: 'scheduled' | 'published', ownerId = OWNER) {
  const doc = { _id: POST_ID, oxyUserId: ownerId, status: initialStatus };
  hoisted.findOneAndUpdate.mockImplementation(async (filter: Record<string, unknown>) => {
    const statusMatches = filter.status === undefined || filter.status === doc.status;
    const ownerMatches = filter.oxyUserId === undefined || filter.oxyUserId === doc.oxyUserId;
    const idMatches = filter._id === doc._id;
    if (!statusMatches || !ownerMatches || !idMatches) return null;
    doc.status = 'published';
    return doc;
  });
  return doc;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The publish pipeline itself is covered by its own tests; here it only has to
  // be observable, so the claim's effect on how OFTEN it runs is what shows.
  vi.spyOn(postCreationService, 'publishScheduledPost').mockImplementation(
    hoisted.publishScheduledPost.mockImplementation(async (post: unknown) => post),
  );
});

describe('claimAndPublishScheduledPost — exactly once', () => {
  it('publishes a scheduled post the owner claims', async () => {
    stubStore('scheduled');

    const result = await postCreationService.claimAndPublishScheduledPost({
      postId: POST_ID,
      ownerId: OWNER,
    });

    expect(result).not.toBeNull();
    expect(hoisted.publishScheduledPost).toHaveBeenCalledTimes(1);
  });

  it('runs the publish pipeline ONCE when two callers race', async () => {
    stubStore('scheduled');

    // The author tapping "post now" while the sweep is mid-batch on the same post.
    const [author, sweep] = await Promise.all([
      postCreationService.claimAndPublishScheduledPost({ postId: POST_ID, ownerId: OWNER }),
      postCreationService.claimAndPublishScheduledPost({ postId: POST_ID }),
    ]);

    const winners = [author, sweep].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    // The point of the whole exercise: one federation, one MTN record, one set
    // of notifications.
    expect(hoisted.publishScheduledPost).toHaveBeenCalledTimes(1);
  });

  it('refuses a second publish of a post that already went out', async () => {
    stubStore('published');

    const result = await postCreationService.claimAndPublishScheduledPost({
      postId: POST_ID,
      ownerId: OWNER,
    });

    expect(result).toBeNull();
    expect(hoisted.publishScheduledPost).not.toHaveBeenCalled();
  });
});

describe('claimAndPublishScheduledPost — ownership', () => {
  it('REFUSES to publish another user\'s scheduled post', async () => {
    stubStore('scheduled');

    const result = await postCreationService.claimAndPublishScheduledPost({
      postId: POST_ID,
      ownerId: STRANGER,
    });

    expect(result).toBeNull();
    expect(hoisted.publishScheduledPost).not.toHaveBeenCalled();
  });

  it('leaves the post publishable by its real owner after a stranger is refused', async () => {
    stubStore('scheduled');

    await postCreationService.claimAndPublishScheduledPost({ postId: POST_ID, ownerId: STRANGER });
    const owner = await postCreationService.claimAndPublishScheduledPost({
      postId: POST_ID,
      ownerId: OWNER,
    });

    // A refused claim must not consume the post — otherwise anyone could grief
    // an author out of their own scheduled post.
    expect(owner).not.toBeNull();
    expect(hoisted.publishScheduledPost).toHaveBeenCalledTimes(1);
  });

  it('lets the SWEEP publish without an owner, since it acts for nobody', async () => {
    stubStore('scheduled');

    const result = await postCreationService.claimAndPublishScheduledPost({ postId: POST_ID });

    expect(result).not.toBeNull();
    const filter = hoisted.findOneAndUpdate.mock.calls[0][0];
    expect(filter.oxyUserId).toBeUndefined();
    expect(filter.status).toBe('scheduled');
  });

  it('always constrains the claim to a SCHEDULED post, whoever is asking', async () => {
    stubStore('scheduled');

    await postCreationService.claimAndPublishScheduledPost({ postId: POST_ID, ownerId: OWNER });

    // Dropping this from the filter is what would make a double publish possible.
    expect(hoisted.findOneAndUpdate.mock.calls[0][0].status).toBe('scheduled');
  });
});
