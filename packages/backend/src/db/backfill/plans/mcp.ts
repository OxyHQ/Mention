/**
 * The MCP OAuth surface: `mcpconnections`, `mcpauthcodes`, `mcpregisteredclients`.
 *
 * These three were invisible to every code-derived inventory of this migration,
 * and the reason is worth keeping because it generalises: their models live in
 * `src/mcp/models/`, and every model walker written for the port enumerated
 * `src/models/`. A DIRECTORY is an enumeration and it fails exactly like a
 * name-based grep — silently, with a shorter list. `db.listCollections()`
 * against production is what found them.
 *
 * ## `mcpconnections` is thirteen rows and the highest-stakes table here
 *
 * It is the bundle graph every linked Claude account resolves through
 * (`mcp/middleware/mcpAuth.ts`). Losing those rows signs every MCP user out
 * with no way back: Claude allows one connector per URL, so recovery is the
 * whole OAuth flow again for each account. Nothing in this file may be
 * prioritised by row count.
 *
 * ## The bundle invariant is a PARTIAL unique index, and the transform must not
 * dedupe against it
 *
 * `(bundle_id, oxy_user_id)` is unique only `WHERE revoked_at IS NULL` — one
 * LIVE connection per (bundle, account), with any number of revoked rows kept
 * as history. So unlike every member junction in this migration, duplicates
 * here are LEGAL and must be copied: a user who revoked and re-linked has two
 * rows for the same pair and exactly one of them is live. Deduping would delete
 * the audit trail of a revocation, and deduping on the wrong one would delete
 * the live connection.
 *
 * ## `mcpauthcodes` is copied on purpose, and the asymmetry is one-sided
 *
 * They are single-use codes with a short TTL, so the case for skipping them is
 * that most are meaningless within minutes. The case for copying is that a code
 * issued in the seconds before the freeze cannot be redeemed after it, and the
 * user sees a failed connection for a reason nothing explains. Copying costs
 * nothing in exchange: `used_at` makes redemption single-use and the token
 * endpoint checks `expires_at` explicitly, so a spent or stale row that lands
 * in Postgres is inert by the same two guards that govern a live one.
 *
 * One consequence does NOT come along with the rows: Mongo reaped these with a
 * TTL index and Postgres has none, so the table is registered in `db/expiry.ts`.
 * Without that entry the copy is correct and the table grows forever.
 *
 * ## Nothing here reconstructs a credential
 *
 * `refresh_token_hash` is a SHA-256 digest and the refresh token itself was
 * never stored; `code_challenge` is a PKCE S256 challenge, not a verifier. Both
 * are copied as opaque strings. A transform that tried to normalise either
 * would be rewriting a value whose only job is to compare equal to something
 * computed elsewhere.
 */

import { mcpAuthCodes, mcpConnections, mcpRegisteredClients } from '../../schema/mcp';
import type { CollectionPlan } from '../plan';
import { buildRow } from '../rowBuilder';
import { bool, date, ownId, reqDate, reqStr, str, strArray } from '../values';
import { createdOnly } from './timestamps';

