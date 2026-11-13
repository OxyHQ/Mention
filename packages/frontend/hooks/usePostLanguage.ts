import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';
import type { PostContent } from '@mention/shared-types';
import { api } from '@/utils/api';
import { useTrendsStore } from '@/stores/trendsStore';
import {
  currentReaderEpoch,
  NO_TRANSLATION,
  patchPostTranslation,
  type PostTranslationState,
  usePostReader,
} from '@/stores/readerStateStore';
import {
  buildPostLanguageOptions,
  resolveTranslateTarget,
  servedLanguageTag,
  shouldOfferTranslation,
  type PostLanguageOption,
} from '@/utils/postLanguages';

interface TranslateResponse {
  translatedText?: string;
  /** The CANONICAL tag the variant was stored under — `es` requested may come back `es-ES`. */
  tag?: string;
}

export interface PostLanguageState {
  /**
   * The renditions this post SHIPPED with (author, plus a machine translation
   * for the reader's own language when one existed) and anything fetched since.
   * One entry = nothing to switch to = no switcher. It is not a list of the
   * languages this post can be translated into — that is any of them.
   */
  options: PostLanguageOption[];
  /** The language on screen — the server's choice until the reader overrides it. */
  activeTag: string | null;
  /**
   * Body override for the renderers, or `null` to show the server-resolved
   * `content.text`. Never derived by the renderers themselves: the server owns
   * variant resolution, and this is the reader deliberately overruling it.
   */
  displayText: string | null;
  isTranslating: boolean;
  /** The body on screen is a machine translation, not the author's words. */
  isTranslated: boolean;
  /**
   * Whether translating would give this reader anything — false for a post
   * already written in their language, which is the only post whose action bar
   * has no translate icon at all.
   */
  canTranslate: boolean;
  selectLanguage: (tag: string) => void;
  /** The action-bar icon: translate into the reader's language, or undo it. */
  toggleReaderTranslation: () => void;
}

/**
 * Reading a post in another language.
 *
 * The server already resolved ONE body for this viewer (see
 * `PostHydrationService`), so this hook exists only for the reader who wants a
 * DIFFERENT one. The renditions the DTO shipped carry their bodies, so switching
 * between them is a `setState` — never a request. Any OTHER language is a
 * translate call: the server answers it from its cache or from a model, and the
 * reader cannot tell which (nor should the client try to guess).
 *
 * NOTHING HERE TRANSLATES ON ITS OWN. Mounting, rendering, recycling, render-ahead
 * and viewability never reach the translate endpoint: the server's hydration
 * already picked the best rendition it HAS for this viewer (including a machine
 * translation some earlier reader asked for), and manufacturing a missing one is
 * only ever the answer to an explicit reader action — the translate icon or the
 * language picker. Do not add a preference- or visibility-driven path back.
 */
export function usePostLanguage(
  content: PostContent,
  postId: string | undefined,
  postLanguage?: string,
  /** The viewer wrote this post (`viewerState.isOwner`): no translate icon. */
  isOwnPost?: boolean,
): PostLanguageState {
  const { t } = useTranslation();

  /**
   * Every language this reader understands, most-preferred first — the
   * account's OWN declared locales (the same ordered list the backend already
   * resolves a post's served variant against), with the app's display language
   * behind them so a signed-out reader still gets one. A reader who lists
   * `[en, es]` must not be offered a translation for a Spanish post just
   * because English happens to be their app chrome's language.
   *
   * Read from `trendsStore` rather than re-derived here: `AccountSwitchReset`
   * already computes this exact list once per identity change for feed
   * ranking, and re-deriving it per post row would mean every visible row in
   * a scrolling feed subscribing to the full auth/session context just to
   * read `user.languages`.
   */
  const readerLanguages = useTrendsStore((s) => s.readerLanguages);

  /**
   * The reader's override lives in `readerStateStore`, keyed by the POST, never
   * in this component. A feed row is recycled (FlashList hands the instance a
   * different post) or unmounted (the web list), and a translation held in the
   * row died with it: translate, scroll on, come back, and the post was in its
   * original language again. Keyed by post it outlives every row, never leaks
   * into another post a recycled row is handed, and a translation that lands
   * after the row moved on still reaches the post it was asked for.
   */
  const translation = usePostReader(postId, (entry) => entry.translation) ?? NO_TRANSLATION;
  const { selectedTag, fetchedBodies, isTranslating } = translation;

  const servedTag = servedLanguageTag(content, postLanguage);

  const options = useMemo(
    () => buildPostLanguageOptions(content, postLanguage, fetchedBodies),
    [content, postLanguage, fetchedBodies],
  );

  const translateInto = useCallback(
    async (tag: string) => {
      if (!postId) return;
      // Every write below targets THIS post under THIS viewer, wherever the row
      // that asked has gone since.
      const epoch = currentReaderEpoch();
      const patch = (next: Partial<PostTranslationState>) =>
        patchPostTranslation(postId, () => next, epoch);
      patch({ isTranslating: true });
      try {
        const { data } = await api.post<TranslateResponse>(`/posts/${postId}/translate`, {
          targetLanguage: tag,
        });
        const translated = data.translatedText;
        if (typeof translated === 'string' && translated.length > 0) {
          // Key the body by the tag the SERVER canonicalized it to, not the one
          // we asked for, so it lines up with the variant the next hydration
          // ships, and follow the selection over to it.
          const storedTag = data.tag ?? tag;
          patchPostTranslation(
            postId,
            (previous) => ({
              fetchedBodies: { ...previous.fetchedBodies, [storedTag]: translated },
              selectedTag: storedTag,
              isTranslating: false,
            }),
            epoch,
          );
          return;
        }
        patch({ selectedTag: null, isTranslating: false });
        toast(t('translation.failed'), { type: 'error' });
      } catch (error: unknown) {
        patch({ selectedTag: null, isTranslating: false });
        const status = (error as { response?: { status?: number } })?.response?.status;
        toast(t(status === 429 ? 'translation.rateLimited' : 'translation.failed'), {
          type: 'error',
        });
      }
    },
    [postId, t],
  );

  const selectLanguage = useCallback(
    (tag: string) => {
      if (!postId) return;
      if (tag === servedTag) {
        patchPostTranslation(postId, () => ({ selectedTag: null }));
        return;
      }
      patchPostTranslation(postId, () => ({ selectedTag: tag }));
      // An author variant (and any body already fetched) is on hand — switching
      // to it must not cost a request.
      const known = options.find((option) => option.tag === tag);
      if (known?.text) return;
      void translateInto(tag);
    },
    [postId, servedTag, options, translateInto],
  );

  const toggleReaderTranslation = useCallback(() => {
    if (selectedTag !== null) {
      if (postId) patchPostTranslation(postId, () => ({ selectedTag: null }));
      return;
    }
    const target = resolveTranslateTarget(options, readerLanguages);
    if (target) selectLanguage(target);
  }, [postId, selectedTag, options, readerLanguages, selectLanguage]);

  const canTranslate = shouldOfferTranslation({
    content,
    postLanguage,
    readerLanguages,
    options,
    isOwnPost,
  });

  const activeTag = selectedTag ?? servedTag;
  const activeOption = activeTag ? options.find((option) => option.tag === activeTag) : undefined;
  const displayText = selectedTag !== null ? (activeOption?.text ?? null) : null;

  return {
    options,
    activeTag,
    displayText,
    isTranslating,
    isTranslated: selectedTag !== null && activeOption?.source === 'machine',
    canTranslate,
    selectLanguage,
    toggleReaderTranslation,
  };
}
