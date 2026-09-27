import type { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  mcpPrincipalMatchesFingerprint,
  type AuthenticatedMcpToken,
} from "./http-security.js";

/**
 * The open legacy SSE sessions of THIS process.
 *
 * Only the deprecated `/sse` + `/messages` transport needs one: its response
 * stream lives in the task that accepted `GET /sse`, and each `POST /messages`
 * must reach that same task. Streamable HTTP at `/mcp` is stateless and never
 * registers here.
 *
 * Keeping transport and principal binding behind one API prevents
 * partially-deleted sessions and makes account isolation an invariant rather
 * than a convention spread across the HTTP router. A session is removed when
 * its stream closes, so there is no idle sweep.
 */
export class McpSessionRegistry {
  readonly #transports = new Map<string, SSEServerTransport>();
  readonly #principalFingerprints = new Map<string, string>();

  get size(): number {
    return this.#transports.size;
  }

  get(id: string): SSEServerTransport | undefined {
    return this.#transports.get(id);
  }

  has(id: string): boolean {
    return this.#transports.has(id);
  }

  register(
    id: string,
    transport: SSEServerTransport,
    principalFingerprint: string,
  ): void {
    this.#transports.set(id, transport);
    this.#principalFingerprints.set(id, principalFingerprint);
  }

  isAuthorized(id: string, claims: AuthenticatedMcpToken): boolean {
    return mcpPrincipalMatchesFingerprint(
      claims,
      this.#principalFingerprints.get(id),
    );
  }

  delete(id: string): void {
    this.#transports.delete(id);
    this.#principalFingerprints.delete(id);
  }

  async closeAll(): Promise<void> {
    const entries = Array.from(this.#transports.entries());
    for (const [id] of entries) this.delete(id);
    await Promise.allSettled(
      entries.map(([, transport]) => Promise.resolve(transport.close())),
    );
  }
}
