/**
 * The catalogue this process serves, registered with Oxy by the process itself.
 *
 * Oxy upserts a registration on (appId, version, digest), so registering the
 * same catalogue again returns the same registration. That makes the running
 * code the ONE source of the internal MCP's catalogue binding: the version and
 * digest are this catalogue's, and the registration id is the one Oxy holds for
 * exactly these bytes. Before, the binding was an environment variable copied
 * by hand into the task definition — absent in production, so `/_oxy/mcp`
 * answered 503 to every Alia call — and the catalogue was registered by a
 * separate post-deploy task, two sources that a new catalogue version would
 * have split again.
 */
import type { CapabilityCatalogBinding } from '@oxy.so/contracts';
import type { OxyServer } from '@oxy.so/core/server';
import { registerCapabilityCatalog } from '@oxy.so/mcp';
import { MENTION_CAPABILITY_CATALOG } from './mention-catalog.js';

/** The shared workload transport registers exactly the catalogue this process serves. */
export async function registerMentionCatalog(input: {
  readonly oxy: Pick<OxyServer, 'createServiceClient'>;
  readonly oxyApiUrl: string;
}): Promise<CapabilityCatalogBinding> {
  const transport = input.oxy.createServiceClient({
    baseURL: input.oxyApiUrl,
    audience: 'oxy-api',
  });
  try {
    return await registerCapabilityCatalog(MENTION_CAPABILITY_CATALOG, {
      oxyApiUrl: input.oxyApiUrl,
      transport,
      timeoutMs: 15_000,
    });
  } finally {
    transport.dispose();
  }
}

/**
 * Describe whatever a registration failed on, in one line an operator can act on.
 *
 * `String(error)` was what it used to print, and the Oxy SDK rejects with a
 * PLAIN OBJECT (`{ message, code, status }`) rather than an `Error` — so every
 * failure reached the deploy log as the literal text `[object Object]`, and the
 * registration was undiagnosable from its own output. The status is the part that matters: a 429 is the shared
 * Oxy rate budget and a 401/403 is the service credential, and they need
 * opposite responses.
 */
export function describeRegistrationFailure(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error !== 'object' || error === null) return String(error);

  const fields = error as {
    message?: unknown;
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  const status =
    typeof fields.status === 'number'
      ? fields.status
      : typeof fields.statusCode === 'number'
        ? fields.statusCode
        : undefined;
  const parts = [
    typeof fields.message === 'string' && fields.message.length > 0 ? fields.message : undefined,
    status !== undefined ? `status=${status}` : undefined,
    typeof fields.code === 'string' && fields.code.length > 0 ? `code=${fields.code}` : undefined,
  ].filter((part): part is string => part !== undefined);

  // Never fall back to `[object Object]`: a shape nobody anticipated is still
  // worth its JSON, bounded so a large payload cannot flood the deploy log.
  if (parts.length === 0) {
    try {
      return JSON.stringify(error)?.slice(0, 500) ?? 'unknown failure';
    } catch {
      return 'unknown failure (unserializable)';
    }
  }
  return parts.join(' ');
}
