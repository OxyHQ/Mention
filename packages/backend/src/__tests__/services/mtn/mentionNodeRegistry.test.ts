import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
/**
 * OWNED BY THIS FILE — `mention_user_nodes.oxy_user_id` is UNIQUE and this suite
 * seeds real node rows. See the same note in `mentionNodeSync.test.ts`.
 */
const SUBJECT_OXY_ID = '650000000000000000000a52';
const SUBJECT_DID = `did:web:oxy.so:u:${SUBJECT_OXY_ID}`;
const MANAGED_BASE = 'https://nodes.mention.earth';

// --- In-memory RecordStore (the protocol `RecordStore` contract). -------------
interface MemoryStore extends RecordStore {
  rows: Array<{ env: SignedRecordEnvelope; recordId: string }>;
  heads: Map<string, ChainHead>;
}

const { memoryStore, resolveDid, safeFetchMock } = vi.hoisted(() => {
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

  const safeFetch = vi.fn(async (_url: string) => ({
    status: 200,
    headers: {} as Record<string, string>,
    response: { destroy: () => undefined },
    finalUrl: '',
  }));

  return { memoryStore: store, resolveDid: resolveDidMock, safeFetchMock: safeFetch };
});

// --- Mocks -------------------------------------------------------------------
vi.mock('../../../services/mtn/MentionRecordStore', () => ({
  mentionRecordStore: memoryStore,
}));
vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ resolveDid }),
}));
vi.mock('@oxyhq/core/server', () => ({
  safeFetch: safeFetchMock,
}));

import { eq, like } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../../db/postgres';
import { mentionUserNodes } from '../../../db/schema/mtn';
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
/** How long the concurrency barrier waits for the pool to saturate before failing. */
const CONCURRENCY_BARRIER_TIMEOUT_MS = 5_000;
const NODE_PUBLIC_KEY = 'ab'.repeat(33); // 66 hex chars — a valid secp256k1 key

/**
 * The stored node row.
 *
 * This used to read the `$set` of the last call to a mocked Mongo static, which
 * asserted what the service ASKED FOR rather than what the store kept — so it
 * could not see a write the database would reject (the `managed`/`controller`
 * CHECK) nor a field the update silently dropped.
 */
async function storedNode(oxyUserId: string) {
  const [row] = await getDb()
    .select()
    .from(mentionUserNodes)
    .where(eq(mentionUserNodes.oxyUserId, oxyUserId))
    .limit(1);
  return row;
}

/** Seed a cached node row directly, for the probe/sweep cases. */
async function seedNode(
  oxyUserId: string,
  overrides: Partial<typeof mentionUserNodes.$inferInsert> = {},
): Promise<void> {
  await getDb().insert(mentionUserNodes).values({
    oxyUserId,
    endpoint: NODE_ENDPOINT,
    nodePublicKey: NODE_PUBLIC_KEY,
    ...overrides,
  });
}

beforeAll(async () => {
  await connectPostgres();
});

afterAll(async () => {
  await closePostgres();
});

beforeEach(async () => {
  await getDb().delete(mentionUserNodes).where(like(mentionUserNodes.oxyUserId, `${SUBJECT_OXY_ID}%`));
  process.env.MENTION_DID = MENTION_DID;
  process.env.MENTION_PRIVATE_KEY = CUSTODIAL_PRIVATE;
  process.env.MENTION_PUBLIC_KEY = CUSTODIAL_PUBLIC;
  process.env.MENTION_NODE_BASE_URL = MANAGED_BASE;
  memoryStore.rows.length = 0;
  memoryStore.heads.clear();
  safeFetchMock.mockClear();
  resolveDid.mockClear();
  clearVerificationMethodCache();
});

