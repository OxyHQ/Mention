/**
 * Following a TOPIC, through the user-owned follow graph.
 *
 * Two reads, split by how they scale.
 *
 * `useFollowedTopics` asks ONCE what the viewer already follows, in a paginated
 * sweep, and hands each answer to the SDK's own store as an `initialStatus`.
 * That is the case `useFollowTarget` documents the seed for — "a caller that
 * already knows the status … seeds it rather than making this hook re-ask once
 * per rendered row" — and without it a grid of twenty chips opens with twenty
 * status requests.
 *
 * `useTopicFollowTargetId` resolves ONE topic's target id, because following
 * takes a target id and never a URI: registration is the moment an application
 * vouches that a thing exists, and if following created targets a typo would
 * become a permanent row one person follows and nobody else can reach.
 *
 * Neither caches follow STATUS. React Query holds the URI→id mapping and the
 * seed; the SDK's store owns status from the moment it is seeded, which is what
 * keeps one authority for a value that is written and read in the same session.
 */

import { useQuery } from '@tanstack/react-query';
import type { FollowStatus } from '@oxyhq/contracts';
import { useAuth } from '@oxyhq/services/ui/client';
import { logger } from '@oxyhq/core/logger';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { OXY_TOPIC_KIND, topicFollowUri } from '@/services/followGraph';

/** What one already-followed topic contributes to the grid. */
export interface FollowedTopic {
  targetId: string;
  status: FollowStatus;
}

/**
 * A page is 100 and a person following more topics than this many pages has hit
 * something else. Bounded because a cursor that stops advancing is a hang, and a
 * settings screen is a bad place to discover that.
 */
const MAX_FOLLOW_PAGES = 20;
const FOLLOW_PAGE_SIZE = 100;

export interface FollowedTopicsResult {
  /** Keyed by canonical URI — the identity the graph resolves, not the slug. */
  byUri: Map<string, FollowedTopic>;
  /**
   * Whether the sweep completed. Until it has, a chip cannot tell "not followed"
   * from "not asked yet", and saying the first would offer to follow something
   * already followed.
   */
  isReady: boolean;
}

export function useFollowedTopics(): FollowedTopicsResult {
  const { user, oxyServices, canUsePrivateApi } = useAuth();

  const query = useQuery({
    queryKey: viewerQueryKeys.followedTopics(user?.id),
    queryFn: async () => {
      const byUri = new Map<string, FollowedTopic>();
      let cursor: string | undefined;
      for (let page = 0; page < MAX_FOLLOW_PAGES; page += 1) {
        const result = await oxyServices.listFollows({
          kind: OXY_TOPIC_KIND,
          limit: FOLLOW_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        });
        for (const record of result.follows) {
          byUri.set(record.target.uri, {
            targetId: record.target.id,
            // Rebuilt from the record rather than re-fetched. `effectiveState`
            // is the server's derivation and the one field a client must not
            // invent, so it is composed the way the server composes it: acting
            // here only when the follow is active AND not switched off here.
            status: {
              relationshipId: record.relationshipId,
              globalState: record.globalState,
              applicationMode: record.applicationMode,
              effectiveState:
                record.globalState === 'active' && record.applicationMode !== 'disabled'
                  ? 'following'
                  : record.globalState === 'requested'
                    ? 'requested'
                    : 'not_following',
              ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
            },
          });
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return byUri;
    },
    // Gated on `canUsePrivateApi`, not `isAuthenticated`: during the session
    // cold boot the second is true well before the first, and a read sent in
    // that window 401s.
    enabled: canUsePrivateApi,
    staleTime: 60 * 1000,
  });

  return { byUri: query.data ?? new Map(), isReady: query.isSuccess };
}

/**
 * One topic's target id, registering the target the first time anyone asks.
 *
 * `seededTargetId` short-circuits the request entirely for a topic the sweep
 * above already named — the id is right there on the record, so a chip the
 * viewer follows costs nothing.
 */
export function useTopicFollowTargetId(input: {
  slug: string | undefined;
  displayName?: string;
  icon?: string;
  seededTargetId?: string;
}): string | undefined {
  const { user, oxyServices, canUsePrivateApi } = useAuth();
  const uri = input.slug ? topicFollowUri(input.slug) : '';

  const query = useQuery({
    queryKey: viewerQueryKeys.followGraphTarget(user?.id, uri),
    queryFn: async () => {
      try {
        const resolved = await oxyServices.ensureFollowTarget({
          uri,
          kind: OXY_TOPIC_KIND,
          /*
           * The display snapshot a follow list elsewhere in the ecosystem
           * renders without one lookup per row. Only sent once a real name is
           * known — writing the bare slug in as a name would put
           * "climate_change" into every other application's rendering of this
           * topic.
           */
          ...(input.displayName
            ? {
                metadata: {
                  name: input.displayName,
                  slug: input.slug,
                  ...(input.icon ? { icon: input.icon } : {}),
                },
              }
            : {}),
        });
        return resolved.id;
      } catch (error) {
        logger.error('Failed to resolve a topic follow target', error, { uri });
        throw error;
      }
    },
    enabled: canUsePrivateApi && !input.seededTargetId && uri.length > 0,
    // Idempotent on the URI, answering with a row id that never changes.
    staleTime: Infinity,
  });

  return input.seededTargetId ?? query.data;
}
