/**
 * `mention_user_nodes` + `mention_node_ingest_witnesses` against real rows.
 *
 * Everything this table serves is a BACKGROUND sweep, so a wrong answer here is
 * seen by nobody. Three of these cases pin a translation that would have failed
 * exactly that way, and each is mutation-sensitive rather than illustrative:
 *
 *  - A never-probed / never-synced node must LEAD its sweep. Mongo sorted a
 *    missing field first; a bare Postgres `ASC` sorts NULLs last and starves it
 *    permanently, with no error and no log.
 *  - The ingest loop's `-1` "no chain yet" sentinel must reach the column as
 *    `NULL`. Stored raw it violates the CHECK, and the throw lands inside a
 *    worker whose contract is that it never throws — so it surfaces as a node
 *    that silently stops syncing.
 *  - Witnessing must stay idempotent AND must not overwrite the first
 *    attestation, because that first sighting is the entire value of the table.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';

import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { mentionNodeIngestWitnesses, mentionUserNodes } from '../../db/schema/mtn';
import {
  findIngestTarget,
  findNodeEndpoint,
  findNodesToProbe,
  findNodesToSync,
  findUserNode,
  hasLiveNode,
  markNodeSynced,
  markNodeSyncStopped,
  recordNodeLiveness,
  recordNodeSyncError,
  revokeNode,
  upsertNodeRegistration,
  witnessIngestedRecord,
} from '../../db/mtn/nodeRepository';

/** Namespaces every account this file writes, so a parallel file cannot collide. */
const OWNER_PREFIX = 'oxy-mtn-node-repo-';

function owner(name: string): string {
  return `${OWNER_PREFIX}${name}`;
}

/** A registration with only the fields a case cares about spelled out. */
function registration(overrides: Partial<Parameters<typeof upsertNodeRegistration>[1]> = {}) {
  return {
    endpoint: 'https://node.example',
    nodePublicKey: 'pub-key-hex',
    mode: 'pull' as const,
    managed: false,
    controller: 'self' as const,
    ...overrides,
  };
}

async function seedNode(
  oxyUserId: string,
  overrides: Partial<typeof mentionUserNodes.$inferInsert> = {},
): Promise<void> {
  await getDb().insert(mentionUserNodes).values({
    oxyUserId,
    endpoint: 'https://node.example',
    nodePublicKey: 'pub-key-hex',
    ...overrides,
  });
}

async function readNode(oxyUserId: string) {
  const [row] = await getDb()
    .select()
    .from(mentionUserNodes)
    .where(eq(mentionUserNodes.oxyUserId, oxyUserId))
    .limit(1);
  return row;
}

beforeAll(async () => {
  await connectPostgres();
});

afterEach(async () => {
  await getDb()
    .delete(mentionNodeIngestWitnesses)
    .where(like(mentionNodeIngestWitnesses.oxyUserId, `${OWNER_PREFIX}%`));
  await getDb()
    .delete(mentionUserNodes)
    .where(like(mentionUserNodes.oxyUserId, `${OWNER_PREFIX}%`));
});

afterAll(async () => {
  await closePostgres();
});

describe('registering a node', () => {
  it('creates the row active, with the operator the registration named', async () => {
    const user = owner('fresh');

    const node = await upsertNodeRegistration(user, registration({ nodeDid: 'did:example:node' }));

    expect(node).toMatchObject({
      oxyUserId: user,
      endpoint: 'https://node.example',
      mode: 'pull',
      managed: false,
      controller: 'self',
      status: 'active',
      nodeDid: 'did:example:node',
    });
    expect(node?.lastError).toBeUndefined();
  });

  /**
   * Re-registering flips the operator deterministically and clears the badge.
   *
   * `managed` and `controller` are written EVERY time precisely so a self-hosted
   * node registered over a managed vault does not keep half the old operator.
   * The column pair also carries a CHECK (`managed = (controller = 'oxy')`), so
   * a half-written flip would be rejected rather than stored inconsistently.
   */
  it('re-registration flips the operator and clears a stale error', async () => {
    const user = owner('reregistered');
    await seedNode(user, { status: 'unreachable', lastError: 'connect ETIMEDOUT' });

    const node = await upsertNodeRegistration(
      user,
      registration({ managed: true, controller: 'oxy', mode: 'push' }),
    );

    expect(node).toMatchObject({ managed: true, controller: 'oxy', mode: 'push', status: 'active' });
    expect(node?.lastError).toBeUndefined();
  });

  /**
   * A registration that omits `nodeDid` LEAVES the previously advertised one.
   *
   * The Mongo `$set` was conditional on the field being present, and the DID is
   * informational — dropping it on every re-registration that happens not to
   * carry one would quietly empty a field nothing else repopulates.
   */
  it('leaves a previously advertised DID alone when the new record omits one', async () => {
    const user = owner('keeps-did');
    await upsertNodeRegistration(user, registration({ nodeDid: 'did:example:first' }));

    const node = await upsertNodeRegistration(user, registration());

    expect(node?.nodeDid).toBe('did:example:first');
  });
});

