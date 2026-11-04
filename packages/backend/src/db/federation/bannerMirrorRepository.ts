/**
 * Writes to `federated_banner_mirrors` from the actor-upsert paths. The sweep
 * that drains it lives in `services/federatedBannerMirror.ts` (it imports the
 * mirror in `connectors/identity.ts`, which imports this — kept apart so the two
 * modules do not import each other).
 */

import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../postgres';
import { federatedBannerMirrors } from '../schema/federation';
import { userSettings } from '../schema/userProfile';
import { updateUserSettings } from '../userProfile/userSettingsRepository';
import { enqueueFederatedMediaDeletions } from './mediaDeletionRepository';
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
 * Forget the banner of a federated account whose source no longer advertises
 * one: drop its mirror row and clear `user_settings.profile_header_image`, queuing
 * the re-hosted file for deletion (the drain re-checks references first), as a
 * replaced banner is. A federated account's header is only ever the mirror's
 * write, so there is nothing of the account's own to keep. Returns whether a
 * stored banner was cleared.
 */
export async function clearFederatedBanner(oxyUserId: string): Promise<boolean> {
  if (!oxyUserId) return false;
  return getDb().transaction(async (tx) => {
    await tx.delete(federatedBannerMirrors).where(eq(federatedBannerMirrors.oxyUserId, oxyUserId));
    const [stored] = await tx
      .select({ banner: userSettings.profileHeaderImage })
      .from(userSettings)
      .where(and(eq(userSettings.oxyUserId, oxyUserId), isNotNull(userSettings.profileHeaderImage)))
      .for('update');
    if (!stored?.banner) return false;
    await updateUserSettings(oxyUserId, { unset: { profileHeaderImage: '' } }, tx);
    await enqueueFederatedMediaDeletions([stored.banner], tx);
    return true;
  });
}

/**
 * Bring the banner bookkeeping in line with what the source advertises on this
 * refresh: a URL is recorded for the sweep ({@link recordFederatedBanner}); no
 * URL means the account removed its banner ({@link clearFederatedBanner}).
 * `bannerUrl` must come from a full read of the source's profile, so its
 * absence is an answer rather than a gap.
 *
 * Never awaited and never fails the caller: the actor upsert must not slow down
 * or fail because the banner bookkeeping did.
 */
export function syncFederatedBannerInBackground(input: {
  oxyUserId: string;
  actorUri: string;
  bannerUrl?: string;
}): void {
  const write = input.bannerUrl
    ? recordFederatedBanner({ ...input, bannerUrl: input.bannerUrl })
    : clearFederatedBanner(input.oxyUserId);
  void write.catch((error: unknown) => {
    logger.debug('[BannerMirror] could not sync a federated banner', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  });
}
