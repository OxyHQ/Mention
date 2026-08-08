import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres } from '../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  loadActorFields,
  readActor,
  seedActor,
  seedFollow,
} from '../helpers/federationFixtures';

const scope = federationScope('federation-service');
/**
 * Every actor this suite invents lives under its OWN origin.
 *
 * The rows the code under test writes are federated posts, and the only handle
 * every one of them carries is `federation.activity_id` — which is derived from
 * the actor URI. Hard-coding `mastodon.social` (as this file used to) makes
 * those rows unscopable, and vitest runs ten files at once against one database.
 */
const BOB_URI = `${scope.origin}/users/bob`;
const ALICE_URI = `${scope.origin}/users/alice`;
const CAROL_URI = `${scope.origin}/users/carol`;
const DIETER_URI = `${scope.origin}/users/dieter`;
/** A ccTLD instance, for the coarse-region derivation. Cleaned up explicitly. */
const DE_ACTOR_URI = 'https://social.example.de/users/dieter';

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

const mocks = vi.hoisted(() => ({
  getPublicKey: vi.fn(),
  signViaOxy: vi.fn(),
  signRequest: vi.fn(),
  findOneAndUpdate: vi.fn(),
  updateOne: vi.fn(),
  /** The real `PostCreationService`, captured when it registers itself. */
  creator: null as null | { create: (params: Record<string, unknown>) => Promise<unknown> },
  federateNewPost: vi.fn(async () => undefined),
  getServiceOxyClient: vi.fn(),
  makeServiceRequest: vi.fn(),
  persistRemoteMedia: vi.fn(),
  recordAccess: vi.fn(),
  assertSafePublicUrl: vi.fn(),
  fetchUpstreamFollowingRedirects: vi.fn(),
  fetchUpstreamSingleHop: vi.fn(),
}));

vi.mock('../../connectors/activitypub/crypto', () => ({
  getPublicKey: mocks.getPublicKey,
  signViaOxy: mocks.signViaOxy,
  signRequest: mocks.signRequest,
}));

vi.mock('@oxyhq/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxyhq/core/server')>()),
  assertSafePublicUrl: mocks.assertSafePublicUrl,
}));

// `models/Post` is NOT mocked and `PostEngagementCommandService` is NOT mocked:
// posts, likes and the denormalized counters are all Postgres now, and the
// counter-in-lockstep guarantee this suite exists to protect is a property of
// the rows, not of which function was called with what.

vi.mock('../../utils/notificationUtils', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  createMentionNotifications: vi.fn().mockResolvedValue(undefined),
  createBatchNotifications: vi.fn().mockResolvedValue(undefined),
  createPostAuthorNotifications: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn().mockResolvedValue([]) },
  resolveUserSummaries: vi.fn(async () => new Map()),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: mocks.getServiceOxyClient,
}));

vi.mock('../../utils/safeUpstreamFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/safeUpstreamFetch')>();
  return {
    ...actual,
    fetchUpstreamFollowingRedirects: mocks.fetchUpstreamFollowingRedirects,
    fetchUpstreamSingleHop: mocks.fetchUpstreamSingleHop,
  };
});

vi.mock('../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: mocks.persistRemoteMedia,
}));

vi.mock('../../services/mediaCache/cacheStore', () => ({
  recordAccessAndMaybeEnqueue: mocks.recordAccess,
}));

// The service registry breaks the FederationService <-> PostCreationService
// circular import. The REAL creator stays behind it: a federated note or boost
// has to become a row the next resolution step can read back, which a stub
// cannot express.
vi.mock('../../services/serviceRegistry', () => ({
  getPostCreator: () => {
    if (!mocks.creator) throw new Error('PostCreator not registered');
    return mocks.creator;
  },
  getPostFederator: () => ({ federateNewPost: mocks.federateNewPost }),
  registerPostCreator: (instance: { create: (params: Record<string, unknown>) => Promise<unknown> }) => {
    mocks.creator = instance;
  },
  registerPostFederator: vi.fn(),
}));

import { and, eq, inArray, like, or, type SQL } from 'drizzle-orm';
import { getDb } from '../../db/postgres';
import { posts } from '../../db/schema/posts';
import { likes } from '../../db/schema/engagement';
import { userSettings } from '../../db/schema/userProfile';
import { bumpPostCounters, insertPostRecord, loadPostRecord } from '../../db/posts/postRepository';
import { PostType, PostVisibility } from '@mention/shared-types';
// Importing the service is what registers it with the (mocked) registry above.
import '../../services/PostCreationService';
import { activityPubConnector as federationService } from '../../connectors/activitypub/ActivityPubConnector';

/**
 * Every activity-id prefix this suite's rows can carry.
 *
 * The scope origin covers the invented actors; the ccTLD instance is a real
 * hostname the region derivation needs, so it is listed explicitly — as the FULL
 * actor URI, not the bare host. `https://social.example.de/` alone also matched
 * a federated post another suite in this batch seeds to exercise the same coarse
 * region, and this sweep deleted it between that suite's create and its read.
 */
const OWNED_ACTIVITY_PREFIXES = [scope.origin, DE_ACTOR_URI];

function ownedPosts(): SQL {
  return or(
    ...OWNED_ACTIVITY_PREFIXES.map((prefix) => like(posts.federationActivityId, `${prefix}%`)),
    like(posts.oxyUserId, `oxy-%-${scope.domain.replace('.test', '')}`),
  ) as SQL;
}

/**
 * Delete every post this suite produced — its own and the ones the code under
 * test wrote.
 *
 * Two passes because these rows reference each other (`boost_of`, `parent_post_id`):
 * clear the links first so the delete cannot be blocked by a foreign key or
 * cascade a row out from under the second statement.
 */
async function clearScopePosts(): Promise<void> {
  const db = getDb();
  // `oxy_user_1` is the id the mocked Oxy resolution hands back, so the settings
  // row the banner mirror writes is not reachable by this suite's own prefix.
  await db.delete(userSettings).where(eq(userSettings.oxyUserId, 'oxy_user_1'));
  const owned = ownedPosts();
  const rows = await db.select({ id: posts.id }).from(posts).where(owned);
  if (rows.length > 0) {
    await db.delete(likes).where(inArray(likes.postId, rows.map((row) => row.id)));
  }
  await db.update(posts).set({ boostOf: null, quoteOf: null, parentPostId: null, threadId: null }).where(owned);
  await db.delete(posts).where(owned);
}

/** A published, public, federated post owned by `oxyUserId`. */
async function seedFederatedPost(input: {
  oxyUserId: string;
  activityId: string;
  actorUri: string;
  text?: string;
}) {
  return insertPostRecord({
    oxyUserId: input.oxyUserId,
    authorship: [{ oxyUserId: input.oxyUserId, role: 'owner', status: 'accepted' }],
    type: PostType.TEXT,
    visibility: PostVisibility.PUBLIC,
    status: 'published',
    content: { variants: [{ source: 'author', text: input.text ?? 'a federated post', tag: 'en' }] },
    federation: { activityId: input.activityId, actorUri: input.actorUri },
  });
}

