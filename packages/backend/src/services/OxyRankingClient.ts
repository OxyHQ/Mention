/**
 * OxyRankingClient — the SINGLE seam between Mention and the Oxy
 * `POST /profiles/recommendations` contract.
 *
 * Every recommendation read goes through here so the wire contract (request
 * body shape, `clientId`, viewer forwarding, response envelope, and the mapping
 * to Mention's frontend DTO) lives in exactly one place. If the Oxy contract
 * changes, only this file changes.
 *
 * Viewer identity (DUAL-AUTH):
 * ---------------------------
 * Recommendations are personalized by the viewer's mutual-connection overlap,
 * app signals, and the content-affinity `boosts` Mention supplies. Mention's
 * backend calls Oxy with a SERVICE token (it has no end-user session token to
 * forward server-side), passing the viewer's Oxy user id via the `X-Oxy-User-Id`
 * header (`makeServiceRequest(method, url, body, userId)`).
 *
 * The Oxy `POST /profiles/recommendations` endpoint authenticates with
 * `optionalUserOrServiceAuth` and resolves the personalization viewer via
 * `resolveViewerId`: a SERVICE principal that holds the viewer-delegation scope
 * (`user:read`, which Mention's service credential has) names the viewer through
 * `X-Oxy-User-Id`. So a service-token call WITH a forwarded viewer id is
 * personalized end to end — the forwarded id seeds the viewer's mutual-overlap
 * graph and the supplied content-affinity boosts join the candidate union. A
 * service credential WITHOUT `user:read`, or a call with no/invalid viewer id,
 * resolves to anonymous (popular-public fallback) — never an error.
 */

import type { UserNameResponse } from '@oxyhq/contracts';
import { getServiceOxyClient, getMentionOxyClientId } from '../utils/oxyHelpers';
import { resolveAvatarUrl } from '../utils/mediaResolver';
import { logger } from '../utils/logger';

/**
 * Wire shape of a single recommendation item as returned by Oxy's
 * `POST /profiles/recommendations`. The canonical recommendation/contract types
 * are NOT exported from the published `@oxyhq/contracts` (they live only in the
 * Oxy workspace), so the HTTP wire shape Mention consumes is declared locally
 * here. `name` reuses the published canonical {@link UserNameResponse} so the
 * display name stays the single-source-of-truth contract.
 */
interface OxyRecommendationItem {
  id?: string;
  _id?: string;
  username?: string;
  name?: UserNameResponse;
  avatar?: string | null;
  description?: string | null;
  verified?: boolean;
  trustTier?: string;
  mutualCount?: number;
  score?: number;
  matchedSignals?: string[];
  isFederated?: boolean;
  isAgent?: boolean;
  isAutomated?: boolean;
  instance?: string;
  _count?: { followers?: number; following?: number };
}

/** Oxy recommendation endpoint path (service-token call). */
const RECOMMENDATIONS_PATH = '/profiles/recommendations';

/** User types the caller may exclude from the recommendation surface. */
export type RecommendationExcludeType = 'federated' | 'agent' | 'automated';

/** Editorial boost forwarded verbatim to Oxy's scorer. */
export interface RecommendationBoostInput {
  userIds: string[];
  weight: number;
  reason?: string;
}

/** Normalized inputs for a single ranking request. */
export interface RankOptions {
  /** Oxy Application `_id` selecting the per-app weight profile. */
  clientId?: string;
  /** Viewer's Oxy user id, when authenticated (forwarded as `X-Oxy-User-Id`). */
  viewerId?: string;
  /** Page size (already validated/capped by the caller). */
  limit: number;
  /** Pagination offset. */
  offset?: number;
  /** Ids to exclude (blocked/muted/restricted + self + already-seen). */
  excludeIds?: string[];
  /** User types to exclude. */
  excludeTypes?: RecommendationExcludeType[];
  /** Editorial boosts. */
  boosts?: RecommendationBoostInput[];
}

/**
 * A single recommendation in Mention's frontend DTO shape. Mirrors the SDK's
 * `getProfileRecommendations` item plus the extra fields the frontend reads
 * (`avatar`). `name.displayName` is the canonical, server-resolved value — never
 * recomposed here.
 */
export interface RankedProfile {
  id: string;
  username?: string;
  name: UserNameResponse;
  avatar?: string;
  description?: string;
  verified: boolean;
  trustTier?: string;
  mutualCount: number;
  score?: number;
  matchedSignals?: string[];
  isFederated: boolean;
  isAgent: boolean;
  isAutomated: boolean;
  instance?: string;
  _count: {
    followers: number;
    following: number;
  };
}

