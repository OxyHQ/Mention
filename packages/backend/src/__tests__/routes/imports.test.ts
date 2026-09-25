import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The content-import API (`routes/imports.ts` + `services/PostImportService.ts`)
 * against REAL rows, driven over HTTP.
 *
 * The gate is exercised with the REAL `oxy.auth()`: service tokens are signed
 * with the SDK's legacy HS256 secret path, so `req.serviceApp` and the
 * internal-tier delegation are populated by the same code production runs —
 * the gate is then tested against what that middleware actually produces, not
 * against a hand-built request. A user SESSION cannot be minted offline (Oxy
 * validates sessions over HTTP), so it is simulated the way `requireAuth` sees
 * one: `req.user` already set and `oxy.auth()` skipped.
 *
 * Mocked are only the network boundaries: Oxy (asset metadata, usernames), the
 * push federator, the outbound Delete, the MTN emitter and Clarity. Everything
 * that decides what is written — post creation, the ledger, the delete path —
 * is real.
 */

const MOVE_APP_ID = 'app-oxy-move';
const OTHER_APP_ID = 'app-some-other-internal';
const SECRET = 'imports-test-secret';

const mocks = vi.hoisted(() => ({
  federateNewPost: vi.fn(),
  federateAsResolvedActor: vi.fn(),
  getServiceAssetMetadataByIds: vi.fn(),
  getUserById: vi.fn(),
  emitPostCreated: vi.fn(),
  emitTombstone: vi.fn(),
}));

vi.mock('../../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config')>();
  return {
    ...actual,
    config: { ...actual.config, imports: { moveApplicationId: 'app-oxy-move' } },
  };
});

vi.mock('../../services/serviceRegistry', () => ({
  getPostFederator: () => ({ federateNewPost: mocks.federateNewPost }),
  registerPostCreator: vi.fn(),
}));

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getUserById: mocks.getUserById,
    getUsersByIds: vi.fn().mockResolvedValue([]),
    getServiceAssetMetadataByIds: mocks.getServiceAssetMetadataByIds,
  }),
}));

vi.mock('../../utils/clarityClient', () => ({
  getClarityClient: async () => ({ indexing: { resolve: vi.fn().mockResolvedValue({ documents: [] }) } }),
}));

vi.mock('../../connectors/outboundFederation', () => ({
  federateAsResolvedActor: mocks.federateAsResolvedActor,
}));

// The pasted-profile-link fold resolves EVERY link to Bob here. That is what
// makes the mention test able to fail: a create that still ran the fold would
// come back with Bob in `mentions`, and the `[mention:<bob>]` in the text would
// reconcile against it.
vi.mock('../../services/profileLinkMentions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/profileLinkMentions')>();
  return {
    ...actual,
    foldProfileLinkMentions: vi.fn(async (_content: unknown, ids: unknown) => ({
      mentions: [...((ids as string[] | undefined) ?? []), 'oxy-content-imports-bob'],
      rewritten: false,
    })),
  };
});

vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: mocks.emitPostCreated,
  emitRepostCreated: vi.fn(),
  emitTombstone: mocks.emitTombstone,
  postRecordUri: (author: string, id: string) => `mtn://${author}/${id}`,
}));

import { OxyServices } from '@oxy.so/core';
import { PostVisibility } from '@mention/shared-types';
import { and, eq, inArray } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { notifications } from '../../db/schema/discovery';
import { postImports } from '../../db/schema/imports';
import { posts } from '../../db/schema/posts';
import { clearServiceScope, readPost, seedPost, serviceScope, trackPost } from '../helpers/serviceFixtures';
import importsRouter from '../../routes/imports';

const scope = serviceScope('content-imports');
const ALICE = scope.user('alice');
const BOB = scope.user('bob');

function serviceToken(appId: string, tier: 'internal' | 'external' = 'internal'): string {
  return jwt.sign(
    {
      type: 'service',
      appId,
      appName: appId,
      credentialId: `${appId}-cred`,
      ownerAccountId: `${appId}-owner`,
      environment: 'production',
      scopes: [],
      tier,
    },
    SECRET,
    { algorithm: 'HS256', issuer: 'oxy-auth', audience: 'oxy-api', expiresIn: 300 },
  );
}

/**
 * The shape of the production mount: `requireAuth` hands an already-identified
 * request straight through and otherwise runs `oxy.auth()`.
 */
