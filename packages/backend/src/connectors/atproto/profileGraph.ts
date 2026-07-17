import { logger } from '../../utils/logger';
import { syncActorStarterPacks } from './starterpack.mapper';
import { syncActorFeeds } from './feedgen.mapper';

/**
 * Sync an atproto actor's PROFILE GRAPH extras — its starter packs (functional
 * mirror) and its feed-generator references (read-only) — in one call.
 *
 * This is the single entry point shared by the live sync-on-view path
 * (`federatedProfileSync`) and the one-shot backfill (`syncBlueskyStarterPacks`),
 * so both discover the same extras through one code path — mirroring how post
 * backfill is the single discovery path for a profile's posts.
 *
 * `ownerOxyUserId` must already be resolved (the no-orphan invariant — the caller
 * resolves the profile first). Each half is independently best-effort and never
 * throws, so one failing does not skip the other; the whole call is fail-soft.
 */
export async function syncAtprotoProfileGraph(did: string, ownerOxyUserId: string): Promise<void> {
  const [packs, feeds] = await Promise.allSettled([
    syncActorStarterPacks(did, ownerOxyUserId),
    syncActorFeeds(did, ownerOxyUserId),
  ]);

  if (packs.status === 'rejected') {
    const message = packs.reason instanceof Error ? packs.reason.message : String(packs.reason);
    logger.warn(`[atproto] starter-pack sync threw for ${did}: ${message}`);
  }
  if (feeds.status === 'rejected') {
    const message = feeds.reason instanceof Error ? feeds.reason.message : String(feeds.reason);
    logger.warn(`[atproto] feed-reference sync threw for ${did}: ${message}`);
  }
}