/** The banner file id stored on an actor's Mention-side settings row. */
async function readProfileHeaderImage(oxyUserId: string): Promise<string | undefined> {
  const [row] = await getDb()
    .select({ profileHeaderImage: userSettings.profileHeaderImage })
    .from(userSettings)
    .where(eq(userSettings.oxyUserId, oxyUserId));
  return row?.profileHeaderImage ?? undefined;
}

/** The stored row for a federated post, looked up the way the code does. */
async function rowByActivityId(activityId: string) {
  const [row] = await getDb()
    .select({
      id: posts.id,
      oxyUserId: posts.oxyUserId,
      type: posts.type,
      boostOf: posts.boostOf,
      createdAt: posts.createdAt,
      updatedAt: posts.updatedAt,
      language: posts.language,
    })
    .from(posts)
    .where(eq(posts.federationActivityId, activityId));
  return row;
}

/** The denormalized counters, which must move only with real records. */
async function countersOf(postId: string) {
  const [row] = await getDb()
    .select({
      likes: posts.statsLikesCount,
      boosts: posts.statsBoostsCount,
      federatedBoosts: posts.statsFederatedBoostsCount,
    })
    .from(posts)
    .where(eq(posts.id, postId));
  return row;
}

/** The `likes` rows for one post — the authority the counter merely projects. */
async function likeRowsFor(postId: string) {
  return getDb()
    .select({ userId: likes.userId, value: likes.value })
    .from(likes)
    .where(eq(likes.postId, postId));
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/activity+json' },
    ...init,
  });
}

function createNoteActivity(id: string, actorUri = ALICE_URI) {
  return {
    id: `${actorUri}/statuses/${id}/activity`,
    type: 'Create',
    actor: actorUri,
    published: `2026-06-18T00:00:0${id}Z`,
    object: {
      id: `${actorUri}/statuses/${id}`,
      type: 'Note',
      attributedTo: actorUri,
      content: `<p>post ${id}</p>`,
      published: `2026-06-18T00:00:0${id}Z`,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    },
  };
}

beforeEach(async () => {
  await clearScopePosts();
  await clearFederationScope(scope, [BOB_URI, ALICE_URI]);
  // The default fixture: the inbound Create path's follower gate passes, because
  // at least one local user follows the note author.
  await seedFollow(scope, { remoteActorUri: ALICE_URI, direction: 'outbound', status: 'accepted' });
  await seedFollow(scope, { remoteActorUri: BOB_URI, direction: 'outbound', status: 'accepted' });
  vi.clearAllMocks();

  mocks.getPublicKey.mockResolvedValue({
    keyId: 'https://mention.earth/ap/users/instance#main-key',
    publicKeyPem: 'public',
  });
  mocks.signViaOxy.mockResolvedValue('signature');
  mocks.signRequest.mockResolvedValue({
    Host: 'www.threads.net',
    Date: 'Thu, 18 Jun 2026 00:00:00 GMT',
    Signature: 'signature',
  });
  mocks.findOneAndUpdate.mockImplementation(async (_query, update) => ({
    _id: 'actor_1',
    ...update.$set,
  }));
  mocks.updateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.assertSafePublicUrl.mockResolvedValue({ ok: true, ip: '93.184.216.34', family: 4 });
  mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false });
  mocks.recordAccess.mockResolvedValue(undefined);
  mocks.makeServiceRequest.mockResolvedValue({ id: 'oxy_user_1' });
  mocks.fetchUpstreamFollowingRedirects.mockReset();
  // `signedFetch` is built on `fetchUpstreamSingleHop` (IP-pinned, no global
  // `fetch`). Adapt it to the per-test stubbed global `fetch` so existing tests
  // that assert on the `fetch(url, { headers })` shape keep exercising the real
  // signing/redirect logic — the only thing that changed is the transport.
  mocks.fetchUpstreamSingleHop.mockImplementation(
    async (url: string, options: { headers: Record<string, string>; method?: string; body?: BodyInit }) => {
      const res: Response = await (globalThis.fetch as typeof fetch)(url, {
        headers: options.headers,
        method: options.method,
        body: options.body,
      });
      const bodyBuffer = Buffer.from(await res.arrayBuffer());
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });
      const stream = new PassThrough();
      stream.end(bodyBuffer);
      return { response: stream, status: res.status, headers };
    },
  );
  mocks.getServiceOxyClient.mockReturnValue({
    makeServiceRequest: mocks.makeServiceRequest,
    getUserById: vi.fn(async (id: string) => ({ id, username: 'someone' })),
    getUsersByIds: vi.fn(async () => []),
  });
});

