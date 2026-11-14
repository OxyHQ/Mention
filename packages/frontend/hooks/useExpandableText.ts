import { useCallback, useRef, useState } from 'react';
import { computeExpandableText } from '@/utils/expandableText';

/**
 * Expansion state for text outside a list (a profile bio). A POST's body is
 * held by the post in `readerStateStore` instead, so it survives scrolling.
 *
 * `resetKey` (the setting driving the preview, e.g. `collapseLongBio`) or a new
 * `text` collapses it again, using the ref-during-render pattern (no
 * `useEffect`), so flipping the setting never leaves a stale expanded bio.
 */
function useTextExpansion(text: string, resetKey?: unknown) {
  const [isExpanded, setIsExpanded] = useState(false);

  const prevTextRef = useRef(text);
  const prevResetKeyRef = useRef(resetKey);
  if (prevTextRef.current !== text || prevResetKeyRef.current !== resetKey) {
    prevTextRef.current = text;
    prevResetKeyRef.current = resetKey;
    if (isExpanded) {
      setIsExpanded(false);
    }
  }

  const toggle = useCallback(() => setIsExpanded((prev) => !prev), []);
  return { isExpanded, toggle };
}

export function useExpandableText(text: string, maxChars: number, resetKey?: unknown) {
  const { isExpanded, toggle } = useTextExpansion(text, resetKey);
  return { ...computeExpandableText(text, maxChars, isExpanded), isExpanded, toggle };
}
