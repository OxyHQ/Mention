import { useState, useCallback, useRef } from 'react';
import { reconcileMentionData, type MentionData } from '@/utils/mentions';
import { logger } from '@oxy.so/core/logger';
import type { MentionJobLocation } from '@mention/shared-types';
import { isCountryCode } from '@mention/shared-types/job';
import { ComposerMediaItem, toComposerMediaType } from '@/utils/composeUtils';
import {
  attachmentKeysOf,
  hasArticleContent,
  hasDraftContent,
  hasPodcastContent,
  hasPollOption,
  hasRoomContent,
  isCompleteEvent,
  reconcileAttachmentOrder,
  type ComposeContent,
} from '@/utils/composeContent';
import type { ArticleData } from './useArticleManager';
import type { Draft, DraftBox, DraftInput } from './useDrafts';
import type { EventData } from './useEventManager';
import type { LocationData } from './useLocationManager';
import type { PodcastAttachmentData } from './usePodcastManager';
import type { JobAttachmentData } from './useJobAttachmentManager';
import type { RoomAttachmentData } from './useRoomManager';
import type { Source } from './useSourcesManager';
import type { DraftBoxContent, DraftThreadItem } from './useThreadManager';
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

// Each reader restores only an attachment `composeContent` would count — the
// same predicate the composer, the carousel and the payload use.

const readArticle = (value: unknown): ArticleData | null => {
  if (!isRecord(value)) return null;
  const article = { title: readString(value.title) ?? '', body: readString(value.body) ?? '' };
  return hasArticleContent(article) ? article : null;
};

const readPodcast = (value: unknown): PodcastAttachmentData | null => {
  if (!isRecord(value)) return null;
  const podcast = {
    syraPodcastId: readString(value.syraPodcastId) ?? '',
    title: readString(value.title) ?? '',
    author: readString(value.author),
    artworkUrl: readString(value.artworkUrl),
  };
  return hasPodcastContent(podcast) ? podcast : null;
};

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

const readRoom = (value: unknown): RoomAttachmentData | null => {
  if (!isRecord(value)) return null;
  const room: RoomAttachmentData = {
    roomId: readString(value.roomId) ?? '',
    title: readString(value.title) ?? '',
    status: readOneOf(value.status, ROOM_STATUSES),
    type: readOneOf(value.type, ROOM_TYPES),
    topic: readString(value.topic),
    host: readString(value.host),
  };
  return hasRoomContent(room) ? room : null;
};

/** One box's content as the composer holds it — what {@link writeBox} stores. */
type LiveBox = DraftBoxContent & { itemId: string; text: string };

const toStoredMention = (mention: MentionData) => ({
  userId: mention.userId,
  handle: mention.username,
  name: mention.displayName,
});

/**
 * Store one box — the root post or a thread item, the same way for both, so a
 * field one of them keeps cannot be one the other forgets.
 */
const writeBox = (box: LiveBox, variants: ComposeVariantsState): DraftBox => ({
  mediaIds: box.mediaIds.map((media) => ({ id: media.id, type: media.type })),
  pollOptions: box.pollOptions,
  pollTitle: box.pollTitle,
  showPollCreator: box.showPollCreator || hasPollOption(box.pollOptions),
  location: box.location
    ? {
        latitude: box.location.latitude,
        longitude: box.location.longitude,
        address: box.location.address,
      }
    : null,
  // Only the mentions the text (in any language) still names.
  mentions: reconcileMentionData(
    [box.text, ...variantTextsForItem(variants, box.itemId)],
    box.mentions,
  ).map(toStoredMention),
  sources: box.sources.map((source) => ({ id: source.id, title: source.title, url: source.url })),
  article: box.article
    ? {
        ...(box.article.title ? { title: box.article.title } : {}),
        ...(box.article.body ? { body: box.article.body } : {}),
      }
    : null,
  event: box.event ? { ...box.event } : null,
  room: box.room ? { ...box.room } : null,
  podcast: box.podcast
    ? {
        syraPodcastId: box.podcast.syraPodcastId,
        title: box.podcast.title,
        ...(box.podcast.author ? { author: box.podcast.author } : {}),
        ...(box.podcast.artworkUrl ? { artworkUrl: box.podcast.artworkUrl } : {}),
      }
    : null,
  attachmentOrder: box.attachmentOrder,
});

