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
  EVENT_ATTACHMENT_KEY,
  ROOM_ATTACHMENT_KEY,
  createMediaAttachmentKey,
} from '@/utils/composeUtils';
import { hasDraftContent, isCompleteEvent, type ComposeContent } from '@/utils/composeContent';
import type { ArticleData } from './useArticleManager';
import type { Draft, DraftInput } from './useDrafts';
import type { EventData } from './useEventManager';
import type { LocationData } from './useLocationManager';
import type { PodcastAttachmentData } from './usePodcastManager';
import type { JobAttachmentData } from './useJobAttachmentManager';
import type { RoomAttachmentData } from './useRoomManager';
import type { Source } from './useSourcesManager';
import type { DraftThreadItem } from './useThreadManager';
import {
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

const readLocation = (value: unknown): LocationData | null => {
  if (!isRecord(value)) return null;
  return {
    latitude: readNumber(value.latitude) ?? 0,
    longitude: readNumber(value.longitude) ?? 0,
    address: readString(value.address),
  };
};

const readSources = (value: unknown): Source[] =>
  readArray(value)
    .filter(isRecord)
    .map((source) => ({
      id: readString(source.id) ?? '',
      title: readString(source.title) ?? '',
      url: readString(source.url) ?? '',
    }));

/** An article with neither a title nor a body is no article. */
const readArticle = (value: unknown): ArticleData | null => {
  if (!isRecord(value)) return null;
  const title = readString(value.title) ?? '';
  const body = readString(value.body) ?? '';
  return title || body ? { title, body } : null;
};

const readPodcast = (value: unknown): PodcastAttachmentData | null => {
  if (!isRecord(value)) return null;
  const syraPodcastId = readString(value.syraPodcastId);
  if (!syraPodcastId) return null;
  return {
    syraPodcastId,
    title: readString(value.title) ?? '',
    author: readString(value.author),
    artworkUrl: readString(value.artworkUrl),
  };
};

/** Only an event the composer could have attached: one with a name and a date. */
const readEvent = (value: unknown): EventData | null => {
  if (!isRecord(value)) return null;
  const event: EventData = {
    name: readString(value.name) ?? '',
    date: readString(value.date) ?? '',
    location: readString(value.location),
    description: readString(value.description),
  };
  return isCompleteEvent(event) ? event : null;
};

const ROOM_STATUSES = ['scheduled', 'live', 'ended'] as const;
const ROOM_TYPES = ['talk', 'stage', 'broadcast'] as const;

const readOneOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  allowed.find((candidate) => candidate === value);

/** A reference to a room that exists: it needs its id and its title. */
const readRoom = (value: unknown): RoomAttachmentData | null => {
  if (!isRecord(value)) return null;
  const roomId = readString(value.roomId);
  const title = readString(value.title);
  if (!roomId || !title?.trim()) return null;
  return {
    roomId,
    title,
    status: readOneOf(value.status, ROOM_STATUSES),
    type: readOneOf(value.type, ROOM_TYPES),
    topic: readString(value.topic),
    host: readString(value.host),
  };
};

/**
 * The stored attachment order, reconciled against what the draft actually
 * restored: keys for attachments that did not survive are dropped, and a
 * restored attachment the stored order never named is appended.
 */
const reconcileAttachmentOrder = (stored: unknown, available: string[]): string[] => {
  const order = readArray(stored)
    .filter(isString)
    .filter((key, index, keys) => available.includes(key) && keys.indexOf(key) === index);
  return [...order, ...available.filter((key) => !order.includes(key))];
};

/** The carousel keys of the attachments one restored box holds. */
const attachmentKeysOf = (box: {
  showPoll: boolean;
  article: ArticleData | null;
  event: EventData | null;
  room: RoomAttachmentData | null;
  podcast: PodcastAttachmentData | null;
  job?: JobAttachmentData | null;
  location: LocationData | null;
  sources: Source[];
  media: ComposerMediaItem[];
}): string[] => [
  ...(box.showPoll ? [POLL_ATTACHMENT_KEY] : []),
  ...(box.article ? [ARTICLE_ATTACHMENT_KEY] : []),
  ...(box.event ? [EVENT_ATTACHMENT_KEY] : []),
  ...(box.room ? [ROOM_ATTACHMENT_KEY] : []),
  ...(box.podcast ? [PODCAST_ATTACHMENT_KEY] : []),
  ...(box.job ? [JOB_ATTACHMENT_KEY] : []),
  ...(box.location ? [LOCATION_ATTACHMENT_KEY] : []),
  ...(box.sources.some((source) => source.url.trim().length > 0) ? [SOURCES_ATTACHMENT_KEY] : []),
  ...box.media.map((media) => createMediaAttachmentKey(media.id)),
];

const writeLocation = (location: LocationData | null) =>
  location
    ? { latitude: location.latitude, longitude: location.longitude, address: location.address }
    : null;

const writeSources = (sources: Source[]) =>
  sources.map((source) => ({ id: source.id, title: source.title, url: source.url }));

const writeArticle = (article: ArticleData | null) =>
  article
    ? {
      ...(article.title ? { title: article.title } : {}),
      ...(article.body ? { body: article.body } : {}),
    }
    : null;

const writePodcast = (podcast: PodcastAttachmentData | null) =>
  podcast
    ? {
      syraPodcastId: podcast.syraPodcastId,
      title: podcast.title,
      ...(podcast.author ? { author: podcast.author } : {}),
      ...(podcast.artworkUrl ? { artworkUrl: podcast.artworkUrl } : {}),
    }
    : null;

const writeEvent = (event: EventData | null) => (event ? { ...event } : null);

const writeRoom = (room: RoomAttachmentData | null) => (room ? { ...room } : null);

/**
 * The composer state a draft is built from — the live values, not the persisted
 * shape. Shared by the three functions that read it so the contract is stated
 * once instead of re-spelled per function.
 */
export interface ComposeDraftRefs extends ComposeContent {
  pollTitle: string;
  showPollCreator: boolean;
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
    event: EventData | null;
    room: RoomAttachmentData | null;
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
  /** The draft write in flight, if any — every later write and delete settles it first. */
  const pendingSaveRef = useRef<Promise<void> | null>(null);
  /**
   * True while something else owns the draft and an autosave must not touch it:
   * from the moment a publish starts until the composer has been emptied, and
   * from a discard on (the composer is closing).
   */
  const suspendedRef = useRef(false);

  const setCurrentDraftId = useCallback((draftId: string | null) => {
    draftIdRef.current = draftId;
    setCurrentDraftIdState(draftId);
  }, []);

  const cancelScheduledAutoSave = useCallback(() => {
    if (autoSaveTimeoutRef.current) {
      clearTimeout(autoSaveTimeoutRef.current);
      autoSaveTimeoutRef.current = null;
    }
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
      location: writeLocation(refs.location),
      sources: writeSources(refs.sources),
      article: writeArticle(refs.article),
      podcast: writePodcast(refs.podcast),
      job: refs.job ? { ...refs.job } : null,
      event: writeEvent(refs.event),
      room: writeRoom(refs.room),
      threadItems: refs.threadItems.map(item => ({
        id: item.id,
        text: item.text,
        mediaIds: item.mediaIds.map(m => ({ id: m.id, type: m.type })),
        pollOptions: item.pollOptions || [],
        pollTitle: item.pollTitle || '',
        showPollCreator: item.showPollCreator ||
          (item.pollOptions && item.pollOptions.length > 0 &&
           item.pollOptions.some(opt => opt.trim().length > 0)),
        location: writeLocation(item.location),
        mentions: reconcileMentionData(
          [item.text, ...variantTextsForItem(refs.variants, item.id)],
          item.mentions,
        ).map((m: MentionData) => ({
          userId: m.userId,
          handle: m.username,
          name: m.displayName,
        })),
        sources: writeSources(item.sources),
        article: writeArticle(item.article),
        event: writeEvent(item.event),
        room: writeRoom(item.room),
        podcast: writePodcast(item.podcast),
        attachmentOrder: item.attachmentOrder,
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

  /**
   * Write the composer's content to THE draft of this editing session — the one
   * {@link draftIdRef} names, created on the first write — or delete that draft
   * when the composer has been emptied. Writes are chained, never concurrent:
   * each runs after the one before it has settled and reads the draft id only
   * then, so a second write always updates the draft the first one created
   * instead of starting another (OxyHQ/Mention#1124).
   */
  const writeDraft = useCallback(async (refs: ComposeDraftRefs) => {
    const write = async () => {
      const draftId = draftIdRef.current;
      if (!hasDraftContent(refs)) {
        if (draftId) {
          await deleteDraft(draftId);
          setCurrentDraftId(null);
        }
        return;
      }
      const savedId = await saveDraft(buildDraftData({ ...refs, currentDraftId: draftId }));
      setCurrentDraftId(savedId);
    };
    // With nothing in flight the write starts NOW, not a microtask later.
    const run = pendingSaveRef.current ? pendingSaveRef.current.then(write) : write();
    const settled = run.catch(() => undefined);
    pendingSaveRef.current = settled;
    try {
      await run;
    } finally {
      if (pendingSaveRef.current === settled) pendingSaveRef.current = null;
    }
  }, [buildDraftData, saveDraft, deleteDraft, setCurrentDraftId]);

  /** The debounced background save. A failure is logged; the next change retries it. */
  const autoSave = useCallback(async (refs: ComposeDraftRefs) => {
    // A post being published is not a draft. Saving it now would persist the
    // very text the publish is about to put in the feed.
    if (suspendedRef.current) return;
    try {
      await writeDraft(refs);
    } catch (error) {
      logger.error('Error auto-saving draft', error);
    }
  }, [writeDraft]);

  /**
   * "Save draft": write NOW, into the same draft the autosave has been keeping,
   * and throw if the write fails — the author asked for it, so a failure is
   * theirs to see, not a log line.
   */
  const saveNow = useCallback(async (refs: ComposeDraftRefs) => {
    cancelScheduledAutoSave();
    await writeDraft(refs);
  }, [cancelScheduledAutoSave, writeDraft]);

  /**
   * "Discard": the work of this session is thrown away, including whatever the
   * autosave already stored. The pending debounce is cancelled, a write already
   * in flight is allowed to land and then deleted, and no autosave runs again —
   * the composer is closing.
   */
  const discard = useCallback(async () => {
    suspendedRef.current = true;
    cancelScheduledAutoSave();
    if (pendingSaveRef.current) await pendingSaveRef.current;
    const draftId = draftIdRef.current;
    setCurrentDraftId(null);
    if (draftId) await deleteDraft(draftId);
  }, [cancelScheduledAutoSave, deleteDraft, setCurrentDraftId]);

  /**
   * A publish is starting: stop autosaving. The pending debounce is cancelled
   * and any autosave that fires before the publish settles is a no-op.
   */
  const beginPublish = useCallback(() => {
    suspendedRef.current = true;
    cancelScheduledAutoSave();
  }, [cancelScheduledAutoSave]);

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
    suspendedRef.current = true;
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
    suspendedRef.current = false;
    await autoSave(refs);
  }, [autoSave]);

  /** The composer has been emptied after a publish; autosave may resume. */
  const endPublish = useCallback(() => {
    suspendedRef.current = false;
  }, []);

  const loadDraft = useCallback((draft: StoredDraft) => {
    const mediaIdsData = readMediaItems(draft.mediaIds);

    const pollOpts = readArray(draft.pollOptions).filter(isString);
    const shouldShowPoll = draft.showPollCreator === true || pollOpts.length > 0;

    const locationData = readLocation(draft.location);
    const sourcesData = readSources(draft.sources);
    const articleData = readArticle(draft.article);
    const podcastData = readPodcast(draft.podcast);
    const eventData = readEvent(draft.event);
    const roomData = readRoom(draft.room);

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

    const sanitizedAttachmentOrder = reconcileAttachmentOrder(
      draft.attachmentOrder,
      attachmentKeysOf({
        showPoll: shouldShowPoll,
        article: articleData,
        event: eventData,
        room: roomData,
        podcast: podcastData,
        job: jobData,
        location: locationData,
        sources: sourcesData,
        media: mediaIdsData,
      }),
    );

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
        const mediaIds = readMediaItems(item.mediaIds);
        const pollOptions = readArray(item.pollOptions).filter(isString);
        const showPollCreator = item.showPollCreator === true;
        const location = readLocation(item.location);
        const sources = readSources(item.sources);
        const article = readArticle(item.article);
        const event = readEvent(item.event);
        const room = readRoom(item.room);
        const podcast = readPodcast(item.podcast);
        return {
          id,
          text,
          mediaIds,
          pollOptions,
          pollTitle: readString(item.pollTitle) ?? '',
          showPollCreator,
          location,
          mentions: reconcileMentionData(
            [text, ...draftVariantTextsForItem(draft.languages, id)],
            readMentions(item.mentions),
          ),
          sources,
          article,
          event,
          room,
          podcast,
          attachmentOrder: reconcileAttachmentOrder(
            item.attachmentOrder,
            attachmentKeysOf({
              showPoll: showPollCreator || pollOptions.length > 0,
              article,
              event,
              room,
              podcast,
              location,
              sources,
              media: mediaIds,
            }),
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
      articleDraftTitle: articleData?.title ?? '',
      articleDraftBody: articleData?.body ?? '',
      podcast: podcastData,
      job: jobData,
      event: eventData,
      room: roomData,
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
    saveNow,
    discard,
    loadDraft,
    beginPublish,
    publishSucceeded,
    publishFailed,
    endPublish,
  };
};
