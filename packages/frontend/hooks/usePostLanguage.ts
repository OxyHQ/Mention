import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@oxyhq/bloom/toast';
import type { PostContent } from '@mention/shared-types';
import { api } from '@/utils/api';
import { useAutoTranslateStore } from '@/stores/autoTranslateStore';
import {
  buildPostLanguageOptions,
  findOptionForLanguage,
  servedLanguageTag,
  shouldOfferTranslation,
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

/**
 * Everything the reader has done to ONE post's language, and which post that
 * was. A recycled row holds the previous post's override until it writes its
 * own; `postId` is what makes that harmless.
 */
interface ReaderOverride {
  postId: string | undefined;
  selectedTag: string | null;
  fetchedBodies: FetchedBodies;
  isTranslating: boolean;
}

const NO_OVERRIDE: ReaderOverride = {
  postId: undefined,
  selectedTag: null,
  fetchedBodies: NO_FETCHED_BODIES,
  isTranslating: false,
};

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
 */
export function usePostLanguage(
  content: PostContent,
  postId: string | undefined,
  postLanguage?: string,
): PostLanguageState {
  const { t, i18n } = useTranslation();
  const readerLanguage = i18n.language;
  const autoTranslateEnabled = useAutoTranslateStore((s) => s.enabled);

  /**
   * THE OVERRIDE IS STAMPED WITH THE POST IT BELONGS TO, and that stamp is the
   * whole design.
   *
   * A feed row is recycled: FlashList hands the same component instance a
   * different post, and the reader's translation of the PREVIOUS post must not
   * survive that. The obvious way to do it is React's documented "adjust state
   * during render" — notice the id changed, call the setters, let React throw
   * the render away and run it again. It is correct, and on this component it is
   * expensive: measured on a Pixel 10 Pro, a scroll through the feed produced
   * ~97 `PostItem` renders where 67 were needed, and removing this one
   * adjustment accounted for every one of the extra 31 — a whole second render
   * of a row (header, body, media, action bar) per recycle.
   *
   * So nothing is reset. The override carries the id it was made for, and a row
   * showing a different post simply does not read it: the reset is a comparison,
   * not a render. An Effect would be worse than either — it lands after paint,
   * so the recycled row would show the previous post's translation for a frame.
   */
  const [override, setOverride] = useState<ReaderOverride>(NO_OVERRIDE);
  const current = override.postId === postId ? override : NO_OVERRIDE;
  const { selectedTag, fetchedBodies, isTranslating } = current;

  /**
   * Write into this post's override, starting from a blank one if what is held
   * belongs to the post this row used to show.
   */
  const patchOverride = useCallback(
    (patch: Partial<ReaderOverride>) => {
      setOverride((previous) => ({
        ...(previous.postId === postId ? previous : NO_OVERRIDE),
        ...patch,
        postId,
      }));
    },
    [postId],
  );

  /**
   * Which post auto-translate has already been offered for. A ref, because
   * "already tried" must not repaint anything — and stamped, for the same reason
   * the override above is: a recycled row is a different post and gets its own
   * attempt.
   */
  const autoTranslateAttempted = useRef<string | undefined>(undefined);

  const servedTag = servedLanguageTag(content, postLanguage);

  const options = useMemo(
    () => buildPostLanguageOptions(content, postLanguage, fetchedBodies),
    [content, postLanguage, fetchedBodies],
  );

  const translateInto = useCallback(
    async (tag: string) => {
      if (!postId) return;
      patchOverride({ isTranslating: true });
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
          setOverride((previous) => {
            const base = previous.postId === postId ? previous : NO_OVERRIDE;
            return {
              ...base,
              postId,
              fetchedBodies: { ...base.fetchedBodies, [storedTag]: translated },
              // Follow the selection over to the tag the SERVER canonicalized to.
              selectedTag: storedTag,
            };
          });
          return;
        }
        patchOverride({ selectedTag: null });
        toast(t('translation.failed'), { type: 'error' });
      } catch (error: unknown) {
        patchOverride({ selectedTag: null });
        const status = (error as { response?: { status?: number } })?.response?.status;
        toast(t(status === 429 ? 'translation.rateLimited' : 'translation.failed'), { type: 'error' });
      } finally {
        patchOverride({ isTranslating: false });
      }
    },
    [postId, t, patchOverride],
  );

  const selectLanguage = useCallback(
    (tag: string) => {
      if (tag === servedTag) {
        patchOverride({ selectedTag: null });
        return;
      }
      patchOverride({ selectedTag: tag });
      // An author variant (and any body already fetched) is on hand — switching
      // to it must not cost a request.
      const known = options.find((option) => option.tag === tag);
      if (known?.text) return;
      void translateInto(tag);
    },
    [servedTag, options, translateInto, patchOverride],
  );

  const toggleReaderTranslation = useCallback(() => {
    if (selectedTag !== null) {
      patchOverride({ selectedTag: null });
      return;
    }
    const existing = findOptionForLanguage(options, readerLanguage);
    selectLanguage(existing?.tag ?? readerLanguage);
  }, [selectedTag, options, readerLanguage, selectLanguage]);

  const canTranslate = shouldOfferTranslation({ content, postLanguage, readerLanguage, options });

  // Auto-translate, computed during render and fired once per post. It stays
  // silent when the author already wrote this post in the reader's language.
  if (
    autoTranslateEnabled &&
    autoTranslateAttempted.current !== postId &&
    selectedTag === null &&
    !isTranslating &&
    postId &&
    canTranslate
  ) {
    autoTranslateAttempted.current = postId;
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
    canTranslate,
    selectLanguage,
    toggleReaderTranslation,
  };
}
