/**
 * Durable mirroring of federated account banners.
 *
 * WHY THIS EXISTS. Mirroring a remote banner into Oxy used to run inline on
 * every actor resolve, best-effort, with nothing remembering the outcome. When
 * resolution moved to Oxy's identity authority (#994) that call went with it,
 * and from then on no new federated account got a banner at all. A banner that
 * failed for a reason that passes (a 503, a timeout, Oxy's upload budget) was
 * never retried either.
 *
 * NOW:
 *  - an actor resolve RECORDS the banner URL its source advertises
 *    (`recordFederatedBanner`, `db/federation/bannerMirrorRepository.ts`): one row per Oxy user in
 *    `federated_banner_mirrors`, written only when the URL is new or changed;
 *  - a periodic sweep ({@link runFederatedBannerMirrors}) mirrors due rows
 *    through `mirrorFederatedBanner` (magic-byte sniffing, re-encoding of an
 *    oversized or animated banner — see `services/mediaCache/cacheWorker.ts`);
 *  - a failure is NEVER final: a transient one retries at 5 min x 3^n (up to
 *    6 h), and a banner whose bytes are not a usable image retries once a day,
 *    so a host that fixes its banner — or a fix on our side — recovers it.
 */

import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { getDb } from '../db/postgres';
import { federatedBannerMirrors } from '../db/schema/federation';
import { mirrorFederatedBanner, type MirrorBannerResult } from '../connectors/identity';
import { isMediaCacheEnabled } from './mediaCache/oxyMediaStore';
import { logger } from '../utils/logger';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** First transient retry; each further failure multiplies it by {@link TRANSIENT_BACKOFF_FACTOR}. */
export const TRANSIENT_BACKOFF_BASE_MS = 5 * MINUTE_MS;
const TRANSIENT_BACKOFF_FACTOR = 3;
/** Longest wait between transient retries. */
export const TRANSIENT_BACKOFF_MAX_MS = 6 * HOUR_MS;
/** Wait before re-trying a banner whose bytes were not a usable image. */
export const PERMANENT_RETRY_MS = 24 * HOUR_MS;
/** Default deferral when Oxy's budget refusal names no wait: one budget window. */
const BUDGET_DEFER_MS = MINUTE_MS;
/** A sweep's claim on a row; a crashed sweep's rows are due again after it. */
const LEASE_MS = 15 * MINUTE_MS;

/** Rows mirrored per sweep, and how many at once. */
export const BANNER_SWEEP_BATCH = 50;
const BANNER_SWEEP_CONCURRENCY = 4;

/** The delay before the next attempt, after `attempts` failures (already incremented). */
export function bannerRetryDelayMs(attempts: number, permanent: boolean): number {
  if (permanent) return PERMANENT_RETRY_MS;
  const exponent = Math.max(0, attempts - 1);
  return Math.min(
    TRANSIENT_BACKOFF_BASE_MS * TRANSIENT_BACKOFF_FACTOR ** exponent,
    TRANSIENT_BACKOFF_MAX_MS,
  );
}

type ClaimedRow = { oxyUserId: string; actorUri: string; sourceUrl: string; attempts: number };

/** Claim up to `limit` due rows (skipping rows another sweep holds). */
async function claimDueBanners(limit: number): Promise<ClaimedRow[]> {
  const due = getDb()
    .select({ oxyUserId: federatedBannerMirrors.oxyUserId })
    .from(federatedBannerMirrors)
    .where(
      and(
        sql`${federatedBannerMirrors.state} <> 'mirrored'`,
        sql`${federatedBannerMirrors.retryAt} <= now()`,
        or(
          isNull(federatedBannerMirrors.leaseUntil),
          lt(federatedBannerMirrors.leaseUntil, sql`now()`),
        ),
      ),
    )
    .orderBy(asc(federatedBannerMirrors.retryAt))
    .limit(limit)
    .for('update', { skipLocked: true });
  return getDb()
    .update(federatedBannerMirrors)
    .set({ leaseUntil: sql`now() + ${`${LEASE_MS} milliseconds`}::interval` })
    .where(inArray(federatedBannerMirrors.oxyUserId, due))
    .returning({
      oxyUserId: federatedBannerMirrors.oxyUserId,
      actorUri: federatedBannerMirrors.actorUri,
      sourceUrl: federatedBannerMirrors.sourceUrl,
      attempts: federatedBannerMirrors.attempts,
    });
}