/** JSON body sent to `POST /profiles/recommendations`. */
interface RecommendationRequestBody {
  clientId?: string;
  limit: number;
  offset?: number;
  excludeTypes?: RecommendationExcludeType[];
  excludeIds?: string[];
  boosts?: RecommendationBoostInput[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Unwrap the Oxy `sendSuccess` envelope (`{ data: [...] }`) into the raw item
 * array. Tolerates a bare array too (defensive — some SDK paths pre-unwrap).
 */
function extractItems(response: unknown): OxyRecommendationItem[] {
  if (Array.isArray(response)) return response as OxyRecommendationItem[];
  if (isRecord(response) && Array.isArray(response.data)) {
    return response.data as OxyRecommendationItem[];
  }
  return [];
}

/**
 * Map one raw Oxy recommendation item to Mention's frontend DTO. Resolves the
 * avatar to a final URL via the shared media resolver; passes `name` through
 * untouched so `name.displayName` stays canonical. Returns `null` for an item
 * with no usable id or no canonical display name so the caller can drop it.
 */
function toRankedProfile(raw: OxyRecommendationItem): RankedProfile | null {
  const id = typeof raw.id === 'string' && raw.id.length > 0
    ? raw.id
    : typeof raw._id === 'string' && raw._id.length > 0
      ? raw._id
      : '';
  if (!id) return null;

  const name = raw.name;
  if (!name || typeof name.displayName !== 'string' || name.displayName.length === 0) {
    // Without a canonical displayName the item violates the DTO contract; drop
    // it rather than synthesize a name client-side.
    return null;
  }

  const rawAvatar = typeof raw.avatar === 'string' ? raw.avatar : undefined;
  const count = raw._count ?? {};

  return {
    id,
    username: typeof raw.username === 'string' ? raw.username : undefined,
    name,
    avatar: resolveAvatarUrl(rawAvatar),
    description: typeof raw.description === 'string' ? raw.description : undefined,
    verified: raw.verified === true,
    trustTier: typeof raw.trustTier === 'string' ? raw.trustTier : undefined,
    mutualCount: typeof raw.mutualCount === 'number' ? raw.mutualCount : 0,
    ...(typeof raw.score === 'number' ? { score: raw.score } : {}),
    ...(Array.isArray(raw.matchedSignals)
      ? { matchedSignals: raw.matchedSignals.filter((s): s is string => typeof s === 'string') }
      : {}),
    isFederated: raw.isFederated === true,
    isAgent: raw.isAgent === true,
    isAutomated: raw.isAutomated === true,
    instance: typeof raw.instance === 'string' ? raw.instance : undefined,
    _count: {
      followers: typeof count.followers === 'number' ? count.followers : 0,
      following: typeof count.following === 'number' ? count.following : 0,
    },
  };
}

/**
 * Adapter over the Oxy recommendations endpoint. Stateless; safe to share.
 */
export class OxyRankingClient {
  /**
   * Rank profiles for a viewer. Builds the request body, forwards the viewer id
   * (when present) for personalization, calls Oxy with the service token, and
   * maps the response to Mention's frontend DTO. THROWS on transport/HTTP
   * failure — the RecommendationService owns the soft-fail policy.
   */
  async rank(options: RankOptions): Promise<RankedProfile[]> {
    const clientId = options.clientId ?? getMentionOxyClientId();

    const body: RecommendationRequestBody = {
      limit: options.limit,
    };
    if (clientId) body.clientId = clientId;
    if (typeof options.offset === 'number' && options.offset > 0) body.offset = options.offset;
    if (options.excludeTypes && options.excludeTypes.length > 0) body.excludeTypes = options.excludeTypes;
    if (options.excludeIds && options.excludeIds.length > 0) body.excludeIds = options.excludeIds;
    if (options.boosts && options.boosts.length > 0) body.boosts = options.boosts;

    const client = getServiceOxyClient();
    // `makeServiceRequest`'s 4th arg becomes the `X-Oxy-User-Id` header. Omitted
    // (undefined) for logged-out callers so no viewer is asserted.
    const response = await client.makeServiceRequest<
      OxyRecommendationItem[] | { data: OxyRecommendationItem[] }
    >(
      'POST',
      RECOMMENDATIONS_PATH,
      body,
      options.viewerId,
    );

    const items = extractItems(response);
    const mapped: RankedProfile[] = [];
    for (const item of items) {
      const profile = toRankedProfile(item);
      if (profile) mapped.push(profile);
    }

    logger.debug(
      `[OxyRankingClient] ranked ${mapped.length}/${items.length} profiles ` +
      `(viewer=${options.viewerId ?? 'anon'}, clientId=${clientId ?? 'default'})`,
    );

    return mapped;
  }
}

export const oxyRankingClient = new OxyRankingClient();
export default oxyRankingClient;
