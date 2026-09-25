import { useState, useCallback, useRef } from 'react';
import {
  reconcileMentionData,
  type MentionData,
} from '@/utils/mentions';
import { logger } from '@oxy.so/core/logger';
import type { MentionJobLocation } from '@mention/shared-types';
import { isCountryCode } from '@mention/shared-types/job';
import {
  ComposerMediaItem,
  toComposerMediaType,
  POLL_ATTACHMENT_KEY,
  ARTICLE_ATTACHMENT_KEY,
  LOCATION_ATTACHMENT_KEY,
  SOURCES_ATTACHMENT_KEY,
  PODCAST_ATTACHMENT_KEY,
  JOB_ATTACHMENT_KEY,
  createMediaAttachmentKey,
} from '@/utils/composeUtils';
import type { ArticleData } from './useArticleManager';
import type { Draft, DraftInput } from './useDrafts';
import type { LocationData } from './useLocationManager';
import type { PodcastAttachmentData } from './usePodcastManager';
import type { JobAttachmentData } from './useJobAttachmentManager';
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

/**
 * A job attachment's location as a draft stored it. Drafts saved before job
 * locations became structured held a free-text string; that is dropped rather
 * than shown, and the card simply renders without a location.
 */
const readJobLocation = (value: unknown): MentionJobLocation | undefined => {
  if (!isRecord(value) || !isCountryCode(value.countryCode)) return undefined;
  return {
    countryCode: value.countryCode,
    placeId: readString(value.placeId),
    region: readString(value.region),
    city: readString(value.city),
  };
};

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
export interface ComposeDraftRefs {
  postContent: string;
  mediaIds: ComposerMediaItem[];
  pollOptions: string[];
  pollTitle: string;
  showPollCreator: boolean;
  location: LocationData | null;
  sources: Source[];
  article: ArticleData | null;
  podcast: PodcastAttachmentData | null;
  /** ROOT post only — see `useJobAttachmentManager.ts`. */
  job: JobAttachmentData | null;
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
    job: JobAttachmentData | null;
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
  const [currentDraftId, setCurrentDraftIdState] = useState<string | null>(null);
  const autoSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The draft id as of NOW, not as of the last render. A publish reads it after
   * awaiting the network, by which time an autosave that fired mid-request may
   * have created the draft — the rendered `currentDraftId` its closure captured
   * would still say there is none, and that draft would outlive the post it
   * duplicates.
   */
  const draftIdRef = useRef<string | null>(null);
  /** The autosave write in flight, if any — a publish settles it before deleting. */
  const pendingSaveRef = useRef<Promise<void> | null>(null);
  /** True from the moment a publish starts until the composer has been emptied. */
  const publishingRef = useRef(false);

