import { OxyServices } from '@oxy.so/core';
import { OxyServer } from '@oxy.so/core/server';
import { ForegroundOxyProfileClient } from '../services/ForegroundOxyProfileClient';
import { extractBearerToken } from '@oxy.so/mcp';
import { OxyPrivacyUnavailableError, type OxyClient } from './privacyHelpers';
import {
  config,
  getOxyServiceCredentials,
} from '../config';
import { logger } from './logger';
import { canAuthenticateAsService } from '../runtime/serviceIdentity';
import { instrumentOxyEgress, measureOxyFetch } from './oxyMetrics';

const OXY_BASE_URL = config.oxyApiUrl;
const OXY_MCP_CONNECTION_VIEWER_GRAPH_PATH = '/auth/mcp/oauth/connections/viewer-graph';

interface ScopedOxyRequest {
  user?: { id: string } | null;
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
 * use Mention's service credential delegated to the already-verified served
 * account via `X-Oxy-User-Id`. An MCP request also hands its token to the
 * delegated client, which presents it to Oxy — as proof, never as a session —
 * for the served account's privacy lists. A capability request has no such
 * proof, so its privacy reads fail closed.
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
    const connectionToken = req.mcp ? extractBearerToken(req.headers ?? {}) : undefined;
    return createServiceDelegatedOxyClient(delegatedUserId, connectionToken ?? undefined);
  }

  const token = req.accessToken || extractBearerToken(req.headers ?? {});
  if (!token) return undefined;
  const client = new OxyServices({ baseURL: OXY_BASE_URL });
  client.session.setAccessToken(token);
  return client;
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
  client.session.setAccessToken(token);
  return client;
}

/** Already verified HTTP request only; an MCP or attribution proof is not a session. */
export function createForegroundOxyProfileClient(req: ScopedOxyRequest): ForegroundOxyProfileClient | undefined {
  if (!req.user || req.mcp || req.capability) return undefined;
  const token = req.accessToken;
  const configuration = process.env.MENTION_OXY_FOREGROUND_CATALOG_BINDING;
  if (!token || !configuration) throw new Error('FOREGROUND_RANKING_NOT_CONFIGURED');
  let binding: unknown;
  try { binding = JSON.parse(configuration); } catch { throw new Error('FOREGROUND_CATALOG_INVALID'); }
  return new ForegroundOxyProfileClient(getServiceOxyClient(), token, req.user.id, binding);
}

/**
 * Module-level singleton OxyServer instance authenticated with the rotating
 * service credential.
 * Used for server-side operations on behalf of the system (e.g. resolving federated actors).
 */
const serviceClient: OxyServer = (() => {
  const { apiKey, apiSecret } = getOxyServiceCredentials();
  // `serviceIdentity`: the SDK's ordinary reads on this client (everything that
  // is not `serviceRequest`) carry the service token too, rather than going
  // out anonymous and sharing the NAT address's per-IP budget (#1173).
  const client = new OxyServer({
    baseURL: OXY_BASE_URL,
    serviceIdentity: 'when-anonymous',
    ...(apiKey && apiSecret ? { serviceAuth: { apiKey, apiSecret } } : {}),
  });

  if (!apiKey || !apiSecret) {
    if (canAuthenticateAsService()) {
      /**
       * Not a warning, and not "unauthenticated".
       *
       * With no key pair the SDK attests this process's task role instead and
       * mints the same service token (oxy ADR 0026). The old line said the client
       * would be unauthenticated, which was true when the only identity was a
       * secret and became false the day the deployment stopped carrying one — and
       * a warning that says a working deployment is broken is how somebody ends up
       * putting the credential back.
       */
      logger.info('[oxyHelpers] no service key pair; the Oxy client attests this task role instead');
    } else {
      logger.warn(
        '[oxyHelpers] no Oxy service identity: neither a key pair nor an attestable task role. Calls needing one will fail.',
      );
    }
  }
  // The first Oxy client this process builds, and the only install point
  // needed: `instrumentOxyEgress` patches the shared `HttpService` PROTOTYPE, so
  // every instance built before or after — including the two constructed per
  // request — is covered without threading anything through their call sites.
  instrumentOxyEgress(client);
  return client;
})();

