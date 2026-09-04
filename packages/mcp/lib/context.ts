/**
 * Request-scoped context using AsyncLocalStorage.
 *
 * Allows the HTTP transport layer to set a per-request user token
 * that the API client picks up automatically — no need to thread
 * tokens through every tool handler.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** The resource-bound credential forwarded only to Mention's own backend. */
  userToken?: string;
  authMode?: "central" | "legacy" | "capability";
  authorizationScheme?: "Bearer" | "Capability";
  /** OAuth token/client identity used only to bind transport state and effects. */
  tokenId?: string;
  clientId?: string;
  accountId?: string;
  scopes: ReadonlySet<string>;
  /** Present only while one effectful tool invocation is running. */
  idempotencyKey?: string;
  toolName?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