describe('federationService.deliverActivity', () => {
  it('posts via the SSRF-safe single-hop fetcher instead of global fetch', async () => {
    const fetchMock = vi.fn(async () => new Response('should not be used', { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    const stream = new PassThrough();
    stream.end('accepted');
    mocks.fetchUpstreamSingleHop.mockResolvedValueOnce({
      response: stream,
      status: 202,
      headers: {},
    });

    const delivered = await federationService.deliverActivity(
      { type: 'Follow', id: 'https://mention.earth/ap/users/alice/follows/1' },
      'https://remote.example/users/bob/inbox',
      'oxy_alice',
      'alice',
    );

    expect(delivered).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.fetchUpstreamSingleHop).toHaveBeenCalledWith(
      'https://remote.example/users/bob/inbox',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/activity+json',
          'User-Agent': expect.any(String),
        }),
        body: expect.stringContaining('"type":"Follow"'),
      }),
    );
  });

  it('returns false when the SSRF-safe fetcher rejects a blocked inbox URL', async () => {
    const fetchMock = vi.fn(async () => new Response('should not be used', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    mocks.fetchUpstreamSingleHop.mockRejectedValueOnce(new Error('literal ip in blocked range'));

    const delivered = await federationService.deliverActivity(
      { type: 'Follow', id: 'https://mention.earth/ap/users/alice/follows/2' },
      'http://127.0.0.1/internal-admin/inbox',
      'oxy_alice',
      'alice',
    );

    expect(delivered).toBe(false);
    expect(mocks.fetchUpstreamSingleHop).toHaveBeenCalledWith(
      'http://127.0.0.1/internal-admin/inbox',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('federationService.fetchRemoteActor', () => {
  it('preserves canonical www hostnames such as Threads actor URIs', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://www.threads.net/ap/users/mosseri/') {
        return jsonResponse({
          id: 'https://www.threads.net/ap/users/mosseri/',
          type: 'Person',
          preferredUsername: 'mosseri',
          name: 'Adam Mosseri',
          inbox: 'https://www.threads.net/ap/users/mosseri/inbox',
          outbox: 'https://www.threads.net/ap/users/mosseri/outbox',
          publicKey: {
            id: 'https://www.threads.net/ap/users/mosseri/#main-key',
            publicKeyPem: 'remote-public',
          },
        });
      }

      if (url === 'https://www.threads.net/ap/users/mosseri/outbox') {
        return jsonResponse({ type: 'OrderedCollection', totalItems: 12 });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const actor = await federationService.fetchRemoteActor(
      'https://www.threads.net/ap/users/mosseri/',
      false,
      'mosseri@threads.net',
    );

    expect(actor?.uri).toBe('https://www.threads.net/ap/users/mosseri/');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.threads.net/ap/users/mosseri/',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: expect.stringContaining('application/activity+json'),
        }),
      }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('https://threads.net/ap/users/mosseri/'),
      expect.anything(),
    );
    // The stored ROW, not the shape of an upsert call: a `toHaveBeenCalledWith`
    // here passed whether or not the write reached a database.
    expect(await readActor('https://www.threads.net/ap/users/mosseri/')).toMatchObject({
      uri: 'https://www.threads.net/ap/users/mosseri/',
      acct: 'mosseri@threads.net',
      domain: 'threads.net',
      outboxUrl: 'https://www.threads.net/ap/users/mosseri/outbox',
    });
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith(
      'PUT',
      '/users/resolve',
      expect.objectContaining({
        username: 'mosseri@threads.net',
        actorUri: 'https://www.threads.net/ap/users/mosseri/',
        domain: 'threads.net',
      }),
    );
  });

  it('rejects actor documents that claim a different origin than the fetched URI', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://evil.example/users/mallory') {
        return jsonResponse({
          id: 'https://victim.example/users/alice',
          type: 'Person',
          preferredUsername: 'alice',
          name: 'Alice',
          inbox: 'https://evil.example/users/mallory/inbox',
          publicKey: {
            id: 'https://victim.example/users/alice#main-key',
            publicKeyPem: 'attacker-public',
          },
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const actor = await federationService.fetchRemoteActor('https://evil.example/users/mallory');

    expect(actor).toBeNull();
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
  });

  it('rejects actor documents with a cross-origin public key id', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://remote.example/users/alice') {
        return jsonResponse({
          id: 'https://remote.example/users/alice',
          type: 'Person',
          preferredUsername: 'alice',
          name: 'Alice',
          inbox: 'https://remote.example/users/alice/inbox',
          publicKey: {
            id: 'https://victim.example/users/alice#main-key',
            publicKeyPem: 'remote-public',
          },
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const actor = await federationService.fetchRemoteActor('https://remote.example/users/alice');

    expect(actor).toBeNull();
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
  });

  it('does not trust cross-domain acct hints or actor webfinger claims', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://evil.example/users/mallory') {
        return jsonResponse({
          id: 'https://evil.example/users/mallory',
          type: 'Person',
          preferredUsername: 'mallory',
          name: 'Mallory',
          webfinger: 'victim@trusted.example',
          inbox: 'https://evil.example/users/mallory/inbox',
          outbox: 'https://evil.example/users/mallory/outbox',
          publicKey: {
            id: 'https://evil.example/users/mallory#main-key',
            publicKeyPem: 'remote-public',
          },
        });
      }

      if (url === 'https://evil.example/users/mallory/outbox') {
        return jsonResponse({ type: 'OrderedCollection', totalItems: 0 });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await federationService.fetchRemoteActor(
      'https://evil.example/users/mallory',
      false,
      'victim@trusted.example',
    );

    expect(await readActor('https://evil.example/users/mallory')).toMatchObject({
      uri: 'https://evil.example/users/mallory',
      acct: 'mallory@evil.example',
      domain: 'evil.example',
    });
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith(
      'PUT',
      '/users/resolve',
      expect.objectContaining({
        username: 'mallory@evil.example',
        actorUri: 'https://evil.example/users/mallory',
        domain: 'evil.example',
      }),
    );
  });

  it('mirrors the actor banner to a public federated asset and stores its file id', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://remote.example/users/alice') {
        return jsonResponse({
          id: 'https://remote.example/users/alice',
          type: 'Person',
          preferredUsername: 'alice',
          name: 'Alice',
          inbox: 'https://remote.example/users/alice/inbox',
          image: { url: 'https://remote.example/banner.jpg' },
        });
      }

      throw new Error(`unexpected global fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    mocks.persistRemoteMedia.mockResolvedValue({
      ok: true,
      media: { oxyFileId: 'banner_file_1', contentType: 'image/jpeg', sizeBytes: 1234 },
    });

    await federationService.fetchRemoteActor('https://remote.example/users/alice');

    // The banner is mirrored through the SAME service-token public-upload path as
    // all other federated media (`persistRemoteMediaForFederatedOwnerDetailed` →
    // `POST /assets/service/federation`), NOT the user-authenticated SDK
    // `uploadProfileBanner` (which 401s on the service client). SSRF guarding +
    // content validation now live inside that helper's `downloadToTempFile`.
    expect(mocks.persistRemoteMedia).toHaveBeenCalledWith(
      'https://remote.example/banner.jpg',
      'oxy_user_1',
      expect.objectContaining({ role: 'banner', remoteHost: 'remote.example' }),
      // Banners download under an image-only policy, never the generic
      // federated-media video/audio allowance (see policy.ts).
      expect.objectContaining({ allowedContentTypePrefixes: ['image/'] }),
    );
    // The mirrored file id is STORED on the actor's Mention-side settings row —
    // `user_settings.profile_header_image` is what `buildLocalActorObject` reads
    // back to emit the AP `image`, so a mirror that never reached the column
    // leaves the banner mirrored and invisible.
    expect(await readProfileHeaderImage('oxy_user_1')).toBe('banner_file_1');
  });

  it('does not store a profile header image when banner mirroring fails', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://remote.example/users/bob') {
        return jsonResponse({
          id: 'https://remote.example/users/bob',
          type: 'Person',
          preferredUsername: 'bob',
          inbox: 'https://remote.example/users/bob/inbox',
          image: 'https://remote.example/banner.txt',
        });
      }

      throw new Error(`unexpected global fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    mocks.persistRemoteMedia.mockResolvedValue({ ok: false, reason: 'not-media', permanent: true });

    await federationService.fetchRemoteActor('https://remote.example/users/bob');

    expect(mocks.persistRemoteMedia).toHaveBeenCalledWith(
      'https://remote.example/banner.txt',
      'oxy_user_1',
      expect.objectContaining({ role: 'banner' }),
      expect.objectContaining({ allowedContentTypePrefixes: ['image/'] }),
    );
    // Nothing stored: a failed mirror must not leave a header pointing at a file
    // that was never uploaded.
    expect(await readProfileHeaderImage('oxy_user_1')).toBeUndefined();
  });

  it('normalizes the whitespace of every remote text field on the actor', async () => {
    // Remote actor text arrives with the whitespace of the remote server's
    // markup. The display name is the worst of them: it crosses the identity
    // bridge into Oxy, is cached in Redis, and ships on every post DTO — so a
    // newline in it would be rendered verbatim across the whole app.
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://remote.example/users/carol') {
        return jsonResponse({
          id: 'https://remote.example/users/carol',
          type: 'Person',
          preferredUsername: '  carol\n ',
          name: '  Carol\n  Danvers  ',
          summary: '<p>\n      Primera línea\n    </p>\n    <p>\n      Segunda línea\n    </p>',
          inbox: 'https://remote.example/users/carol/inbox',
          attachment: [
            { type: 'PropertyValue', name: '  Sitio\n  web  ', value: '  <a href="https://carol.example">carol.example</a>\n  ' },
            { type: 'PropertyValue', name: '   \n ', value: 'dropped: the label is only whitespace' },
          ],
        });
      }

      throw new Error(`unexpected global fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await federationService.fetchRemoteActor('https://remote.example/users/carol');

    const stored = await readActor('https://remote.example/users/carol');
    expect(stored).toMatchObject({
      username: 'carol',
      // The bio is a body: the author's paragraph break survives, the markup's
      // indentation and blank line do not.
      summary: 'Primera línea\n\nSegunda línea',
    });
    // The verified-links table is a SECOND table now, so it is read back rather
    // than compared inside the upsert payload.
    expect(await loadActorFields(stored!.id)).toEqual([
      { name: 'Sitio web', value: '<a href="https://carol.example">carol.example</a>', verifiedAt: undefined },
    ]);
    // The display name that crosses into Oxy is collapsed to a single line.
    expect(mocks.makeServiceRequest).toHaveBeenCalledWith(
      'PUT',
      '/users/resolve',
      expect.objectContaining({ displayName: 'Carol Danvers' }),
    );
  });

  it('skips actors on the Oxy identity apex without fetching, creating a FederatedActor, or resolving an Oxy user', async () => {
    // Oxy publishes every local user as `acct:<user>@oxy.so` via the DID layer,
    // so an actor on our own identity apex must never be treated as a remote
    // source — doing so duplicates a local user as a "federated" account. The
    // guard must short-circuit BEFORE any network I/O; any fetch attempt here
    // fails the test.
    const fetchMock = vi.fn(async (url: string) => {
      throw new Error(`unexpected fetch to own identity apex: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await federationService.fetchRemoteActor(
      'https://oxy.so/u/69b2d3df5d12f58c9800d651',
      false,
      'alice@oxy.so',
    );

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.fetchUpstreamSingleHop).not.toHaveBeenCalled();
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.makeServiceRequest).not.toHaveBeenCalled();
  });
});

