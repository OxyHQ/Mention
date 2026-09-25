import { useCallback, useMemo } from 'react';
import { router } from 'expo-router';

import { pageIndexByName } from '@/components/navigation/tabs';
import { useTabPager } from '@/context/TabPagerContext';
import { useSafeBack } from '@/hooks/useSafeBack';

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
   *   link) it is REPLACED by Home — `useSafeBack`'s push would leave the
   *   composer underneath, one Back away.
   * - tab: Home, with the composer tab taken out of the tabs' back history, so
   *   neither Back nor the pager can return to it.
   */
  leaveAfterPublish: () => void;
}

export function useComposeExit(presentation: ComposePresentation): ComposeExit {
  const safeBack = useSafeBack();
  const { selectTab, leaveTab } = useTabPager();

  const dismiss = useCallback(() => {
    if (presentation === 'tab') {
      selectTab(pageIndexByName('index'));
      return;
    }
    safeBack();
  }, [presentation, safeBack, selectTab]);

  const leaveAfterPublish = useCallback(() => {
    if (presentation === 'tab') {
      leaveTab(pageIndexByName('write'), pageIndexByName('index'));
      return;
    }
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  }, [presentation, leaveTab]);

  return useMemo(() => ({ dismiss, leaveAfterPublish }), [dismiss, leaveAfterPublish]);
}
