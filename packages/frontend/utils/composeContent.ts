import type { ArticleData } from '@/hooks/useArticleManager';
import type { EventData } from '@/hooks/useEventManager';
import type { JobAttachmentData } from '@/hooks/useJobAttachmentManager';
import type { LocationData } from '@/hooks/useLocationManager';
import type { PodcastAttachmentData } from '@/hooks/usePodcastManager';
import type { RoomAttachmentData } from '@/hooks/useRoomManager';
import type { Source } from '@/hooks/useSourcesManager';
import type { ThreadItem } from '@/hooks/useThreadManager';
import type { ComposerMediaItem } from '@/utils/composeUtils';
import { hasVariantWork, type ComposeVariantsState } from '@/utils/composeVariants';
import { shouldIncludeThreadItem } from '@/utils/postBuilder';

/**
 * What the composer holds, for the two questions asked about it: "may this be
 * published?" and "is there work here worth keeping?".
 *
 * Both used to be answered in several places, each with its own list of
 * attachments — the Post button's validation, the publish guard, the autosave,
 * the autosave trigger and the close prompt. The lists drifted: the button
 * never learned about events, rooms, podcasts or jobs, so a post whose only
 * content was a valid event could not be published (OxyHQ/Mention#1124), and the
 * autosave never learned about events either. Adding an attachment now means
 * adding it HERE, once.
 */
export interface ComposeContent {
  postContent: string;
  mediaIds: ComposerMediaItem[];
  pollOptions: string[];
  location: LocationData | null;
  sources: Source[];
  article: ArticleData | null;
  event: EventData | null;
  room: RoomAttachmentData | null;
  podcast: PodcastAttachmentData | null;
  /** ROOT post only — see `useJobAttachmentManager.ts`. */
  job: JobAttachmentData | null;
  threadItems: ThreadItem[];
}

const hasText = (value: string | undefined): boolean => Boolean(value?.trim());

const hasPollOption = (options: string[]): boolean => options.some(hasText);

/** An event the server will accept: it has a name and a date. */
export const isCompleteEvent = (event: EventData | null | undefined): event is EventData =>
  Boolean(event && hasText(event.name) && hasText(event.date));

export const hasArticleContent = (article: ArticleData | null | undefined): boolean =>
  Boolean(article && (hasText(article.title) || hasText(article.body)));

const hasRoom = (room: RoomAttachmentData | null | undefined): boolean =>
  Boolean(room?.roomId && hasText(room.title));

const hasSourceWork = (sources: Source[]): boolean =>
  sources.some((source) => hasText(source.title) || hasText(source.url));

/** Whether the post is publishable: at least one box carries something a post can be made of. */
export const hasPublishableContent = (content: ComposeContent): boolean =>
  hasText(content.postContent) ||
  content.mediaIds.length > 0 ||
  hasPollOption(content.pollOptions) ||
  content.location !== null ||
  hasArticleContent(content.article) ||
  isCompleteEvent(content.event) ||
  hasRoom(content.room) ||
  Boolean(content.podcast?.syraPodcastId) ||
  Boolean(content.job?.mentionJobId) ||
  content.threadItems.some(shouldIncludeThreadItem);

/**
 * Whether the composer holds work worth keeping as a draft. Wider than
 * {@link hasPublishableContent}: half-written sources, a box holding only a
 * location, or a rendition in another language are not a post yet, but they
 * are the author's work.
 */
export const hasDraftContent = (
  content: ComposeContent & { variants: ComposeVariantsState },
): boolean =>
  hasPublishableContent(content) ||
  hasVariantWork(content.variants) ||
  hasSourceWork(content.sources) ||
  content.threadItems.some((item) =>
    shouldIncludeThreadItem(item) ||
    item.location !== null ||
    hasSourceWork(item.sources),
  );