afterEach(async () => {
  await getDb().delete(mentionUserNodes).where(like(mentionUserNodes.oxyUserId, `${SUBJECT_OXY_ID}%`));
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
    expect(await storedNode(SUBJECT_OXY_ID)).toMatchObject({
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
    const row = await storedNode(SUBJECT_OXY_ID);
    // Trailing slash is normalised off the endpoint.
    expect(row?.endpoint).toBe(NODE_ENDPOINT);
    expect(row?.mode).toBe('push');
    expect(row?.nodeDid).toBe('did:web:node.example.com');
  });

  it('is a non-throwing no-op for a non-HTTPS endpoint', async () => {
    const node = await materializeNodeFromRecord(SUBJECT_OXY_ID, {
      endpoint: 'http://insecure.example.com',
      nodePublicKey: NODE_PUBLIC_KEY,
    });
    expect(node).toBeNull();
    expect(await storedNode(SUBJECT_OXY_ID)).toBeUndefined();
  });

  it('is a non-throwing no-op for a non-hex node public key', async () => {
    const node = await materializeNodeFromRecord(SUBJECT_OXY_ID, {
      endpoint: NODE_ENDPOINT,
      nodePublicKey: 'not-a-hex-key',
    });
    expect(node).toBeNull();
    expect(await storedNode(SUBJECT_OXY_ID)).toBeUndefined();
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

    // The cache was materialized as a Mention-operated managed node. Both flags
    // are read back off the row because the table CHECKs that they agree —
    // asserting the requested `$set` could not have caught a pair the database
    // would refuse.
    expect(await storedNode(SUBJECT_OXY_ID)).toMatchObject({
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
    await seedNode(SUBJECT_OXY_ID, { status: 'unreachable', lastError: 'ECONNREFUSED' });

    await probeLiveness(SUBJECT_OXY_ID);

    expect(safeFetchMock).toHaveBeenCalledWith(
      `${NODE_ENDPOINT}/.well-known/oxy-node.json`,
      expect.objectContaining({ maxRedirects: 1 }),
    );
    const row = await storedNode(SUBJECT_OXY_ID);
    expect(row?.status).toBe('active');
    expect(row?.lastError).toBeNull();
  });

  it('marks a node unreachable + records lastError when the probe throws', async () => {
    await seedNode(SUBJECT_OXY_ID, { status: 'active' });
    safeFetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await probeLiveness(SUBJECT_OXY_ID);

    const row = await storedNode(SUBJECT_OXY_ID);
    expect(row?.status).toBe('unreachable');
    expect(row?.lastError).toContain('ECONNREFUSED');
  });
});

describe('MentionNodeRegistryService.sweepNodeLiveness — bounded concurrency', () => {
  /**
 * The endpoints THIS suite's probes went to.
 *
 * `sweepNodeLiveness` reads the whole table, and vitest runs test FILES in
 * parallel against one database — so sibling suites' node rows are legitimately
 * in the batch and a bare `toHaveBeenCalledTimes` counts them too. That is a
 * cross-file flake, not a finding, so every count here is scoped to endpoints
 * this file owns. (The batch limit is 100 and this suite seeds 24, so its own
 * rows always fit regardless of what the siblings add.)
 */
function probedOwnEndpoints(): string[] {
  return safeFetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith(`${NODE_ENDPOINT}/${SUBJECT_OXY_ID}`));
}

/** Build N real cached node rows for the sweep to pick up. */
  async function seedNodes(count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, (_, i) => `${SUBJECT_OXY_ID}${i}`);
    await Promise.all(
      ids.map((id) => seedNode(id, { endpoint: `${NODE_ENDPOINT}/${id}`, status: 'active' })),
    );
    return ids;
  }

  /**
   * The pool is genuinely parallel, and never wider than the cap.
   *
   * Overlap is FORCED rather than observed. Each probe now makes real database
   * round-trips either side of its fetch, so probes that used to collide inside
   * one microtask no longer do — the previous version measured a peak of 1 and
   * would have reported a sequential loop as fine (or flaked, depending on how
   * the pool interleaved with the driver that run). Instead every fetch parks
   * until the cap-th one arrives: a pool narrower than the cap can never reach
   * that point, so it fails on the barrier's own timeout with a message naming
   * the guarantee, rather than hanging or passing.
   */
  it('probes EVERY node but never exceeds the in-flight concurrency cap', async () => {
    const cap = MENTION_NODE_LIVENESS_PROBE_CONCURRENCY;
    const NODE_COUNT = cap * 3;
    const ids = await seedNodes(NODE_COUNT);

    let inFlight = 0;
    let peakInFlight = 0;
    let saturated: (() => void) | undefined;
    const reachedCap = new Promise<void>((resolve) => { saturated = resolve; });
    const barrier = Promise.race([
      reachedCap,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(
            `only ${peakInFlight} probe(s) were ever in flight at once, so the `
            + `liveness sweep is not running a pool of ${cap} — it has become `
            + 'sequential, and one slow node now stalls every node behind it',
          )),
          CONCURRENCY_BARRIER_TIMEOUT_MS,
        ).unref?.();
      }),
    ]);

    safeFetchMock.mockImplementation(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      if (inFlight >= cap) saturated?.();
      await barrier;
      inFlight -= 1;
      return { status: 200, headers: {}, response: { destroy: () => undefined }, finalUrl: '' };
    });

    await sweepNodeLiveness();

    // Every node this suite registered was probed exactly once.
    const probedEndpoints = probedOwnEndpoints();
    expect(probedEndpoints).toHaveLength(NODE_COUNT);
    for (const id of ids) {
      expect(probedEndpoints).toContain(`${NODE_ENDPOINT}/${id}/.well-known/oxy-node.json`);
    }
    expect(peakInFlight).toBeLessThanOrEqual(cap);
  });

  it('isolates a single failing probe — the rest of the batch still completes', async () => {
    const ids = await seedNodes(5);
    let call = 0;
    safeFetchMock.mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new Error('one node is down');
      return { status: 200, headers: {}, response: { destroy: () => undefined }, finalUrl: '' };
    });

    // A rejecting probe must not reject the sweep.
    await expect(sweepNodeLiveness()).resolves.toBeUndefined();
    // All five nodes were still probed despite the one failure.
    expect(probedOwnEndpoints()).toHaveLength(ids.length);
  });

  it('probes nothing of its own when it has registered no nodes', async () => {
    // No rows seeded for this subject. A sibling suite's rows may still be in
    // the batch, which is why this asks about THIS suite's endpoints rather than
    // asserting the sweep made no request at all.
    await expect(sweepNodeLiveness()).resolves.toBeUndefined();
    expect(probedOwnEndpoints()).toEqual([]);
  });
});
