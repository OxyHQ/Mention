/**
 * The MCP OAuth plans — three collections nothing in this migration could see.
 *
 * Their models live in `src/mcp/models/`, and every model walker written for
 * this port enumerated `src/models/`. Only `db.listCollections()` against
 * production found them, which is why the schema and these plans exist at all.
 *
 * Two properties carry the weight, and the first is the OPPOSITE of the rule
 * every other junction in this migration follows:
 *
 * - **A duplicate `(bundle_id, oxy_user_id)` is LEGAL and must be copied.** The
 *   unique index is PARTIAL — `WHERE revoked_at IS NULL` — so one live
 *   connection per pair, with any number of revoked ones kept as history. A
 *   transform that deduped here would delete the record of a revocation, and
 *   deduping on the wrong row would delete the LIVE connection.
 * - **`mcpauthcodes` is copied on purpose.** Skipping it fails a user whose code
 *   was issued in the seconds before the freeze; copying it costs nothing,
 *   because `used_at` and the token endpoint's own `expires_at` check make a
 *   stale row inert.
 *
 * Fixtures are `bfmcp-` prefixed and every cleanup is SCOPED.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { eq } from 'drizzle-orm';
import { closePostgres, connectPostgres, getDb } from '../../db/postgres';
import { mcpAuthCodes, mcpConnections, mcpRegisteredClients } from '../../db/schema/mcp';
import { mongoSourceFromDb, type MongoSource } from '../../db/backfill/mongoSource';
import { copyCollection } from '../../db/backfill/runner';
import { COLLECTION_PLANS } from '../../db/backfill/collectionMap';
import { auditUniqueness } from '../../db/backfill/audit';
import { EXPIRY_SWEEP_TARGETS } from '../../db/expiry';
import {
  createResolutionContext,
  parentKeysFrom,
  planResolutions,
  ResolutionLog,
} from '../../db/backfill/resolutions';

let mongod: MongoMemoryServer;
let client: MongoClient;
let mongo: Db;
let source: MongoSource;

/** Scoped to this file — see the header. */
const VIEWER = 'bfmcp-viewer';
const CLIENT_ID = 'bfmcp-client';

const planFor = (collection: string) => {
  const plan = COLLECTION_PLANS.find((entry) => entry.collection === collection);
  if (!plan) throw new Error(`no plan for ${collection}`);
  return plan;
};

async function resolutions() {
  return createResolutionContext(await planResolutions(source), new ResolutionLog());
}

async function copy(collection: string) {
  return copyCollection(planFor(collection), {
    db: getDb(),
    source,
    resolutions: await resolutions(),
    parents: parentKeysFrom(new Map()),
  });
}

beforeAll(async () => {
  await connectPostgres();
  mongod = await MongoMemoryServer.create();
  client = await MongoClient.connect(mongod.getUri());
  mongo = client.db('backfill_mcp_test');
  source = mongoSourceFromDb(mongo, async () => {
    await client.close();
  });
}, 120_000);

afterEach(async () => {
  const db = getDb();
  await db.delete(mcpConnections).where(eq(mcpConnections.oxyUserId, VIEWER));
  await db.delete(mcpAuthCodes).where(eq(mcpAuthCodes.oxyUserId, VIEWER));
  await db.delete(mcpRegisteredClients).where(eq(mcpRegisteredClients.clientId, CLIENT_ID));
  for (const name of await mongo.listCollections({}, { nameOnly: true }).toArray()) {
    await mongo.collection(name.name).deleteMany({});
  }
});

afterAll(async () => {
  await client.close();
  await mongod.stop();
  await closePostgres();
});

