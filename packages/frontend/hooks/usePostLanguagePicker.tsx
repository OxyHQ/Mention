import { useCallback } from 'react';
import PostLanguageSheet from '@/components/Post/PostLanguageSheet';
import type { PostLanguageOption } from '@/utils/postLanguages';
import { presentSheet } from '@/utils/sheet';

/**
 * Opens the language picker on the app's surface stack.
 *
 * Every post row in a feed calls this, and none of them shows anything for it —
 * so it deliberately holds no i18n or theme subscription of its own. The sheet
 * takes those when it is actually mounted (`PostLanguageSheet`), which is once
 * per opening rather than once per row.
 */
export function usePostLanguagePicker(
  options: readonly PostLanguageOption[],
  activeTag: string | null,
  onSelect: (tag: string) => void,
): () => void {
  return useCallback(() => {
    void presentSheet((surface) => (
      <PostLanguageSheet
        options={options}
        activeTag={activeTag}
        onSelect={(tag) => {
          surface.dismiss();
          onSelect(tag);
        }}
      />
    ));
  }, [options, activeTag, onSelect]);
}
