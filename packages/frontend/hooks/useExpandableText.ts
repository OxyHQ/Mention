import { useCallback, useState } from 'react';
import { computeExpandableText } from '@/utils/expandableText';

/**
 * Stateful wrapper around `computeExpandableText`. Not unit-tested directly
 * (it's a thin useState binding with no branching of its own) — the
 * truncation logic itself is covered by `utils/__tests__/expandableText.test.ts`.
 */
export function useExpandableText(text: string, maxChars: number) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { displayText, isTruncated } = computeExpandableText(text, maxChars, isExpanded);
  const toggle = useCallback(() => setIsExpanded((prev) => !prev), []);
  const collapse = useCallback(() => setIsExpanded(false), []);
  return { displayText, isTruncated, isExpanded, toggle, collapse };
}