  const setCurrentDraftId = useCallback((draftId: string | null) => {
    draftIdRef.current = draftId;
    setCurrentDraftIdState(draftId);
  }, []);

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
      job: refs.job ? { ...refs.job } : undefined,
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
      Boolean(refs.job?.mentionJobId) ||
      refs.sources.some(source => (source.title && source.title.trim().length > 0) ||
                                   (source.url && source.url.trim().length > 0)) ||
      refs.threadItems.some(item => item.text.trim().length > 0 || item.mediaIds.length > 0 ||
        (item.pollOptions.length > 0 && item.pollOptions.some(opt => opt.trim().length > 0)) ||
        item.location !== null);
  }, []);

  const autoSave = useCallback(async (refs: ComposeDraftRefs) => {
    // A post being published is not a draft. Saving it now would persist the
    // very text the publish is about to put in the feed.
    if (publishingRef.current) return;
    const draftId = draftIdRef.current ?? refs.currentDraftId;

    if (!hasContent(refs)) {
      if (draftId) {
        await deleteDraft(draftId);
        setCurrentDraftId(null);
      }
      return;
    }

    const save = (async () => {
      try {
        const draftData = buildDraftData({ ...refs, currentDraftId: draftId });
        const savedId = await saveDraft(draftData);
        setCurrentDraftId(savedId);
      } catch (error) {
        logger.error('Error auto-saving draft', error);
      }
    })();
    pendingSaveRef.current = save;
    try {
      await save;
    } finally {
      if (pendingSaveRef.current === save) pendingSaveRef.current = null;
    }
  }, [hasContent, buildDraftData, saveDraft, deleteDraft, setCurrentDraftId]);

  /**
   * A publish is starting: stop autosaving. The pending debounce is cancelled
   * and any autosave that fires before the publish settles is a no-op.
   */
  const beginPublish = useCallback(() => {
    publishingRef.current = true;
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
      autoSaveTimeoutRef.current = null;
    }
  }, []);

  /**
   * The publish succeeded, so the draft it came from is spent: let any autosave
   * already in flight land, then delete whatever draft exists NOW (see
   * {@link draftIdRef}). Autosave stays off until {@link endPublish} — the
   * composer still holds the published text until it resets itself.
   *
   * A failed delete is logged, not thrown: the post is out, and the author must
   * not be told otherwise because a local cleanup failed.
   */
  const publishSucceeded = useCallback(async () => {
    publishingRef.current = true;
    if (pendingSaveRef.current) await pendingSaveRef.current;
    const draftId = draftIdRef.current;
    setCurrentDraftId(null);
    if (!draftId) return;
    try {
      await deleteDraft(draftId);
    } catch (error) {
      logger.error('Error deleting a published draft', error);
    }
  }, [deleteDraft, setCurrentDraftId]);

  /**
   * The publish failed: the author's work is still a draft. Autosave resumes,
   * and the work is saved NOW — {@link beginPublish} cancelled the debounce
   * that would otherwise have saved it, and nothing about a failed request
   * changes the composer's content to re-arm it.
   */
  const publishFailed = useCallback(async (refs: ComposeDraftRefs) => {
    publishingRef.current = false;
    await autoSave(refs);
  }, [autoSave]);

  /** The composer has been emptied after a publish; autosave may resume. */
  const endPublish = useCallback(() => {
    publishingRef.current = false;
  }, []);

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

    let jobData: JobAttachmentData | null = null;
    const storedJob = isRecord(draft.job) ? draft.job : null;
    const mentionJobId = storedJob ? readString(storedJob.mentionJobId) : undefined;
    const jobEmployerOxyUserId = storedJob ? readString(storedJob.employerOxyUserId) : undefined;
    const jobCanonicalUrl = storedJob ? readString(storedJob.canonicalUrl) : undefined;
    const jobStatus = storedJob ? readString(storedJob.status) : undefined;
    if (storedJob && mentionJobId && jobEmployerOxyUserId && jobCanonicalUrl && jobStatus) {
      jobData = {
        mentionJobId,
        title: readString(storedJob.title) ?? '',
        employerName: readString(storedJob.employerName) ?? '',
        employerOxyUserId: jobEmployerOxyUserId,
        canonicalUrl: jobCanonicalUrl,
        status: jobStatus as JobAttachmentData['status'],
        location: readJobLocation(storedJob.location),
        workplaceType: readString(storedJob.workplaceType) as JobAttachmentData['workplaceType'],
        employmentType: readString(storedJob.employmentType) as JobAttachmentData['employmentType'],
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
    if (jobData) {
      availableAttachmentKeys.push(JOB_ATTACHMENT_KEY);
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
      job: jobData,
      scheduledAt: scheduledAtData,
      attachmentOrder: sanitizedAttachmentOrder,
      mentions: mentionsData,
      postingMode: draft.postingMode === 'beast' ? 'beast' : 'thread',
      threadItems: threadItemsData,
      languages: draft.languages,
    });

    setCurrentDraftId(readString(draft.id) ?? null);
  }, [onDraftLoad, setCurrentDraftId]);

  return {
    currentDraftId,
    setCurrentDraftId,
    autoSaveTimeoutRef,
    autoSave,
    loadDraft,
    beginPublish,
    publishSucceeded,
    publishFailed,
    endPublish,
  };
};