describe('federationService.syncOutboxPostsDetailed', () => {
  it('does not stamp cooldown for non-empty outboxes that expose no importable pages', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://www.threads.net/ap/users/mosseri/outbox/') {
        return jsonResponse({
          type: 'OrderedCollection',
          totalItems: 2169,
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await federationService.syncOutboxPostsDetailed({
      uri: 'https://www.threads.net/ap/users/mosseri/',
      acct: 'mosseri@threads.net',
      outboxUrl: 'https://www.threads.net/ap/users/mosseri/outbox/',
      oxyUserId: 'oxy_user_threads',
    });

    expect(result).toMatchObject({
      syncedCount: 0,
      shouldStampCooldown: false,
      reason: 'non-empty-outbox-without-items',
      candidateCount: 0,
      reachedEnd: false,
    });
  });

  it('returns a page cursor with item offset when a backfill batch stops mid-page', async () => {
    const outboxUrl = `${ALICE_URI}/outbox`;
    const firstPageUrl = `${ALICE_URI}/outbox?page=true`;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === outboxUrl) {
        return jsonResponse({
          type: 'OrderedCollection',
          totalItems: 3,
          first: firstPageUrl,
        });
      }
      if (url === firstPageUrl) {
        return jsonResponse({
          type: 'OrderedCollectionPage',
          id: firstPageUrl,
          next: `${ALICE_URI}/outbox?max_id=3&page=true`,
          orderedItems: [
            createNoteActivity('1'),
            createNoteActivity('2'),
            createNoteActivity('3'),
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await federationService.syncOutboxPostsDetailed(
      {
        uri: ALICE_URI,
        acct: `alice@${scope.domain}`,
        outboxUrl,
        oxyUserId: scope.user('alice'),
      },
      { limit: 2, maxPages: 1 },
    );

    expect(result).toMatchObject({
      syncedCount: 2,
      shouldStampCooldown: true,
      candidateCount: 2,
      newPostCount: 2,
      nextCursor: { url: firstPageUrl, itemOffset: 2 },
      reachedEnd: false,
    });
    // The batch was STORED — exactly the first two notes, and not the third the
    // limit stopped before.
    const note1 = await rowByActivityId(`${ALICE_URI}/statuses/1`);
    const note2 = await rowByActivityId(`${ALICE_URI}/statuses/2`);
    const note3 = await rowByActivityId(`${ALICE_URI}/statuses/3`);
    expect(note1).toBeDefined();
    expect(note2).toBeDefined();
    expect(note3).toBeUndefined();

    // Each note carries its ORIGINAL AP `published` date as createdAt/updatedAt
    // (not the sync time), so feeds order by author time. These are real
    // `timestamptz` columns: a date that never reached them would read as the
    // insert moment, which is the bug the assertion is for.
    expect(note1?.createdAt.toISOString()).toBe('2026-06-18T00:00:01.000Z');
    expect(note1?.updatedAt.toISOString()).toBe('2026-06-18T00:00:01.000Z');
    expect(note2?.createdAt.toISOString()).toBe('2026-06-18T00:00:02.000Z');
  });

  it('continues from a stored page cursor and offset', async () => {
    const outboxUrl = `${ALICE_URI}/outbox`;
    const firstPageUrl = `${ALICE_URI}/outbox?page=true`;
    const secondPageUrl = `${ALICE_URI}/outbox?max_id=3&page=true`;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === outboxUrl) {
        return jsonResponse({
          type: 'OrderedCollection',
          totalItems: 4,
          first: firstPageUrl,
        });
      }
      if (url === firstPageUrl) {
        return jsonResponse({
          type: 'OrderedCollectionPage',
          id: firstPageUrl,
          next: secondPageUrl,
          orderedItems: [
            createNoteActivity('1'),
            createNoteActivity('2'),
            createNoteActivity('3'),
          ],
        });
      }
      if (url === secondPageUrl) {
        return jsonResponse({
          type: 'OrderedCollectionPage',
          id: secondPageUrl,
          orderedItems: [
            createNoteActivity('4'),
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await federationService.syncOutboxPostsDetailed(
      {
        uri: ALICE_URI,
        acct: `alice@${scope.domain}`,
        outboxUrl,
        oxyUserId: scope.user('alice'),
      },
      {
        limit: 2,
        maxPages: 2,
        startPageUrl: firstPageUrl,
        startItemOffset: 2,
      },
    );

    expect(result).toMatchObject({
      syncedCount: 2,
      shouldStampCooldown: true,
      candidateCount: 2,
      newPostCount: 2,
      reachedEnd: true,
    });
    expect(result.nextCursor).toBeUndefined();
    // Resuming from `itemOffset: 2` stores notes 3 and 4 — and NOT 1 and 2,
    // which the cursor says were already taken. A cursor that silently restarted
    // the page would re-import them.
    expect(await rowByActivityId(`${ALICE_URI}/statuses/3`)).toBeDefined();
    expect(await rowByActivityId(`${ALICE_URI}/statuses/4`)).toBeDefined();
    expect(await rowByActivityId(`${ALICE_URI}/statuses/1`)).toBeUndefined();
    expect(await rowByActivityId(`${ALICE_URI}/statuses/2`)).toBeUndefined();
  });
});

/**
 * Seed the remote actor `getOrFetchActor`/`resolveActorOxyUserId` resolve, as a
 * FRESH row so no background refresh fires.
 *
 * `null` seeds NO row at all — the "never seen this actor" state, which is what
 * the unresolved-actor branches are about. A row present but unlinked is a
 * different state and is seeded explicitly where a test needs it.
 */
async function seedResolvedActor(oxyUserId: string | null): Promise<void> {
  await clearFederationScope(scope, [BOB_URI]);
  // Re-seed the follower gate the file-level `beforeEach` established: clearing
  // the scope takes the follow rows with it, and `handleCreate` drops any Create
  // from an actor nobody here follows.
  await seedFollow(scope, { remoteActorUri: ALICE_URI, direction: 'outbound', status: 'accepted' });
  await seedFollow(scope, { remoteActorUri: BOB_URI, direction: 'outbound', status: 'accepted' });
  if (oxyUserId === null) return;
  await seedActor(scope, {
    username: 'bob',
    uri: BOB_URI,
    acct: `bob@${scope.domain}`,
    oxyUserId,
    lastFetchedAt: new Date(),
  });
}

/**
 * Store the post a remote object URI resolves to, and return its real id.
 *
 * `resolvePostIdFromObjectUri` reads `posts.federation_activity_id`, so the only
 * way to make it resolve is to have the row — which is also the only way the
 * engagement commands below can move a counter that belongs to something.
 */
async function seedResolvableTarget(activityId: string, actorUri = ALICE_URI): Promise<string> {
  const post = await seedFederatedPost({
    oxyUserId: scope.user('alice'),
    activityId,
    actorUri,
    text: 'the post being engaged with',
  });
  return post.id;
}

describe('federationService.processInboxActivity → handleLike', () => {
  const objectUri = `${ALICE_URI}/statuses/100`;
  const actorUri = BOB_URI;

  it('records a native Like and moves the counter in lockstep', async () => {
    await seedResolvedActor(scope.user('bob'));
    const postId = await seedResolvableTarget(objectUri);
    expect((await countersOf(postId))?.likes).toBe(0);

    await federationService.processInboxActivity(
      { type: 'Like', actor: actorUri, object: objectUri },
      actorUri,
    );

    // The RECORD is the authority — a federated like is a native `likes` row,
    // listable exactly like a local one.
    expect(await likeRowsFor(postId)).toEqual([{ userId: scope.user('bob'), value: 1 }]);
    // …and the denormalized counter moved by exactly one, not by "some".
    expect((await countersOf(postId))?.likes).toBe(1);
  });

  it('is a no-op when the liker cannot be resolved to an Oxy user', async () => {
    await seedResolvedActor(null);
    const postId = await seedResolvableTarget(objectUri);

    await federationService.processInboxActivity(
      { type: 'Like', actor: actorUri, object: objectUri },
      actorUri,
    );

    // No record and no counter movement: the count only ever reflects real,
    // listable likers.
    expect(await likeRowsFor(postId)).toEqual([]);
    expect((await countersOf(postId))?.likes).toBe(0);
  });

  it('does not move the counter when the same Like is redelivered', async () => {
    await seedResolvedActor(scope.user('bob'));
    const postId = await seedResolvableTarget(objectUri);
    const like = { type: 'Like', actor: actorUri, object: objectUri };

    await federationService.processInboxActivity(like, actorUri);
    await federationService.processInboxActivity(like, actorUri);

    // The unique `(user_id, post_id)` index makes the second insert a no-op, and
    // the counter must not double-count it. This is the assertion a mocked
    // command service could only ever make about its own return value.
    expect(await likeRowsFor(postId)).toHaveLength(1);
    expect((await countersOf(postId))?.likes).toBe(1);
  });

  it('is a no-op when the liked object resolves to no local post', async () => {
    await seedResolvedActor(scope.user('bob'));

    await federationService.processInboxActivity(
      { type: 'Like', actor: actorUri, object: `${ALICE_URI}/statuses/never-imported` },
      actorUri,
    );

    const [row] = await getDb().select({ n: likes.userId }).from(likes).where(eq(likes.userId, scope.user('bob')));
    expect(row).toBeUndefined();
  });
});

describe('federationService.processInboxActivity → handleUndoLike', () => {
  const objectUri = `${ALICE_URI}/statuses/100`;
  const actorUri = BOB_URI;

  it('deletes the Like and decrements the counter when a record existed', async () => {
    await seedResolvedActor(scope.user('bob'));
    const postId = await seedResolvableTarget(objectUri);
    await federationService.processInboxActivity(
      { type: 'Like', actor: actorUri, object: objectUri },
      actorUri,
    );
    expect((await countersOf(postId))?.likes).toBe(1);

    await federationService.processInboxActivity(
      { type: 'Undo', actor: actorUri, object: { type: 'Like', object: objectUri } },
      actorUri,
    );

    expect(await likeRowsFor(postId)).toEqual([]);
    expect((await countersOf(postId))?.likes).toBe(0);
  });

  it('does not decrement when no Like record existed', async () => {
    await seedResolvedActor(scope.user('bob'));
    const postId = await seedResolvableTarget(objectUri);

    await federationService.processInboxActivity(
      { type: 'Undo', actor: actorUri, object: { type: 'Like', object: objectUri } },
      actorUri,
    );

    // Zero, not minus one: the decrement is guarded, so a redelivered Undo can
    // never drive the count below the number of records.
    expect((await countersOf(postId))?.likes).toBe(0);
  });
});

describe('federationService.processInboxActivity → handleAnnounce', () => {
  const announcedUri = `${ALICE_URI}/statuses/200`;
  const actorUri = BOB_URI;
  const announceId = `${BOB_URI}/statuses/200/activity`;

  function announce(overrides: Record<string, unknown> = {}) {
    return {
      type: 'Announce',
      id: announceId,
      actor: actorUri,
      object: announcedUri,
      published: '2026-06-18T09:30:00Z',
      ...overrides,
    };
  }

  it('creates a native boost Post deduped by Announce id and moves BOTH counters', async () => {
    await seedResolvedActor(scope.user('bob'));
    const postId = await seedResolvableTarget(announcedUri);

    await federationService.processInboxActivity(announce(), actorUri);

    // The boost is a real post row of its own, owned by the BOOSTER and pointing
    // at the boosted original — the same shape a native repost has, which is what
    // lets the feed and hydration treat the two identically.
    //
    // It also carries an intentionally EMPTY body, and that is the whole reason
    // this is worth asserting against a row: `PostCreationService`'s
    // "refusing to create empty federated post" guard used to match exactly this
    // shape, so every inbound Announce was thrown out, caught by
    // `importAnnounce`'s own `catch`, logged at WARN and reported as `false` —
    // no boost row, no counter movement, nothing above WARN to say so. The
    // previous suite could not see it: it replaced the creator with a mock that
    // returned a fake document and never ran the guard at all.
    const boost = await rowByActivityId(announceId);
    expect(boost).toBeDefined();
    expect(boost?.type).toBe('boost');
    expect(boost?.oxyUserId).toBe(scope.user('bob'));
    expect(boost?.boostOf).toBe(postId);
    // The boost's date reflects when the boost happened, not the sync.
    expect(boost?.createdAt.toISOString()).toBe('2026-06-18T09:30:00.000Z');
    // Empty body, stored: the boost renders entirely from `boostOf`.
    const boostRecord = await loadPostRecord(boost?.id ?? '');
    expect(boostRecord?.content.variants ?? []).toEqual([]);

    // A federated Announce moves the native boost counter AND the federated
    // subset counter +1 in lockstep, so `boostsCount - federatedBoostsCount`
    // isolates native reposts.
    const counters = await countersOf(postId);
    expect(counters?.boosts).toBe(1);
    expect(counters?.federatedBoosts).toBe(1);
  });

  it('skips when the booster is unresolved (no record, no counter move)', async () => {
    await seedResolvedActor(null);
    const postId = await seedResolvableTarget(announcedUri);

    await federationService.processInboxActivity(announce(), actorUri);

    expect(await rowByActivityId(announceId)).toBeUndefined();
    const counters = await countersOf(postId);
    expect(counters?.boosts).toBe(0);
    expect(counters?.federatedBoosts).toBe(0);
  });

  it('does not double-create when the Announce is redelivered', async () => {
    await seedResolvedActor(scope.user('bob'));
    const postId = await seedResolvableTarget(announcedUri);

    await federationService.processInboxActivity(announce(), actorUri);
    await federationService.processInboxActivity(announce(), actorUri);

    const boosts = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.federationActivityId, announceId));
    expect(boosts).toHaveLength(1);
    // The dedup returns BEFORE the counter bump, so a redelivery cannot inflate
    // the count of a boost that already exists.
    const counters = await countersOf(postId);
    expect(counters?.boosts).toBe(1);
    expect(counters?.federatedBoosts).toBe(1);
  });

  it('blocks unsafe boosted object fetches before contacting the network', async () => {
    const unsafeUri = 'http://127.0.0.1/latest/meta-data';
    await seedResolvedActor(scope.user('bob'));
    mocks.assertSafePublicUrl.mockImplementation(async (url: string) => (
      url === unsafeUri
        ? { ok: false, reason: 'literal ip in blocked range' }
        : { ok: true, ip: '93.184.216.34', family: 4 }
    ));
    const fetchMock = vi.fn(async () => jsonResponse({ type: 'Note' }));
    vi.stubGlobal('fetch', fetchMock);

    await federationService.processInboxActivity(
      { type: 'Announce', id: announceId, actor: actorUri, object: unsafeUri },
      actorUri,
    );

    expect(mocks.assertSafePublicUrl).toHaveBeenCalledWith(unsafeUri);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await rowByActivityId(announceId)).toBeUndefined();
  });
});

describe('federationService.processInboxActivity → handleUndoAnnounce', () => {
  const announcedUri = `${ALICE_URI}/statuses/200`;
  const actorUri = BOB_URI;
  const announceId = `${BOB_URI}/statuses/200/activity`;

  /**
   * Import a real boost through the inbound Announce path, so the Undo retracts
   * something a real import produced rather than a row the test invented in the
   * shape it hoped the importer used.
   */
  async function importBoost(): Promise<{ postId: string }> {
    await seedResolvedActor(scope.user('bob'));
    const postId = await seedResolvableTarget(announcedUri);
    await federationService.processInboxActivity(
      {
        type: 'Announce',
        id: announceId,
        actor: actorUri,
        object: announcedUri,
        published: '2026-06-18T09:30:00Z',
      },
      actorUri,
    );
    expect(await rowByActivityId(announceId)).toBeDefined();
    const counters = await countersOf(postId);
    expect(counters?.boosts).toBe(1);
    expect(counters?.federatedBoosts).toBe(1);
    return { postId };
  }

  it('deletes the boost and decrements BOTH counters in lockstep', async () => {
    const { postId } = await importBoost();

    await federationService.processInboxActivity(
      { type: 'Undo', actor: actorUri, object: { type: 'Announce', id: announceId, object: announcedUri } },
      actorUri,
    );

    expect(await rowByActivityId(announceId)).toBeUndefined();
    const counters = await countersOf(postId);
    expect(counters?.boosts).toBe(0);
    expect(counters?.federatedBoosts).toBe(0);
  });

  it('is a no-op when no matching boost exists (redelivered Undo)', async () => {
    await seedResolvedActor(scope.user('bob'));
    const postId = await seedResolvableTarget(announcedUri);

    await federationService.processInboxActivity(
      { type: 'Undo', actor: actorUri, object: { type: 'Announce', id: announceId, object: announcedUri } },
      actorUri,
    );

    // Guarded at zero rather than driven negative — a negative count is both
    // nonsense on the wire and a ranking input below every unengaged post.
    const counters = await countersOf(postId);
    expect(counters?.boosts).toBe(0);
    expect(counters?.federatedBoosts).toBe(0);
  });

  it('cannot retract another actor boost by replaying its public Announce id', async () => {
    const { postId } = await importBoost();
    const attackerUri = 'https://evil.example/users/mallory';

    await federationService.processInboxActivity(
      {
        type: 'Undo',
        // Lie in the JSON; the second argument is the VERIFIED signer.
        actor: actorUri,
        object: { type: 'Announce', id: announceId, object: announcedUri },
      },
      attackerUri,
    );

    // Announce ids are public. The boost, and its two counter contributions,
    // survive an Undo signed by anybody else.
    expect(await rowByActivityId(announceId)).toBeDefined();
    const counters = await countersOf(postId);
    expect(counters?.boosts).toBe(1);
    expect(counters?.federatedBoosts).toBe(1);
  });
});

describe('federationService.processInboxActivity → handleDelete', () => {
  const ownerUri = ALICE_URI;
  const attackerUri = 'https://evil.example/users/mallory';
  const objectId = `${ownerUri}/statuses/500`;

  it('authorizes Delete against the verified actor URI stored on the post', async () => {
    const seeded = await seedFederatedPost({
      oxyUserId: scope.user('alice'),
      activityId: objectId,
      actorUri: ownerUri,
      text: 'a post an impostor tried to delete',
    });

    await federationService.processInboxActivity(
      {
        id: `${attackerUri}/delete/500`,
        type: 'Delete',
        // Deliberately lie in JSON; the second argument is the verified signer.
        actor: ownerUri,
        object: objectId,
      },
      attackerUri,
    );

    // The object id is public and remote-controlled, so authorization is against
    // the actor URI STAMPED on the row at ingest — the post survives, body and
    // all. Asserted on the BODY so a failure names what was destroyed rather
    // than printing `expected undefined to be defined`.
    expect((await loadPostRecord(seeded.id))?.content.variants[0]?.text).toBe(
      'a post an impostor tried to delete',
    );
  });

  it('deletes only when the verified signer owns the stored post', async () => {
    await seedFederatedPost({
      oxyUserId: scope.user('alice'),
      activityId: objectId,
      actorUri: ownerUri,
      text: 'the author deletes their own post',
    });

    await federationService.processInboxActivity(
      { id: `${ownerUri}/delete/500`, type: 'Delete', actor: ownerUri, object: objectId },
      ownerUri,
    );

    expect(await rowByActivityId(objectId)).toBeUndefined();
  });
});

describe('federationService.processInboxActivity → handleCreate', () => {
  const actorUri = BOB_URI;
  const noteId = `${BOB_URI}/statuses/300`;
  const activityId = `${BOB_URI}/statuses/300/activity`;

  function createActivity(notePublished?: string, activityPublished?: string) {
    const object: Record<string, unknown> = {
      id: noteId,
      type: 'Note',
      attributedTo: actorUri,
      content: '<p>hello from the past</p>',
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    };
    if (notePublished) object.published = notePublished;
    const activity: Record<string, unknown> = { type: 'Create', id: activityId, actor: actorUri, object };
    if (activityPublished) activity.published = activityPublished;
    return activity;
  }

  it('stores the ORIGINAL Note published date as the post createdAt (not sync time)', async () => {
    await seedResolvedActor(scope.user('bob'));

    await federationService.processInboxActivity(createActivity('2022-03-10T14:00:00Z'), actorUri);

    const row = await rowByActivityId(noteId);
    expect(row).toBeDefined();
    // A federated post's `created_at` is what every chronological feed sorts on,
    // so a date that never reached the column silently files the post under the
    // moment we happened to receive it.
    expect(row?.createdAt.toISOString()).toBe('2022-03-10T14:00:00.000Z');
    expect(row?.updatedAt.toISOString()).toBe('2022-03-10T14:00:00.000Z');
  });

  it('falls back to the Create activity published when the Note omits one', async () => {
    await seedResolvedActor(scope.user('bob'));

    await federationService.processInboxActivity(
      createActivity(undefined, '2021-12-01T00:00:00Z'),
      actorUri,
    );

    expect((await rowByActivityId(noteId))?.createdAt.toISOString()).toBe('2021-12-01T00:00:00.000Z');
  });

  it('defaults createdAt to now when no valid published date is present', async () => {
    await seedResolvedActor(scope.user('bob'));
    const before = Date.now();

    await federationService.processInboxActivity(createActivity(), actorUri);

    const row = await rowByActivityId(noteId);
    expect(row).toBeDefined();
    // The column default, not a date invented from a malformed value — and
    // certainly not 1970, which an unparsed timestamp collapses to.
    expect(row?.createdAt.getTime()).toBeGreaterThanOrEqual(before - 60_000);
  });
});

describe('federationService media-cache fallback during outbox backfill', () => {
  const outboxUrl = `${CAROL_URI}/outbox`;
  const firstPageUrl = `${CAROL_URI}/outbox?page=true`;
  const CAROL_OXY = scope.user('carol');

  function noteWithImage(id: string, imageUrl: string) {
    return {
      id: `${CAROL_URI}/statuses/${id}/activity`,
      type: 'Create',
      actor: CAROL_URI,
      published: `2026-06-18T00:00:0${id}Z`,
      object: {
        id: `${CAROL_URI}/statuses/${id}`,
        type: 'Note',
        attributedTo: CAROL_URI,
        content: `<p>post ${id}</p>`,
        published: `2026-06-18T00:00:0${id}Z`,
        to: ['https://www.w3.org/ns/activitystreams#Public'],
        attachment: [{ type: 'Document', mediaType: 'image/jpeg', url: imageUrl }],
      },
    };
  }

  function stubOutbox(note: Record<string, unknown>) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === outboxUrl) {
        return jsonResponse({ type: 'OrderedCollection', totalItems: 1, first: firstPageUrl });
      }
      if (url === firstPageUrl) {
        return jsonResponse({ type: 'OrderedCollectionPage', id: firstPageUrl, orderedItems: [note] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  /** The stored media of the single note this describe imports. */
  async function storedMedia() {
    const row = await rowByActivityId(`${CAROL_URI}/statuses/1`);
    expect(row).toBeDefined();
    const record = await loadPostRecord(row?.id ?? '');
    return record?.content.media ?? [];
  }

  it('keeps the original remote media item when the S3 cache write fails (soft)', async () => {
    stubOutbox(noteWithImage('1', 'https://cdn.mastodon.social/img1.jpg'));
    mocks.persistRemoteMedia.mockResolvedValue({ ok: false, permanent: false });

    await federationService.syncOutboxPostsDetailed(
      { uri: CAROL_URI, acct: `carol@${scope.domain}`, outboxUrl, oxyUserId: CAROL_OXY },
      { limit: 5, maxPages: 1 },
    );

    expect(mocks.persistRemoteMedia).toHaveBeenCalled();
    // Soft failure: the remote URL is queued for a later cache attempt and the
    // post is STORED with the original (un-rewritten) media id — the raw URL is
    // what `content.media[].id` holds for federated media.
    expect(mocks.recordAccess).toHaveBeenCalledWith('https://cdn.mastodon.social/img1.jpg');
    expect(await storedMedia()).toEqual([
      expect.objectContaining({ id: 'https://cdn.mastodon.social/img1.jpg' }),
    ]);
  });

  it('passes non-absolute media URLs through untouched (no cache attempt)', async () => {
    stubOutbox(noteWithImage('1', 'not-a-valid-url'));

    await federationService.syncOutboxPostsDetailed(
      { uri: CAROL_URI, acct: `carol@${scope.domain}`, outboxUrl, oxyUserId: CAROL_OXY },
      { limit: 5, maxPages: 1 },
    );

    expect(mocks.persistRemoteMedia).not.toHaveBeenCalled();
  });

  it('rewrites media to the cached Oxy file id on a successful cache write', async () => {
    stubOutbox(noteWithImage('1', 'https://cdn.mastodon.social/img1.jpg'));
    mocks.persistRemoteMedia.mockResolvedValue({
      ok: true,
      media: { oxyFileId: 'oxy_file_abc' },
    });

    await federationService.syncOutboxPostsDetailed(
      { uri: CAROL_URI, acct: `carol@${scope.domain}`, outboxUrl, oxyUserId: CAROL_OXY },
      { limit: 5, maxPages: 1 },
    );

    // The rewrite has to survive the write, because it is the stored id that
    // every later render resolves — a rewrite that only happened in memory
    // leaves the post pointing at the remote CDN forever.
    expect(await storedMedia()).toEqual([
      expect.objectContaining({ id: 'oxy_file_abc', cachedFromFederation: true }),
    ]);
  });
});

describe('Stage-A baseline classification on federated outbox backfill', () => {
  const outboxUrl = `${DIETER_URI}/outbox`;
  const firstPageUrl = `${DIETER_URI}/outbox?page=true`;
  const DIETER_OXY = scope.user('dieter');

  /** A German note carrying an explicit AP `language`. */
  function germanNote(id: string, language?: string, contentMap?: Record<string, string>) {
    const note: Record<string, unknown> = {
      id: `${DIETER_URI}/statuses/${id}`,
      type: 'Note',
      attributedTo: DIETER_URI,
      content: '<p>Guten Morgen zusammen, das ist ein ganz normaler deutscher Beitrag.</p>',
      published: `2026-06-18T00:00:0${id}Z`,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
    };
    if (language) note.language = language;
    if (contentMap) note.contentMap = contentMap;
    return {
      id: `${DIETER_URI}/statuses/${id}/activity`,
      type: 'Create',
      actor: DIETER_URI,
      published: `2026-06-18T00:00:0${id}Z`,
      object: note,
    };
  }

  function stubOutbox(activity: Record<string, unknown>, base = outboxUrl, page = firstPageUrl) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === base) {
        return jsonResponse({ type: 'OrderedCollection', totalItems: 1, first: page });
      }
      if (url === page) {
        return jsonResponse({ type: 'OrderedCollectionPage', id: page, orderedItems: [activity] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  /** The single post the backfill stored, as it is held. */
  async function storedNote(activityId: string) {
    const row = await rowByActivityId(activityId);
    expect(row).toBeDefined();
    const record = await loadPostRecord(row?.id ?? '');
    if (!record) throw new Error(`post ${activityId} was not readable`);
    return record;
  }

  it('captures the AP-declared language (not the "en" default) and the Stage-A baseline, keeping status pending', async () => {
    stubOutbox(germanNote('1', 'de-DE'));

    await federationService.syncOutboxPostsDetailed(
      { uri: DIETER_URI, acct: `dieter@${scope.domain}`, outboxUrl, oxyUserId: DIETER_OXY },
      { limit: 5, maxPages: 1 },
    );

    const post = await storedNote(`${DIETER_URI}/statuses/1`);
    // Top-level language carries the REAL AP language, not the column default.
    expect(post.language).toBe('de');

    const classification = post.postClassification;
    // The subdoc carries ONLY the multi-language array; the primary lives on the
    // top-level `post.language`.
    expect(classification.languages).toEqual(['de']);
    // The scope origin is a `.test` host, not a ccTLD the derivation recognises,
    // so no region is invented.
    expect(classification.region).toBeUndefined();
    expect(classification.version).toBeGreaterThan(0);
    expect(classification.classifiedAt).toBeInstanceOf(Date);
    expect(Array.isArray(classification.hashtagsNorm)).toBe(true);
    // …but status stays `pending` so the async AI batch still enriches it.
    expect(classification.status).toBe('pending');
    expect(classification.attempts).toBe(0);
  });

  it('falls back to the AP contentMap language when no top-level language is set', async () => {
    stubOutbox(germanNote('1', undefined, { de: '<p>Guten Morgen zusammen.</p>' }));

    await federationService.syncOutboxPostsDetailed(
      { uri: DIETER_URI, acct: `dieter@${scope.domain}`, outboxUrl, oxyUserId: DIETER_OXY },
      { limit: 5, maxPages: 1 },
    );

    const post = await storedNote(`${DIETER_URI}/statuses/1`);
    expect(post.language).toBe('de');
    expect(post.postClassification.languages).toEqual(['de']);
  });

  it('derives a coarse region from a ccTLD federated instance', async () => {
    const deOutboxUrl = `${DE_ACTOR_URI}/outbox`;
    const deFirstPageUrl = `${DE_ACTOR_URI}/outbox?page=true`;
    const activityId = `${DE_ACTOR_URI}/statuses/1`;
    stubOutbox(
      {
        id: `${activityId}/activity`,
        type: 'Create',
        actor: DE_ACTOR_URI,
        published: '2026-06-18T00:00:01Z',
        object: {
          id: activityId,
          type: 'Note',
          attributedTo: DE_ACTOR_URI,
          content: '<p>Guten Morgen zusammen, das ist ein deutscher Beitrag.</p>',
          language: 'de',
          published: '2026-06-18T00:00:01Z',
          to: ['https://www.w3.org/ns/activitystreams#Public'],
        },
      },
      deOutboxUrl,
      deFirstPageUrl,
    );

    await federationService.syncOutboxPostsDetailed(
      { uri: DE_ACTOR_URI, acct: 'dieter@social.example.de', outboxUrl: deOutboxUrl, oxyUserId: DIETER_OXY },
      { limit: 5, maxPages: 1 },
    );

    expect((await storedNote(activityId)).postClassification.region).toBe('DE');
  });
});

afterEach(async () => {
  await clearScopePosts();
  await clearFederationScope(scope, [BOB_URI, ALICE_URI]);
});
