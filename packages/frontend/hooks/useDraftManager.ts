import { useState, useCallback, useRef } from 'react';
import {
  reconcileMentionData,
  type MentionData,
} from '@/utils/mentions';
import { logger } from '@oxyhq/core/logger';
import {
  ComposerMediaItem,
  toComposerMediaType,
  POLL_ATTACHMENT_KEY,
  ARTICLE_ATTACHMENT_KEY,
  LOCATION_ATTACHMENT_KEY,
  SOURCES_ATTACHMENT_KEY,
  PODCAST_ATTACHMENT_KEY,
  createMediaAttachmentKey,
} from '@/utils/composeUtils';
import type { ArticleData } from './useArticleManager';
import type { Draft, DraftInput } from './useDrafts';
import type { LocationData } from './useLocationManager';
import type { PodcastAttachmentData } from './usePodcastManager';
import type { Source } from './useSourcesManager';
import type { DraftThreadItem, ThreadItem } from './useThreadManager';
import {
  hasVariantWork,
  draftVariantTextsForItem,
  MAIN_ITEM_ID,
  serializeVariants,
  variantTextsForItem,
  type ComposeVariantsState,
} from '@/utils/composeVariants';

/**
 * A draft AS IT COMES OUT OF STORAGE.
 *
 * Drafts are persisted raw and unversioned, so a stored blob may predate any
 * field's current shape — the media list, for one, used to hold bare file id
 * strings. {@link Draft} describes what the composer WRITES; this describes what
 * the reader may actually find, which is why every value below is narrowed
 * rather than trusted.
 */
