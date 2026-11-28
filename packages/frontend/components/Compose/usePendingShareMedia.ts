import { useEffect, useRef } from 'react';
import { consumePendingShareMedia, type PendingShareMediaItem } from '@/utils/pendingShareMedia';
import type { ComposePresentation } from './useComposeExit';

/** Claim the handoff only after this composer commits, before its intent effect. */
export function usePendingShareMedia(presentation: ComposePresentation) {
  const media = useRef<PendingShareMediaItem[]>([]);
  const claimed = useRef(false);
  useEffect(() => {
    if (claimed.current || presentation === 'tab') return;
    claimed.current = true;
    media.current = consumePendingShareMedia();
  }, [presentation]);
  return media;
}