/** Settle one claimed row — unless its URL changed meanwhile (then the new URL is due as recorded). */
async function settle(row: ClaimedRow, result: MirrorBannerResult): Promise<void> {
  const sameUrl = and(
    eq(federatedBannerMirrors.oxyUserId, row.oxyUserId),
    eq(federatedBannerMirrors.sourceUrl, row.sourceUrl),
  );
  if (result.reason === 'budget-spent') {
    // Oxy's write budget is spent for the window: the banner was not tried, so
    // no attempt is counted and the row is due when the window reopens.
    await getDb()
      .update(federatedBannerMirrors)
      .set({
        leaseUntil: null,
        retryAt: sql`now() + ${`${result.retryAfterMs ?? BUDGET_DEFER_MS} milliseconds`}::interval`,
        updatedAt: new Date(),
      })
      .where(sameUrl);
    return;
  }
  if (result.ok) {
    await getDb()
      .update(federatedBannerMirrors)
      .set({
        state: 'mirrored',
        attempts: 0,
        leaseUntil: null,
        lastFailure: null,
        mirroredAt: sql`now()`,
        updatedAt: new Date(),
      })
      .where(sameUrl);
    return;
  }
  const attempts = row.attempts + 1;
  const delay = bannerRetryDelayMs(attempts, result.permanent);
  await getDb()
    .update(federatedBannerMirrors)
    .set({
      state: 'failed',
      attempts,
      leaseUntil: null,
      lastFailure: (result.reason ?? 'unknown').slice(0, 120),
      retryAt: sql`now() + ${`${delay} milliseconds`}::interval`,
      updatedAt: new Date(),
    })
    .where(sameUrl);
}

export interface BannerSweepResult {
  claimed: number;
  mirrored: number;
  failed: number;
  /** Failures by reason (`not-media`, `upstream-error:503`, …). */
  byReason: Record<string, number>;
}

/**
 * Mirror the due banners. A no-op while media writes are off: a sweep that
 * cannot upload would only burn every row's attempts.
 */
export async function runFederatedBannerMirrors(
  options: { limit?: number; concurrency?: number } = {},
): Promise<BannerSweepResult> {
  const result: BannerSweepResult = { claimed: 0, mirrored: 0, failed: 0, byReason: {} };
  if (!isMediaCacheEnabled()) return result;
  const rows = await claimDueBanners(options.limit ?? BANNER_SWEEP_BATCH);
  result.claimed = rows.length;

  // Once Oxy's budget is spent, no worker starts another mirror (each would
  // download a remote image only to be refused): the rest are deferred unclaimed.
  let next = 0;
  let budgetSpent = false;
  const worker = async (): Promise<void> => {
    while (next < rows.length && !budgetSpent) {
      const row = rows[next];
      next += 1;
      const outcome = await mirrorFederatedBanner(row.sourceUrl, row.oxyUserId, row.actorUri);
      await settle(row, outcome);
      if (outcome.ok) {
        result.mirrored += 1;
      } else {
        if (outcome.reason === 'budget-spent') budgetSpent = true;
        result.failed += 1;
        const reason = outcome.reason ?? 'unknown';
        result.byReason[reason] = (result.byReason[reason] ?? 0) + 1;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(options.concurrency ?? BANNER_SWEEP_CONCURRENCY, rows.length) },
      worker,
    ),
  );
  // Rows claimed but never started go back to due now, not after their lease.
  const unstarted = rows.slice(next).map((row) => row.oxyUserId);
  if (unstarted.length > 0) {
    await getDb()
      .update(federatedBannerMirrors)
      .set({ leaseUntil: null })
      .where(inArray(federatedBannerMirrors.oxyUserId, unstarted));
  }

  if (result.claimed > 0) logger.info('[BannerMirror] sweep', { ...result });
  return result;
}
