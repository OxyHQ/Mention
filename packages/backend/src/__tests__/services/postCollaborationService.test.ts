import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * {@link PostCollaborationService} — invite validation, the authorship writes,
 * and the DEFERRED federation gate.
 *
 * ## What changed with the Postgres port
 *
 * Authorship is a TABLE now (`post_authorships`), with a partial unique index
 * allowing exactly one `owner` row per post, and the only correct write is the
 * transactional delete-then-insert in `replacePostAuthorship`. The service
 * therefore persists the list itself instead of handing the caller a mutated
 * document to `.save()`.
 *
 * That is precisely what the old suite could not see. It built a `fakePost` with
 * a `save: vi.fn()` and asserted that entries on that in-memory object had been
 * flipped — which stays true whether or not anything reached the database, and
 * which cannot notice the failure mode the new schema introduces: a rewrite that
 * drops the owner row, duplicates it, or loses `respondedAt`. Every state
 * assertion below reloads the post through `loadPostRecord`.
 *
 * The Oxy client, notifications and the federator stay mocked — they are the
 * network boundaries, and WHICH of them fires is the actual subject of the
 * deferred-federation tests.
 */

const { federateNewPost, createNotification } = vi.hoisted(() => ({
  federateNewPost: vi.fn(async () => undefined),
  createNotification: vi.fn(async () => undefined),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: vi.fn(() => ({
    getUsersByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, type: 'local', username: id, name: { displayName: id } })),
    ),
    getUserById: vi.fn(async (id: string) => ({
      id,
      type: 'local',
      username: id,
      name: { displayName: id },
    })),
    getProfileByUsername: vi.fn(async (username: string) => {
      if (username === 'ghost') throw new Error('not found');
      if (username === 'remote') return { id: 'fed-1', type: 'federated', username: 'remote' };
      return { id: `user-${username}`, type: 'local', username };
    }),
  })),
}));

vi.mock('../../utils/notificationUtils', () => ({ createNotification }));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async () => [{}]) },
}));

vi.mock('../../services/serviceRegistry', () => ({
  getPostFederator: () => ({ federateNewPost }),
}));

import { closePostgres, connectPostgres } from '../../db/postgres';
import { clearServiceScope, readPost, seedPost, serviceScope } from '../helpers/serviceFixtures';
import {
  postCollaborationService,
  CollabValidationError,
  CollabStateError,
} from '../../services/PostCollaborationService';
import { buildAuthorship } from '../../utils/postAuthorship';
import type { PostRecord } from '../../db/posts/postRecord';
import type { PostAuthorshipEntry } from '@mention/shared-types';

const scope = serviceScope('post-collaboration');
const OWNER = scope.user('owner');
const C1 = scope.user('c-1');
const C2 = scope.user('c-2');

/** Seed a published, local, top-level post with the given authorship. */
function seedCollabPost(
  authorship: PostAuthorshipEntry[],
  overrides: Parameters<typeof seedPost>[1] = {},
): Promise<PostRecord> {
  return seedPost(scope, {
    oxyUserId: OWNER,
    authorship,
    metadata: { collabFederationDeferred: authorship.length > 1 },
    ...overrides,
  });
}

