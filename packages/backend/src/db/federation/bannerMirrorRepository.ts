/**
 * Writes to `federated_banner_mirrors` from the actor-resolve path. The sweep
 * that drains it lives in `services/federatedBannerMirror.ts` (it imports the
 * mirror in `connectors/identity.ts`, which imports this — kept apart so the two
 * modules do not import each other).
 */

import { sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { federatedBannerMirrors } from '../schema/federation';
import { isAbsoluteHttpUrl } from '../../connectors/shared/url';
import { logger } from '../../utils/logger';

/**
 * Record the banner a federated account's source advertises. Writes only when
 * the URL is NEW or CHANGED (a changed URL re-arms the row at once, resetting
 * its backoff); an unchanged one is left alone, mirrored or backing off.
 * Returns whether a mirror is now owed.
 */
export async function recordFederatedBanner(
  input: { oxyUserId: string; actorUri: string; bannerUrl: string },
  db: DatabaseOrTransaction = getDb(),
): Promise<boolean> {
  if (!input.oxyUserId || !isAbsoluteHttpUrl(input.bannerUrl)) return false;
  const written = await db
    .insert(federatedBannerMirrors)
    .values({ oxyUserId: input.oxyUserId, actorUri: input.actorUri, sourceUrl: input.bannerUrl })
    .onConflictDoUpdate({
      target: federatedBannerMirrors.oxyUserId,
      set: {
        actorUri: input.actorUri,
        sourceUrl: input.bannerUrl,
        state: 'pending',
        attempts: 0,
        retryAt: sql`now()`,
        lastFailure: null,
        updatedAt: new Date(),
      },
      setWhere: sql`${federatedBannerMirrors.sourceUrl} is distinct from excluded.source_url`,
    })
    .returning({ oxyUserId: federatedBannerMirrors.oxyUserId });
  return written.length > 0;
}

/**
 * Record, without waiting and without ever failing the caller: the actor
 * resolve path must not slow down or fail because the banner bookkeeping did.
 */
export function recordFederatedBannerInBackground(input: { oxyUserId: string; actorUri: string; bannerUrl?: string }): void {
  if (!input.bannerUrl) return;
  void recordFederatedBanner({ ...input, bannerUrl: input.bannerUrl }).catch((error: unknown) => {
    logger.debug('[BannerMirror] could not record a federated banner', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
}

