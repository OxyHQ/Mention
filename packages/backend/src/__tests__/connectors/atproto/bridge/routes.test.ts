import express, { type Express } from 'express';
import request from 'supertest';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { buildUserDid } from '../../../../services/mtn/mentionDid';

/**
 * Phase C4 — bridge XRPC ROUTE contract. Mounts the bridge router with the bridge
 * ENABLED (env set before import) and the read/identity services MOCKED, then
 * exercises `com.atproto.repo.listRecords` / `getRecord` / `describeRepo` /
 * `com.atproto.sync.getLatestCommit` / `getRepo` (NotImplemented) + the DID-doc
 * view. A separate suite asserts the DISABLED gate 404s. No DB, no network.
 */

// The bridge gate is read from env at module-import time → enable BEFORE import.
process.env.ATPROTO_BRIDGE_ENABLED = 'true';

const mockListRecords = vi.fn();
const mockGetRecord = vi.fn();
const mockGetHead = vi.fn();
const mockGetAtprotoIdentity = vi.fn();
const mockBuildDidView = vi.fn();
const mockResolveOxyUser = vi.fn();

vi.mock('../../../../middleware/rateLimitStore', () => ({
  RedisStore: class {
    init(): void {}
    async increment(): Promise<{ totalHits: number; resetTime: undefined }> {
      return { totalHits: 1, resetTime: undefined };
    }
    async decrement(): Promise<void> {}
    async resetKey(): Promise<void> {}
    async get(): Promise<undefined> {
      return undefined;
    }
  },
}));

vi.mock('../../../../connectors/atproto/bridge/repoReadService', () => ({
  listRecords: (...a: unknown[]) => mockListRecords(...a),
  getRecord: (...a: unknown[]) => mockGetRecord(...a),
  BRIDGE_DESCRIBE_COLLECTIONS: ['app.bsky.feed.post', 'app.bsky.feed.like', 'app.bsky.feed.repost'],
}));

vi.mock('../../../../services/mtn/MentionRepoLogService', () => ({
  getHead: (...a: unknown[]) => mockGetHead(...a),
}));

vi.mock('../../../../connectors/atproto/bridge/identityService', () => ({
  getAtprotoIdentity: (...a: unknown[]) => mockGetAtprotoIdentity(...a),
  buildBridgeDidDocumentView: (...a: unknown[]) => mockBuildDidView(...a),
  bridgePdsEndpoint: () => 'https://mention.earth',
}));

vi.mock('../../../../connectors/activitypub/constants', async () => {
  const actual = await vi.importActual<typeof import('../../../../connectors/activitypub/constants')>(
    '../../../../connectors/activitypub/constants',
  );
  return { ...actual, resolveOxyUser: (...a: unknown[]) => mockResolveOxyUser(...a) };
});

const OWNER = '650000000000000000000abc';
const OWNER_DID = buildUserDid(OWNER);

let app: Express;

beforeAll(async () => {
  const mod = await import('../../../../connectors/atproto/bridge/routes');
  app = express();
  app.use(express.json());
  app.use('/xrpc', mod.default);
  app.use('/ap-bridge', mod.bridgeMetaRouter);
  app.use('/.well-known', mod.wellKnownBridgeRouter);
});

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveOxyUser.mockResolvedValue({ id: OWNER, username: 'alice' });
  mockGetAtprotoIdentity.mockResolvedValue({
    did: OWNER_DID,
    oxyUserId: OWNER,
    handle: 'alice.mention.earth',
    pdsEndpoint: 'https://mention.earth',
  });
});

