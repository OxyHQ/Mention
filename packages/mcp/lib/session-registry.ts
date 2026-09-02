import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpPrincipalMatchesFingerprint,
  type AuthenticatedMcpToken,
} from "./http-security.js";

export type McpHttpTransport =
  | StreamableHTTPServerTransport
  | SSEServerTransport;

/**
 * Owns all state associated with an MCP transport session.
 *
 * Keeping transport, activity and principal bindings behind one API prevents
 * partially-deleted sessions and makes account isolation an invariant rather
 * than a convention spread across the HTTP router.
 */
export class McpSessionRegistry {
  readonly #transports = new Map<string, McpHttpTransport>();
  readonly #lastActivity = new Map<string, number>();
  readonly #principalFingerprints = new Map<string, string>();

  get size(): number {
    return this.#transports.size;
  }

  get(id: string): McpHttpTransport | undefined {
    return this.#transports.get(id);
  }

  has(id: string): boolean {
    return this.#transports.has(id);
  }

  register(
    id: string,
    transport: McpHttpTransport,
    principalFingerprint: string,
    now = Date.now(),
  ): void {
    this.#transports.set(id, transport);
    this.#lastActivity.set(id, now);
    this.#principalFingerprints.set(id, principalFingerprint);
  }

  touch(id: string, now = Date.now()): void {
    if (this.#transports.has(id)) {
      this.#lastActivity.set(id, now);
    }
  }

  isAuthorized(id: string, claims: AuthenticatedMcpToken): boolean {
    return mcpPrincipalMatchesFingerprint(
      claims,
      this.#principalFingerprints.get(id),
    );
  }

  delete(id: string): void {
    this.#transports.delete(id);
    this.#lastActivity.delete(id);
    this.#principalFingerprints.delete(id);
  }

  cleanupIdle(now: number, idleTimeoutMs: number): number {
    let cleaned = 0;
    for (const [id, transport] of this.#transports) {
      // Legacy SSE sessions are tied directly to their response stream and are
      // removed by its `close` event.
      if (transport instanceof SSEServerTransport) continue;
      const lastActivity = this.#lastActivity.get(id) ?? 0;
      if (now - lastActivity <= idleTimeoutMs) continue;

      void transport.close().catch(() => {});
      this.delete(id);
      cleaned++;
    }
    return cleaned;
  }

  async closeAll(): Promise<void> {
    const entries = Array.from(this.#transports.entries());
    for (const [id] of entries) this.delete(id);
    await Promise.allSettled(
      entries.map(([, transport]) => Promise.resolve(transport.close())),
    );
  }
}
