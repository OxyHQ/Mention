/**
 * "Who to follow" recommendations — single source for the Mention backend
 * recommendations endpoint and the shared profile shape every surface renders.
 *
 * The endpoint is `GET /recommendations?limit&excludeTypes` (CSV) and is
 * optional-auth: it works logged-out (popular public profiles) and personalizes
 * via mutual-connection overlap when the viewer's bearer token is attached. The
 * app HTTP layer (`utils/api.ts`) already wraps `oxyServices.createLinkedClient`
 * so the viewer's auth + the `{ data }` unwrap come for free.
 */

import { api } from '@/utils/api';
import { getRecommendationFilters, type RecommendationFilters } from '@/lib/recommendationFilters';

/** A user type the recommendations endpoint can exclude via `excludeTypes`. */
export type RecommendationExcludeType = 'federated' | 'agent' | 'automated';

/**
 * A single recommended profile, as returned by `GET /recommendations`.
 *
 * Mirrors the element shape of the SDK's `getProfileRecommendations()` (id,
 * canonical `name.displayName`, optional federation/automation metadata,
 * `_count`) intersected with the extra fields `formatProfileResult` actually
 * returns (`avatar`, `bio`/`description`, `verified`). The index signature keeps
 * it assignable to the SDK cache-upsert helper (`upsertCachedUsers`, whose
 * `CacheableUser`) and to `enrichMissingAvatars`, and to the surfaces' card
 * shapes, without enumerating every passthrough field.
 */
export interface ProfileData {
  id: string;
  username?: string;
  name: {
    displayName: string;
    first?: string;
    last?: string;
    full?: string;
  };
  avatar?: string;
  bio?: string;
  description?: string;
  verified?: boolean;
  isFederated?: boolean;
  isAgent?: boolean;
  isAutomated?: boolean;
  instance?: string;
  federation?: {
    actorUri?: string;
    domain?: string;
    actorId?: string;
  };
  automation?: {
    ownerId?: string;
  };
  _count?: {
    followers: number;
    following: number;
  };
  [key: string]: unknown;
}

/**
 * One page of recommendations plus the cursor metadata the backend returns.
 * Paginate by echoing `nextCursor` back as the next request's `cursor`;
 * `hasMore === false` (⇒ `nextCursor === null`) means stop.
 */
export interface RecommendationsPage {
  recommendations: ProfileData[];
  /** Opaque cursor for the next page, or `null` when there are no more pages. */
  nextCursor: string | null;
  /** Offset of the next page (informational mirror of the cursor), or `null`. */
  nextOffset: number | null;
  hasMore: boolean;
}

interface RecommendationsResponse {
  recommendations?: ProfileData[];
  nextCursor?: string | null;
  nextOffset?: number | null;
  hasMore?: boolean;
}

/**
 * Map a {@link RecommendationFilters} object to the `excludeTypes` list the
 * endpoint accepts. The single, synchronous derivation shared by both the async
 * {@link resolveExcludeTypes} (which reads persisted filters) and the React
 * Query `useRecommendations` hook (which keys its cache on the derived CSV).
 */
export function deriveExcludeTypes(filters: RecommendationFilters): RecommendationExcludeType[] {
  const excludeTypes: RecommendationExcludeType[] = [];
  if (!filters.showFederated) excludeTypes.push('federated');
  if (!filters.showAgents) excludeTypes.push('agent');
  if (!filters.showAutomated) excludeTypes.push('automated');
  return excludeTypes;
}

/**
 * Derive the `excludeTypes` list from the viewer's persisted recommendation
 * filters. Centralized here so every surface shares the exact same derivation.
 */
async function resolveExcludeTypes(
  override?: RecommendationExcludeType[],
): Promise<RecommendationExcludeType[]> {
  if (override) return override;
  return deriveExcludeTypes(await getRecommendationFilters());
}

/**
 * Fetch one page of "who to follow" recommendations from the Mention backend.
 *
 * When `excludeTypes` is omitted, it is derived from the viewer's persisted
 * recommendation filters via {@link getRecommendationFilters}. Pass `cursor`
 * (the previous page's {@link RecommendationsPage.nextCursor}) to page forward.
 * The endpoint is public, so callers do not need to gate on `canUsePrivateApi`.
 */
export async function fetchRecommendationsPage(opts?: {
  excludeTypes?: RecommendationExcludeType[];
  limit?: number;
  cursor?: string;
}): Promise<RecommendationsPage> {
  const excludeTypes = await resolveExcludeTypes(opts?.excludeTypes);

  const params: Record<string, unknown> = {};
  if (excludeTypes.length > 0) params.excludeTypes = excludeTypes.join(',');
  if (typeof opts?.limit === 'number') params.limit = opts.limit;
  if (opts?.cursor) params.cursor = opts.cursor;

  const res = await api.get<RecommendationsResponse>('/recommendations', params);
  return {
    recommendations: res.data.recommendations ?? [],
    nextCursor: res.data.nextCursor ?? null,
    nextOffset: res.data.nextOffset ?? null,
    hasMore: res.data.hasMore ?? false,
  };
}
