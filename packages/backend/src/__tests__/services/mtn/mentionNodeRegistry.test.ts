import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  verifyEnvelopeSignature,
  isAuthorizedKey,
  type RecordStore,
  type ChainHead,
} from '@oxyhq/protocol';
import type { SignedRecordEnvelope } from '@oxyhq/contracts';

/**
 * MTN Protocol — B3 node REGISTRATION (MentionNodeRegistryService).
 *
 * Exercises:
 *  - `materializeNodeFromRecord` projects a signed `app.mention.node` record's
 *    payload into the `MentionUserNode` cache (active, self-hosted), validating +
 *    normalising the endpoint and firing a background probe;
 *  - a malformed payload (bad endpoint / non-hex key) is a non-throwing no-op;
 *  - `provisionManagedVault` custodial-signs an `app.mention.node` record through
 *    the REAL protocol engine (in-memory store + resolver), then materializes the
 *    cache as `managed:true, controller:'oxy'` and flags the operator;
 *  - `provisionManagedVault` fails closed when the custodial key or the managed
 *    base URL is unconfigured;
 *  - `probeLiveness` flips the badge from a mocked `safeFetch` result.
 *
 * The real `@oxyhq/protocol` engine runs against an in-memory `RecordStore` (so
 * the managed record genuinely signs + verifies + appends without Mongo); the
 * `MentionUserNode` model + `safeFetch` are mocked.
 */

// --- A fixed custodial secp256k1 keypair the resolver authorizes (issuer ===
//     MENTION_DID). `signEnvelope` derives `publicKey` = CUSTODIAL_PUBLIC. ---
const CUSTODIAL_PRIVATE = 'd6bd0dbca0e4e37f4329e615cde35d1990ff6650d5b88a58c470d6d393cc6584';
const CUSTODIAL_PUBLIC =
  '04d5c06b76d56858b73655c4cc03594cc17e60d1a1607e14b98387bf5dcc62282a66ad2e1eb60b96fb854f1c303b1d50a7eebbcb06ea7151f69b0e2cbc436f43a6';
const MENTION_DID = 'did:web:mention.earth';
const SUBJECT_OXY_ID = '650000000000000000000abc';
const SUBJECT_DID = `did:web:oxy.so:u:${SUBJECT_OXY_ID}`;
const MANAGED_BASE = 'https://nodes.mention.earth';

// --- In-memory RecordStore (the protocol `RecordStore` contract). -------------
interface MemoryStore extends RecordStore {
  rows: Array<{ env: SignedRecordEnvelope; recordId: string }>;
  heads: Map<string, ChainHead>;
}

const { memoryStore, resolveDid, nodeModel, safeFetchMock } = vi.hoisted(() => {
  const rows: Array<{ env: SignedRecordEnvelope; recordId: string }> = [];
  const heads = new Map<string, ChainHead>();
  const store: MemoryStore = {
    rows,
    heads,
    async getHead(subject) {
      return heads.get(subject) ?? null;
    },
    async append(subject, env, recordId) {
      rows.push({ env, recordId });
      heads.set(subject, {
        headRecordId: recordId,
        seq: env.seq as number,
        recordCount: (heads.get(subject)?.recordCount ?? 0) + 1,
      });
      return { ok: true, recordId, seq: env.seq as number };
    },
    async getLogSince(subject, sinceSeq, limit) {
      return rows
        .filter((r) => r.env.subject === subject && (r.env.seq ?? -1) > sinceSeq)
        .sort((a, b) => (a.env.seq ?? 0) - (b.env.seq ?? 0))
        .slice(0, limit)
        .map((r) => r.env);
    },
    async resolveCursorSeq(subject, recordId) {
      const row = rows.find((r) => r.env.subject === subject && r.recordId === recordId);
      return typeof row?.env.seq === 'number' ? row.env.seq : null;
    },
    async materializeCurrent(subject, collection, rkey) {
      const matches = rows.filter(
        (r) => r.env.subject === subject && r.env.collection === collection && r.env.rkey === rkey,
      );
      return matches.length ? matches[matches.length - 1].env : null;
    },
    async latestIssuedAtForKey(subject, env) {
      if (env.version === 2 && (typeof env.collection !== 'string' || typeof env.rkey !== 'string')) {
        return null;
      }
      const matches = rows.filter(
        (r) => r.env.subject === subject && r.env.collection === env.collection && r.env.rkey === env.rkey,
      );
      const latest = matches[matches.length - 1];
      return typeof latest?.env.issuedAt === 'number' ? latest.env.issuedAt : null;
    },
  };

  const resolveDidMock = vi.fn(async () => ({ verificationMethod: [] as Array<{ publicKeyHex: string }> }));

  // In-memory MentionUserNode model: only the statics the registry touches.
  const cache = new Map<string, Record<string, unknown>>();
  const model = {
    cache,
    findOneAndUpdate: vi.fn(
      async (
        filter: { oxyUserId: string },
        update: { $set?: Record<string, unknown>; $setOnInsert?: Record<string, unknown> },
      ) => {
        const existing = cache.get(filter.oxyUserId) ?? {};
        const doc = { ...existing, ...(update.$setOnInsert ?? {}), ...(update.$set ?? {}) };
        cache.set(filter.oxyUserId, doc);
        return doc;
      },
    ),
    findOne: vi.fn((filter: { oxyUserId: string }) => ({
      select: () => ({ lean: async () => cache.get(filter.oxyUserId) ?? null }),
      lean: async () => cache.get(filter.oxyUserId) ?? null,
    })),
    updateOne: vi.fn(async () => ({ modifiedCount: 1 })),
    find: vi.fn(() => ({
      sort: () => ({
        limit: () => ({
          select: () => ({ lean: async (): Promise<Array<{ oxyUserId: string }>> => [] }),
        }),
      }),
    })),
  };

  const safeFetch = vi.fn(async (_url: string) => ({
    status: 200,
    headers: {} as Record<string, string>,
    response: { destroy: () => undefined },
    finalUrl: '',
  }));

  return { memoryStore: store, resolveDid: resolveDidMock, nodeModel: model, safeFetchMock: safeFetch };
});