/** The authorship as it is STORED right now, keyed by collaborator id. */
async function storedAuthorship(postId: string): Promise<Map<string, PostAuthorshipEntry>> {
  const post = await readPost(postId);
  if (!post) throw new Error(`post ${postId} is gone`);
  return new Map(post.authorship.map((entry) => [entry.oxyUserId, entry]));
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearServiceScope(scope);
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('PostCollaborationService — invite resolution (no post required)', () => {
  it('returns validated unique collaborator ids', async () => {
    await expect(postCollaborationService.validateInvites(OWNER, [C1, C2])).resolves.toEqual([C1, C2]);
  });

  it('rejects self-invite', async () => {
    await expect(postCollaborationService.validateInvites(OWNER, [OWNER])).rejects.toBeInstanceOf(
      CollabValidationError,
    );
  });

  it('returns undefined when no collaborators provided', async () => {
    await expect(postCollaborationService.resolveCollaboratorRefs(OWNER)).resolves.toBeUndefined();
  });

  it('passes through collaborator IDs', async () => {
    await expect(postCollaborationService.resolveCollaboratorRefs(OWNER, [C1, C2])).resolves.toEqual([
      C1,
      C2,
    ]);
  });

  it('resolves local handles to IDs', async () => {
    await expect(
      postCollaborationService.resolveCollaboratorRefs(OWNER, undefined, ['@alice', 'bob']),
    ).resolves.toEqual(['user-alice', 'user-bob']);
  });

  it('rejects unknown handles', async () => {
    await expect(
      postCollaborationService.resolveCollaboratorRefs(OWNER, undefined, ['ghost']),
    ).rejects.toThrow('Unknown user: @ghost');
  });

  it('rejects federated users from handle lookup', async () => {
    await expect(
      postCollaborationService.resolveCollaboratorRefs(OWNER, undefined, ['remote']),
    ).rejects.toThrow('Federated users cannot be collaborators');
  });

  it('creates owner + pending collaborators', () => {
    const authorship = postCollaborationService.buildAuthorship(OWNER, [C1]);
    expect(authorship[0]).toMatchObject({ oxyUserId: OWNER, role: 'owner', status: 'accepted' });
    expect(authorship[1]).toMatchObject({ oxyUserId: C1, role: 'collaborator', status: 'pending' });
  });
});

describe('PostCollaborationService.attachCollaborators', () => {
  it('persists the pending collaborators onto a solo post, keeping exactly one owner row', async () => {
    const post = await seedCollabPost(buildAuthorship(OWNER, []), { metadata: {} });

    const returned = await postCollaborationService.attachCollaborators(post, OWNER, [C1]);

    const stored = await storedAuthorship(post.id);
    expect(stored.size).toBe(2);
    // The partial unique index allows one owner; a rewrite that re-inserted the
    // owner without deleting it would have failed the write, and one that
    // dropped it leaves an unattributable post.
    expect(stored.get(OWNER)).toMatchObject({ role: 'owner', status: 'accepted' });
    expect(stored.get(C1)).toMatchObject({ role: 'collaborator', status: 'pending' });
    // The deferral flag is STORED, not merely returned — it is what
    // `maybeFederateOnResolve` reads later, from a fresh load.
    expect((await readPost(post.id))?.metadata.collabFederationDeferred).toBe(true);
    expect(returned.metadata.collabFederationDeferred).toBe(true);
  });

  it('does not set collabFederationDeferred when the post already federated', async () => {
    const post = await seedCollabPost(buildAuthorship(OWNER, []), {
      metadata: { federationDelivered: true },
    });

    await postCollaborationService.attachCollaborators(post, OWNER, [C1]);

    // Solo posts federate at creation; converting to collab via edit must not
    // schedule a SECOND delivery when the invites resolve.
    expect((await readPost(post.id))?.metadata.collabFederationDeferred).toBe(false);
    // The invite itself still landed.
    expect((await storedAuthorship(post.id)).get(C1)?.status).toBe('pending');
  });

  it('rejects posts that already have collaborators, writing nothing', async () => {
    const post = await seedCollabPost(buildAuthorship(OWNER, [C1]));

    await expect(
      postCollaborationService.attachCollaborators(post, OWNER, [C2]),
    ).rejects.toBeInstanceOf(CollabStateError);

    expect((await storedAuthorship(post.id)).has(C2)).toBe(false);
  });

  it('rejects replies, writing nothing', async () => {
    const parent = await seedPost(scope, { oxyUserId: OWNER });
    const post = await seedCollabPost(buildAuthorship(OWNER, []), {
      metadata: {},
      parentPostId: parent.id,
    });

    await expect(
      postCollaborationService.attachCollaborators(post, OWNER, [C1]),
    ).rejects.toBeInstanceOf(CollabValidationError);

    expect((await storedAuthorship(post.id)).size).toBe(1);
  });

  it('rejects a caller who is not the owner', async () => {
    const post = await seedCollabPost(buildAuthorship(OWNER, []), { metadata: {} });

    await expect(
      postCollaborationService.attachCollaborators(post, C1, [C2]),
    ).rejects.toBeInstanceOf(CollabStateError);

    expect((await storedAuthorship(post.id)).size).toBe(1);
  });
});

describe('PostCollaborationService.autoAcceptInvites', () => {
  it('accepts pending invites for users in the set and leaves the rest pending', async () => {
    const post = await seedCollabPost(buildAuthorship(OWNER, [C1, C2]));

    const result = await postCollaborationService.autoAcceptInvites(post, new Set([C1]));

    const stored = await storedAuthorship(post.id);
    expect(stored.get(C1)?.status).toBe('accepted');
    expect(stored.get(C1)?.respondedAt).toBeTruthy();
    expect(stored.get(C2)?.status).toBe('pending');
    expect(result.authorship.find((e) => e.oxyUserId === C1)?.status).toBe('accepted');
    // One invite is still pending, so the deferred fan-out must not fire.
    expect(federateNewPost).not.toHaveBeenCalled();
  });

  it('federates when auto-accept resolves the last pending invite', async () => {
    const post = await seedCollabPost(buildAuthorship(OWNER, [C1]));

    await postCollaborationService.autoAcceptInvites(post, new Set([C1]));

    expect(federateNewPost).toHaveBeenCalledTimes(1);
    // And the markers move together, durably: delivered set, deferral cleared.
    const reloaded = await readPost(post.id);
    expect(reloaded?.metadata.federationDelivered).toBe(true);
    expect(reloaded?.metadata.collabFederationDeferred).toBe(false);
  });

  it('is a no-op when no pending invite matches', async () => {
    const post = await seedCollabPost(buildAuthorship(OWNER, [C1]));
    const before = await storedAuthorship(post.id);

    const result = await postCollaborationService.autoAcceptInvites(post, new Set(['stranger']));

    expect(result).toBe(post);
    const after = await storedAuthorship(post.id);
    expect(after.get(C1)?.status).toBe(before.get(C1)?.status);
    expect(after.get(C1)?.respondedAt).toBeUndefined();
  });
});

describe('PostCollaborationService.accept — deferred federation gate', () => {
  it('federates once the LAST pending invite is accepted', async () => {
    const post = await seedCollabPost(buildAuthorship(OWNER, [C1]));

    await postCollaborationService.accept(post.id, C1);

    expect(federateNewPost).toHaveBeenCalledTimes(1);
    const [federated, ownerId, username] = federateNewPost.mock.calls[0] as [
      { id: string },
      string,
      string,
    ];
    expect(federated.id).toBe(post.id);
    expect(ownerId).toBe(OWNER);
    expect(username).toBe(OWNER);
    expect((await readPost(post.id))?.metadata.federationDelivered).toBe(true);
  });

  it('does NOT federate while another invite is still pending', async () => {
    const post = await seedCollabPost(buildAuthorship(OWNER, [C1, C2]));

    await postCollaborationService.accept(post.id, C1);

    expect(federateNewPost).not.toHaveBeenCalled();
    // The deferral survives for the invite that has yet to resolve.
    expect((await readPost(post.id))?.metadata.collabFederationDeferred).toBe(true);
  });

  it('does NOT federate a scheduled post on accept (defers to publish)', async () => {
    const post = await seedCollabPost(buildAuthorship(OWNER, [C1]), {
      status: 'scheduled',
      scheduledFor: new Date(Date.now() + 3_600_000),
    });

    await postCollaborationService.accept(post.id, C1);

    expect(federateNewPost).not.toHaveBeenCalled();
    // The accept still landed — only the fan-out waits for the publisher.
    expect((await storedAuthorship(post.id)).get(C1)?.status).toBe('accepted');
  });

  it('does NOT federate when collabFederationDeferred is unset (solo post converted via edit)', async () => {
    const post = await seedCollabPost(buildAuthorship(OWNER, [C1]), {
      metadata: { federationDelivered: true },
    });

    await postCollaborationService.accept(post.id, C1);

    expect(federateNewPost).not.toHaveBeenCalled();
  });

  it('does NOT federate a post that arrived from the fediverse', async () => {
    const post = await seedCollabPost(buildAuthorship(OWNER, [C1]), {
      federation: { activityId: `https://remote.example/${scope.name}/statuses/1` },
    });

    await postCollaborationService.accept(post.id, C1);

    expect(federateNewPost).not.toHaveBeenCalled();
  });

  it('throws when the viewer has no pending invite, and stores nothing', async () => {
    const post = await seedCollabPost(buildAuthorship(OWNER, [C1]));

    await expect(postCollaborationService.accept(post.id, 'stranger')).rejects.toBeInstanceOf(
      CollabStateError,
    );

    expect(federateNewPost).not.toHaveBeenCalled();
    const stored = await storedAuthorship(post.id);
    expect(stored.size).toBe(2);
    expect(stored.get(C1)?.status).toBe('pending');
  });

  it('throws for a post that does not exist', async () => {
    await expect(
      postCollaborationService.accept('019f0000-0000-7000-8000-000000000000', C1),
    ).rejects.toBeInstanceOf(CollabStateError);
  });

  it('stores the accepting user as accepted (co-authorship contract)', async () => {
    // The controller hydrates and returns THIS post; the client reads the
    // resulting `authors[]` / `viewerState.isCollaborator` to show the new
    // collaboration everywhere. The stored row is what every later read sees.
    const post = await seedCollabPost(buildAuthorship(OWNER, [C1]));

    const result = await postCollaborationService.accept(post.id, C1);

    expect((await storedAuthorship(post.id)).get(C1)).toMatchObject({
      role: 'collaborator',
      status: 'accepted',
    });
    expect(result.authorship.find((e) => e.oxyUserId === C1)?.status).toBe('accepted');
    expect(createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ recipientId: OWNER, actorId: C1, type: 'collab_accepted' }),
    );
  });
});

