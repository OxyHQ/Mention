/**
 * The MCP OAuth surface: `mcp_connections`, `mcp_auth_codes` and
 * `mcp_registered_clients`.
 *
 * These three were invisible to every code-derived inventory of this migration
 * for one reason worth keeping: their models live in `src/mcp/models/`, and
 * every model walker written for this port enumerated `src/models/`. A
 * DIRECTORY is an enumeration, and it fails exactly like a name-based grep —
 * silently, with a shorter list. Only `db.listCollections()` against production
 * found them.
 *
 * ## A low document count is not a low stake
 *
 * `mcpconnections` held THIRTEEN documents when production was censused. It is
 * also the bundle graph every linked Claude account resolves through
 * (`mcp/middleware/mcpAuth.ts`), so losing those thirteen rows signs every MCP
 * user out with no way back — they cannot re-link without re-running the whole
 * OAuth flow, and Claude allows only one connector per URL.
 *
 * ## What is stored is a HASH, and that is load-bearing
 *
 * `mcp_connections.refresh_token_hash` is a SHA-256 digest; the refresh token
 * itself is never stored. `jti` is the current token-family id embedded in
 * every access token minted for the connection — it rotates on refresh and is
 * added to a Redis revocation blocklist when the connection is revoked, which
 * is what stops already-issued access tokens validating before their natural
 * expiry. Both are opaque strings here on purpose: nothing in Postgres should
 * be able to reconstruct a credential.
 *
 * ## The partial unique index is the bundle invariant
 *
 * Mongo declared `{bundleId, oxyUserId}` unique with
 * `partialFilterExpression: {revokedAt: null}` — one LIVE connection per
 * (bundle, account), while any number of revoked ones may accumulate as
 * history. A total unique index would refuse a user who revokes and re-links,
 * which is the ordinary recovery path. Postgres expresses it as a partial
 * unique index with the same predicate.
 */

import { sql } from 'drizzle-orm';
import { boolean, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz } from './columns';

/**
 * How long a redeemed or expired authorization code is kept before the sweep
 * takes it.
 *
 * Mongo used a TTL index on `expiresAt` with `expireAfterSeconds: 0` — the
 * column IS the deadline — so the retention here is 0 for the same reason the
 * moderation tables use 0. The constant exists so `db/expiry.ts` reads it from
 * the schema rather than restating a literal.
 */
export const MCP_AUTH_CODE_RETENTION_SECONDS = 0;

/**
 * `mcp_connections` — one row per active authorization grant between an MCP
 * client and a Mention account. One row IS one refresh-token family.
 */
export const mcpConnections = pgTable(
  'mcp_connections',
  {
    id: generatedId(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    clientId: text().notNull(),
    clientLabel: text().notNull(),
    scopes: text().array().notNull(),
    /**
     * Shared id for every account linked to one MCP connector. NULLABLE because
     * the Mongoose field carries no `required` and connections written before
     * bundles existed have none — defaulting it would invent a bundle and make
     * unrelated connections look linked.
     */
    bundleId: text(),
    /** True only for the account whose OAuth grant the client holds and refreshes. */
    isBundlePrimary: boolean().notNull().default(false),
    /** The bundle's active account, stored on the primary row. */
    activeOxyUserId: text(),
    /** SHA-256 hex of the active refresh token. The token itself is never stored. */
    refreshTokenHash: text().notNull(),
    /** Current token-family id; rotates on refresh, mirrored into access-token `jti`. */
    jti: text().notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamptz(),
    revokedAt: timestamptz(),
  },
  (t) => [
    // A refresh lookup must resolve exactly one connection.
    uniqueIndex('mcp_connections_refresh_token_hash_key').on(t.refreshTokenHash),
    // ONE LIVE connection per (bundle, account) — see the docblock. The
    // predicate is what lets a revoked row stay as history.
    uniqueIndex('mcp_connections_bundle_id_oxy_user_id_key')
      .on(t.bundleId, t.oxyUserId)
      .where(sql`${t.revokedAt} is null`),
    // A user's connection list, and a bundle's members. Both filter on revoked.
    index('mcp_connections_oxy_user_id_idx').on(t.oxyUserId, t.revokedAt),
    index('mcp_connections_bundle_id_idx').on(t.bundleId, t.revokedAt),
    // Revocation resolves a token family by `jti`.
    index('mcp_connections_jti_idx').on(t.jti),
  ]
);

/**
 * `mcp_auth_codes` — short-lived, single-use OAuth authorization codes.
 *
 * `used_at` is stamped on redemption and the token endpoint checks `expires_at`
 * explicitly, so a spent or stale row is inert by two independent guards. That
 * is what makes copying the collection during the cutover safe: a code that
 * cannot be redeemed twice and cannot be redeemed late costs nothing to carry,
 * while dropping the collection would fail a user whose code was issued in the
 * seconds before the freeze.
 *
 * There is no TTL index in Postgres, so the reaping Mongo did for free is now
 * an entry in `db/expiry.ts`. Without it this table grows forever — the TTL is
 * a behaviour of the source that does NOT survive the port on its own.
 */
export const mcpAuthCodes = pgTable(
  'mcp_auth_codes',
  {
    id: generatedId(),
    code: text().notNull(),
    clientId: text().notNull(),
    /** An Oxy account id — no foreign key. */
    oxyUserId: text().notNull(),
    redirectUri: text().notNull(),
    /** PKCE S256 challenge, base64url. Only S256 is accepted at the token endpoint. */
    codeChallenge: text().notNull(),
    scopes: text().array().notNull(),
    expiresAt: timestamptz().notNull(),
    usedAt: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [
    // The redemption lookup, and the single-use guarantee's first half.
    uniqueIndex('mcp_auth_codes_code_key').on(t.code),
    // Required by the expiry sweep: its predicate is a range scan on this column.
    index('mcp_auth_codes_expires_at_idx').on(t.expiresAt),
  ]
);

/**
 * `mcp_registered_clients` — dynamically registered OAuth clients (RFC 7591).
 *
 * Claude will not connect against a fixed pre-shared `client_id`, so
 * `POST /mcp/oauth/register` mints one of these: a PUBLIC client with no
 * secret, whose `redirect_uris` are validated HTTPS at registration and then
 * enforced byte-for-byte alongside PKCE at authorize and token time. There is
 * deliberately no secret column — adding one would invite storing a credential
 * the flow does not use.
 */
export const mcpRegisteredClients = pgTable(
  'mcp_registered_clients',
  {
    id: generatedId(),
    clientId: text().notNull(),
    redirectUris: text().array().notNull(),
    label: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('mcp_registered_clients_client_id_key').on(t.clientId)]
);

/** Row types, for the call sites being ported off Mongoose. */
export type McpConnectionRow = typeof mcpConnections.$inferSelect;
export type McpAuthCodeRow = typeof mcpAuthCodes.$inferSelect;
export type McpRegisteredClientRow = typeof mcpRegisteredClients.$inferSelect;