// --- Mocks -------------------------------------------------------------------
vi.mock('../../../services/mtn/MentionRecordStore', () => ({
  mentionRecordStore: memoryStore,
}));
vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ resolveDid }),
}));
vi.mock('../../../models/MentionUserNode', () => ({
  __esModule: true,
  default: nodeModel,
  MentionUserNode: nodeModel,
}));
vi.mock('@oxyhq/core/server', () => ({
  safeFetch: safeFetchMock,
}));

import {
  materializeNodeFromRecord,
  provisionManagedVault,
  probeLiveness,
  sweepNodeLiveness,
} from '../../../services/mtn/MentionNodeRegistryService';
import { clearVerificationMethodCache } from '../../../services/mtn/mentionVerificationResolver';
import {
  MENTION_NODE_COLLECTION,
  MENTION_NODE_RKEY,
  MENTION_NODE_LIVENESS_PROBE_CONCURRENCY,
} from '../../../services/mtn/mentionNodes.constants';

const NODE_ENDPOINT = 'https://node.example.com';
const NODE_PUBLIC_KEY = 'ab'.repeat(33); // 66 hex chars — a valid secp256k1 key

/** The update arg (`{ $set, $unset, ... }`) of a Mongo-static mock's last call. */
type MongoUpdate = { $set?: Record<string, unknown>; $unset?: Record<string, unknown> };
function lastUpdate(mock: { mock: { calls: unknown[][] } }): MongoUpdate {
  const calls = mock.mock.calls;
  const last = calls[calls.length - 1];
  return (last?.[1] ?? {}) as MongoUpdate;
}
/** The `$set` of a Mongo-static mock's last call (asserted present). */
function lastSet(mock: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  const set = lastUpdate(mock).$set;
  expect(set).toBeDefined();
  return set as Record<string, unknown>;
}

beforeEach(() => {
  process.env.MENTION_DID = MENTION_DID;
  process.env.MENTION_PRIVATE_KEY = CUSTODIAL_PRIVATE;
  process.env.MENTION_PUBLIC_KEY = CUSTODIAL_PUBLIC;
  process.env.MENTION_NODE_BASE_URL = MANAGED_BASE;
  memoryStore.rows.length = 0;
  memoryStore.heads.clear();
  nodeModel.cache.clear();
  nodeModel.findOneAndUpdate.mockClear();
  nodeModel.updateOne.mockClear();
  safeFetchMock.mockClear();
  resolveDid.mockClear();
  clearVerificationMethodCache();
});

