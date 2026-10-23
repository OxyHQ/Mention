import { verifiedDownstreamRequester, type RequestSafetyContext } from './safetyRequester';
import { OxyServices } from '@oxy.so/core';
import type { OxyServer } from '@oxy.so/core/server';
import { ForegroundOxyProfileClient } from '../services/ForegroundOxyProfileClient';
import { extractBearerToken } from '@oxy.so/mcp';
import { OxyPrivacyUnavailableError, type OxyClient } from './privacyHelpers';
import { config } from '../config';
import { logger } from './logger';
import { getRuntimeOxyClient } from '../runtime/oxyClient';

const OXY_BASE_URL = config.oxyApiUrl;
const OXY_MCP_CONNECTION_VIEWER_GRAPH_PATH = '/auth/mcp/oauth/connections/viewer-graph';

/**
 * Create the Oxy client appropriate for the verified request identity.
 *
 * Normal Oxy sessions receive an isolated token-scoped client. MCP requests
 * MUST NOT plant the resource-bound MCP bearer into OxyServices; instead they
 * present their original connection proof to the shared authority. Capability
 * requests use the original live ticket; neither proof is planted as a session.
 */
export function createScopedOxyClient(req: RequestSafetyContext): OxyClient | undefined {
  if (req.capability) {
    if (!req.capability.ticket || !req.capability.claims?.resource?.effectiveAccountId) {
      throw new Error('Verified capability requester proof is missing');
    }
    return getServiceOxyClient().withRequester({ capabilityTicket: req.capability.ticket });
  }
  if (req.serviceApp)
    return getServiceOxyClient().withRequester({
      requesterContext: verifiedDownstreamRequester(req),
    });
  const delegatedUserId = req.mcp?.activeUserId?.trim();
  if (req.mcp) {
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
export function createUserScopedOxyServices(
  req: RequestSafetyContext,
  options: { requestTimeout?: number } = {},
): OxyServices | undefined {
  if (req.mcp || req.capability || req.serviceApp) return undefined;
  const token = req.accessToken || extractBearerToken(req.headers ?? {});
  if (!token) return undefined;
  const client = new OxyServices({ baseURL: OXY_BASE_URL, ...options });
  client.session.setAccessToken(token);
  return client;
}

/** Already verified HTTP request only; an MCP or attribution proof is not a session. */
export function createForegroundOxyProfileClient(
  req: RequestSafetyContext,
): ForegroundOxyProfileClient | undefined {
  if (!req.user || req.mcp || req.capability || req.serviceApp) return undefined;
  const token = req.accessToken;
  const configuration = process.env.MENTION_OXY_FOREGROUND_CATALOG_BINDING;
  if (!token || !configuration) throw new Error('FOREGROUND_RANKING_NOT_CONFIGURED');
  if (!req.oxyActor || req.oxyActor.effectiveAccountId !== req.user.id)
    throw new Error('FOREGROUND_REQUESTER_REQUIRED');
  let binding: unknown;
  try {
    binding = JSON.parse(configuration);
  } catch {
    throw new Error('FOREGROUND_CATALOG_INVALID');
  }
  return new ForegroundOxyProfileClient(
    getServiceOxyClient(),
    token,
    req.user.id,
    binding,
    req.oxyActor.actorAccountId,
  );
}

/** Own service operations share the process workload identity, never a customer key. */
export function getServiceOxyClient(): OxyServer {
  return getRuntimeOxyClient();
}

function unwrapDataEnvelope(value: unknown): unknown {
  if (value && typeof value === 'object' && 'data' in value) {
    return (value as { data?: unknown }).data;
  }
  return value;
}

interface DelegatedViewerGraph {
  followingIds?: unknown;
  mutualIds?: unknown;
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
  key: 'blockedIds' | 'restrictedIds' | 'mutualIds',
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
            new Error(
              'Oxy answered the viewer graph of a different account than this request serves',
            ),
            { code: 'MCP_CONNECTION_ACCOUNT_MISMATCH' },
          );
        }
        return body.graph as DelegatedViewerGraph;
      });
    return connectionGraph;
  };

  const delegationRefused = (): Promise<never> =>
    Promise.reject(
      Object.assign(
        new Error('Viewer graph requires the existing central OAuth connection proof'),
        { code: 'SERVICE_DELEGATION_NOT_AUTHORIZED' },
      ),
    );

  const viewerGraph = (): Promise<unknown> => {
    if (connectionToken) return readConnectionGraph(connectionToken);
    return delegationRefused();
  };

  const privacyList = async (listType: 'blocked' | 'restricted'): Promise<unknown[]> => {
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
      // The connection graph carries the served account's mutuals; without the
      // connection proof there is no viewer to read them for.
      async mutualIds(params?: { limit?: number }): Promise<string[]> {
        if (!connectionToken) return delegationRefused();
        const ids = connectionGraphIds(await readConnectionGraph(connectionToken), 'mutualIds');
        return params?.limit === undefined ? ids : ids.slice(0, params.limit);
      },
      // Oxy has no connection-proof read of the two-hop walk.
      followsOfFollowsIds(): Promise<string[]> {
        return delegationRefused();
      },
    },
  };
}

/** Select the SDK proof lane from already verified HTTP context, never an owner header. */
export function requesterFiles(
  req: RequestSafetyContext,
  tool: 'upload-media' | 'upload-media-from-url',
) {
  const accountId = req.user?.id;
  if (!accountId) throw new Error('Verified media account is missing');
  const assets = getServiceOxyClient().assets;
  if (req.mcp) {
    const connectionToken = extractBearerToken(req.headers ?? {});
    if (!connectionToken || req.mcp.activeUserId !== accountId)
      throw new Error('Verified media connection proof is missing');
    return assets.withMcpMediaRequester({ connectionToken, accountId, tool });
  }
  if (req.capability) {
    if (!req.capability.ticket || req.capability.claims?.resource?.effectiveAccountId !== accountId)
      throw new Error('Verified media capability proof is missing');
    return assets.withRequester({ capabilityTicket: req.capability.ticket, accountId });
  }
  if (req.serviceApp)
    return assets.withRequester({ requesterContext: verifiedDownstreamRequester(req), accountId });
  if (!req.accessToken) throw new Error('Verified media session proof is missing');
  return assets.withRequester({ requesterToken: req.accessToken });
}

export interface ServiceUserMediaUploadResult {
  fileId: string;
  contentType: string;
}
/** Public post media retains the original account and operation proof at Oxy Files. */
export async function uploadServiceUserMedia(params: {
  requester: RequestSafetyContext;
  ownerUserId: string;
  buffer: Buffer;
  contentType: string;
  fileName: string;
}): Promise<ServiceUserMediaUploadResult> {
  if (params.requester.user?.id !== params.ownerUserId) throw new Error('Media account mismatch');
  const file = await requesterFiles(params.requester, 'upload-media').uploadUserMedia(
    params.ownerUserId,
    new Uint8Array(params.buffer),
    params.contentType,
    { originalName: params.fileName, visibility: 'public' },
  );
  return { fileId: file.id, contentType: params.contentType };
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
