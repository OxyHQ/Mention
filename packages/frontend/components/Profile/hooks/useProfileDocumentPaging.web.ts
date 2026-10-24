import { useCallback } from 'react';
import { runOnJS, useAnimatedReaction } from 'react-native-reanimated';
import { usePanelScrollContainer } from '@oxy.so/bloom/app-shell/hooks';
import { useDocumentScroll } from '@/context/DocumentScroll.web';
import { LAYOUT } from '../types';

/** WEB: the document (or the bounded panel) asks for the next page near its end. */
export function useProfileDocumentPaging(onNearEnd: () => void): void {
  const panel = usePanelScrollContainer<HTMLElement>();
  const { scrollPosition } = useDocumentScroll();
  const check = useCallback(
    (y: number) => {
      const contentHeight = panel?.current?.scrollHeight ?? document.documentElement.scrollHeight;
      const viewHeight = panel?.current?.clientHeight ?? window.innerHeight;
      if (contentHeight - (y + viewHeight) < LAYOUT.LOAD_MORE_THRESHOLD) onNearEnd();
    },
    [panel, onNearEnd],
  );
  useAnimatedReaction(
    () => scrollPosition.value,
    (y) => {
      runOnJS(check)(y);
    },
    [check],
  );
}
