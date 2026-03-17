/**
 * Request-scoped context using AsyncLocalStorage.
 *
 * Allows the HTTP transport layer to set a per-request user token
 * that the API client picks up automatically — no need to thread
 * tokens through every tool handler.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** The user's Oxy JWT, extracted from the incoming MCP request's Bearer token. */
  userToken?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();
