// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { FeedReadIdentity } from './feedStaleness';
import { createFeedRuleSignal, type FeedRuleSignal } from './feedRuleSignal';

// Viewer-scoped: a late settings response from an outgoing account must not
// reload the new account's feeds. No React Query family invalidation: mounted
// feeds replace page one, and held SQLite/query pages fail their warm-start check.
const signals = new Map<string, { settings: FeedRuleSignal; tuning: FeedRuleSignal }>();
function forViewer(viewerId: string) {
  let signal = signals.get(viewerId);
  if (!signal) {
    signal = { settings: createFeedRuleSignal(), tuning: createFeedRuleSignal() };
    signals.set(viewerId, signal);
  }
  return signal;
}

export function notifyFeedRankingChanged(viewerId: string | undefined, tuningOnly = false): void {
  if (!viewerId) return;
  const signal = forViewer(viewerId);
  (tuningOnly ? signal.tuning : signal.settings).notify();
}

export function isFeedCacheStaleForRanking(feed: FeedReadIdentity, readAt: number): boolean {
  const signal = feed.viewerId && signals.get(feed.viewerId);
  return Boolean(
    signal &&
      (signal.settings.isStale(readAt) ||
        (feed.type === 'for_you' && !feed.userId && signal.tuning.isStale(readAt))),
  );
}

export function subscribeToFeedRankingChanges(
  feed: FeedReadIdentity,
  listener: () => void,
): () => void {
  if (!feed.viewerId) return () => {};
  const signal = forViewer(feed.viewerId);
  const settings = signal.settings.subscribe(listener);
  const tuning =
    feed.type === 'for_you' && !feed.userId ? signal.tuning.subscribe(listener) : () => {};
  return () => {
    settings();
    tuning();
  };
}