afterEach(() => {
  delete process.env.MENTION_DID;
  delete process.env.MENTION_PRIVATE_KEY;
  delete process.env.MENTION_PUBLIC_KEY;
  delete process.env.MENTION_NODE_BASE_URL;
  delete process.env.MENTION_NODE_PUBLIC_KEY;
});

describe('MentionNodeRegistryService.materializeNodeFromRecord', () => {
  it('projects a signed app.mention.node record payload into the cache as an active self-hosted node', async () => {
    const node = await materializeNodeFromRecord(SUBJECT_OXY_ID, {
      endpoint: NODE_ENDPOINT,
      nodePublicKey: NODE_PUBLIC_KEY,
    });

    expect(node).not.toBeNull();
    expect(lastSet(nodeModel.findOneAndUpdate)).toMatchObject({
      endpoint: NODE_ENDPOINT,
      nodePublicKey: NODE_PUBLIC_KEY,
      mode: 'pull',
      managed: false,
      controller: 'self',
      status: 'active',
    });
  });

  it('honors an explicit push mode + nodeDid from the record', async () => {
    await materializeNodeFromRecord(SUBJECT_OXY_ID, {
      endpoint: `${NODE_ENDPOINT}/`,
      nodePublicKey: NODE_PUBLIC_KEY,
      mode: 'push',
      nodeDid: 'did:web:node.example.com',
    });
    const set = lastSet(nodeModel.findOneAndUpdate);
    // Trailing slash is normalised off the endpoint.
    expect(set.endpoint).toBe(NODE_ENDPOINT);
    expect(set.mode).toBe('push');
    expect(set.nodeDid).toBe('did:web:node.example.com');
  });

  it('is a non-throwing no-op for a non-HTTPS endpoint', async () => {
    const node = await materializeNodeFromRecord(SUBJECT_OXY_ID, {
      endpoint: 'http://insecure.example.com',
      nodePublicKey: NODE_PUBLIC_KEY,
    });
    expect(node).toBeNull();
    expect(nodeModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('is a non-throwing no-op for a non-hex node public key', async () => {
    const node = await materializeNodeFromRecord(SUBJECT_OXY_ID, {
      endpoint: NODE_ENDPOINT,
      nodePublicKey: 'not-a-hex-key',
    });
    expect(node).toBeNull();
    expect(nodeModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('MentionNodeRegistryService.provisionManagedVault', () => {
  it('custodial-signs a verifiable app.mention.node record and materializes a managed vault', async () => {
    const result = await provisionManagedVault(SUBJECT_OXY_ID);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Exactly one signed record was appended to the subject's chain (genesis).
    expect(memoryStore.rows).toHaveLength(1);
    const stored = memoryStore.rows[0].env;
    expect(stored.version).toBe(2);
    expect(stored.subject).toBe(SUBJECT_DID);
    expect(stored.issuer).toBe(MENTION_DID);
    expect(stored.collection).toBe(MENTION_NODE_COLLECTION);
    expect(stored.rkey).toBe(MENTION_NODE_RKEY);
    expect(stored.seq).toBe(0);
    expect(stored.publicKey).toBe(CUSTODIAL_PUBLIC);
    expect(stored.record).toMatchObject({
      endpoint: `${MANAGED_BASE}/u/${SUBJECT_OXY_ID}`,
      mode: 'pull',
      managed: true,
    });

    // The record genuinely verifies + is authorized for the custodial issuer.
    expect(await verifyEnvelopeSignature(stored)).toBe(true);
    const { mentionVerificationResolver } = await import('../../../services/mtn/mentionVerificationResolver');
    const resolved = await mentionVerificationResolver.resolve(stored.subject);
    expect(isAuthorizedKey(resolved, stored).ok).toBe(true);

    // The cache was materialized as a Mention-operated managed node.
    expect(lastSet(nodeModel.findOneAndUpdate)).toMatchObject({
      managed: true,
      controller: 'oxy',
      status: 'active',
    });
  });

  it('fails closed (custodial_key_unconfigured) when the custodial key is unset', async () => {
    delete process.env.MENTION_PRIVATE_KEY;
    const result = await provisionManagedVault(SUBJECT_OXY_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('custodial_key_unconfigured');
    expect(memoryStore.rows).toHaveLength(0);
  });

  it('fails closed (managed_endpoint_unconfigured) when MENTION_NODE_BASE_URL is unset', async () => {
    delete process.env.MENTION_NODE_BASE_URL;
    const result = await provisionManagedVault(SUBJECT_OXY_ID);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('managed_endpoint_unconfigured');
    expect(memoryStore.rows).toHaveLength(0);
  });
});

describe('MentionNodeRegistryService.probeLiveness', () => {
  it('flips a node to active on a 2xx well-known probe', async () => {
    nodeModel.cache.set(SUBJECT_OXY_ID, { oxyUserId: SUBJECT_OXY_ID, endpoint: NODE_ENDPOINT, status: 'unreachable' });

    await probeLiveness(SUBJECT_OXY_ID);

    expect(safeFetchMock).toHaveBeenCalledWith(
      `${NODE_ENDPOINT}/.well-known/oxy-node.json`,
      expect.objectContaining({ maxRedirects: 1 }),
    );
    const update = lastUpdate(nodeModel.updateOne);
    expect(update.$set).toMatchObject({ status: 'active' });
    expect(update.$unset).toEqual({ lastError: '' });
  });

  it('marks a node unreachable + records lastError when the probe throws', async () => {
    nodeModel.cache.set(SUBJECT_OXY_ID, { oxyUserId: SUBJECT_OXY_ID, endpoint: NODE_ENDPOINT, status: 'active' });
    safeFetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await probeLiveness(SUBJECT_OXY_ID);

    const set = lastSet(nodeModel.updateOne);
    expect(set.status).toBe('unreachable');
    expect(set.lastError).toContain('ECONNREFUSED');
  });
});

describe('MentionNodeRegistryService.sweepNodeLiveness — bounded concurrency', () => {
  /** Build N cached node rows + return them from `MentionUserNode.find()`. */
  function seedNodes(count: number): string[] {
    const ids = Array.from({ length: count }, (_, i) => `${SUBJECT_OXY_ID}${i}`);
    for (const id of ids) {
      nodeModel.cache.set(id, { oxyUserId: id, endpoint: `${NODE_ENDPOINT}/${id}`, status: 'active' });
    }
    nodeModel.find.mockReturnValueOnce({
      sort: () => ({
        limit: () => ({
          select: () => ({ lean: async () => ids.map((oxyUserId) => ({ oxyUserId })) }),
        }),
      }),
    });
    return ids;
  }

  it('probes EVERY node but never exceeds the in-flight concurrency cap', async () => {
    const NODE_COUNT = MENTION_NODE_LIVENESS_PROBE_CONCURRENCY * 3;
    const ids = seedNodes(NODE_COUNT);

    let inFlight = 0;
    let peakInFlight = 0;
    // Each probe holds a fetch open across a microtask so several can overlap;
    // the pool must keep overlap at/below the cap.
    safeFetchMock.mockImplementation(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return { status: 200, headers: {}, response: { destroy: () => undefined }, finalUrl: '' };
    });

    await sweepNodeLiveness();

    // Every node was probed exactly once.
    expect(safeFetchMock).toHaveBeenCalledTimes(NODE_COUNT);
    const probedEndpoints = safeFetchMock.mock.calls.map((c) => String(c[0]));
    for (const id of ids) {
      expect(probedEndpoints).toContain(`${NODE_ENDPOINT}/${id}/.well-known/oxy-node.json`);
    }
    // Concurrency stayed bounded: never more than the cap open at once.
    expect(peakInFlight).toBeGreaterThan(1); // genuinely parallel (not sequential)
    expect(peakInFlight).toBeLessThanOrEqual(MENTION_NODE_LIVENESS_PROBE_CONCURRENCY);
  });

  it('isolates a single failing probe — the rest of the batch still completes', async () => {
    const ids = seedNodes(5);
    let call = 0;
    safeFetchMock.mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new Error('one node is down');
      return { status: 200, headers: {}, response: { destroy: () => undefined }, finalUrl: '' };
    });

    // A rejecting probe must not reject the sweep.
    await expect(sweepNodeLiveness()).resolves.toBeUndefined();
    // All five nodes were still probed despite the one failure.
    expect(safeFetchMock).toHaveBeenCalledTimes(ids.length);
  });

  it('is a clean no-op when no nodes are registered', async () => {
    nodeModel.find.mockReturnValueOnce({
      sort: () => ({ limit: () => ({ select: () => ({ lean: async () => [] }) }) }),
    });

    await expect(sweepNodeLiveness()).resolves.toBeUndefined();
    expect(safeFetchMock).not.toHaveBeenCalled();
  });
});
