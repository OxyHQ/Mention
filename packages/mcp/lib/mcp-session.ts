import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

/**
 * The `Mcp-Session-Id` of a stateless Streamable HTTP server.
 *
 * The server keeps nothing per session, yet it still ISSUES a session id on
 * `initialize` and requires it afterwards, for one reason: effect idempotency.
 * A mutating tool's key is derived from the JSON-RPC request id, and clients
 * number requests per connection, starting again at 0 or 1 on every new one. A
 * connector that opens a second connection with the same access token would
 * otherwise send a genuinely new `create-post` with the same request id as an
 * earlier one, and the API would refuse it as a duplicate. The session id keeps
 * two connections' request ids apart, exactly as the in-memory transport's id
 * did — and since it is the same header, keys do not change across the deploy.
 *
 * The id is an opaque random value, never looked up, so any task accepts any
 * id, including one issued by a task that no longer exists. It carries no
 * authority: every request is authorized by its own bearer token, and the
 * idempotency key also binds the account and OAuth client, so a leaked id only
 * ever names a namespace inside its holder's own grant.
 */
export type McpSessionResolution =
  | { readonly ok: true; readonly id: string; readonly issued: boolean }
  | { readonly ok: false; readonly message: string };

/** Visible ASCII only, as the MCP specification requires of a session id. */
const SESSION_ID_PATTERN = /^[\x21-\x7e]{1,128}$/;

export function resolveMcpSession(
  body: unknown,
  header: string | string[] | undefined,
  generateId: () => string = randomUUID,
): McpSessionResolution {
  const messages = Array.isArray(body) ? body : [body];
  if (messages.some((message) => isInitializeRequest(message))) {
    // A fresh id even when the client presents an old one: re-initializing
    // starts a new connection whose request ids start again.
    return { ok: true, id: generateId(), issued: true };
  }

  const presented = Array.isArray(header) ? header[0] : header;
  if (!presented) {
    return {
      ok: false,
      message: 'Bad Request: Mcp-Session-Id header is required. Send an initialize request first.',
    };
  }
  if (!SESSION_ID_PATTERN.test(presented)) {
    return { ok: false, message: 'Bad Request: Invalid Mcp-Session-Id header.' };
  }
  return { ok: true, id: presented, issued: false };
}
