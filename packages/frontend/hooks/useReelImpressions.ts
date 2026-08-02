import { useEffect } from 'react';
import { useFeedImpressionTracker } from '@/utils/feedTelemetry';

/**
 * The reel's impression + dwell reporting.
 *
 * A reel has TWO ways of deciding which video is being watched — the pager's
 * snapped slide, and, once the OS has lifted a player into its own window, the
 * Picture-in-Picture session's cursor — but it reports through ONE tracker.
 *
 * One, because a `FeedImpressionTracker` dedupes against its own pending map:
 * two instances each see the handoff into PiP as a first sighting of the same
 * post, and emit an impression each. The `viewsCount` write is protected by the
 * server's once-per-viewer dedupe, but the ranking signal is not — the second
 * impression carries only the dwell accrued since the window opened, which lands
 * under the server's skip threshold and books a NEGATIVE preference against a
 * video the viewer just watched in full.
 */
export interface UseReelImpressionsOptions {
  /** Id of the surface owning the OS window; `null` when no session is open. */
  pipOwnerId: string | null;
  /** What that session is playing, if its cursor points into the loaded list. */
  pipPlayingId?: string;
  /** Whether /videos is the focused route (a pushed screen leaves it mounted). */
  screenFocused: boolean;
  /** The slide the pager is on. */
  activePostId?: string;
  /** Feed the impressions are attributed to. */
  feedDescriptor: string;
  /** A change starts a fresh impression session (a reload, a new viewer). */
  impressionResetKey?: string | number;
  /** Whether impressions may be POSTed at all (the private-API / auth gate). */
  canReportImpressions: boolean;
}

export function useReelImpressions({
  pipOwnerId,
  pipPlayingId,
  screenFocused,
  activePostId,
  feedDescriptor,
  impressionResetKey,
  canReportImpressions,
}: UseReelImpressionsOptions): void {
  const impressionTracker = useFeedImpressionTracker(
    feedDescriptor,
    impressionResetKey,
    canReportImpressions,
  );

  // Read DURING render, deliberately. The condition the effect below has to
  // re-run on is "the tracker INSTANCE changed", and that is exactly what this
  // is: `useFeedImpressionTracker` swaps its ref during ITS render whenever the
  // session identity changes — a tab switch, or the viewer resolving on cold
  // boot — and the call above precedes this read, so a swap render already sees
  // the new instance. Keyed on the ref object instead, the effect never re-runs:
  // the video on screen stays registered only with the session that was just
  // disposed, and is re-opened on the next swipe. On cold boot the outgoing
  // session could not report yet (`canReportImpressions` was false), so that
  // impression is not merely late — it is lost.
  //
  // The cost is that the React Compiler refuses this function outright and bails
  // it, which buys nothing back HERE: what it would cache is a ternary inside a
  // hook that returns void. That is why the read lives in this hook and must
  // never be moved into `VideosScreen`, where a bail would be real.
  const tracker = impressionTracker.current;

  // Discriminated on whether a session EXISTS, not on whether it currently has
  // something to play: that is what makes the two cases total — no gap, no
  // overlap. A `?? activePostId` fallback would look harmless and instead accrue
  // dwell against a slide nobody is watching, because the pager is frozen for as
  // long as the OS window is up and its cursor can point outside a list that has
  // just been rebuilt (a tab switch under a live session).
  //
  // The focus gate matches the rest of the screen: a pushed route leaves the reel
  // mounted but stops its playback, and time spent on top of a paused video is
  // not dwell on that video. A viewer PAUSE deliberately does not gate — dwell is
  // the time the post occupied the viewport, which is exactly what the web feed's
  // IntersectionObserver measures for a text post that plays nothing.
  const impressedPostId = pipOwnerId !== null
    ? pipPlayingId
    : (screenFocused ? activePostId : undefined);

  // Visible while it is the watched video, hidden when the watch moves on or the
  // screen goes away — the same visible/hidden contract every feed reports, so
  // the dwell and the once-per-post dedupe come out identical.
  useEffect(() => {
    if (impressedPostId === undefined) return;
    tracker.setVisible(impressedPostId);
    return () => tracker.setHidden(impressedPostId);
  }, [impressedPostId, tracker]);
}
