import { PostVisibility } from '@mention/shared-types';
import { isUniqueViolation } from '@oxy.so/db';
import type { FederationImportReason } from '../../db/schema/federationImports';
import { bumpPostCounters, loadPostRecord } from '../../db/posts/postRepository';
import { getPostCreator } from '../../services/serviceRegistry';
import { logger } from '../../utils/logger';
import { upstreamPostKey } from './upstreamPostKey';

/**
 * Store a federated boost — an ActivityPub `Announce`, a Bluesky repost — as a
 * native boost Post attributed to the booster, mirroring the native repost shape
 * (`type: 'boost'`, `boostOf: <local original id>`, empty content).
 *
 * The caller has already resolved the booster to a real, listable Oxy user and
 * the original to a LOCAL post id; this refuses an original that is not
 * published and public. Idempotent on `activityId` (the boost's own identity on
 * its network, held by the unique `federation.activityId` index) and on its
 * upstream key (a Bluesky repost reached natively and through Bridgy Fed is one
 * repost): a duplicate is `false`, not an error. The original's `boostsCount` and `federatedBoostsCount`
 * move +1 in lockstep only when a new boost Post is created — this is the ONLY
 * site a federated boost becomes a boost count, so `boostsCount -
 * federatedBoostsCount` isolates the native ones.
 *
 * @returns true when a new boost Post was created.
 */
export async function createFederatedBoost(input: {
  activityId: string;
  originalPostId: string;
  boosterOxyUserId: string;
  actorUri?: string;
  url?: string;
  importReason?: FederationImportReason;
  /** When the BOOST happened; the embedded original keeps its own date. */
  createdAt?: Date;
}): Promise<boolean> {
  const originalPost = await loadPostRecord(input.originalPostId);
  if (originalPost?.status !== 'published' || originalPost.visibility !== PostVisibility.PUBLIC) {
    logger.info('[Federation] skipped non-public or unpublished boost');
    return false;
  }

  try {
    await getPostCreator().create({
      oxyUserId: input.boosterOxyUserId,
      boostOf: input.originalPostId,
      // A boost carries no content of its own — mirror native reposts which
      // store an empty content body and rely on `boostOf` for hydration.
      content: { text: '' },
      visibility: PostVisibility.PUBLIC,
      federation: {
        activityId: input.activityId,
        ...(input.importReason ? { importReason: input.importReason } : {}),
        actorUri: input.actorUri,
        url: input.url ?? input.activityId,
        sourcePostKey: upstreamPostKey(input.activityId),
      },
      status: 'published',
      skipNotifications: true,
      skipSocketEmit: true,
      skipFederationDelivery: true,
      ...(input.createdAt ? { createdAt: input.createdAt, updatedAt: input.createdAt } : {}),
    });
  } catch (err) {
    // A unique violation means a concurrent import already created the
    // boost — treat as already-imported, not a failure.
    if (isUniqueViolation(err)) return false;
    logger.warn('[Federation] failed to create boost', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }

  await bumpPostCounters(input.originalPostId, { boosts: 1, federatedBoosts: 1 });
  return true;
}
