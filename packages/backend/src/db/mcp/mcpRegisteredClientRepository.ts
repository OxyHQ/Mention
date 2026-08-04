/**
 * `mcp_registered_clients` — RFC 7591 dynamically-registered OAuth clients.
 *
 * Claude will not connect against a pre-shared `client_id`, so it registers
 * itself here and the resulting row is what the authorize and token endpoints
 * validate its `redirect_uri` against. There is no secret column and no lookup
 * that returns one: these are PUBLIC clients, and PKCE plus the byte-for-byte
 * redirect allowlist carry the security.
 *
 * `client_id` deliberately carries no foreign key anywhere else in the schema —
 * a client may instead be STATICALLY configured (`mcp/config/mcpClients.ts`)
 * with no row here at all, so a key pointing at this table would refuse every
 * connection made by a configured client while looking like correct referential
 * hygiene.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../postgres';
import { mcpRegisteredClients, type McpRegisteredClientRow } from '../schema/mcp';

/** Persist a newly-registered public client. */
export async function createRegisteredClient(values: {
  clientId: string;
  redirectUris: string[];
  label: string;
}): Promise<McpRegisteredClientRow> {
  const [row] = await getDb().insert(mcpRegisteredClients).values(values).returning();
  return row;
}

/** One registered client by its `client_id`, or `null` when unknown. */
export async function findRegisteredClient(
  clientId: string
): Promise<McpRegisteredClientRow | null> {
  const [row] = await getDb()
    .select()
    .from(mcpRegisteredClients)
    .where(eq(mcpRegisteredClients.clientId, clientId))
    .limit(1);
  return row ?? null;
}