describe('the liveness sweep', () => {
  /**
   * A never-probed node leads the queue.
   *
   * This is the `NULLS FIRST` case. Under a bare `ASC` the freshly-registered
   * node sorts behind every node that has ever been probed, so on any deployment
   * with more registered nodes than the batch size it is never probed at all —
   * and its badge stays whatever it was seeded with, forever.
   */
  it('puts a never-probed node ahead of one probed long ago', async () => {
    const neverProbed = owner('never-probed');
    const probedLongAgo = owner('probed-long-ago');
    const probedRecently = owner('probed-recently');

    await seedNode(probedLongAgo, { lastProbeAt: new Date('2020-01-01T00:00:00.000Z') });
    await seedNode(probedRecently, { lastProbeAt: new Date('2030-01-01T00:00:00.000Z') });
    await seedNode(neverProbed, { lastProbeAt: null });

    const queue = (await findNodesToProbe(50)).filter((id) => id.startsWith(OWNER_PREFIX));

    expect(queue).toEqual([neverProbed, probedLongAgo, probedRecently]);
  });

  it('never offers a revoked node', async () => {
    const revoked = owner('revoked-node');
    await seedNode(revoked, { status: 'revoked' });

    const queue = await findNodesToProbe(50);
    expect(queue).not.toContain(revoked);
  });

  it('records a reachable probe as active and clears the previous error', async () => {
    const user = owner('now-reachable');
    await seedNode(user, { status: 'unreachable', lastError: 'connect ETIMEDOUT' });
    const probedAt = new Date('2026-01-01T00:00:00.000Z');

    await recordNodeLiveness(user, { reachable: true, probedAt });

    const row = await readNode(user);
    expect(row?.status).toBe('active');
    expect(row?.lastSeenAt?.toISOString()).toBe(probedAt.toISOString());
    expect(row?.lastError).toBeNull();
  });

  /**
   * A failed probe stamps `last_probe_at` but NOT `last_seen_at`.
   *
   * They answer different questions — when we last looked, and when the node was
   * last actually up — and collapsing them would make an offline node look alive
   * to anything reading `lastSeenAt`.
   */
  it('records an unreachable probe without touching last-seen', async () => {
    const user = owner('now-unreachable');
    const seenAt = new Date('2025-01-01T00:00:00.000Z');
    await seedNode(user, { status: 'active', lastSeenAt: seenAt });
    const probedAt = new Date('2026-01-01T00:00:00.000Z');

    await recordNodeLiveness(user, { reachable: false, probedAt, error: 'HTTP 503' });

    const row = await readNode(user);
    expect(row?.status).toBe('unreachable');
    expect(row?.lastError).toBe('HTTP 503');
    expect(row?.lastSeenAt?.toISOString()).toBe(seenAt.toISOString());
  });

  it('will not write liveness onto a node the user revoked', async () => {
    const user = owner('revoked-midprobe');
    await seedNode(user, { status: 'revoked' });

    await recordNodeLiveness(user, { reachable: true, probedAt: new Date() });

    expect((await readNode(user))?.status).toBe('revoked');
  });
});

