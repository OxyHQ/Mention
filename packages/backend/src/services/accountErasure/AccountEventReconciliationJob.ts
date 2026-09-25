/**
 * THE SAFETY NET under the webhook: read Oxy's account-event feed on a timer, and
 * re-run any erasure that did not finish.
 *
 * A webhook is at-least-once from Oxy's side, but Mention can still miss one: a
 * deploy during the retry window, a bug in the route, Oxy giving up after its
 * dead-letter limit. The pull feed (`GET /account-events?after=`) holds every
 * event addressed to Mention, so reading it forward from a durable cursor catches
 * anything the push path lost. Overlap with the push path is normal and harmless:
 * both dedupe on the event id.
 *
 * LEADER-GATED: started from `startSchedulers` (`runtime/schedulers.ts`), which
 * only the task holding the Redis leadership lock runs, so the feed is read by one
 * task at a time. `inFlight` keeps one tick from overlapping the next.
 *
 * WHAT MOVES THE CURSOR. Only a page whose every event was recorded. A failure to
 * reach Oxy, or a failure to record, leaves the cursor where it was and the next
 * tick re-reads the same page. A token Oxy's own feed serves that fails
 * verification is REFUSED (logged, counted) and skipped, because it can never
 * verify on a retry and would otherwise pin the cursor forever. A failure that is
 * not a refusal (the key set could not be fetched) stops the tick without moving.
 *
 * NEVER INFERS. This reads signed events only. It never asks Oxy whether a profile
 * exists, and a 404 is not a deletion.
 */

import { logger } from '../../utils/logger';
import { metrics } from '../../utils/metrics';
import {
  findAccountErasure,
  findRetryableAccountErasures,
  readAccountEventCursor,
  scrubExpiredErasureUsernames,
  writeAccountEventCursor,
} from '../../db/accountErasures/accountErasureRepository';
import { ERASURE_USERNAME_RETENTION_DAYS } from '../../db/schema/accountErasures';
import { isAccountEventRefusal, listAccountEvents, verifyAccountEvent } from './oxyAccountEvents';
import { acceptAccountEvent, scheduleAccountErasure } from './accountEventIntake';

const LOG_PREFIX = '[AccountErasure]';

/** The feed's row in `oxy_account_event_cursors`. */
export const ACCOUNT_EVENTS_FEED = 'account-events';
export const RECONCILIATION_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 30 * 1000;
/** Events per page (Oxy allows 1..200). */
export const RECONCILIATION_PAGE_SIZE = 100;
/** Pages per tick, so a long backlog is read over several ticks rather than one unbounded one. */
export const RECONCILIATION_MAX_PAGES = 20;
/** Unfinished erasures retried per tick. */
export const RECONCILIATION_RETRY_LIMIT = 10;
/** How long a pending/failed row sits untouched before the sweep takes it over from the queue. */
export const RECONCILIATION_QUIET_MS = 10 * 60 * 1000;

export const ACCOUNT_EVENT_REFUSED_METRIC = 'account_event_refused_total';

export interface PullResult {
  pages: number;
  recorded: number;
  refused: number;
  cursorAdvanced: boolean;
}

/** Read the feed forward from the stored cursor, recording every verified event. */
export async function pullAccountEvents(): Promise<PullResult> {
  const result: PullResult = { pages: 0, recorded: 0, refused: 0, cursorAdvanced: false };
  let cursor = await readAccountEventCursor(ACCOUNT_EVENTS_FEED);

  for (let page = 0; page < RECONCILIATION_MAX_PAGES; page += 1) {
    const response = await listAccountEvents({
      ...(cursor ? { after: cursor } : {}),
      limit: RECONCILIATION_PAGE_SIZE,
    });
    result.pages += 1;

    for (const item of response.events) {
      let event;
      try {
        event = await verifyAccountEvent(item.token);
      } catch (error) {
        if (!isAccountEventRefusal(error)) throw error;
        result.refused += 1;
        metrics.incrementCounter(ACCOUNT_EVENT_REFUSED_METRIC, 1, { source: 'reconciliation' });
        logger.error(`${LOG_PREFIX} the pull feed served a token that does not verify; skipped`, {
          eventId: item.eventId,
        });
        continue;
      }
      // The signed token is the authority; the feed's plain fields are not. An
      // item whose fields disagree with its own token is recorded from the TOKEN.
      if (event.eventId !== item.eventId || event.userId !== item.userId) {
        logger.warn(`${LOG_PREFIX} a feed item disagreed with its signed token; using the token`, {
          eventId: event.eventId,
        });
      }
      await acceptAccountEvent(event, 'reconciliation');
      result.recorded += 1;
    }

    const next = response.nextCursor;
    if (!next || next === cursor) break;
    await writeAccountEventCursor(ACCOUNT_EVENTS_FEED, next);
    cursor = next;
    result.cursorAdvanced = true;
    if (response.events.length < RECONCILIATION_PAGE_SIZE) break;
  }
  return result;
}

/** Re-schedule erasures that were recorded but never finished. */
export async function retryUnfinishedErasures(): Promise<number> {
  const eventIds = await findRetryableAccountErasures(RECONCILIATION_RETRY_LIMIT, RECONCILIATION_QUIET_MS);
  for (const eventId of eventIds) {
    const row = await findAccountErasure(eventId);
    if (row) await scheduleAccountErasure(row);
  }
  return eventIds.length;
}

/** One pass: pull, retry, scrub. Each part is isolated so one failure does not stop the others. */
export async function reconcileAccountEvents(): Promise<void> {
  try {
    const pulled = await pullAccountEvents();
    logger.info(`${LOG_PREFIX} pull feed read`, { ...pulled });
  } catch (error) {
    logger.warn(`${LOG_PREFIX} pull feed read failed; the cursor did not move`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const retried = await retryUnfinishedErasures();
    if (retried > 0) logger.info(`${LOG_PREFIX} re-scheduled unfinished erasures`, { retried });
  } catch (error) {
    logger.warn(`${LOG_PREFIX} retry scan failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const scrubbed = await scrubExpiredErasureUsernames(ERASURE_USERNAME_RETENTION_DAYS);
    if (scrubbed > 0) logger.info(`${LOG_PREFIX} cleared expired handles`, { scrubbed });
  } catch (error) {
    logger.warn(`${LOG_PREFIX} handle scrub failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export class AccountEventReconciliationJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private firstTick: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private running = false;

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => {
      void this.tick();
    }, RECONCILIATION_INTERVAL_MS);
    this.timer.unref?.();
    // A first pass soon after leadership is taken, so a deploy does not wait a
    // whole interval to catch up on what arrived while no task was leader.
    this.firstTick = setTimeout(() => {
      void this.tick();
    }, FIRST_TICK_DELAY_MS);
    this.firstTick.unref?.();
    logger.info(`${LOG_PREFIX} reconciliation job started`, { intervalMs: RECONCILIATION_INTERVAL_MS });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.firstTick) {
      clearTimeout(this.firstTick);
      this.firstTick = null;
    }
  }

  /** One single-flight pass. Public so tests and the first leader tick can drive it. */
  async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;
    const work = reconcileAccountEvents().finally(() => {
      if (this.inFlight === work) this.inFlight = null;
    });
    this.inFlight = work;
    await work;
  }
}

export const accountEventReconciliationJob = new AccountEventReconciliationJob();
