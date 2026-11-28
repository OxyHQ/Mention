// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

/**
 * How hard a promotion is pushed right now, from where it stands against its
 * schedule. Pure: the lifecycle job and the feed source both read it, and a test
 * can hold every case.
 *
 * The schedule is linear: a promotion should have delivered
 * `purchased * (elapsed / window)` views by now. Behind it, the post is lifted
 * in the ranking up to a ceiling; on pace, not at all; well ahead of it, the
 * promotion sits out until the schedule catches up. That is the whole of
 * "spend it over the window".
 */

import type { MtnConfig } from '@mention/shared-types';

type PromotionConfig = typeof MtnConfig.promotion;

/** The part of a promotion row pacing reads. */
export interface PromotionProgress {
  purchasedImpressions: number;
  deliveredImpressions: number;
  startsAt: Date;
  endsAt: Date;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** The views a promotion should have delivered by `now`, floored so a new one is not "on pace" at zero. */
export function scheduledImpressions(
  progress: PromotionProgress,
  now: Date,
  config: Pick<PromotionConfig, 'pacingFloorShare'>,
): number {
  const window = progress.endsAt.getTime() - progress.startsAt.getTime();
  const elapsed = window > 0 ? clamp01((now.getTime() - progress.startsAt.getTime()) / window) : 1;
  return Math.max(
    progress.purchasedImpressions * elapsed,
    progress.purchasedImpressions * config.pacingFloorShare,
  );
}

/**
 * The rank multiplier: `1` when on pace or ahead, rising to `maxMultiplier` when
 * nothing has been delivered against a schedule that expects something.
 */
export function promotionMultiplier(
  progress: PromotionProgress,
  now: Date,
  config: Pick<PromotionConfig, 'pacingFloorShare' | 'maxMultiplier'>,
): number {
  const scheduled = scheduledImpressions(progress, now, config);
  const pace = scheduled > 0 ? progress.deliveredImpressions / scheduled : 1;
  return 1 + (config.maxMultiplier - 1) * clamp01(1 - pace);
}

/** Whether the promotion has delivered so far past its schedule that it should sit out. */
export function isAheadOfSchedule(
  progress: PromotionProgress,
  now: Date,
  config: Pick<PromotionConfig, 'pacingFloorShare' | 'aheadSlackShare'>,
): boolean {
  const scheduled = scheduledImpressions(progress, now, config);
  return (
    progress.deliveredImpressions >=
    scheduled + progress.purchasedImpressions * config.aheadSlackShare
  );
}
