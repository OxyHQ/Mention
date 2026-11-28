import { useScreenBack } from '@oxy.so/bloom/screen';
import { useCallback, useMemo } from 'react';

import { useTabPager } from '@oxy.so/bloom/tab-pager';

/**
 * How this composer was reached, which is the only thing the two routes serving
 * it disagree about.
 *
 * `pushed` is `/compose` — the composer as a DESTINATION, opened from a reply
 * button, a quote, an edit action or the OS share sheet, almost always carrying
 * params, and dismissed with Back to wherever the reader came from. Fourteen
 * call sites open it that way.
 *
 * `tab` is `/write` — the composer as a PLACE, one of the root pages, reached
 * from the bar's compose action. There is no "back to where I was" for a tab,
 * and it must never consume a share intent: the intent belongs to the pushed
 * instance that the share sheet actually opened, and `consumePendingShareMedia`
 * is a one-shot read, so a second live composer reading it would take the media
 * out from under the first.
 */
export type ComposePresentation = 'pushed' | 'tab';

export interface ComposeExit {
  /**
   * Leave WITHOUT publishing — the ✕ and the unsaved-changes prompt. The work is
   * not finished, so the composer stays reachable: a pushed one pops (the draft
   * is persisted), the tab stays mounted behind Home with its text intact.
   */
  dismiss: () => void;
  /**
   * Leave AFTER a successful publish. The work IS finished, so the composer must
   * not be anywhere the reader can land on again (OxyHQ/Mention#1140):
   *
   * - pushed: POPPED. When nothing is beneath it (a cold-start share or deep
   *   link) it is REPLACED by Home — a push would leave the composer
   *   underneath, one Back away.
   * - tab: Home, with the composer tab taken out of the tabs' back history, so
   *   neither Back nor the pager can return to it.
   */
  leaveAfterPublish: () => void;
}

export function useComposeExit(presentation: ComposePresentation): ComposeExit {
  // The app's Back: through the history, or REPLACED by Home when nothing is
  // beneath (`BloomProvider back`), never a push over the composer.
  const back = useScreenBack();
  const { selectTab, leaveTab } = useTabPager();

  const dismiss = useCallback(() => {
    if (presentation === 'tab') selectTab('index');
    else back?.();
  }, [presentation, back, selectTab]);

  const leaveAfterPublish = useCallback(() => {
    if (presentation === 'tab') leaveTab('write', 'index');
    else back?.();
  }, [presentation, back, leaveTab]);

  return useMemo(() => ({ dismiss, leaveAfterPublish }), [dismiss, leaveAfterPublish]);
}