describe('mcp connections', () => {
  it('copies a REVOKED duplicate alongside the live one', async () => {
    // The property that inverts this migration's usual rule. Same bundle, same
    // account, twice — which is what a revoke-and-re-link produces, the ordinary
    // recovery path. The partial index permits it because only one is live.
    const revoked = new ObjectId();
    const live = new ObjectId();
    await mongo.collection('mcpconnections').insertMany([
      {
        _id: revoked,
        oxyUserId: VIEWER,
        clientId: CLIENT_ID,
        clientLabel: 'Claude',
        scopes: ['read'],
        bundleId: 'bfmcp-bundle',
        refreshTokenHash: 'bfmcp-hash-old',
        jti: 'bfmcp-jti-old',
        revokedAt: new Date('2025-01-01T00:00:00.000Z'),
      },
      {
        _id: live,
        oxyUserId: VIEWER,
        clientId: CLIENT_ID,
        clientLabel: 'Claude',
        scopes: ['read', 'write'],
        bundleId: 'bfmcp-bundle',
        isBundlePrimary: true,
        refreshTokenHash: 'bfmcp-hash-new',
        jti: 'bfmcp-jti-new',
      },
    ]);
    await copy('mcpconnections');

    const rows = await getDb()
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.oxyUserId, VIEWER));

    // BOTH survive. Deduping would erase either the revocation record or the
    // live connection, and nothing downstream would report which.
    expect(rows).toHaveLength(2);
    const liveRow = rows.find((row) => row.revokedAt === null);
    expect(liveRow?.refreshTokenHash).toBe('bfmcp-hash-new');
    expect(liveRow?.isBundlePrimary).toBe(true);
    expect(rows.find((row) => row.revokedAt !== null)?.refreshTokenHash).toBe('bfmcp-hash-old');
  });

  it('does NOT report that legal duplicate as a uniqueness collision', async () => {
    // The audit half of the same property: the partial index's predicate has to
    // narrow the audit too, or the ordinary revoke-and-re-link path blocks the
    // whole run with a finding an operator cannot act on.
    await mongo.collection('mcpconnections').insertMany([
      {
        _id: new ObjectId(),
        oxyUserId: VIEWER,
        clientId: CLIENT_ID,
        clientLabel: 'Claude',
        bundleId: 'bfmcp-bundle',
        refreshTokenHash: 'bfmcp-hash-a',
        jti: 'bfmcp-jti-a',
        revokedAt: new Date('2025-01-01T00:00:00.000Z'),
      },
      {
        _id: new ObjectId(),
        oxyUserId: VIEWER,
        clientId: CLIENT_ID,
        clientLabel: 'Claude',
        bundleId: 'bfmcp-bundle',
        refreshTokenHash: 'bfmcp-hash-b',
        jti: 'bfmcp-jti-b',
        revokedAt: null,
      },
    ]);

    expect(await auditUniqueness(source, planFor('mcpconnections'), await resolutions())).toStrictEqual(
      []
    );
  });

  it('REPORTS two LIVE connections for one bundle and account', async () => {
    // The negative control for the case above: with the predicate applied, a
    // genuine collision must still block. Without this, an audit that simply
    // never fired would pass the previous case too.
    await mongo.collection('mcpconnections').insertMany([
      {
        _id: new ObjectId(),
        oxyUserId: VIEWER,
        clientId: CLIENT_ID,
        clientLabel: 'Claude',
        bundleId: 'bfmcp-bundle',
        refreshTokenHash: 'bfmcp-hash-c',
        jti: 'bfmcp-jti-c',
        revokedAt: null,
      },
      {
        _id: new ObjectId(),
        oxyUserId: VIEWER,
        clientId: CLIENT_ID,
        clientLabel: 'Claude',
        bundleId: 'bfmcp-bundle',
        refreshTokenHash: 'bfmcp-hash-d',
        jti: 'bfmcp-jti-d',
        revokedAt: null,
      },
    ]);

    const findings = await auditUniqueness(
      source,
      planFor('mcpconnections'),
      await resolutions()
    );
    expect(findings.map((finding) => finding.detail).join('\n')).toContain(
      'mcp_connections_bundle_id_oxy_user_id_key'
    );
  });

  it('keeps a connection with no bundle rather than inventing one', async () => {
    const id = new ObjectId();
    await mongo.collection('mcpconnections').insertOne({
      _id: id,
      oxyUserId: VIEWER,
      clientId: CLIENT_ID,
      clientLabel: 'Claude',
      refreshTokenHash: 'bfmcp-hash-solo',
      jti: 'bfmcp-jti-solo',
    });
    await copy('mcpconnections');

    const [row] = await getDb()
      .select()
      .from(mcpConnections)
      .where(eq(mcpConnections.id, id.toHexString()));

    // Written before bundles existed. A defaulted bundle id would make every
    // such connection look linked to every other.
    expect(row?.bundleId).toBeNull();
    expect(row?.isBundlePrimary).toBe(false);
    expect(row?.scopes).toStrictEqual([]);
    expect(row?.revokedAt).toBeNull();
  });
});