/**
 * Restore one box from storage, narrowing every field and reconciling its
 * attachment order against the attachments that actually survived. `job` is
 * passed in because only the root post carries one.
 */
const readBox = (
  stored: Record<string, unknown>,
  text: string,
  itemId: string,
  languages: unknown,
  job: JobAttachmentData | null = null,
): DraftBoxContent => {
  const mediaIds = readMediaItems(stored.mediaIds);
  const pollOptions = readArray(stored.pollOptions).filter(isString);
  const showPollCreator = stored.showPollCreator === true || pollOptions.length > 0;
  const location = readLocation(stored.location);
  const sources = readSources(stored.sources);
  const article = readArticle(stored.article);
  const event = readEvent(stored.event);
  const room = readRoom(stored.room);
  const podcast = readPodcast(stored.podcast);
  return {
    mediaIds,
    pollOptions,
    pollTitle: readString(stored.pollTitle) ?? '',
    showPollCreator,
    location,
    mentions: reconcileMentionData(
      [text, ...draftVariantTextsForItem(languages, itemId)],
      readMentions(stored.mentions),
    ),
    sources,
    article,
    event,
    room,
    podcast,
    attachmentOrder: reconcileAttachmentOrder(
      readArray(stored.attachmentOrder).filter(isString),
      attachmentKeysOf({
        showPollCreator,
        article,
        event,
        room,
        podcast,
        job,
        location,
        sources,
        mediaIds,
      }),
    ),
  };
};

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
  onDraftLoad: (
    draft: DraftBoxContent & {
      postContent: string;
      job: JobAttachmentData | null;
      scheduledAt: Date | null;
      postingMode: 'thread' | 'beast';
      threadItems: DraftThreadItem[];
      /**
       * The draft's persisted variant buffer, exactly as it came out of storage.
       * Unknown by design — an old draft has none, and the composer's tolerant
       * reader is the single place that decides what a stored blob means.
       */
      languages: unknown;
    },
  ) => void;
}