type StoredDraft = { [K in keyof Draft]?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === 'string';

const readArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Stored media entries, tolerating the legacy bare-file-id form. */
const readMediaItems = (value: unknown): ComposerMediaItem[] =>
  readArray(value)
    .map((entry) => {
      if (isString(entry)) {
        return { id: entry, type: toComposerMediaType(undefined, undefined) };
      }
      const item = isRecord(entry) ? entry : {};
      return {
        id: readString(item.id) ?? '',
        type: toComposerMediaType(
          readString(item.type),
          readString(item.mime) ?? readString(item.contentType),
        ),
      };
    })
    .filter((item) => item.id.length > 0);

/** Stored mentions, mapped onto the composer's {@link MentionData} shape. */
const readMentions = (value: unknown): MentionData[] =>
  readArray(value)
    .filter(isRecord)
    .map((mention) => ({
      userId: readString(mention.userId) ?? '',
      username: readString(mention.handle) ?? '',
      displayName: readString(mention.name) ?? '',
    }));

/**
 * The composer state a draft is built from — the live values, not the persisted
 * shape. Shared by the three functions that read it so the contract is stated
 * once instead of re-spelled per function.
 */
interface ComposeDraftRefs {
  postContent: string;
  mediaIds: ComposerMediaItem[];
  pollOptions: string[];
  pollTitle: string;
  showPollCreator: boolean;
  location: LocationData | null;
  sources: Source[];
  article: ArticleData | null;
  podcast: PodcastAttachmentData | null;
  threadItems: ThreadItem[];
  mentions: MentionData[];
  postingMode: 'thread' | 'beast';
  attachmentOrder: string[];
  scheduledAt: Date | null;
  currentDraftId: string | null;
  variants: ComposeVariantsState;
}

interface DraftManagerProps {
  saveDraft: (draft: DraftInput) => Promise<string>;
  deleteDraft: (draftId: string) => Promise<void>;
  onDraftLoad: (draft: {
    postContent: string;
    mediaIds: ComposerMediaItem[];
    pollOptions: string[];
    pollTitle: string;
    showPollCreator: boolean;
    location: LocationData | null;
    sources: Source[];
    article: ArticleData | null;
    articleDraftTitle: string;
    articleDraftBody: string;
    podcast: PodcastAttachmentData | null;
    scheduledAt: Date | null;
    attachmentOrder: string[];
    mentions: MentionData[];
    postingMode: 'thread' | 'beast';
    threadItems: DraftThreadItem[];
    /**
     * The draft's persisted variant buffer, exactly as it came out of storage.
     * Unknown by design — an old draft has none, and the composer's tolerant
     * reader is the single place that decides what a stored blob means.
     */
    languages: unknown;
  }) => void;
}

export const useDraftManager = ({
  saveDraft,
  deleteDraft,
  onDraftLoad,
}: DraftManagerProps) => {
  const [currentDraftId, setCurrentDraftId] = useState<string | null>(null);
  const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const buildDraftData = useCallback((refs: ComposeDraftRefs): DraftInput => {
    const shouldShowPollCreator = refs.showPollCreator ||
      (refs.pollOptions.length > 0 && refs.pollOptions.some(opt => opt.trim().length > 0));
    const languages = serializeVariants(refs.variants);
    const mainMentions = reconcileMentionData(
      [
        refs.postContent,
        ...variantTextsForItem(refs.variants, MAIN_ITEM_ID),
      ],
      refs.mentions,
    );

    return {
      id: refs.currentDraftId || undefined,
      postContent: refs.postContent,
      languages,
      mediaIds: refs.mediaIds.map(m => ({ id: m.id, type: m.type })),
      pollOptions: refs.pollOptions || [],
      pollTitle: refs.pollTitle || '',
      showPollCreator: shouldShowPollCreator,
      location: refs.location ? {
        latitude: refs.location.latitude,
        longitude: refs.location.longitude,
        address: refs.location.address,
      } : null,
      sources: refs.sources.map((source) => ({ 
        id: source.id, 
        title: source.title, 
        url: source.url 
      })),
      article: refs.article ? {
        ...(refs.article.title ? { title: refs.article.title } : {}),
        ...(refs.article.body ? { body: refs.article.body } : {}),
      } : undefined,
      podcast: refs.podcast ? {
        syraPodcastId: refs.podcast.syraPodcastId,
        title: refs.podcast.title,
        ...(refs.podcast.author ? { author: refs.podcast.author } : {}),
        ...(refs.podcast.artworkUrl ? { artworkUrl: refs.podcast.artworkUrl } : {}),
      } : undefined,
      threadItems: refs.threadItems.map(item => ({
        id: item.id,
        text: item.text,
        mediaIds: item.mediaIds.map(m => ({ id: m.id, type: m.type })),
        pollOptions: item.pollOptions || [],
        pollTitle: item.pollTitle || '',
        showPollCreator: item.showPollCreator ||
          (item.pollOptions && item.pollOptions.length > 0 &&
           item.pollOptions.some(opt => opt.trim().length > 0)),
        location: item.location ? {
          latitude: item.location.latitude,
          longitude: item.location.longitude,
          address: item.location.address,
        } : null,
        mentions: reconcileMentionData(
          [item.text, ...variantTextsForItem(refs.variants, item.id)],
          item.mentions,
        ).map((m: MentionData) => ({
          userId: m.userId,
          handle: m.username,
          name: m.displayName,
        })),
      })),
      mentions: mainMentions.map(m => ({
        userId: m.userId,
        handle: m.username,
        name: m.displayName,
      })),
      postingMode: refs.postingMode,
      attachmentOrder: refs.attachmentOrder,
      scheduledAt: refs.scheduledAt ? refs.scheduledAt.toISOString() : null,
    };
  }, []);

  const hasContent = useCallback((refs: ComposeDraftRefs) => {
    return hasVariantWork(refs.variants) ||
      refs.postContent.trim().length > 0 ||
      refs.mediaIds.length > 0 ||
      (refs.pollOptions.length > 0 && refs.pollOptions.some(opt => opt.trim().length > 0)) ||
      refs.location !== null ||
      (refs.article && ((refs.article.title && refs.article.title.trim().length > 0) ||
                        (refs.article.body && refs.article.body.trim().length > 0))) ||
      Boolean(refs.podcast?.syraPodcastId) ||
      refs.sources.some(source => (source.title && source.title.trim().length > 0) || 
                                   (source.url && source.url.trim().length > 0)) ||
      refs.threadItems.some(item => item.text.trim().length > 0 || item.mediaIds.length > 0 ||
        (item.pollOptions.length > 0 && item.pollOptions.some(opt => opt.trim().length > 0)) ||
        item.location !== null);
  }, []);

  const autoSave = useCallback(async (refs: ComposeDraftRefs) => {
    if (!hasContent(refs)) {
      if (refs.currentDraftId) {
        await deleteDraft(refs.currentDraftId);
        setCurrentDraftId(null);
      }
      return;
    }

    try {
      const draftData = buildDraftData(refs);
      const draftId = await saveDraft(draftData);
      setCurrentDraftId(draftId);
    } catch (error) {
      logger.error('Error auto-saving draft', error);
    }
  }, [hasContent, buildDraftData, saveDraft, deleteDraft]);

  const loadDraft = useCallback((draft: StoredDraft) => {
    const mediaIdsData = readMediaItems(draft.mediaIds);

    const pollOpts = readArray(draft.pollOptions).filter(isString);
    const shouldShowPoll = draft.showPollCreator === true || pollOpts.length > 0;

    let locationData: LocationData | null = null;
    const storedLocation = isRecord(draft.location) ? draft.location : null;
    if (storedLocation) {
      locationData = {
        latitude: readNumber(storedLocation.latitude) ?? 0,
        longitude: readNumber(storedLocation.longitude) ?? 0,
        address: readString(storedLocation.address),
      };
    }

    const sourcesData: Source[] = readArray(draft.sources)
      .filter(isRecord)
      .map((source) => ({
        id: readString(source.id) ?? '',
        title: readString(source.title) ?? '',
        url: readString(source.url) ?? '',
      }));

    let articleData: ArticleData | null = null;
    let articleDraftTitle = '';
    let articleDraftBody = '';
    const storedArticle = isRecord(draft.article) ? draft.article : null;
    if (storedArticle) {
      const title = readString(storedArticle.title) ?? '';
      const body = readString(storedArticle.body) ?? '';
      if (title || body) {
        articleData = { title, body };
        articleDraftTitle = title;
        articleDraftBody = body;
      }
    }

    let podcastData: PodcastAttachmentData | null = null;
    const storedPodcast = isRecord(draft.podcast) ? draft.podcast : null;
    const syraPodcastId = storedPodcast ? readString(storedPodcast.syraPodcastId) : undefined;
    if (storedPodcast && syraPodcastId) {
      podcastData = {
        syraPodcastId,
        title: readString(storedPodcast.title) ?? '',
        author: readString(storedPodcast.author),
        artworkUrl: readString(storedPodcast.artworkUrl),
      };
    }

    let scheduledAtData: Date | null = null;
    const storedScheduledAt = readString(draft.scheduledAt);
    if (storedScheduledAt) {
      const parsed = new Date(storedScheduledAt);
      if (!Number.isNaN(parsed.getTime())) {
        scheduledAtData = parsed;
      }
    }

    // Build attachment order
    const availableAttachmentKeys: string[] = [];
    if (shouldShowPoll) {
      availableAttachmentKeys.push(POLL_ATTACHMENT_KEY);
    }
    if (articleData) {
      availableAttachmentKeys.push(ARTICLE_ATTACHMENT_KEY);
    }
    if (podcastData) {
      availableAttachmentKeys.push(PODCAST_ATTACHMENT_KEY);
    }
    if (locationData) {
      availableAttachmentKeys.push(LOCATION_ATTACHMENT_KEY);
    }
    if (sourcesData.some((source) => source.url.trim().length > 0)) {
      availableAttachmentKeys.push(SOURCES_ATTACHMENT_KEY);
    }
    mediaIdsData.forEach((media) => {
      availableAttachmentKeys.push(createMediaAttachmentKey(media.id));
    });

    const sanitizedAttachmentOrder: string[] = [];
    readArray(draft.attachmentOrder).filter(isString).forEach((key) => {
      if (availableAttachmentKeys.includes(key)) {
        sanitizedAttachmentOrder.push(key);
      }
    });
    availableAttachmentKeys.forEach(key => {
      if (!sanitizedAttachmentOrder.includes(key)) {
        sanitizedAttachmentOrder.push(key);
      }
    });

    const postContent = readString(draft.postContent) ?? '';
    const mentionsData = reconcileMentionData(
      [
        postContent,
        ...draftVariantTextsForItem(draft.languages, MAIN_ITEM_ID),
      ],
      readMentions(draft.mentions),
    );

    const threadItemsData: DraftThreadItem[] = readArray(draft.threadItems)
      .filter(isRecord)
      .map((item) => {
        const id = readString(item.id) ?? '';
        const text = readString(item.text) ?? '';
        const storedLocation = isRecord(item.location) ? item.location : null;
        return {
          id,
          text,
          mediaIds: readMediaItems(item.mediaIds),
          pollOptions: readArray(item.pollOptions).filter(isString),
          pollTitle: readString(item.pollTitle) ?? '',
          showPollCreator: item.showPollCreator === true,
          location: storedLocation
            ? {
              latitude: readNumber(storedLocation.latitude) ?? 0,
              longitude: readNumber(storedLocation.longitude) ?? 0,
              address: readString(storedLocation.address),
            }
            : null,
          mentions: reconcileMentionData(
            [text, ...draftVariantTextsForItem(draft.languages, id)],
            readMentions(item.mentions),
          ),
        };
      });

    onDraftLoad({
      postContent,
      mediaIds: mediaIdsData,
      pollOptions: pollOpts,
      pollTitle: readString(draft.pollTitle) ?? '',
      showPollCreator: shouldShowPoll,
      location: locationData,
      sources: sourcesData,
      article: articleData,
      articleDraftTitle,
      articleDraftBody,
      podcast: podcastData,
      scheduledAt: scheduledAtData,
      attachmentOrder: sanitizedAttachmentOrder,
      mentions: mentionsData,
      postingMode: draft.postingMode === 'beast' ? 'beast' : 'thread',
      threadItems: threadItemsData,
      languages: draft.languages,
    });

    setCurrentDraftId(readString(draft.id) ?? null);
  }, [onDraftLoad]);

  return {
    currentDraftId,
    setCurrentDraftId,
    autoSaveTimeoutRef,
    autoSave,
    loadDraft,
  };
};
