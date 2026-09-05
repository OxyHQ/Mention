import { OxyServices } from '@oxyhq/core';
import { extractBearerToken } from '@oxyhq/mcp';
import type { OxyClient } from './privacyHelpers';
import {
  config,
  getOxyServiceCredentials,
} from '../config';
import { logger } from './logger';
import { instrumentOxyEgress } from './oxyMetrics';

const OXY_BASE_URL = config.oxyApiUrl;
const OXY_VIEWER_GRAPH_PATH = '/users/me/graph';

interface ScopedOxyRequest {
  accessToken?: string;
  headers?: { authorization?: string | readonly string[] };
  mcp?: { activeUserId?: string };
  capability?: { claims?: { resource?: { effectiveAccountId?: string } } };
}

/**
 * Create the Oxy client appropriate for the verified request identity.
 *
 * Normal Oxy sessions receive an isolated token-scoped client. MCP requests
 * MUST NOT plant the resource-bound MCP bearer into OxyServices; instead they
 * use Mention's service credential delegated to the already-verified active
 * bundle account via `X-Oxy-User-Id`.
 */
export function createScopedOxyClient(req: ScopedOxyRequest): OxyClient | undefined {
  const delegatedUserId = (
    req.mcp?.activeUserId
    ?? req.capability?.claims?.resource?.effectiveAccountId
  )?.trim();
  if (req.mcp || req.capability) {
    if (!delegatedUserId) {
      throw new Error('Verified delegated request is missing its effective Oxy account');
    }
    return createServiceDelegatedOxyClient(delegatedUserId);
  }

  const token = req.accessToken || extractBearerToken(req.headers ?? {});
  if (!token) return undefined;
  const client = new OxyServices({ baseURL: OXY_BASE_URL });
  client.setTokens(token);
  return client as unknown as OxyClient;
}

/**
 * A full `OxyServices` scoped to the caller's OWN verified bearer, for the Oxy
 * endpoints that are authorized against the authenticated USER and honour no
 * service-token delegation — today, the account-graph membership read behind
 * `publishAsOxyUserId` (`GET /accounts/:id/members`).
 *
 * Deliberately NOT {@link createScopedOxyClient}: that one narrows to the
 * privacy-graph surface and, for an MCP request, answers with a SERVICE-delegated
 * client. A service credential cannot read that route at all, so an MCP caller
 * gets `undefined` here and the publish-as gate refuses — which is the correct
 * answer, not a gap.
 *
 * A fresh instance per request, so the SDK's own GET cache is empty: an
 * authorization decision must never be served from another caller's cached
 * membership list.
 */
export function createUserScopedOxyServices(req: ScopedOxyRequest): OxyServices | undefined {
  if (req.mcp || req.capability) return undefined;
  const token = req.accessToken || extractBearerToken(req.headers ?? {});
  if (!token) return undefined;
  const client = new OxyServices({ baseURL: OXY_BASE_URL });
  client.setTokens(token);
  return client;
}

/**
 * Module-level singleton OxyServices instance authenticated with the rotating
 * service credential.
 * Used for server-side operations on behalf of the system (e.g. resolving federated actors).
 */
const serviceClient: OxyServices = (() => {
  const client = new OxyServices({ baseURL: OXY_BASE_URL });

  const { apiKey, apiSecret } = getOxyServiceCredentials();
  if (apiKey && apiSecret) {
    client.configureServiceAuth(apiKey, apiSecret);
  } else {
    logger.warn('[oxyHelpers] OXY_SERVICE_API_KEY/SECRET is not set; service client will be unauthenticated');
  }
  // The first `OxyServices` this process builds, and the only install point
  // needed: `instrumentOxyEgress` patches the shared `HttpService` PROTOTYPE, so
  // every instance built before or after — including the two constructed per
  // request — is covered without threading anything through their call sites.
  instrumentOxyEgress(client);
  return client;
})();

export function getServiceOxyClient(): OxyServices {
  return serviceClient;
}

function unwrapDataEnvelope(value: unknown): unknown {
  if (
    value &&
    typeof value === 'object' &&
    'data' in value
  ) {
    return (value as { data?: unknown }).data;
  }
  return value;
}

/**
 * Read one bounded id list off the delegated viewer graph. A missing or
 * non-array list is an error, never an empty result: treating it as "no
 * blocks/restrictions" would disclose the accounts the viewer hid.
 */
