/**
 * `mcp_connections` — every read and write of the MCP bundle graph.
 *
 * This module exists for ONE predicate. Mongo spelled "this connection is still
 * live" as `{ revokedAt: null }`, which matches a missing field AND an explicit
 * null; SQL's `<> null` matches NOTHING and `= null` matches nothing either, so
 * the naive transcription of that filter is a gate that silently stops gating.
 * Every one of those filters is a PERMISSION gate — `findLiveConnectionByJti`
 * resolves an access token's family, and if its predicate stops discriminating,
 * a REVOKED connection starts authenticating again. Writing `isNull` once, here,
 * is what stops the mistranslation from being reintroduced at the ninth call
 * site.
 *
 * ## Duplicates are LEGAL here, and this is the one place they are
 *
 * `(bundle_id, oxy_user_id)` is unique only `WHERE revoked_at IS NULL`, so any
 * number of revoked rows may accumulate beside exactly one live one.
 * Revoke-and-re-link is the ordinary recovery path — deduping would destroy the
 * revocation record, and deduping the wrong row would destroy a live connection
 * and sign a linked Claude account out with no way back (Claude allows one
 * connector per URL, so recovery is the whole OAuth flow per account). Every
 * other junction in this migration dedupes; do not extend the house style here.
 *
 * ## What is never selected
 *
 * `refresh_token_hash` and `jti` are credential-adjacent: the first is the
 * lookup key for a refresh-token family, the second is what the Redis
 * revocation blocklist keys on. Reads that serve a client name their columns
 * explicitly rather than taking the whole row, so a future DTO field cannot
 * pick either up by accident.
 */

import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '../postgres';
import { mcpConnections, type McpConnectionRow } from '../schema/mcp';

/**
 * A connection whose `bundle_id` is known to be set.
 *
 * The column is nullable — connections written before bundles shipped have none,
 * and defaulting it would invent a bundle and make unrelated connections look
 * linked. {@link ensureBundleFields} is what turns one of those into this, so
 * callers that need a bundle id get it from the type rather than a non-null
 * assertion.
 */
export type BundledMcpConnection = McpConnectionRow & { bundleId: string };

/** The columns a bundle member's own routes need. Never the credential ones. */
const MEMBER_COLUMNS = {
  id: mcpConnections.id,
  oxyUserId: mcpConnections.oxyUserId,
  clientId: mcpConnections.clientId,
  clientLabel: mcpConnections.clientLabel,
  scopes: mcpConnections.scopes,
  bundleId: mcpConnections.bundleId,
  isBundlePrimary: mcpConnections.isBundlePrimary,
  createdAt: mcpConnections.createdAt,
  lastUsedAt: mcpConnections.lastUsedAt,
} as const;

/** One bundle member, without the credential columns. */
export type McpBundleMember = {
  id: string;
  oxyUserId: string;
  clientId: string;
  clientLabel: string;
  scopes: string[];
  bundleId: string | null;
  isBundlePrimary: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
};

/** Fields a new connection supplies; the rest are defaulted by the schema. */
export interface NewMcpConnection {
  oxyUserId: string;
  clientId: string;
  clientLabel: string;
  scopes: string[];
  bundleId: string;
  isBundlePrimary: boolean;
  activeOxyUserId?: string | null;
  refreshTokenHash: string;
  jti: string;
  lastUsedAt: Date;
}

/**
 * The live connection whose current token family is `jti`, or `null`.
 *
 * The `revoked_at IS NULL` half is the revocation gate: a token minted for a
 * connection that has since been revoked must not resolve here even though its
 * `jti` still matches a row.
 */
export async function findLiveConnectionByJti(jti: string): Promise<McpConnectionRow | null> {
  const [row] = await getDb()
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.jti, jti), isNull(mcpConnections.revokedAt)))
    .limit(1);
  return row ?? null;
}

/**
 * The connection holding `refreshTokenHash`, revoked or not.
 *
 * Deliberately UNFILTERED on `revoked_at`: the refresh grant has to be able to
 * tell "no such token" from "that token's connection was revoked", and it
 * answers `invalid_grant` to both. Filtering here would make the two
 * indistinguishable to the caller, not more secure.
 */
