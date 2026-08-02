/**
 * `mcp_auth_codes` — issue, look up and CLAIM an OAuth authorization code.
 *
 * The whole module is about {@link claimAuthCode}. Mongo made a code single-use
 * with `findOneAndUpdate({ _id, usedAt: null }, { usedAt: now })` — one atomic
 * statement whose "matched nothing" answer IS the "already redeemed" verdict.
 * Ported as a `select` followed by an `update` it stops being atomic, and the
 * false answer points toward PERMISSION rather than silence: two requests
 * racing on one code both read `used_at IS NULL`, both redeem it, and one
 * authorization grant becomes two token families.
 *
 * So the claim is a single conditional UPDATE with `used_at IS NULL` in the
 * WHERE, and the number of rows it returns is the guarantee. Never split it.
 *
 * There is no TTL index in Postgres — Mongo reaped these rows for free and that
 * behaviour does NOT survive the port on its own. `db/expiry.ts` carries the
 * replacement; the explicit `expires_at` check at the token endpoint is the
 * independent second guard that makes a stale row inert regardless.
 */

import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../postgres';
import { mcpAuthCodes, type McpAuthCodeRow } from '../schema/mcp';

/** Fields a new authorization code supplies; `used_at` starts NULL. */
export interface NewMcpAuthCode {
  code: string;
  clientId: string;
  oxyUserId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  expiresAt: Date;
}

/** Issue an authorization code. */
export async function createAuthCode(values: NewMcpAuthCode): Promise<McpAuthCodeRow> {
  const [row] = await getDb().insert(mcpAuthCodes).values(values).returning();
  return row;
}

/**
 * The row for one code, spent or expired or neither.
 *
 * The caller checks `used_at` and `expires_at` itself and answers
 * `invalid_grant` to every failure, so narrowing this query would only make the
 * distinctions unavailable — not the answer safer.
 */
export async function findAuthCodeByCode(code: string): Promise<McpAuthCodeRow | null> {
  const [row] = await getDb()
    .select()
    .from(mcpAuthCodes)
    .where(eq(mcpAuthCodes.code, code))
    .limit(1);
  return row ?? null;
}

/**
 * Stamp `used_at` on a code that has not been redeemed yet.
 *
 * ONE statement. `used_at IS NULL` lives in the WHERE precisely so the database
 * decides the race, and the returned row count is the answer.
 *
 * @returns `true` when this call is the one that redeemed the code; `false`
 *   when it was already spent — which the caller must treat as a rejection,
 *   never as a retry.
 */
export async function claimAuthCode(id: string): Promise<boolean> {
  const claimed = await getDb()
    .update(mcpAuthCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(mcpAuthCodes.id, id), isNull(mcpAuthCodes.usedAt)))
    .returning({ id: mcpAuthCodes.id });
  return claimed.length > 0;
}