describe('mcp auth codes', () => {
  it('copies a spent code, which is inert rather than dangerous', async () => {
    const id = new ObjectId();
    const usedAt = new Date('2025-02-02T00:00:00.000Z');
    await mongo.collection('mcpauthcodes').insertOne({
      _id: id,
      code: 'bfmcp-code-used',
      clientId: CLIENT_ID,
      oxyUserId: VIEWER,
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeChallenge: 'bfmcp-challenge',
      scopes: ['read'],
      expiresAt: new Date('2025-02-02T00:10:00.000Z'),
      usedAt,
    });
    await copy('mcpauthcodes');

    const [row] = await getDb().select().from(mcpAuthCodes).where(eq(mcpAuthCodes.id, id.toHexString()));

    // `used_at` is half the single-use guarantee and the token endpoint checks
    // `expires_at` itself, so carrying this row cannot authorise anything.
    expect(row?.usedAt).toStrictEqual(usedAt);
    // Byte-for-byte: a normalised redirect URI stops matching the client's
    // registered value and fails every redemption for that client.
    expect(row?.redirectUri).toBe('https://claude.ai/api/mcp/auth_callback');
  });

  it('REFUSES a code with no expiry rather than inventing a deadline', async () => {
    await mongo.collection('mcpauthcodes').insertOne({
      _id: new ObjectId(),
      code: 'bfmcp-code-undated',
      clientId: CLIENT_ID,
      oxyUserId: VIEWER,
      redirectUri: 'https://claude.ai/api/mcp/auth_callback',
      codeChallenge: 'bfmcp-challenge',
    });

    // This column IS the deadline the token endpoint checks and the sweep reads.
    // An invented one either resurrects a dead code or reaps a live one.
    await expect(copy('mcpauthcodes')).rejects.toThrow(/expiresAt/);
  });

  it('is registered for the expiry sweep, because the TTL does not come along', async () => {
    // Mongo reaped these with a TTL index. Postgres has none, so without this
    // registry entry the copy is correct and the table grows forever — the one
    // behaviour of the source that a faithful row-for-row port silently drops.
    const target = EXPIRY_SWEEP_TARGETS.find((entry) => entry.table === mcpAuthCodes);
    expect(target).toBeDefined();
    expect(target?.column).toBe(mcpAuthCodes.expiresAt);
    // Retention 0: the column IS the deadline, exactly as `expireAfterSeconds: 0`.
    expect(target?.retentionSeconds).toBe(0);
  });
});

describe('mcp registered clients', () => {
  it('copies the redirect allowlist verbatim', async () => {
    const id = new ObjectId();
    await mongo.collection('mcpregisteredclients').insertOne({
      _id: id,
      clientId: CLIENT_ID,
      redirectUris: ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/cb'],
      label: 'Claude',
    });
    await copy('mcpregisteredclients');

    const [row] = await getDb()
      .select()
      .from(mcpRegisteredClients)
      .where(eq(mcpRegisteredClients.clientId, CLIENT_ID));

    // Enforced byte-for-byte alongside PKCE at authorize and token time, so the
    // ORDER and the exact strings both have to survive.
    expect(row?.redirectUris).toStrictEqual([
      'https://claude.ai/api/mcp/auth_callback',
      'https://claude.com/cb',
    ]);
    expect(row?.id).toBe(id.toHexString());
  });
});