function buildApp() {
  const oxy = new OxyServices({ baseURL: 'http://127.0.0.1:9' });
  const oxyAuth = oxy.auth({ jwtSecret: SECRET });
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const sessionUser = req.header('x-test-session-user');
    if (sessionUser) {
      (req as Request & { user?: { id: string } }).user = { id: sessionUser };
    }
    next();
  });
  app.use(
    '/imports',
    (req: Request, res: Response, next: NextFunction) =>
      (req as Request & { user?: { id: string } }).user?.id ? next() : oxyAuth(req, res, next),
    importsRouter,
  );
  return app;
}

const app = buildApp();

function asMove(req: request.Test, userId: string = ALICE): request.Test {
  return req.set('Authorization', `Bearer ${serviceToken(MOVE_APP_ID)}`).set('X-Oxy-User-Id', userId);
}

let batchCounter = 0;
function newBatchId(): string {
  batchCounter += 1;
  return `${scope.name}-batch-${batchCounter}-${Date.now()}`;
}

function item(sourceId: string, overrides: Record<string, unknown> = {}) {
  return {
    sourceId,
    sourceUrl: `https://mastodon.example/@alice/${sourceId}`,
    createdAt: '2019-03-04T05:06:07.123Z',
    text: `imported post ${sourceId}`,
    visibility: 'public',
    media: [],
    ...overrides,
  };
}

async function postBatch(body: Record<string, unknown>, userId: string = ALICE) {
  const res = await asMove(request(app).post('/imports/v1/posts:batch'), userId).send(body);
  for (const result of (res.body?.results ?? []) as Array<{ postId?: string }>) {
    if (result.postId) trackPost(scope, result.postId);
  }
  return res;
}

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.getUserById.mockResolvedValue({ id: ALICE, username: 'alice' });
  mocks.getServiceAssetMetadataByIds.mockResolvedValue([]);
  await clearServiceScope(scope);
});

