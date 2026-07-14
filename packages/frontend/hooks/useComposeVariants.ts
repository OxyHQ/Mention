import { useCallback, useMemo, useReducer } from 'react';
import type { PostContent } from '@mention/shared-types';
import type { ComposerMediaItem } from '@/utils/composeUtils';
import {
  createVariantsState,
  deserializeVariants,
  variantsReducer,
  variantsStateFromPost,
  type ComposeVariantArticle,
  type ComposeVariantsState,
} from '@/utils/composeVariants';

/**
 * The composer's (item × language) buffer.
 *
 * A thin `useReducer` over the pure core in `utils/composeVariants.ts` — all the
 * behaviour (the inheritance rule, the author-variant cap, the tolerant draft
 * read) lives there and is unit-tested without React.
 *
 * `defaultPrimaryTag` is where the composer OPENS, not what it declares: see
 * `hasDeclaredLanguages`.
 */
export const useComposeVariants = (defaultPrimaryTag: string) => {
  const [state, dispatch] = useReducer(variantsReducer, defaultPrimaryTag, createVariantsState);

  const setActiveTag = useCallback((tag: string) => dispatch({ type: 'set-active', tag }), []);
  const addLanguage = useCallback((tag: string) => dispatch({ type: 'add-language', tag }), []);
  const removeLanguage = useCallback((tag: string) => dispatch({ type: 'remove-language', tag }), []);
  const renameLanguage = useCallback(
    (from: string, to: string) => dispatch({ type: 'rename-language', from, to }),
    [],
  );
  const setPrimaryLanguage = useCallback((tag: string) => dispatch({ type: 'set-primary-language', tag }), []);

  const setVariantText = useCallback(
    (tag: string, itemId: string, text: string) => dispatch({ type: 'set-text', tag, itemId, text }),
    [],
  );

  const setVariantMediaAlt = useCallback(
    (tag: string, itemId: string, mediaId: string, alt: string) =>
      dispatch({ type: 'set-media-alt', tag, itemId, mediaId, alt }),
    [],
  );

  const appendVariantMedia = useCallback(
    (tag: string, itemId: string, media: ComposerMediaItem[]) =>
      dispatch({ type: 'append-media', tag, itemId, media }),
    [],
  );

  const removeVariantMedia = useCallback(
    (tag: string, itemId: string, mediaId: string) =>
      dispatch({ type: 'remove-media', tag, itemId, mediaId }),
    [],
  );

  const inheritVariantMedia = useCallback(
    (tag: string, itemId: string) => dispatch({ type: 'inherit-media', tag, itemId }),
    [],
  );

  const setVariantArticle = useCallback(
    (tag: string, itemId: string, article: ComposeVariantArticle | null) =>
      dispatch({ type: 'set-article', tag, itemId, article }),
    [],
  );

  const removeVariantItem = useCallback((itemId: string) => dispatch({ type: 'remove-item', itemId }), []);

  const loadVariants = useCallback(
    (next: ComposeVariantsState) => dispatch({ type: 'load', state: next }),
    [],
  );

  /** Rebuild the buffer from a draft's persisted (possibly absent) variant blob. */
  const loadVariantsFromDraft = useCallback(
    (raw: unknown) => dispatch({ type: 'load', state: deserializeVariants(raw, defaultPrimaryTag) }),
    [defaultPrimaryTag],
  );

  /** Rebuild the buffer from the post being edited. */
  const loadVariantsFromPost = useCallback(
    (content: PostContent | undefined, itemId: string) =>
      dispatch({ type: 'load', state: variantsStateFromPost(content, itemId, defaultPrimaryTag) }),
    [defaultPrimaryTag],
  );

  const resetVariants = useCallback(
    () => dispatch({ type: 'reset', primaryTag: defaultPrimaryTag }),
    [defaultPrimaryTag],
  );

  return useMemo(
    () => ({
      variants: state,
      setActiveTag,
      addLanguage,
      removeLanguage,
      renameLanguage,
      setPrimaryLanguage,
      setVariantText,
      setVariantMediaAlt,
      appendVariantMedia,
      removeVariantMedia,
      inheritVariantMedia,
      setVariantArticle,
      removeVariantItem,
      loadVariants,
      loadVariantsFromDraft,
      loadVariantsFromPost,
      resetVariants,
    }),
    [
      state,
      setActiveTag,
      addLanguage,
      removeLanguage,
      renameLanguage,
      setPrimaryLanguage,
      setVariantText,
      setVariantMediaAlt,
      appendVariantMedia,
      removeVariantMedia,
      inheritVariantMedia,
      setVariantArticle,
      removeVariantItem,
      loadVariants,
      loadVariantsFromDraft,
      loadVariantsFromPost,
      resetVariants,
    ],
  );
};
