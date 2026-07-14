import { useCallback, useEffect, useRef } from 'react';
import type { View } from 'react-native';
import type { FeedInterstitialEventName, FeedInterstitialKind } from '@mention/shared-types';
import { reportInterstitialEvent } from '@/utils/feedTelemetry';

/**
 * What the recommendation bands measure, and how.
 *
 * The cards are a product bet — they interrupt the feed to suggest something —
 * so they have to be answerable: is anyone SEEING them, and does anyone act on
 * them. This module is the one place that answers it, so the four bands report
 * identically and none of them can quietly stop reporting.
 *
 * Card events never travel the post-interaction path (`reportFeedInteraction`):
 * that route needs a `postUri` and feeds POST ranking, so a follow that happened
 * on a card would corrupt author/topic affinity with engagement that never
 * touched a post. See `reportInterstitialEvent`.
 */

/** The slot a band occupies — everything an event needs to be attributable. */
export interface InterstitialTelemetry {
  /**
   * Descriptor of the feed the card sits in (`for_you`, `author|<id>`, …).
   * Absent when a card is rendered outside a real feed; nothing is reported then.
   */
  feedDescriptor?: string;
  /** The server-issued slot key this band was planned for. */
  slotKey: string;
  kind: FeedInterstitialKind;
}

/**
 * What the dispatcher hands every band: its page offset into the suggestion pool
 * plus the telemetry identity of the slot it was planned for.
 */
export interface InterstitialCardProps {
  /**
   * Which interstitial this is within the accumulated feed (0, 1, 2…). Each band
   * offsets into its suggestion pool by its ordinal, so a viewer who scrolls past
   * two cards of a kind is not shown the same suggestions twice.
   */
  ordinal: number;
  slotKey: string;
  feedDescriptor?: string;
}

/**
 * Report one card event. `position` is the item's 0-based index within the card
 * for item-level events (click/follow/subscribe/use/dismiss), and omitted for
 * card-level ones (impression/seeMore).
 */
export type ReportInterstitialEvent = (
  event: FeedInterstitialEventName,
  position?: number,
) => void;

/** The band's bound reporter. Stable while the slot it reports for is. */
export function useInterstitialReporter(
  telemetry: InterstitialTelemetry,
): ReportInterstitialEvent {
  const { feedDescriptor, slotKey, kind } = telemetry;

  return useCallback(
    (event: FeedInterstitialEventName, position?: number) => {
      if (!feedDescriptor) return;
      reportInterstitialEvent({ feedDescriptor, slotKey, kind, event, position });
    },
    [feedDescriptor, slotKey, kind],
  );
}

/** A card counts as seen once half of it is on screen. */
const IMPRESSION_VISIBLE_RATIO = 0.5;

/**
 * How long after a card mounts it counts as seen where visibility cannot be
 * observed (native). Long enough that a card the reader flicks straight past
 * does not count, short enough that a card they stop at always does.
 */
const IMPRESSION_MOUNTED_DELAY_MS = 500;

/** The DOM element behind a rendered `View`, on the platforms that have one. */
function toObservableElement(target: unknown): Element | null {
  if (typeof Element === 'undefined') return null;
  return target instanceof Element ? target : null;
}

/**
 * Report a band's `impression` — ONCE per mount, and only once it has actually
 * been SEEN. A card that is rendered below the fold and never scrolled to is not
 * an impression; counting one would make the click-through rate meaningless.
 *
 * Two ways to know, one per platform:
 *  - **Web**: an `IntersectionObserver` on the band's own element, firing at 50%
 *    visibility. Subscribing to an external system is exactly what an Effect is
 *    for.
 *  - **Native**: no observer exists, and FlashList only mounts a row near the
 *    viewport, so mount + a short delay is the pragmatic equivalent (the same
 *    approach Bluesky takes). A row recycled past in a fast fling is unmounted
 *    before the delay elapses and reports nothing.
 *
 * `enabled` is what the band knows and this hook cannot: whether it is really
 * showing suggestions. A band still on skeletons — which may yet collapse to
 * nothing — has not been seen, so it does not report.
 *
 * Returns the ref the band must attach to its outermost view.
 */
export function useInterstitialImpression(
  report: ReportInterstitialEvent,
  enabled: boolean,
): React.RefObject<View | null> {
  const targetRef = useRef<View | null>(null);
  const reportedRef = useRef(false);

  useEffect(() => {
    if (!enabled || reportedRef.current) return;

    const reportImpression = (): void => {
      if (reportedRef.current) return;
      reportedRef.current = true;
      report('impression');
    };

    const element = toObservableElement(targetRef.current);
    if (element !== null && typeof IntersectionObserver === 'function') {
      const observer = new IntersectionObserver(
        (entries) => {
          const seen = entries.some(
            (entry) =>
              entry.isIntersecting && entry.intersectionRatio >= IMPRESSION_VISIBLE_RATIO,
          );
          if (!seen) return;
          reportImpression();
          observer.disconnect();
        },
        { threshold: IMPRESSION_VISIBLE_RATIO },
      );
      observer.observe(element);
      return () => observer.disconnect();
    }

    const timer = setTimeout(reportImpression, IMPRESSION_MOUNTED_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled, report]);

  return targetRef;
}
