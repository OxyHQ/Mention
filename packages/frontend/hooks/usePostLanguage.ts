import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { show as toast } from '@oxyhq/bloom/toast';
import type { PostContent } from '@mention/shared-types';
import { api } from '@/utils/api';
import { useAutoTranslateStore } from '@/stores/autoTranslateStore';
import {
  buildPostLanguageOptions,
  findOptionForLanguage,
  servedLanguageTag,
  shouldAutoTranslate,
  type PostLanguageOption,
} from '@/utils/postLanguages';

interface TranslateResponse {
  translatedText?: string;
  /** The CANONICAL tag the variant was stored under — `es` requested may come back `es-ES`. */
  tag?: string;
}

/** Machine bodies fetched during this session, keyed by their language tag. */
type FetchedBodies = Readonly<Record<string, string>>;

const NO_FETCHED_BODIES: FetchedBodies = {};

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
  selectLanguage: (tag: string) => void;
  /** The action-bar button: translate into the reader's language, or undo it. */
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
 */
export function usePostLanguage(
  content: PostContent,
  postId: string | undefined,
  postLanguage?: string,
): PostLanguageState {
  const { t, i18n } = useTranslation();
  const readerLanguage = i18n.language;
  const autoTranslateEnabled = useAutoTranslateStore((s) => s.enabled);

  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [fetchedBodies, setFetchedBodies] = useState<FetchedBodies>(NO_FETCHED_BODIES);
  const [isTranslating, setIsTranslating] = useState(false);
  const autoTranslateAttempted = useRef(false);

  // A recycled row must never show the previous post's translation: reset the
  // reader's override when the identity under it changes (React's documented
  // "adjust state during render" pattern — no Effect, no stale frame).
  const [renderedPostId, setRenderedPostId] = useState(postId);
  if (postId !== renderedPostId) {
    setRenderedPostId(postId);
    setSelectedTag(null);
    setFetchedBodies(NO_FETCHED_BODIES);
    setIsTranslating(false);
    autoTranslateAttempted.current = false;
  }

  const servedTag = servedLanguageTag(content, postLanguage);

  const options = useMemo(
    () => buildPostLanguageOptions(content, postLanguage, fetchedBodies),
    [content, postLanguage, fetchedBodies],
  );

  const translateInto = useCallback(
    async (tag: string) => {
      if (!postId) return;
      setIsTranslating(true);
      try {
        const { data } = await api.post<TranslateResponse>(`/posts/${postId}/translate`, {
          targetLanguage: tag,
        });
        const translated = data.translatedText;
        if (typeof translated === 'string' && translated.length > 0) {
          // Key the body by the tag the SERVER canonicalized it to, not the one
          // we asked for, so it lines up with the variant the next hydration
          // ships. Follow the selection over to it.
          const storedTag = data.tag ?? tag;
          setFetchedBodies((previous) => ({ ...previous, [storedTag]: translated }));
          if (storedTag !== tag) setSelectedTag(storedTag);
          return;
        }
        setSelectedTag(null);
        toast(t('translation.failed'), { type: 'error' });
      } catch (error: unknown) {
        setSelectedTag(null);
        const status = (error as { response?: { status?: number } })?.response?.status;
        toast(t(status === 429 ? 'translation.rateLimited' : 'translation.failed'), { type: 'error' });
      } finally {
        setIsTranslating(false);
      }
    },
    [postId, t],
  );

  const selectLanguage = useCallback(
    (tag: string) => {
      if (tag === servedTag) {
        setSelectedTag(null);
        return;
      }
      setSelectedTag(tag);
      // An author variant (and any body already fetched) is on hand — switching
      // to it must not cost a request.
      const known = options.find((option) => option.tag === tag);
      if (known?.text) return;
      void translateInto(tag);
    },
    [servedTag, options, translateInto],
  );

  const toggleReaderTranslation = useCallback(() => {
    if (selectedTag !== null) {
      setSelectedTag(null);
      return;
    }
    const existing = findOptionForLanguage(options, readerLanguage);
    selectLanguage(existing?.tag ?? readerLanguage);
  }, [selectedTag, options, readerLanguage, selectLanguage]);

  // Auto-translate, computed during render and fired once per post. It stays
  // silent when the author already wrote this post in the reader's language.
  if (
    autoTranslateEnabled &&
    !autoTranslateAttempted.current &&
    selectedTag === null &&
    !isTranslating &&
    postId &&
    shouldAutoTranslate({ content, postLanguage, readerLanguage, options })
  ) {
    autoTranslateAttempted.current = true;
    const target = findOptionForLanguage(options, readerLanguage)?.tag ?? readerLanguage;
    queueMicrotask(() => selectLanguage(target));
  }

  const activeTag = selectedTag ?? servedTag;
  const activeOption = activeTag ? options.find((option) => option.tag === activeTag) : undefined;
  const displayText = selectedTag !== null ? (activeOption?.text ?? null) : null;

  return {
    options,
    activeTag,
    displayText,
    isTranslating,
    isTranslated: selectedTag !== null && activeOption?.source === 'machine',
    selectLanguage,
    toggleReaderTranslation,
  };
}