describe('PostCollaborationService.decline — deferred federation gate', () => {
  it('federates the owner post when the last invite is declined', async () => {
    const post = await seedCollabPost(buildAuthorship(OWNER, [C1]));

    await postCollaborationService.decline(post.id, C1);

    // A declined invite still resolves the post: it is a valid owner post and
    // must not stay stuck un-federated.
    expect(federateNewPost).toHaveBeenCalledTimes(1);
    expect((await storedAuthorship(post.id)).get(C1)?.status).toBe('declined');
  });

  it('stores the decline, leaving others pending and the fan-out deferred', async () => {
    const post = await seedCollabPost(buildAuthorship(OWNER, [C1, C2]));

    const result = await postCollaborationService.decline(post.id, C1);

    const stored = await storedAuthorship(post.id);
    expect(stored.get(C1)?.status).toBe('declined');
    expect(stored.get(C2)?.status).toBe('pending');
    expect(result.authorship.find((e) => e.oxyUserId === C1)?.status).toBe('declined');
    expect(federateNewPost).not.toHaveBeenCalled();
  });
});

describe('PostCollaborationService.stopSharing', () => {
  it('moves an ACCEPTED collaborator to stopped, and refuses a pending one', async () => {
    const post = await seedCollabPost(buildAuthorship(OWNER, [C1, C2]));
    await postCollaborationService.accept(post.id, C1);

    await postCollaborationService.stopSharing(post.id, C1);
    expect((await storedAuthorship(post.id)).get(C1)?.status).toBe('stopped');

    // C2 never accepted, so there is nothing to stop.
    await expect(postCollaborationService.stopSharing(post.id, C2)).rejects.toBeInstanceOf(
      CollabStateError,
    );
    expect((await storedAuthorship(post.id)).get(C2)?.status).toBe('pending');
  });
});

describe('buildAuthorship helper', () => {
  it('always includes owner first', () => {
    const authorship = buildAuthorship(OWNER, []);
    expect(authorship).toHaveLength(1);
    expect(authorship[0].role).toBe('owner');
  });
});

describe('CollabStateError', () => {
  it('is named correctly', () => {
    expect(new CollabStateError('x').name).toBe('CollabStateError');
  });
});
