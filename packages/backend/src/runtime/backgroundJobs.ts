import { startWorkers, shutdownQueues } from '../queue/workers';
import { engagementOutboxDispatcher } from '../services/EngagementOutboxDispatcher';
import { moderationOutboxDispatcher } from '../services/moderation/ModerationOutboxDispatcher';
import { leaderElection } from '../services/LeaderElection';
import { startSchedulers, stopSchedulers } from './schedulers';
import { logger } from '../utils/logger';

/** One owner of job lifecycle, shared by combined and dedicated worker processes. */
async function startJobs(strict: boolean): Promise<void> {
  try {
    startWorkers();
  } catch (error) {
    if (strict) throw error;
    logger.warn('Failed to start federation queue workers', error);
  }
  engagementOutboxDispatcher.start();
  moderationOutboxDispatcher.start();
  await leaderElection.start(startSchedulers, stopSchedulers);
}

async function stopJobs(): Promise<void> {
  await Promise.allSettled([
    leaderElection.stop(),
    engagementOutboxDispatcher.stop(),
    moderationOutboxDispatcher.stop(),
    shutdownQueues(),
  ]);
}

let starting: Promise<void> | undefined;
let stopping: Promise<void> | undefined;
export function startBackgroundJobs(strict: boolean): Promise<void> {
  if (stopping) return Promise.reject(new Error('Background jobs are stopping'));
  starting ??= startJobs(strict);
  return starting;
}
export function stopBackgroundJobs(): Promise<void> {
  stopping ??= (async () => {
    try {
      await starting;
    } catch {
      /* Drain any partially started workers. */
    }
    await stopJobs();
  })();
  return stopping;
}
