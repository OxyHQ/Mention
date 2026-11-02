/**
 * Registers this deployment's local accounts with Oxy (OxyHQ/oxy ADR 0052), the
 * source of NodeInfo `usage.users.total` (#1748).
 *
 * Oxy accounts are global and a first-party session names no application, so Oxy
 * can only count the accounts a deployment says it provisioned. The population
 * here is every account with a `user_settings` row: one per user, created the
 * first time the account uses this deployment, whether or not it ever posted.
 * Oxy filters eligibility (local, personal, active, not closing) itself, at
 * registration and at every recount.
 *
 * ## Shape
 *
 * Leader-gated and bounded: each run registers at most {@link MAX_BATCHES_PER_RUN}
 * batches of {@link BATCH_SIZE} ids, walking `user_settings` by its unique
 * `oxy_user_id` index from a cursor kept in Redis. At the end of the table the
 * cursor wraps to the start, so the walk is a continuous cycle: a new account is
 * registered within one cycle, and a lost cursor merely restarts the walk because
 * registration is idempotent. No full-table scan, no per-user Oxy call.
 */
import { asc, gt } from 'drizzle-orm';
import { isRedisRuntimeConfigured } from '../config';
import { getDb } from '../db/postgres';
import { userSettings } from '../db/schema/userProfile';
import { getRuntimeOxyClient } from '../runtime/oxyClient';
import { createCache } from '../utils/cache';
import { logger } from '../utils/logger';

const BATCH_SIZE = 500; // the Oxy call's maximum
const MAX_BATCHES_PER_RUN = 20;
const RUN_INTERVAL_MS = 30 * 60 * 1000;
const START_DELAY_MS = 5 * 60 * 1000;
const CURSOR_KEY = 'oxy:application-accounts:cursor:v1';

const cursorCache = createCache({
  name: 'ApplicationAccountRegistrationCursor',
  ttlSeconds: 30 * 24 * 60 * 60,
});

/** One bounded pass. Exported for tests; never throws. */
export async function registerLocalAccountsOnce(): Promise<{
  registered: number;
  wrapped: boolean;
}> {
  let registered = 0;
  let scanned = 0;
  let batches = 0;
  try {
    let cursor = (await cursorCache.get<string>(CURSOR_KEY)) ?? '';
    for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
      const rows = await getDb()
        .select({ id: userSettings.oxyUserId })
        .from(userSettings)
        .where(gt(userSettings.oxyUserId, cursor))
        .orderBy(asc(userSettings.oxyUserId))
        .limit(BATCH_SIZE);
      if (rows.length === 0) {
        await cursorCache.set(CURSOR_KEY, '');
        logger.info('[ApplicationAccountRegistration] pass wrapped', {
          scanned,
          registered,
          batches,
        });
        return { registered, wrapped: true };
      }
      scanned += rows.length;
      batches += 1;
      registered += await getRuntimeOxyClient().registerApplicationAccounts(
        rows.map((row) => row.id),
      );
      cursor = rows[rows.length - 1].id;
      // Advanced only after Oxy accepted the batch: a failure retries it.
      await cursorCache.set(CURSOR_KEY, cursor);
    }
  } catch (error) {
    logger.warn('[ApplicationAccountRegistration] pass failed; it resumes from the cursor', error);
    return { registered, wrapped: false };
  }
  logger.info('[ApplicationAccountRegistration] pass done', { scanned, registered, batches });
  return { registered, wrapped: false };
}

export class ApplicationAccountRegistrationJob {
  private interval: ReturnType<typeof setInterval> | null = null;
  private startTimeout: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  start(): void {
    if (this.interval || this.startTimeout) return;
    if (!isRedisRuntimeConfigured()) {
      logger.info(
        '[ApplicationAccountRegistration] REDIS_URL not set — disabled (no cursor store)',
      );
      return;
    }
    this.startTimeout = setTimeout(() => {
      this.startTimeout = null;
      void this.tick();
      this.interval = setInterval(() => void this.tick(), RUN_INTERVAL_MS);
      this.interval.unref?.();
    }, START_DELAY_MS);
    this.startTimeout.unref?.();
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.startTimeout) clearTimeout(this.startTimeout);
    this.interval = null;
    this.startTimeout = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await registerLocalAccountsOnce();
    } finally {
      this.running = false;
    }
  }
}

export const applicationAccountRegistrationJob = new ApplicationAccountRegistrationJob();
