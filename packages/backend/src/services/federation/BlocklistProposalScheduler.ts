/**
 * THE SWEEP, ON A CADENCE — so the review queue keeps being produced when
 * nobody remembers to produce it.
 *
 * A blocklist rots quietly: other operators keep publishing decisions, and the
 * intelligence that would surface them only runs when somebody thinks to run it.
 * This is the thing that keeps thinking to run it. It cannot block anything —
 * it calls `runBlocklistProposalSweep`, which writes a review queue and nothing
 * else (see that module for why the decision stays manual).
 *
 * ## Why a due TIME in the database rather than a weekly timer
 *
 * A `setInterval` of seven days in a service that redeploys several times a day
 * NEVER FIRES: every deploy resets the timer well before it elapses, and the
 * failure is silent — no error, no log, just a job that quietly never happens,
 * which is exactly the rot being prevented. So the cadence is stored, not
 * counted: the tick is short enough to always survive to its next beat, and it
 * asks the run history whether a sweep is due. Restarts, scale-outs and
 * leadership changes all cost nothing.
 *
 * It also behaves identically everywhere. A BullMQ repeatable job would be the
 * house convention for a periodic federation task, but it exists only where
 * Redis is configured — and a schedule that silently does not exist in some
 * environments is the same failure in a different costume. The shared periodic
 * queue is additionally the wrong home for this one: its worker runs at
 * concurrency 1 so a repeatable job never overlaps itself, and a sweep that
 * polls thirteen remote instances would stall jobs that run every thirty
 * seconds.
 *
 * ## Leader-gated, and what remains possible
 *
 * Started only from `startSchedulers()` in `server.ts`, which runs on the
 * elected leader alone. Two tasks could still briefly overlap across a
 * leadership handover; the cost is a duplicate poll, because every ledger write
 * in the sweep is an idempotent upsert keyed on the domain. That is the same
 * posture as `ModerationReconciliationJob`, and it is proportionate: nothing
 * here deletes or enforces.
 */

import { FEDERATION_ENABLED } from '../../connectors/activitypub/constants';
import { latestProposalRunStartedAt } from '../../db/blocklist/blocklistProposalRepository';
import {
  renderProposalReport,
  runBlocklistProposalSweep,
  type BlocklistProposalSweepOptions,
  type BlocklistProposalSweepResult,
} from './BlocklistProposalService';
import { logger } from '../../utils/logger';

/**
 * How often a sweep is due.
 *
 * Weekly, because that is the cadence of the thing it feeds: a person reading a
 * queue and writing up entries. Published blocklists move slowly, and a domain
 * that appears on one today will still be there in six days — while a daily
 * report nobody has time to answer is a report that gets filtered to a folder.
 */
export const BLOCKLIST_PROPOSAL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How often we CHECK whether it is due.
 *
 * Deliberately far shorter than the cadence: this timer only has to survive
 * between its own beats, and five minutes survives any deploy pattern. The check
 * is one indexed `findOne`.
 */
const DUE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** The sweep this scheduler drives. Injected so the DUE decision is testable. */
export type BlocklistProposalSweep = (
  options: BlocklistProposalSweepOptions,
) => Promise<BlocklistProposalSweepResult>;

export class BlocklistProposalScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;

  /**
   * The sweep is a constructor parameter for one reason: "is a sweep due?" is
   * the whole behaviour of this class, and verifying it must not require
   * polling thirteen live instances. Production takes the default.
   */
  constructor(private readonly sweep: BlocklistProposalSweep = runBlocklistProposalSweep) {}

  start(): void {
    if (this.running) return;
    // An instance that does not federate holds no federated content, so there
    // is nothing a block would protect and nothing it would cost — and polling
    // thirteen strangers weekly to answer a question nobody has would be rude.
    if (!FEDERATION_ENABLED) {
      logger.info('[blocklistProposals] federation disabled — scheduler not started');
      return;
    }
    this.running = true;

    this.timer = setInterval(() => {
      void this.tick();
    }, DUE_CHECK_INTERVAL_MS);
    // House rule: a module-level singleton's interval must not hold the event
    // loop open, or a test run hangs non-deterministically.
    this.timer.unref?.();

    logger.info('[blocklistProposals] scheduler started', {
      dueCheckIntervalMs: DUE_CHECK_INTERVAL_MS,
      sweepIntervalMs: BLOCKLIST_PROPOSAL_INTERVAL_MS,
    });
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run the sweep if it is due.
   *
   * Exported behaviour, not just an internal beat: the manual path in
   * `scripts/reviewFederationBlocklistProposals` runs the sweep directly and
   * unconditionally, so this stays the one place the DUE decision is made.
   */
  async tick(): Promise<void> {
    if (!this.running || this.inFlight) return;

    const work = this.sweepIfDue()
      .catch((error: unknown) => {
        logger.error('[blocklistProposals] sweep failed', error);
      })
      .finally(() => {
        if (this.inFlight === work) this.inFlight = null;
      });
    this.inFlight = work;
    await work;
  }

  private async sweepIfDue(): Promise<void> {
    // NULL means no sweep has ever been recorded, which is DUE. That direction
    // costs a redundant poll; the other one is a sweep that silently stops
    // happening, which is precisely what the run history exists to make visible.
    const latestStartedAt = await latestProposalRunStartedAt();

    if (latestStartedAt && Date.now() - latestStartedAt.getTime() < BLOCKLIST_PROPOSAL_INTERVAL_MS) {
      return;
    }

    const result = await this.sweep({ trigger: 'scheduled' });

    // One record per line: the logger caps a single string field, and a
    // truncated report loses precisely the tail of the queue.
    for (const line of renderProposalReport(result)) {
      logger.info('[blocklistProposals] report', { line });
    }

    if (!result.ok) {
      // Not thrown: the run is recorded and the queue was left untouched, which
      // is the correct outcome for an untrustworthy poll. It is an error in the
      // log because a report that cannot reach a verdict must not read as a
      // quiet week.
      logger.error('[blocklistProposals] sweep could not reach a verdict', {
        reason: result.failureReason,
      });
      return;
    }

    logger.info('[blocklistProposals] sweep complete', {
      opened: result.counts.opened,
      pending: result.counts.pending,
      suppressedDeclined: result.counts.suppressedDeclined,
      suppressedBlocked: result.counts.suppressedBlocked,
      lapsed: result.counts.lapsed,
      adopted: result.counts.adopted,
    });
  }
}

export const blocklistProposalScheduler = new BlocklistProposalScheduler();

export default blocklistProposalScheduler;