function delegatedGraphIds(response: unknown, key: 'blockedIds' | 'restrictedIds'): string[] {
  const graph = unwrapDataEnvelope(response);
  if (!graph || typeof graph !== 'object') {
    throw new Error('Oxy delegated viewer graph response is malformed');
  }
  const ids = (graph as Record<string, unknown>)[key];
  if (!Array.isArray(ids)) {
    throw new Error(`Oxy delegated viewer graph is missing ${key}`);
  }
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Privacy/graph client for an MCP bundle member. Every private read is made
 * with Mention's service credential and an explicit, server-verified viewer id;
 * the incoming MCP token never leaves Mention.
 */
function createServiceDelegatedOxyClient(viewerId: string): OxyClient {
  const client = getServiceOxyClient();
  // Blocks, restrictions and the following list all come off the viewer graph,
  // and the callers run in the same `Promise.all`, so the request is made once
  // and shared. The per-user privacy routes are user-token only, and a delegated
  // caller has no user token — the graph endpoint is the one that accepts a
  // service credential with an explicit viewer.
  let graph: Promise<unknown> | undefined;
  const viewerGraph = (): Promise<unknown> => {
    graph ??= client.makeServiceRequest('GET', OXY_VIEWER_GRAPH_PATH, undefined, viewerId);
    return graph;
  };

  return {
    async getBlockedUsers(): Promise<unknown[]> {
      const ids = delegatedGraphIds(await viewerGraph(), 'blockedIds');
      return ids.map((blockedId) => ({ blockedId }));
    },
    async getRestrictedUsers(): Promise<unknown[]> {
      const ids = delegatedGraphIds(await viewerGraph(), 'restrictedIds');
      return ids.map((restrictedId) => ({ restrictedId }));
    },
    // Unwrapped so the delegated shape matches what OxyServices.getViewerGraph
    // returns for a session-scoped client: the graph object itself, never the
    // `{ data }` envelope the raw service request carries.
    async getViewerGraph(): Promise<unknown> {
      return unwrapDataEnvelope(await viewerGraph());
    },
    getUserFollowing(userId: string): Promise<unknown> {
      return client.getUserFollowing(userId);
    },
    getUserFollowers(userId: string): Promise<unknown> {
      return client.getUserFollowers(userId);
    },
  };
}

const OXY_ASSET_USER_MEDIA_PATH = '/assets/service/user-media';

export interface ServiceUserMediaUploadResult {
  fileId: string;
  contentType: string;
}

/**
 * Upload media bytes to Oxy as a durable public asset owned by a local user,
 * using the Mention service credential. Used when the caller authenticated with
 * an MCP JWT (no Oxy session bearer).
 */
export async function uploadServiceUserMedia(params: {
  ownerUserId: string;
  buffer: Buffer;
  contentType: string;
  fileName: string;
}): Promise<ServiceUserMediaUploadResult> {
  const client = getServiceOxyClient();
  const token = await client.getServiceToken();
  const baseUrl = client.getBaseURL().replace(/\/+$/, '');
  const url = `${baseUrl}${OXY_ASSET_USER_MEDIA_PATH}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': params.contentType,
      'Content-Length': String(params.buffer.length),
      'x-owner-user-id': params.ownerUserId,
      'x-original-name': encodeURIComponent(params.fileName),
      Accept: 'application/json',
    },
    body: new Uint8Array(params.buffer),
  });

  const rawText = await response.text();
  if (!response.ok) {
    let detail = '';
    try {
      const errBody = JSON.parse(rawText) as { message?: string; error?: string };
      detail = errBody.message || errBody.error || '';
    } catch {
      detail = rawText;
    }
    throw new Error(detail || `Oxy user-media upload failed (${response.status})`);
  }

  const body = JSON.parse(rawText) as { data?: { file?: { id?: string } } };
  const fileId = body.data?.file?.id;
  if (typeof fileId !== 'string' || fileId.length === 0) {
    throw new Error('Oxy user-media upload response missing file id');
  }

  return { fileId, contentType: params.contentType };
}

/**
 * Promote an Oxy asset that a user has set as public-facing profile media
 * (e.g. the Mention profile banner) to `public` visibility, so it renders for
 * anonymous viewers.
 *
 * Why this is needed: profile media is displayed by a bare `<img>`/`Image`,
 * which cannot send an Authorization header or a signed token. A private Oxy
 * asset requested anonymously is denied (403 on `/assets/:id/stream`, 404 on
 * the public CDN), so the banner never renders — not even for the owner.
 * Oxy already does this for avatars/banners owned via `PUT /users/me`
 * (`assetService.ensureOwnedAssetPublic`), but the Mention banner is a
 * Mention-only field that never flows through that endpoint, so Mention must
 * promote it itself.
 *
 * Auth path: Oxy's `PATCH /assets/:id/visibility` requires a session-based
 * user bearer token and enforces `file.ownerUserId === req.user._id`. A service
 * token (no `sessionId`) is rejected by that route, so this MUST use the
 * owner's own access token — which is exactly the token on the authenticated
 * profile-settings request. Building a scoped client (never mutating the
 * singleton) keeps it race-safe under concurrent requests.
 *
 * Best-effort and owner-gated by Oxy: it skips empty/temp/absolute refs, never
 * throws, and never blocks the profile update. A non-owner or already-public
 * asset is a no-op on the Oxy side.
 *
 * @param accessToken - The authenticated owner's Oxy session bearer token.
 * @param fileId - The Oxy file id just persisted as profile media.
 */
export async function ensureProfileMediaPublic(
  accessToken: string | undefined,
  fileId: string,
): Promise<void> {
  if (!accessToken) return;
  // Only bare Oxy file ids are promotable. Skip empties, client-side temp ids,
  // and absolute URLs (federated/external media has no Oxy visibility flag).
  if (!fileId || fileId.startsWith('temp-') || /^https?:\/\//i.test(fileId)) return;

  try {
    const client = new OxyServices({ baseURL: OXY_BASE_URL });
    client.setTokens(accessToken);
    await client.assetUpdateVisibility(fileId, 'public');
    logger.info('[oxyHelpers] Promoted profile media asset to public', { fileId });
  } catch (error) {
    // Non-fatal: a failed visibility flip must never block the profile update.
    // Ownership/already-public cases are handled on the Oxy side; log the rest.
    logger.warn('[oxyHelpers] Failed to promote profile media asset to public', {
      fileId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Mention's Oxy `Application` `_id`. Sent as `clientId` on
 * `POST /profiles/recommendations` so Oxy selects Mention's per-app weight
 * profile when scoring recommendations (`REC_SCORING_V2`). When unset the Oxy
 * endpoint falls back to its default weight profile, so the value is optional
 * and the recommendation adapter simply omits `clientId` rather than failing.
 *
 * Provisioned separately from the service credential. Keep production
 * credential identifiers and secret storage locations out of repository docs.
 */
export function getMentionOxyClientId(): string | undefined {
  return config.identity.mentionOxyClientId;
}