export async function findConnectionByRefreshTokenHash(
  refreshTokenHash: string
): Promise<McpConnectionRow | null> {
  const [row] = await getDb()
    .select()
    .from(mcpConnections)
    .where(eq(mcpConnections.refreshTokenHash, refreshTokenHash))
    .limit(1);
  return row ?? null;
}

/** The live connection linking `oxyUserId` to `bundleId`, or `null`. */
export async function findLiveBundleMember(
  bundleId: string,
  oxyUserId: string
): Promise<McpBundleMember | null> {
  const [row] = await getDb()
    .select(MEMBER_COLUMNS)
    .from(mcpConnections)
    .where(
      and(
        eq(mcpConnections.bundleId, bundleId),
        eq(mcpConnections.oxyUserId, oxyUserId),
        isNull(mcpConnections.revokedAt)
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * The bundle's live PRIMARY connection — the account whose OAuth grant the
 * client actually holds — optionally narrowed to one `clientId`.
 */
export async function findLiveBundlePrimary(
  bundleId: string,
  clientId?: string
): Promise<McpBundleMember | null> {
  const filters = [
    eq(mcpConnections.bundleId, bundleId),
    eq(mcpConnections.isBundlePrimary, true),
    isNull(mcpConnections.revokedAt),
  ];
  if (clientId !== undefined) {
    filters.push(eq(mcpConnections.clientId, clientId));
  }

  const [row] = await getDb()
    .select(MEMBER_COLUMNS)
    .from(mcpConnections)
    .where(and(...filters))
    .limit(1);
  return row ?? null;
}

/**
 * Every live member of one bundle, primary first then oldest first.
 *
 * `isBundlePrimary DESC` puts `true` ahead of `false` in Postgres, which is the
 * same order Mongo's `{ isBundlePrimary: -1 }` produced.
 */
export async function listLiveBundleMembers(bundleId: string): Promise<McpBundleMember[]> {
  return getDb()
    .select(MEMBER_COLUMNS)
    .from(mcpConnections)
    .where(and(eq(mcpConnections.bundleId, bundleId), isNull(mcpConnections.revokedAt)))
    .orderBy(desc(mcpConnections.isBundlePrimary), asc(mcpConnections.createdAt));
}

/** How many live members one bundle has — the cap check for add-account. */
export async function countLiveBundleMembers(bundleId: string): Promise<number> {
  const [row] = await getDb()
    .select({ members: count() })
    .from(mcpConnections)
    .where(and(eq(mcpConnections.bundleId, bundleId), isNull(mcpConnections.revokedAt)));
  return row?.members ?? 0;
}

/** One user's live connections, newest first. */
export async function listLiveConnectionsForUser(oxyUserId: string): Promise<McpBundleMember[]> {
  return getDb()
    .select(MEMBER_COLUMNS)
    .from(mcpConnections)
    .where(and(eq(mcpConnections.oxyUserId, oxyUserId), isNull(mcpConnections.revokedAt)))
    .orderBy(desc(mcpConnections.createdAt));
}

/** Every live member of any of `bundleIds`. Empty input short-circuits. */
export async function listLiveMembersOfBundles(
  bundleIds: readonly string[]
): Promise<McpBundleMember[]> {
  if (bundleIds.length === 0) return [];
  return getDb()
    .select(MEMBER_COLUMNS)
    .from(mcpConnections)
    .where(
      and(inArray(mcpConnections.bundleId, [...bundleIds]), isNull(mcpConnections.revokedAt))
    );
}

/**
 * Insert one connection.
 *
 * Lets the partial unique index refuse a concurrent duplicate rather than
 * reading first — the caller catches it and reports "already linked". A read
 * followed by an insert is not the same thing: two add-account requests that
 * both read "not linked" would both insert.
 */
export async function createConnection(values: NewMcpConnection): Promise<McpConnectionRow> {
  const [row] = await getDb().insert(mcpConnections).values(values).returning();
  return row;
}

/**
 * Give a pre-bundle connection its own bundle, and make it that bundle's
 * primary and active account.
 *
 * Idempotent by construction: `WHERE bundle_id IS NULL` means a row another
 * request already backfilled is left alone, and its current values come back
 * instead of being overwritten with a second freshly-minted bundle id.
 */
export async function ensureBundleFields(
  connection: McpConnectionRow,
  bundleId: string
): Promise<BundledMcpConnection> {
  if (connection.bundleId) {
    return { ...connection, bundleId: connection.bundleId };
  }

  const [row] = await getDb()
    .update(mcpConnections)
    .set({ bundleId, isBundlePrimary: true, activeOxyUserId: connection.oxyUserId })
    .where(and(eq(mcpConnections.id, connection.id), isNull(mcpConnections.bundleId)))
    .returning();

  if (row?.bundleId) {
    return { ...row, bundleId: row.bundleId };
  }

  // Another request won the backfill race. Re-read rather than assume our own
  // bundle id landed — the row now carries THEIRS, and returning ours would put
  // this request in a bundle that does not exist.
  const current = await findConnectionById(connection.id);
  if (current?.bundleId) {
    return { ...current, bundleId: current.bundleId };
  }
  return { ...connection, bundleId };
}

/** One connection by primary key, revoked or not. */
export async function findConnectionById(id: string): Promise<McpConnectionRow | null> {
  const [row] = await getDb()
    .select()
    .from(mcpConnections)
    .where(eq(mcpConnections.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Record the bundle's active account on its live primary connection.
 *
 * @returns Whether a row was updated. `false` means the durable half of the
 *   active-account write did not happen, which the caller pairs with the Redis
 *   result — it must never be read as "the switch succeeded".
 */
export async function setBundleActiveAccount(
  bundleId: string,
  activeOxyUserId: string
): Promise<boolean> {
  const updated = await getDb()
    .update(mcpConnections)
    .set({ activeOxyUserId })
    .where(
      and(
        eq(mcpConnections.bundleId, bundleId),
        eq(mcpConnections.isBundlePrimary, true),
        isNull(mcpConnections.revokedAt)
      )
    )
    .returning({ id: mcpConnections.id });
  return updated.length > 0;
}

/**
 * Revoke one of `oxyUserId`'s own connections.
 *
 * Ownership is in the WHERE, not checked beforehand: a connection is never
 * addressable across users, and a read-then-write would leave a window in which
 * the ownership fact is older than the write it authorizes.
 *
 * @returns The revoked row's token-family id, or `null` when nothing matched —
 *   which covers both "no such connection" and "not yours", deliberately
 *   indistinguishable to the caller.
 */
export async function revokeConnectionForOwner(
  id: string,
  oxyUserId: string
): Promise<{ jti: string } | null> {
  const [row] = await getDb()
    .update(mcpConnections)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(mcpConnections.id, id),
        eq(mcpConnections.oxyUserId, oxyUserId),
        isNull(mcpConnections.revokedAt)
      )
    )
    .returning({ jti: mcpConnections.jti });
  return row ?? null;
}

/**
 * Rotate a connection onto a new refresh-token family.
 *
 * Conditional on the OUTGOING hash still being current, so two concurrent
 * refreshes cannot both succeed: the loser matches no row and its caller
 * answers `invalid_grant` rather than minting a second live family from one
 * refresh token.
 *
 * @returns Whether the rotation was applied.
 */
export async function rotateRefreshTokenFamily(
  id: string,
  previousRefreshTokenHash: string,
  next: { jti: string; refreshTokenHash: string }
): Promise<boolean> {
  const updated = await getDb()
    .update(mcpConnections)
    .set({
      jti: next.jti,
      refreshTokenHash: next.refreshTokenHash,
      lastUsedAt: new Date(),
    })
    .where(
      and(
        eq(mcpConnections.id, id),
        eq(mcpConnections.refreshTokenHash, previousRefreshTokenHash)
      )
    )
    .returning({ id: mcpConnections.id });
  return updated.length > 0;
}