describe('the sync sweep', () => {
  /** Same `NULLS FIRST` guarantee as the liveness sweep, on the other column. */
  it('puts a never-synced node ahead of one synced long ago', async () => {
    const neverSynced = owner('never-synced');
    const syncedLongAgo = owner('synced-long-ago');

    await seedNode(syncedLongAgo, { lastSyncedAt: new Date('2020-01-01T00:00:00.000Z') });
    await seedNode(neverSynced, { lastSyncedAt: null, mode: 'push' });

    const queue = (await findNodesToSync(50)).filter((n) => n.oxyUserId.startsWith(OWNER_PREFIX));

    expect(queue).toEqual([
      { oxyUserId: neverSynced, mode: 'push' },
      { oxyUserId: syncedLongAgo, mode: 'pull' },
    ]);
  });

  /**
   * `-1` reaches the column as `NULL`.
   *
   * `Math.max(node.cursor ?? -1, localHeadSeq)` yields `-1` for a user with no
   * chain yet, and `mention_user_nodes_cursor_check` refuses a negative. Stored
   * raw this throws inside `ingestFromNode`, whose outer catch turns it into a
   * `lastError` — a node that stops syncing and says only that something failed.
   */
  it('stores the no-chain-yet sentinel as a null cursor, not a negative one', async () => {
    const user = owner('empty-chain');
    await seedNode(user);

    await markNodeSynced(user, -1, true);

    const row = await readNode(user);
    expect(row?.cursor).toBeNull();
    expect(row?.lastSyncedAt).not.toBeNull();
  });

  it('advances a real cursor and clears the error when asked', async () => {
    const user = owner('advancing');
    await seedNode(user, { lastError: 'chain_gap' });

    await markNodeSynced(user, 42, true);

    const row = await readNode(user);
    expect(row?.cursor).toBe(42);
    expect(row?.lastError).toBeNull();
  });

  it('keeps the existing error when the sync did not clear it', async () => {
    const user = owner('kept-error');
    await seedNode(user, { lastError: 'chain_gap' });

    await markNodeSynced(user, 7, false);

    expect((await readNode(user))?.lastError).toBe('chain_gap');
  });

  it('records the reason a sync stopped early alongside the cursor it reached', async () => {
    const user = owner('stopped');
    await seedNode(user);

    await markNodeSyncStopped(user, 3, 'chain_gap');

    const row = await readNode(user);
    expect(row?.cursor).toBe(3);
    expect(row?.lastError).toBe('chain_gap');
  });

  it('records a sync failure as an error on the row', async () => {
    const user = owner('failed-sync');
    await seedNode(user);

    await recordNodeSyncError(user, 'fetch failed');

    expect((await readNode(user))?.lastError).toBe('fetch failed');
  });

  it('hands the ingest loop the endpoint and its stored cursor', async () => {
    const user = owner('resumable');
    await seedNode(user, { endpoint: 'https://resume.example', cursor: 11 });

    await expect(findIngestTarget(user)).resolves.toEqual({
      endpoint: 'https://resume.example',
      cursor: 11,
    });
  });

  it('offers no ingest target for a revoked node', async () => {
    const user = owner('revoked-ingest');
    await seedNode(user, { status: 'revoked' });

    await expect(findIngestTarget(user)).resolves.toBeUndefined();
  });
});

describe('witnessing an ingested record', () => {
  it('writes the attestation the first time', async () => {
    const user = owner('witnessed');

    await expect(
      witnessIngestedRecord({
        oxyUserId: user,
        recordId: 'record-1',
        witnessSignature: 'sig-1',
        ingestedAt: 1_700_000_000_000,
      }),
    ).resolves.toBe(true);
  });

  /**
   * A re-pull leaves the FIRST attestation exactly as it was.
   *
   * The table exists to bind the first `recordId` Mention ever saw at a content
   * address to a timestamp under Mention's own key. An upsert would let a later
   * sweep restate that timestamp and signature, which is precisely the claim the
   * witness is supposed to make impossible — so `DO NOTHING`, not `DO UPDATE`.
   */
  it('is idempotent on a re-pull and never restates the first signature', async () => {
    const user = owner('re-pulled');
    await witnessIngestedRecord({
      oxyUserId: user,
      recordId: 'record-2',
      witnessSignature: 'first-sig',
      ingestedAt: 1_700_000_000_000,
    });

    await expect(
      witnessIngestedRecord({
        oxyUserId: user,
        recordId: 'record-2',
        witnessSignature: 'second-sig',
        ingestedAt: 1_800_000_000_000,
      }),
    ).resolves.toBe(false);

    const rows = await getDb()
      .select()
      .from(mentionNodeIngestWitnesses)
      .where(eq(mentionNodeIngestWitnesses.recordId, 'record-2'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.witnessSignature).toBe('first-sig');
    // Stored as a raw millisecond NUMBER: it is part of the canonicalized
    // signing input and has to round-trip byte-identically.
    expect(rows[0]?.ingestedAt).toBe(1_700_000_000_000);
  });
});

describe('reading and revoking', () => {
  it('returns a node whatever its status', async () => {
    const user = owner('any-status');
    await seedNode(user, { status: 'revoked' });

    await expect(findUserNode(user)).resolves.toMatchObject({ status: 'revoked' });
  });

  it('answers undefined for a user with no node', async () => {
    await expect(findUserNode(owner('no-node'))).resolves.toBeUndefined();
    await expect(findNodeEndpoint(owner('no-node'))).resolves.toBeUndefined();
    await expect(hasLiveNode(owner('no-node'))).resolves.toBe(false);
  });

  it('reports a live node and stops reporting it once revoked', async () => {
    const user = owner('to-revoke');
    await seedNode(user, { lastError: 'stale' });

    await expect(hasLiveNode(user)).resolves.toBe(true);
    await expect(revokeNode(user)).resolves.toBe(true);
    await expect(hasLiveNode(user)).resolves.toBe(false);
    expect((await readNode(user))?.lastError).toBeNull();
  });

  /**
   * Revoking twice answers `false`, and that is "there was nothing to revoke" —
   * NOT "the write failed". The route reads it to choose 404 vs 204.
   */
  it('answers false when there was nothing left to revoke', async () => {
    const user = owner('already-revoked');
    await seedNode(user, { status: 'revoked' });

    await expect(revokeNode(user)).resolves.toBe(false);
  });
});
