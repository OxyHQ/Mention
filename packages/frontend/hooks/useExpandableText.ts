import { useCallback, useRef, useState } from 'react';
import { computeExpandableText } from '@/utils/expandableText';
import { patchPostReader, usePostReader } from '@/stores/readerStateStore';

/**
 * Shared expansion state for plain text and parsed Markdown previews outside a
 * list (a profile bio). A POST's body uses {@link usePostTextExpansion}.
 *
 * `resetKey` collapses `isExpanded` back to `false` whenever it (or `text`)
 * changes, using the ref-during-render pattern (no `useEffect`). This covers
 * two cases in one place: callers that pass the setting driving the preview
 * length/behavior (e.g. `postReadMoreAction`, `collapseLongBio`) so flipping
 * it in Settings doesn't leave a stale expanded post/bio; and content reuse
 * (e.g. a recycled list item) where `text` itself changes out from under an
 * already-expanded instance.
 */
export function useTextExpansion(text: string, resetKey?: unknown) {
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

/**
 * Whether the reader expanded one post's body inline ("Read more").
 *
 * Held by the POST in `readerStateStore`, not by the row: post rows live in
 * virtualized lists that recycle or unmount them, and an expansion held in the
 * row collapsed again when the reader scrolled away and back. It survives a
 * switch to another rendition of the same post too — reading a translation of
 * a long post the reader already opened should not fold it shut.
 */
export function usePostTextExpansion(postId: string | undefined) {
  const isExpanded = usePostReader(postId, (entry) => entry.textExpanded === true);
  const toggle = useCallback(() => {
    if (postId)
      patchPostReader(postId, (entry) => ({ ...entry, textExpanded: !entry.textExpanded }));
  }, [postId]);
  return { isExpanded, toggle };
}

export function useExpandableText(text: string, maxChars: number, resetKey?: unknown) {
  const { isExpanded, toggle } = useTextExpansion(text, resetKey);
  return { ...computeExpandableText(text, maxChars, isExpanded), isExpanded, toggle };
}