/** `mcpconnections` → `mcp_connections`. One row IS one refresh-token family. */
const mcpConnectionsPlan: CollectionPlan = {
  collection: 'mcpconnections',
  table: mcpConnections,
  uniquenessAudits: [
    {
      // Mongo declared this unique too, so a collision means the index was
      // missing or built after the duplicates — and here it would be fatal
      // rather than cosmetic: two live connections for one (bundle, account)
      // make which one a refresh resolves depend on document order.
      index: 'mcp_connections_refresh_token_hash_key',
      key: [{ path: 'refreshTokenHash', normalize: 'exact' }],
    },
    {
      // The PARTIAL one. Its predicate is `revoked_at is null`, so the audit has
      // to ask the same narrower question — a revoked duplicate is legal and
      // reporting it would be a false positive on the ordinary revoke-and-
      // re-link path.
      index: 'mcp_connections_bundle_id_oxy_user_id_key',
      key: [
        { path: 'bundleId', normalize: 'exact' },
        { path: 'oxyUserId', normalize: 'exact' },
      ],
      where: { revokedAt: null },
    },
  ],
  transform: (doc, emit) => {
    const connectionId = ownId(doc);
    emit(
      mcpConnections,
      buildRow(
        mcpConnections,
        {
          id: connectionId,
          oxyUserId: reqStr(doc, 'oxyUserId'),
          clientId: reqStr(doc, 'clientId'),
          clientLabel: reqStr(doc, 'clientLabel'),
          scopes: strArray(doc, 'scopes') ?? [],
          // NULLABLE: connections written before bundles existed carry none, and
          // inventing one would make unrelated connections look linked.
          bundleId: str(doc, 'bundleId'),
          isBundlePrimary: bool(doc, 'isBundlePrimary') ?? false,
          activeOxyUserId: str(doc, 'activeOxyUserId'),
          // Opaque by design — a SHA-256 digest whose only job is to compare
          // equal to one computed at refresh time.
          refreshTokenHash: reqStr(doc, 'refreshTokenHash'),
          jti: reqStr(doc, 'jti'),
          lastUsedAt: date(doc, 'lastUsedAt'),
          // The field that says this connection is HISTORY rather than live, and
          // the predicate of the partial unique index. Copying it wrong in
          // either direction is the difference between a revoked connection
          // coming back to life and a live one disappearing.
          revokedAt: date(doc, 'revokedAt'),
          ...createdOnly(doc),
        },
        connectionId
      )
    );
  },
};

/** `mcpauthcodes` → `mcp_auth_codes`. Copied deliberately — see the docblock. */
const mcpAuthCodesPlan: CollectionPlan = {
  collection: 'mcpauthcodes',
  table: mcpAuthCodes,
  uniquenessAudits: [
    { index: 'mcp_auth_codes_code_key', key: [{ path: 'code', normalize: 'exact' }] },
  ],
  transform: (doc, emit) => {
    const codeId = ownId(doc);
    emit(
      mcpAuthCodes,
      buildRow(
        mcpAuthCodes,
        {
          id: codeId,
          code: reqStr(doc, 'code'),
          clientId: reqStr(doc, 'clientId'),
          oxyUserId: reqStr(doc, 'oxyUserId'),
          // Enforced byte-for-byte at the token endpoint, so it is copied
          // verbatim: a normalised URI (a trailing slash added or removed) would
          // stop matching the client's registered value and fail every
          // redemption for that client.
          redirectUri: reqStr(doc, 'redirectUri'),
          codeChallenge: reqStr(doc, 'codeChallenge'),
          scopes: strArray(doc, 'scopes') ?? [],
          // `NOT NULL` with no default and no substitute: this column IS the
          // deadline the token endpoint checks and the expiry sweep reads. An
          // invented one would either resurrect a dead code or reap a live one.
          expiresAt: reqDate(doc, 'expiresAt'),
          // Half of the single-use guarantee. NULL means unredeemed, which is a
          // different claim from any timestamp.
          usedAt: date(doc, 'usedAt'),
          ...createdOnly(doc),
        },
        codeId
      )
    );
  },
};

/** `mcpregisteredclients` → `mcp_registered_clients`. RFC 7591 dynamic clients. */
const mcpRegisteredClientsPlan: CollectionPlan = {
  collection: 'mcpregisteredclients',
  table: mcpRegisteredClients,
  uniquenessAudits: [
    {
      index: 'mcp_registered_clients_client_id_key',
      key: [{ path: 'clientId', normalize: 'exact' }],
    },
  ],
  transform: (doc, emit) => {
    const clientRowId = ownId(doc);
    emit(
      mcpRegisteredClients,
      buildRow(
        mcpRegisteredClients,
        {
          id: clientRowId,
          clientId: reqStr(doc, 'clientId'),
          // The allowlist enforced byte-for-byte alongside PKCE at authorize and
          // token time. Copied verbatim for the same reason as `redirectUri`
          // above — normalising one silently un-registers a live client.
          redirectUris: strArray(doc, 'redirectUris') ?? [],
          label: reqStr(doc, 'label'),
          ...createdOnly(doc),
        },
        clientRowId
      )
    );
  },
};

/** Every MCP plan. */
export const MCP_PLANS: readonly CollectionPlan[] = [
  mcpConnectionsPlan,
  mcpAuthCodesPlan,
  mcpRegisteredClientsPlan,
];
