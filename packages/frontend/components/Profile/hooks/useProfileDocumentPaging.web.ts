import { useEffect } from 'react';
import { usePanelScrollContainer } from '@oxy.so/bloom/app-shell/hooks';
import { useRefSync } from '@/hooks/useRefSync';
import { LAYOUT } from '../types';

/** WEB: the document (or the bounded panel) asks for the next page near its end. */
export function useProfileDocumentPaging(onNearEnd: () => void): void {
  const panel = usePanelScrollContainer<HTMLElement>();
  const onNearEndRef = useRefSync(onNearEnd);

  // Subscribing to an external mutable store (the page's scroll) is a
  // legitimate effect. Checked once on mount too, so a short page fills itself.
  useEffect(() => {
    const owner = panel?.current ?? window;
    const onScroll = () => {
      const node = panel?.current ?? document.documentElement;
      const y = owner instanceof Window ? owner.scrollY : node.scrollTop;
      const viewHeight = panel?.current?.clientHeight ?? window.innerHeight;
      if (node.scrollHeight - (y + viewHeight) < LAYOUT.LOAD_MORE_THRESHOLD) {
        onNearEndRef.current();
      }
    };
    onScroll();
    owner.addEventListener('scroll', onScroll, { passive: true });
    return () => owner.removeEventListener('scroll', onScroll);
  }, [panel, onNearEndRef]);
}