afterEach(async () => {
  await clearServiceScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

describe('who may call the import API', () => {
  const body = () => ({ platform: 'mastodon', batchId: newBatchId(), items: [item('gate-1')] });

  it('admits Oxy Move acting for a user', async () => {
    const res = await postBatch(body());
    expect(res.status).toBe(200);
    expect(res.body.results[0].status).toBe('created');
  });

  it('refuses a user session, even for the user it would import for', async () => {
    const res = await request(app)
      .post('/imports/v1/posts:batch')
      .set('x-test-session-user', ALICE)
      .send(body());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('IMPORT_CALLER_NOT_ALLOWED');
  });

  it('refuses another INTERNAL service application acting for the same user', async () => {
    const res = await request(app)
      .post('/imports/v1/posts:batch')
      .set('Authorization', `Bearer ${serviceToken(OTHER_APP_ID)}`)
      .set('X-Oxy-User-Id', ALICE)
      .send(body());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('IMPORT_CALLER_NOT_ALLOWED');
  });

  it('refuses Move acting as itself, for nobody', async () => {
    const res = await request(app)
      .post('/imports/v1/posts:batch')
      .set('Authorization', `Bearer ${serviceToken(MOVE_APP_ID)}`)
      .send(body());
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('IMPORT_USER_REQUIRED');
  });

  it('writes nothing for a refused caller', async () => {
    const batch = body();
    await request(app)
      .post('/imports/v1/posts:batch')
      .set('Authorization', `Bearer ${serviceToken(OTHER_APP_ID)}`)
      .set('X-Oxy-User-Id', ALICE)
      .send(batch);
    const rows = await getDb()
      .select({ postId: postImports.postId })
      .from(postImports)
      .where(eq(postImports.importBatchId, batch.batchId));
    expect(rows).toEqual([]);
  });

  it('rejects a malformed batch with 400', async () => {
    const res = await postBatch({ platform: 'myspace', batchId: newBatchId(), items: [item('x')] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_IMPORT_BATCH');
  });
});

describe('POST /imports/v1/posts:batch', () => {
  it('keeps the original created_at, to the millisecond', async () => {
    const res = await postBatch({
      platform: 'mastodon',
      batchId: newBatchId(),
      items: [item('dated', { createdAt: '2019-03-04T05:06:07.123456+00:00' })],
    });
    const stored = await readPost(res.body.results[0].postId);
    expect(stored?.createdAt.toISOString()).toBe('2019-03-04T05:06:07.123Z');
    expect(stored?.status).toBe('published');
    expect(stored?.oxyUserId).toBe(ALICE);
  });

  it('writes no notification and no mention, and never pushes federation', async () => {
    const res = await postBatch({
      platform: 'mastodon',
      batchId: newBatchId(),
      items: [
        item('mentions', {
          text: `hey @bob@mastodon.example and [mention:${BOB}] look at https://mastodon.example/@bob`,
        }),
      ],
    });
    const postId = res.body.results[0].postId as string;
    const stored = await readPost(postId);
    expect(stored?.mentions).toEqual([]);
    const rows = await getDb()
      .select({ id: notifications.id })
      .from(notifications)
      .where(eq(notifications.entityId, postId));
    expect(rows).toEqual([]);
    expect(mocks.federateNewPost).not.toHaveBeenCalled();
    expect(stored?.metadata.federationDelivered).toBe(false);
  });

  it('is idempotent: a re-sent item answers `existing` with the same post', async () => {
    const batchId = newBatchId();
    const first = await postBatch({ platform: 'mastodon', batchId, items: [item('again')] });
    const second = await postBatch({ platform: 'mastodon', batchId, items: [item('again')] });
    expect(second.body.results[0]).toEqual({
      sourceId: 'again',
      status: 'existing',
      postId: first.body.results[0].postId,
    });
    const rows = await getDb()
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.oxyUserId, ALICE));
    expect(rows).toHaveLength(1);
  });

  it('keys idempotency by platform and by user, not by source id alone', async () => {
    const onMastodon = await postBatch({ platform: 'mastodon', batchId: newBatchId(), items: [item('same')] });
    const onBluesky = await postBatch({ platform: 'bluesky', batchId: newBatchId(), items: [item('same')] });
    const forBob = await postBatch({ platform: 'mastodon', batchId: newBatchId(), items: [item('same')] }, BOB);
    const ids = [onMastodon, onBluesky, forBob].map((res) => res.body.results[0]);
    expect(ids.map((result) => result.status)).toEqual(['created', 'created', 'created']);
    expect(new Set(ids.map((result) => result.postId)).size).toBe(3);
  });

  it('resolves a reply and a quote to posts earlier in the same batch, as a thread', async () => {
    const res = await postBatch({
      platform: 'mastodon',
      batchId: newBatchId(),
      items: [
        item('root', { createdAt: '2020-01-01T00:00:00.000Z' }),
        item('reply', { createdAt: '2020-01-01T00:01:00.000Z', replyToSourceId: 'root' }),
        item('quote', { createdAt: '2020-01-02T00:00:00.000Z', quoteSourceId: 'root' }),
      ],
    });
    const [root, reply, quote] = res.body.results as Array<{ postId: string; status: string }>;
    expect([root.status, reply.status, quote.status]).toEqual(['created', 'created', 'created']);
    const storedReply = await readPost(reply.postId);
    const storedRoot = await readPost(root.postId);
    const storedQuote = await readPost(quote.postId);
    expect(storedReply?.parentPostId).toBe(root.postId);
    expect(storedReply?.threadId).toBe(root.postId);
    expect(storedRoot?.threadId).toBe(root.postId);
    expect(storedQuote?.quoteOf).toBe(root.postId);
  });

  it('resolves a parent imported by an EARLIER batch', async () => {
    await postBatch({ platform: 'mastodon', batchId: newBatchId(), items: [item('old-root')] });
    const res = await postBatch({
      platform: 'mastodon',
      batchId: newBatchId(),
      items: [item('late-reply', { replyToSourceId: 'old-root' })],
    });
    expect(res.body.results[0].status).toBe('created');
  });

  it('defers a reply or quote whose target is not imported, and writes nothing for it', async () => {
    const res = await postBatch({
      platform: 'mastodon',
      batchId: newBatchId(),
      items: [
        item('orphan-reply', { replyToSourceId: 'never-sent' }),
        item('orphan-quote', { quoteSourceId: 'never-sent' }),
      ],
    });
    expect(res.body.results).toEqual([
      { sourceId: 'orphan-reply', status: 'deferred', error: 'parent_not_imported' },
      { sourceId: 'orphan-quote', status: 'deferred', error: 'quote_not_imported' },
    ]);
    const rows = await getDb().select({ id: posts.id }).from(posts).where(eq(posts.oxyUserId, ALICE));
    expect(rows).toEqual([]);
  });

  it('never resolves a parent imported by ANOTHER user', async () => {
    await postBatch({ platform: 'mastodon', batchId: newBatchId(), items: [item('bobs-root')] }, BOB);
    const res = await postBatch({
      platform: 'mastodon',
      batchId: newBatchId(),
      items: [item('alice-reply', { replyToSourceId: 'bobs-root' })],
    });
    expect(res.body.results[0].status).toBe('deferred');
  });

  it('attaches media Oxy knows, typed from its MIME, and refuses media it does not', async () => {
    mocks.getServiceAssetMetadataByIds.mockResolvedValue([
      { id: 'asset-image', sha256: 'a', mime: 'image/jpeg', size: 10, status: 'active', width: 640, height: 480, ownerUserId: ALICE },
      { id: 'asset-trashed', sha256: 'b', mime: 'image/png', size: 10, status: 'trash', ownerUserId: ALICE },
    ]);
    const res = await postBatch({
      platform: 'mastodon',
      batchId: newBatchId(),
      items: [
        item('with-media', { media: [{ assetId: 'asset-image', alt: '  a  cat ' }] }),
        item('missing-media', { media: [{ assetId: 'asset-unknown' }] }),
        item('trashed-media', { media: [{ assetId: 'asset-trashed' }] }),
      ],
    });
    const [ok, missing, trashed] = res.body.results;
    expect(ok.status).toBe('created');
    expect(missing).toEqual({ sourceId: 'missing-media', status: 'failed', error: 'media_not_found' });
    expect(trashed).toEqual({ sourceId: 'trashed-media', status: 'failed', error: 'media_not_found' });
    const stored = await readPost(ok.postId);
    expect(stored?.content.media).toEqual([
      expect.objectContaining({ id: 'asset-image', type: 'image', alt: 'a cat', width: 640, height: 480 }),
    ]);
  });

  it("refuses an asset that is not the acting user's, and one whose owner Oxy did not report", async () => {
    mocks.getServiceAssetMetadataByIds.mockResolvedValue([
      { id: 'asset-own', sha256: 'a', mime: 'image/jpeg', size: 10, status: 'active', ownerUserId: ALICE },
      { id: 'asset-bobs', sha256: 'b', mime: 'image/jpeg', size: 10, status: 'active', ownerUserId: BOB },
      { id: 'asset-system', sha256: 'c', mime: 'image/jpeg', size: 10, status: 'active', ownerUserId: null },
      { id: 'asset-unreported', sha256: 'd', mime: 'image/jpeg', size: 10, status: 'active' },
    ]);
    const batchId = newBatchId();
    const res = await postBatch({
      platform: 'mastodon',
      batchId,
      items: [
        item('own-media', { media: [{ assetId: 'asset-own' }] }),
        // One foreign asset fails the whole item, not just that attachment.
        item('mixed-media', { media: [{ assetId: 'asset-own' }, { assetId: 'asset-bobs' }] }),
        item('system-media', { media: [{ assetId: 'asset-system' }] }),
        item('unreported-media', { media: [{ assetId: 'asset-unreported' }] }),
      ],
    });
    const [own, ...refused] = res.body.results;
    expect(own.status).toBe('created');
    expect(refused).toEqual([
      { sourceId: 'mixed-media', status: 'failed', error: 'media_not_owned' },
      { sourceId: 'system-media', status: 'failed', error: 'media_not_owned' },
      { sourceId: 'unreported-media', status: 'failed', error: 'media_not_owned' },
    ]);
    const ledger = await getDb()
      .select({ postId: postImports.postId })
      .from(postImports)
      .where(eq(postImports.importBatchId, batchId));
    expect(ledger).toEqual([{ postId: own.postId }]);
  });

  it('stores an article through the shared article helper', async () => {
    const res = await postBatch({
      platform: 'medium',
      batchId: newBatchId(),
      items: [item('essay', { text: '', article: { title: '  My essay ', body: 'Long body.' } })],
    });
    const stored = await readPost(res.body.results[0].postId);
    expect(stored?.content.article?.title).toBe('My essay');
    expect(stored?.content.article?.articleId).toBeTruthy();
  });

  it('refuses an empty item and a date in the future', async () => {
    const res = await postBatch({
      platform: 'mastodon',
      batchId: newBatchId(),
      items: [
        item('empty', { text: '   ' }),
        item('future', { createdAt: new Date(Date.now() + 86_400_000).toISOString() }),
      ],
    });
    expect(res.body.results.map((result: { error: string }) => result.error)).toEqual([
      'empty',
      'created_at_in_future',
    ]);
  });
});

describe('DELETE /imports/v1/batches/:batchId', () => {
  it("deletes only the acting user's posts of that batch, each through the normal delete path", async () => {
    const batchId = newBatchId();
    const alice = await postBatch({
      platform: 'mastodon',
      batchId,
      items: [
        item('undo-root', { createdAt: '2021-01-01T00:00:00.000Z' }),
        item('undo-reply', { createdAt: '2021-01-01T00:05:00.000Z', replyToSourceId: 'undo-root' }),
      ],
    });
    // The SAME batch id under another account, and another batch of Alice's.
    const bob = await postBatch({ platform: 'mastodon', batchId, items: [item('bob-kept')] }, BOB);
    const otherBatch = await postBatch({ platform: 'mastodon', batchId: newBatchId(), items: [item('alice-kept')] });

    const res = await asMove(request(app).delete(`/imports/v1/batches/${encodeURIComponent(batchId)}`));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 2, failed: 0 });

    const aliceIds = alice.body.results.map((result: { postId: string }) => result.postId);
    const gone = await getDb().select({ id: posts.id }).from(posts).where(inArray(posts.id, aliceIds));
    expect(gone).toEqual([]);
    expect(await readPost(bob.body.results[0].postId)).not.toBeNull();
    expect(await readPost(otherBatch.body.results[0].postId)).not.toBeNull();

    // One federated Delete per imported public post — newest first, so the
    // reply is not swallowed silently by its parent's subtree delete.
    expect(mocks.federateAsResolvedActor).toHaveBeenCalledTimes(2);
    expect(mocks.emitTombstone).toHaveBeenCalledTimes(2);

    // The ledger rows went with the posts.
    const ledger = await getDb()
      .select({ postId: postImports.postId })
      .from(postImports)
      .where(and(eq(postImports.importBatchId, batchId), eq(postImports.oxyUserId, ALICE)));
    expect(ledger).toEqual([]);
  });
});

