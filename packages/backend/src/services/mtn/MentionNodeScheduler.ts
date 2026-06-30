/**
 * Mention Node Scheduler (MTN Protocol — B3 background node sync)
 *
 * The LEADER-GATED background driver for the two-way node sync. Registered in
 * `server.ts`'s `startSchedulers()` alongside `FederationJobScheduler` /
 * `FeedJobScheduler`, which `leaderElection` runs on exactly ONE task at a time —
 * so the sweeps never multiply across the fleet.
 *
 * Two periodic in-process sweeps:
 *  - LIVENESS — re-probe registered nodes (`sweepNodeLiveness`), updating the
 *    cached `status` badge.
 *  - SYNC — for each active node least-recently-synced first: `mode:'pull'`
 *    nodes are INGESTED (`ingestFromNode`), `mode:'push'` nodes are EXPORTED
 *    (`exportToNode`). Bounded batch per sweep.
 *
 * ## Absolute read-path invariant
 *
 * NOTHING here ever runs on a request path. Every tick is background, bounded,
 * and self-isolating: a single node failing its probe/ingest/export is caught and
 * recorded as `lastError`, never thrown. The feed/hydration hot path never queries
 * {@link MentionUserNode} or a node endpoint.
 */

import MentionUserNode from '../../models/MentionUserNode';
import { logger } from '../../utils/logger';
import { sweepNodeLiveness } from './MentionNodeRegistryService';
import { ingestFromNode, exportToNode } from './MentionNodeSyncService';
import {
  MENTION_NODE_LIVENESS_SWEEP_INTERVAL_MS,
  MENTION_NODE_INGEST_SWEEP_INTERVAL_MS,
  MENTION_NODE_INGEST_SWEEP_BATCH,
  MENTION_NODE_LIVENESS_SWEEP_START_DELAY_MS,
  MENTION_NODE_INGEST_SWEEP_START_DELAY_MS,
} from './mentionNodes.constants';

export class MentionNodeScheduler {
  private livenessInterval: NodeJS.Timeout | null = null;
  private syncInterval: NodeJS.Timeout | null = null;
  private livenessStartTimeout: NodeJS.Timeout | null = null;
  private syncStartTimeout: NodeJS.Timeout | null = null;
  private isRunning = false;

  /** Start the leader-gated liveness + sync sweeps. Idempotent. */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    // Defer the first sweeps so boot is never contended; then run on a fixed
    // cadence. Both first-ticks are tracked so stop() can cancel them.
    this.livenessStartTimeout = setTimeout(() => {
      this.livenessStartTimeout = null;
      void this.runLivenessSweep();
      this.livenessInterval = setInterval(() => {
        void this.runLivenessSweep();
      }, MENTION_NODE_LIVENESS_SWEEP_INTERVAL_MS);
    }, MENTION_NODE_LIVENESS_SWEEP_START_DELAY_MS);

    this.syncStartTimeout = setTimeout(() => {
      this.syncStartTimeout = null;
      void this.runSyncSweep();
      this.syncInterval = setInterval(() => {
        void this.runSyncSweep();
      }, MENTION_NODE_INGEST_SWEEP_INTERVAL_MS);
    }, MENTION_NODE_INGEST_SWEEP_START_DELAY_MS);

    logger.info('MentionNodeScheduler started (leader-gated node liveness + sync sweeps)');
  }

  /** Stop all sweeps + cancel any pending first-ticks. Idempotent. */
  stop(): void {
    if (this.livenessInterval) {
      clearInterval(this.livenessInterval);
      this.livenessInterval = null;
    }
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    if (this.livenessStartTimeout) {
      clearTimeout(this.livenessStartTimeout);
      this.livenessStartTimeout = null;
    }
    if (this.syncStartTimeout) {
      clearTimeout(this.syncStartTimeout);
      this.syncStartTimeout = null;
    }
    this.isRunning = false;
    logger.info('MentionNodeScheduler stopped');
  }

  /** One liveness sweep tick — never throws into the timer. */
  private async runLivenessSweep(): Promise<void> {
    try {
      await sweepNodeLiveness();
    } catch (err) {
      logger.warn('MentionNodeScheduler: liveness sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * One sync sweep tick — ingest `pull` nodes, export `push` nodes, bounded and
   * sequential. Each node is independent + non-throwing. Never throws into the
   * timer.
   */
  private async runSyncSweep(): Promise<void> {
    try {
      const nodes = await MentionUserNode.find({ status: { $in: ['active', 'unreachable'] } })
        .sort({ lastSyncedAt: 1 })
        .limit(MENTION_NODE_INGEST_SWEEP_BATCH)
        .select('oxyUserId mode')
        .lean<Array<{ oxyUserId: string; mode: 'pull' | 'push' }>>();

      for (const node of nodes) {
        if (node.mode === 'push') {
          await exportToNode(node.oxyUserId);
        } else {
          await ingestFromNode(node.oxyUserId);
        }
      }
    } catch (err) {
      logger.warn('MentionNodeScheduler: sync sweep failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export const mentionNodeScheduler = new MentionNodeScheduler();
