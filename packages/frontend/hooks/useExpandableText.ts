import { useCallback, useState } from 'react';
import { computeExpandableText } from '@/utils/expandableText';

/**
 * Stateful wrapper around `computeExpandableText`. Not unit-tested directly
 * (it's a thin useState binding with no branching of its own) — the
 * truncation logic itself is covered by `utils/__tests__/expandableText.test.ts`.
 *
 * `resetKey` collapses `isExpanded` back to `false` whenever it (or `text`)
 * changes, using the ref-during-render pattern (no `useEffect`). This covers
 * two cases in one place: callers that pass the setting driving the preview
 * length/behavior (e.g. `postReadMoreAction`, `collapseLongBio`) so flipping
 * it in Settings doesn't leave a stale expanded post/bio; and content reuse
 * (e.g. a recycled list item) where `text` itself changes out from under an
 * already-expanded instance.
 */
export function useExpandableText(text: string, maxChars: number, resetKey?: unknown) {
  const [isExpanded, setIsExpanded] = useState(false);

  // The inputs the expansion belongs to, held in state (not refs) so the reset
  // below is React's "adjust state while rendering" pattern.
  const [expandedFor, setExpandedFor] = useState({ text, resetKey });
  if (expandedFor.text !== text || expandedFor.resetKey !== resetKey) {
    setExpandedFor({ text, resetKey });
    if (isExpanded) {
      setIsExpanded(false);
    }
  }

  const { displayText, isTruncated } = computeExpandableText(text, maxChars, isExpanded);
  const toggle = useCallback(() => setIsExpanded((prev) => !prev), []);
  return { displayText, isTruncated, isExpanded, toggle };
}