describe('GET /imports/v1/lookup', () => {
  it("maps this user's imported source ids, and finds public federated copies by AS2 id", async () => {
    const imported = await postBatch({ platform: 'mastodon', batchId: newBatchId(), items: [item('looked-up')] });
    const noteId = `https://mastodon.example/users/alice/statuses/${Date.now()}`;
    const copy = await seedPost(scope, {
      oxyUserId: null,
      authorship: [],
      federation: { activityId: noteId, actorUri: 'https://mastodon.example/users/alice', url: `${noteId}/web` },
    });
    // Not the caller's until a Move, so only what any reader could see is reported.
    const privateNoteId = `${noteId}-followers`;
    await seedPost(scope, {
      oxyUserId: null,
      authorship: [],
      visibility: PostVisibility.FOLLOWERS_ONLY,
      federation: { activityId: privateNoteId, actorUri: 'https://mastodon.example/users/alice', url: `${privateNoteId}/web` },
    });

    const res = await asMove(
      request(app)
        .get('/imports/v1/lookup')
        .query({ platform: 'mastodon', sourceIds: ['looked-up', 'not-imported'], federatedIds: [noteId, privateNoteId, 'https://nowhere.example/x'] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.imported).toEqual({ 'looked-up': imported.body.results[0].postId });
    expect(res.body.federated).toEqual({
      [noteId]: {
        postId: copy.id,
        actorUri: 'https://mastodon.example/users/alice',
        url: `${noteId}/web`,
        oxyUserId: null,
      },
    });
  });

  it('keeps an id that contains a comma whole', async () => {
    const sourceId = 'https://blog.example/posts/a,b';
    const imported = await postBatch({ platform: 'mastodon', batchId: newBatchId(), items: [item(sourceId)] });
    const res = await asMove(request(app).get('/imports/v1/lookup').query({ platform: 'mastodon', sourceIds: [sourceId] }));
    expect(res.status).toBe(200);
    expect(res.body.imported).toEqual({ [sourceId]: imported.body.results[0].postId });
  });

  it("never reports another user's imports", async () => {
    await postBatch({ platform: 'mastodon', batchId: newBatchId(), items: [item('bobs')] }, BOB);
    const res = await asMove(request(app).get('/imports/v1/lookup').query({ platform: 'mastodon', sourceIds: 'bobs' }));
    expect(res.body.imported).toEqual({});
  });
});
