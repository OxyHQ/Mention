import { useCallback, useContext } from 'react';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import PostLanguageSheet from '@/components/Post/PostLanguageSheet';
import type { PostLanguageOption } from '@/utils/postLanguages';

/**
 * Opens the language picker in the app's shared bottom sheet.
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
  const bottomSheet = useContext(BottomSheetContext);

  return useCallback(() => {
    const select = (tag: string) => {
      bottomSheet.setBottomSheetContent(null);
      bottomSheet.openBottomSheet(false);
      onSelect(tag);
    };

    bottomSheet.setBottomSheetContent(
      <PostLanguageSheet options={options} activeTag={activeTag} onSelect={select} />,
    );
    bottomSheet.openBottomSheet(true);
  }, [bottomSheet, options, activeTag, onSelect]);
}