export function getServiceOxyClient(): OxyServer {
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

interface DelegatedViewerGraph {
  followingIds?: unknown;
  blockedIds?: unknown;
  restrictedIds?: unknown;
}

/**
 * Read one bounded id list off the graph Oxy returned for the served account.
 * A missing or non-array list is an error, never an empty result: treating it
 * as "no blocks/restrictions" would disclose the accounts the viewer hid.
 */
function connectionGraphIds(
  graph: DelegatedViewerGraph,
  key: 'blockedIds' | 'restrictedIds',
): string[] {
  const ids = graph[key];
  if (!Array.isArray(ids)) {
    throw new Error(`Oxy connection viewer graph is missing ${key}`);
  }
  return ids.filter((id): id is string => typeof id === 'string' && id.length > 0);
}

/**
 * Privacy/graph client for an MCP bundle member or a capability-assigned
 * account. Every read is made with Mention's service credential; the incoming
 * token is never installed as an Oxy session.
 *
 * BLOCKS AND RESTRICTIONS. Oxy answers `GET /users/me/graph` with the EMPTY
 * graph for any service-token caller, by design: its viewer is a bare
 * `X-Oxy-User-Id` header, and blocks and restrictions are private. Reading the
 * privacy lists off that 200 said "this viewer blocks nobody", the fail-OPEN
 * `getUserIdsFromPrivacyList` exists to prevent.
 *
 * A CENTRAL MCP request can prove more than a header can: its connector's live
 * access token. `POST /auth/mcp/oauth/connections/viewer-graph` takes that token
 * as proof (only for a resource Mention registered) and answers the graph of
 * the account the connection is serving, chosen by Oxy. The answer is refused
 * unless that account is the one this request serves: Oxy's choice and ours
 * must agree, or the lists would filter some other account's view.
 *
 * Without such a token (a legacy MCP token, a capability ticket), there is still
 * no way to resolve the lists, so the two privacy reads refuse with
 * `SERVICE_DELEGATION_NOT_AUTHORIZED`: fail closed.
 *
 * The follow ids are NOT a privacy decision: a caller that cannot resolve them
 * degrades its ranking, which every graph read here already soft-fails to.
 */
function createServiceDelegatedOxyClient(viewerId: string, connectionToken?: string): OxyClient {
  const client = getServiceOxyClient();

  let connectionGraph: Promise<DelegatedViewerGraph> | undefined;
  const readConnectionGraph = (token: string): Promise<DelegatedViewerGraph> => {
    connectionGraph ??= client
      .serviceRequest<unknown>('POST', OXY_MCP_CONNECTION_VIEWER_GRAPH_PATH, { token })
      .then((response) => {
        const body = unwrapDataEnvelope(response) as
          | { account_id?: unknown; graph?: unknown }
          | null
          | undefined;
        if (!body || typeof body !== 'object' || !body.graph || typeof body.graph !== 'object') {
          throw new Error('Oxy connection viewer graph response is malformed');
        }
        if (body.account_id !== viewerId) {
          throw Object.assign(
            new Error('Oxy answered the viewer graph of a different account than this request serves'),
            { code: 'MCP_CONNECTION_ACCOUNT_MISMATCH' },
          );
        }
        return body.graph as DelegatedViewerGraph;
      });
    return connectionGraph;
  };

  const viewerGraph = (): Promise<unknown> => {
    if (connectionToken) return readConnectionGraph(connectionToken);
    return Promise.reject(Object.assign(
      new Error('Viewer graph requires the existing central OAuth connection proof'),
      { code: 'SERVICE_DELEGATION_NOT_AUTHORIZED' },
    ));
  };

  const privacyList = async (
    listType: 'blocked' | 'restricted',
  ): Promise<unknown[]> => {
    if (!connectionToken) {
      throw new OxyPrivacyUnavailableError(listType, {
        code: 'SERVICE_DELEGATION_NOT_AUTHORIZED',
      });
    }
    const graph = await readConnectionGraph(connectionToken);
    return listType === 'blocked'
      ? connectionGraphIds(graph, 'blockedIds').map((blockedId) => ({ blockedId }))
      : connectionGraphIds(graph, 'restrictedIds').map((restrictedId) => ({ restrictedId }));
  };

  return {
    privacy: {
      blocked(): Promise<unknown[]> {
        return privacyList('blocked');
      },
      restricted(): Promise<unknown[]> {
        return privacyList('restricted');
      },
    },
    follows: {
      // The graph object itself, never the `{ data }` envelope the raw service
      // request carries, so the shape matches OxyServices.follows.viewerGraph.
      viewerGraph(): Promise<unknown> {
        return viewerGraph();
      },
      following(userId: string): Promise<unknown> {
        return client.follows.following(userId);
      },
      followers(userId: string): Promise<unknown> {
        return client.follows.followers(userId);
      },
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
  const token = await client.serviceToken();
  const baseUrl = client.baseURL.replace(/\/+$/, '');
  const url = `${baseUrl}${OXY_ASSET_USER_MEDIA_PATH}`;

  const response = await measureOxyFetch('POST', OXY_ASSET_USER_MEDIA_PATH, () => fetch(url, {
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
  }));

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
    client.session.setAccessToken(accessToken);
    await client.assets.setVisibility(fileId, 'public');
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