export const useDraftManager = ({ saveDraft, deleteDraft, onDraftLoad }: DraftManagerProps) => {
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

  const buildDraftData = useCallback(
    (refs: ComposeDraftRefs): DraftInput => ({
      id: refs.currentDraftId || undefined,
      postContent: refs.postContent,
      languages: serializeVariants(refs.variants),
      ...writeBox({ ...refs, itemId: MAIN_ITEM_ID, text: refs.postContent }, refs.variants),
      job: refs.job ? { ...refs.job } : null,
      threadItems: refs.threadItems.map((item) => ({
        id: item.id,
        text: item.text,
        ...writeBox({ ...item, itemId: item.id }, refs.variants),
      })),
      postingMode: refs.postingMode,
      scheduledAt: refs.scheduledAt ? refs.scheduledAt.toISOString() : null,
    }),
    [],
  );

  /**
   * Write the composer's content to THE draft of this editing session — the one
   * {@link draftIdRef} names, created on the first write — or delete that draft
   * when the composer has been emptied. Writes are chained, never concurrent:
   * each runs after the one before it has settled and reads the draft id only
   * then, so a second write always updates the draft the first one created
   * instead of starting another (OxyHQ/Mention#1124).
   */
  const writeDraft = useCallback(
    async (refs: ComposeDraftRefs) => {
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
    },
    [buildDraftData, saveDraft, deleteDraft, setCurrentDraftId],
  );

  /** The debounced background save. A failure is logged; the next change retries it. */
  const autoSave = useCallback(
    async (refs: ComposeDraftRefs) => {
      // A post being published is not a draft. Saving it now would persist the
      // very text the publish is about to put in the feed.
      if (suspendedRef.current) return;
      try {
        await writeDraft(refs);
      } catch (error) {
        logger.error('Error auto-saving draft', error);
      }
    },
    [writeDraft],
  );

  /**
   * "Save draft": write NOW, into the same draft the autosave has been keeping,
   * and throw if the write fails — the author asked for it, so a failure is
   * theirs to see, not a log line.
   */
  const saveNow = useCallback(
    async (refs: ComposeDraftRefs) => {
      cancelScheduledAutoSave();
      await writeDraft(refs);
    },
    [cancelScheduledAutoSave, writeDraft],
  );

  /**
   * The session's draft is spent — a publish took it, or the author threw it
   * away. Autosave stops, a write already in flight is allowed to land, and then
   * whatever draft exists NOW (see {@link draftIdRef}) is deleted.
   */
  const deleteSessionDraft = useCallback(async () => {
    suspendedRef.current = true;
    if (pendingSaveRef.current) await pendingSaveRef.current;
    const draftId = draftIdRef.current;
    setCurrentDraftId(null);
    if (draftId) await deleteDraft(draftId);
  }, [deleteDraft, setCurrentDraftId]);

  /**
   * "Discard": the work of this session is thrown away, including whatever the
   * autosave already stored. The pending debounce is cancelled, a write already
   * in flight is allowed to land and then deleted, and no autosave runs again —
   * the composer is closing.
   */
  const discard = useCallback(async () => {
    cancelScheduledAutoSave();
    await deleteSessionDraft();
  }, [cancelScheduledAutoSave, deleteSessionDraft]);

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
    try {
      await deleteSessionDraft();
    } catch (error) {
      logger.error('Error deleting a published draft', error);
    }
  }, [deleteSessionDraft]);

  /**
   * The publish failed: the author's work is still a draft. Autosave resumes,
   * and the work is saved NOW — {@link beginPublish} cancelled the debounce
   * that would otherwise have saved it, and nothing about a failed request
   * changes the composer's content to re-arm it.
   */
  const publishFailed = useCallback(
    async (refs: ComposeDraftRefs) => {
      suspendedRef.current = false;
      await autoSave(refs);
    },
    [autoSave],
  );

  /** The composer has been emptied after a publish; autosave may resume. */
  const endPublish = useCallback(() => {
    suspendedRef.current = false;
  }, []);

  const loadDraft = useCallback(
    (draft: StoredDraft) => {
      const storedJob = isRecord(draft.job) ? draft.job : null;
      const mentionJobId = storedJob ? readString(storedJob.mentionJobId) : undefined;
      const jobEmployerOxyUserId = storedJob ? readString(storedJob.employerOxyUserId) : undefined;
      const jobCanonicalUrl = storedJob ? readString(storedJob.canonicalUrl) : undefined;
      const jobStatus = storedJob ? readString(storedJob.status) : undefined;
      const job: JobAttachmentData | null =
        storedJob && mentionJobId && jobEmployerOxyUserId && jobCanonicalUrl && jobStatus
          ? {
              mentionJobId,
              title: readString(storedJob.title) ?? '',
              employerName: readString(storedJob.employerName) ?? '',
              employerOxyUserId: jobEmployerOxyUserId,
              canonicalUrl: jobCanonicalUrl,
              status: jobStatus as JobAttachmentData['status'],
              location: readJobLocation(storedJob.location),
              workplaceType: readString(
                storedJob.workplaceType,
              ) as JobAttachmentData['workplaceType'],
              employmentType: readString(
                storedJob.employmentType,
              ) as JobAttachmentData['employmentType'],
            }
          : null;

      const storedScheduledAt = readString(draft.scheduledAt);
      const scheduledAt = storedScheduledAt ? new Date(storedScheduledAt) : null;

      const postContent = readString(draft.postContent) ?? '';
      onDraftLoad({
        postContent,
        ...readBox(draft, postContent, MAIN_ITEM_ID, draft.languages, job),
        job,
        scheduledAt: scheduledAt && !Number.isNaN(scheduledAt.getTime()) ? scheduledAt : null,
        postingMode: draft.postingMode === 'beast' ? 'beast' : 'thread',
        threadItems: readArray(draft.threadItems)
          .filter(isRecord)
          .map((item) => {
            const id = readString(item.id) ?? '';
            const text = readString(item.text) ?? '';
            return { id, text, ...readBox(item, text, id, draft.languages) };
          }),
        languages: draft.languages,
      });

      setCurrentDraftId(readString(draft.id) ?? null);
    },
    [onDraftLoad, setCurrentDraftId],
  );

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