describe('com.atproto.repo.listRecords', () => {
  it('serves a translated record page (repo resolved by DID)', async () => {
    mockListRecords.mockResolvedValueOnce({
      records: [{ uri: `at://${OWNER_DID}/app.bsky.feed.post/p1`, cid: 'mtn-rid-p1', value: { $type: 'app.bsky.feed.post', text: 'hi', createdAt: 'x' }, rkey: 'p1', createdAt: 'x' }],
      cursor: 'p1',
    });
    const res = await request(app)
      .get('/xrpc/com.atproto.repo.listRecords')
      .query({ repo: OWNER_DID, collection: 'app.bsky.feed.post' });
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.records[0]).toEqual({
      uri: `at://${OWNER_DID}/app.bsky.feed.post/p1`,
      cid: 'mtn-rid-p1',
      value: { $type: 'app.bsky.feed.post', text: 'hi', createdAt: 'x' },
    });
    expect(res.body.cursor).toBe('p1');
    // The repo DID was parsed to the owner id without any Oxy resolution call.
    expect(mockListRecords).toHaveBeenCalledWith(OWNER, 'app.bsky.feed.post', { limit: undefined, cursor: undefined });
  });

  it('resolves a handle repo via Oxy', async () => {
    mockListRecords.mockResolvedValueOnce({ records: [] });
    const res = await request(app)
      .get('/xrpc/com.atproto.repo.listRecords')
      .query({ repo: 'alice.mention.earth', collection: 'app.bsky.feed.post' });
    expect(res.status).toBe(200);
    expect(mockResolveOxyUser).toHaveBeenCalledWith('alice');
    expect(mockListRecords).toHaveBeenCalledWith(OWNER, 'app.bsky.feed.post', expect.anything());
  });

  it('returns an empty page for a non-served collection', async () => {
    const res = await request(app)
      .get('/xrpc/com.atproto.repo.listRecords')
      .query({ repo: OWNER_DID, collection: 'app.mention.feed.bookmark' });
    expect(res.status).toBe(200);
    expect(res.body.records).toEqual([]);
    expect(mockListRecords).not.toHaveBeenCalled();
  });

  it('400s on a missing collection param', async () => {
    const res = await request(app).get('/xrpc/com.atproto.repo.listRecords').query({ repo: OWNER_DID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('InvalidRequest');
  });
});

describe('com.atproto.repo.getRecord', () => {
  it('serves a single record', async () => {
    mockGetRecord.mockResolvedValueOnce({
      uri: `at://${OWNER_DID}/app.bsky.feed.post/p1`,
      cid: 'mtn-rid-p1',
      value: { $type: 'app.bsky.feed.post', text: 'hi', createdAt: 'x' },
      rkey: 'p1',
      createdAt: 'x',
    });
    const res = await request(app)
      .get('/xrpc/com.atproto.repo.getRecord')
      .query({ repo: OWNER_DID, collection: 'app.bsky.feed.post', rkey: 'p1' });
    expect(res.status).toBe(200);
    expect(res.body.value).toMatchObject({ text: 'hi' });
  });

  it('404s a missing record', async () => {
    mockGetRecord.mockResolvedValueOnce(null);
    const res = await request(app)
      .get('/xrpc/com.atproto.repo.getRecord')
      .query({ repo: OWNER_DID, collection: 'app.bsky.feed.post', rkey: 'nope' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('RecordNotFound');
  });
});

describe('com.atproto.repo.describeRepo', () => {
  it('describes the repo with did/handle/collections', async () => {
    const res = await request(app).get('/xrpc/com.atproto.repo.describeRepo').query({ repo: OWNER_DID });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      did: OWNER_DID,
      handle: 'alice.mention.earth',
      collections: ['app.bsky.feed.post', 'app.bsky.feed.like', 'app.bsky.feed.repost'],
      handleIsCorrect: true,
    });
  });
});

describe('com.atproto.sync.getLatestCommit', () => {
  it('reports the chain head as the latest commit', async () => {
    mockGetHead.mockResolvedValueOnce({ headRecordId: 'headrid', seq: 7, recordCount: 8 });
    const res = await request(app).get('/xrpc/com.atproto.sync.getLatestCommit').query({ did: OWNER_DID });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cid: 'mtn-headrid', rev: '7' });
  });

  it('404s a repo with no commits', async () => {
    mockGetHead.mockResolvedValueOnce(null);
    const res = await request(app).get('/xrpc/com.atproto.sync.getLatestCommit').query({ did: OWNER_DID });
    expect(res.status).toBe(404);
  });

  it('400s a non-bridge did', async () => {
    const res = await request(app)
      .get('/xrpc/com.atproto.sync.getLatestCommit')
      .query({ did: 'did:plc:ewvi7nxzyoun6zhxrhs64oiz' });
    expect(res.status).toBe(400);
  });
});

describe('com.atproto.sync.getRepo', () => {
  it('returns a structured NotImplemented (no fake CAR)', async () => {
    const res = await request(app).get('/xrpc/com.atproto.sync.getRepo').query({ did: OWNER_DID });
    expect(res.status).toBe(501);
    expect(res.body.error).toBe('NotImplemented');
  });
});

describe('GET /ap-bridge/did/:username', () => {
  it('serves the atproto-flavoured DID document view', async () => {
    mockBuildDidView.mockResolvedValueOnce({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: OWNER_DID,
      controller: [OWNER_DID],
      verificationMethod: [],
      authentication: [],
      assertionMethod: [],
      alsoKnownAs: ['at://alice.mention.earth'],
      service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://mention.earth' }],
    });
    const res = await request(app).get('/ap-bridge/did/alice');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(OWNER_DID);
    expect(res.body.service[0].id).toBe('#atproto_pds');
  });

  it('404s an unknown user', async () => {
    mockBuildDidView.mockResolvedValueOnce(null);
    const res = await request(app).get('/ap-bridge/did/ghost');
    expect(res.status).toBe(404);
  });
});

describe('GET /.well-known/atproto-did', () => {
  it('resolves the requesting handle host to the Oxy DID (text/plain)', async () => {
    const res = await request(app)
      .get('/.well-known/atproto-did')
      .set('Host', 'alice.mention.earth');
    expect(res.status).toBe(200);
    expect(res.text).toBe(OWNER_DID);
  });
});
