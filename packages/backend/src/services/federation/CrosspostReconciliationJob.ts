// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { config } from '../../config';
import {
  findClustersForRecheck,
  markClusterRechecked,
} from '../../db/posts/postEquivalenceRepository';
import { logger } from '../../utils/logger';
import { reevaluateCluster } from '../posts/PostEquivalenceService';

/** Expired/revoked Oxy proof must restore untouched posts too, without a source edit. */
export async function recheckCrosspostClusters(
  limit = config.federation.crosspostRecheckBatchSize,
  shouldContinue: () => boolean = () => true,
): Promise<number> {
  const ids = await findClustersForRecheck(limit);
  let checked = 0;
  for (const id of ids) {
    if (!shouldContinue()) break;
    await reevaluateCluster(id);
    await markClusterRechecked(id);
    checked += 1;
  }
  return checked;
}

/** Leader-only, bounded sequential batches; no overlapping sweep or persisted identity proof. */
export class CrosspostReconciliationJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, config.federation.crosspostRecheckIntervalMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (!this.timer || this.inFlight) return;
    this.inFlight = true;
    try {
      await recheckCrosspostClusters(undefined, () => this.timer !== null);
    } catch (error) {
      logger.warn('[Equivalence] scheduled recheck failed', { error });
    } finally {
      this.inFlight = false;
    }
  }
}

export const crosspostReconciliationJob = new CrosspostReconciliationJob();
