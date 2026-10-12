import type { ArticleData } from '@/hooks/useArticleManager';
import type { EventData } from '@/hooks/useEventManager';
import type { JobAttachmentData } from '@/hooks/useJobAttachmentManager';
import type { LocationData } from '@/hooks/useLocationManager';
import type { PodcastAttachmentData } from '@/hooks/usePodcastManager';
import type { RoomAttachmentData } from '@/hooks/useRoomManager';
import type { Source } from '@/hooks/useSourcesManager';
import type { ThreadItem } from '@/hooks/useThreadManager';
import {
  ARTICLE_ATTACHMENT_KEY,
  EVENT_ATTACHMENT_KEY,
  JOB_ATTACHMENT_KEY,
  LOCATION_ATTACHMENT_KEY,
  PODCAST_ATTACHMENT_KEY,
  POLL_ATTACHMENT_KEY,
  ROOM_ATTACHMENT_KEY,
  SOURCES_ATTACHMENT_KEY,
  createLinkAttachmentKey,
  createMediaAttachmentKey,
  type ComposerMediaItem,
} from '@/utils/composeUtils';
import { hasVariantWork, type ComposeVariantsState } from '@/utils/composeVariants';

/**
 * What the composer holds, and the questions asked about it: "does this
 * attachment count?", "may this be published?", "is there work here worth
 * keeping?" and "which cards does this box show?".
 *
 * Each used to be answered in several places with its own list of attachments —
 * the Post button, the publish guard, the payload builders, the carousel, the
 * autosave, the draft reader and the close prompt. The lists drifted: the button
 * never learned about events, so a post whose only content was a valid event
 * could not be published, and the autosave never learned about events either
 * (OxyHQ/Mention#1124). Every one of those now asks HERE, and adding an
 * attachment means adding it here, once.
 */

/** One compose box — the root post or a thread item — as far as its content goes. */
export interface ComposeBox {
  text: string;
  mediaIds: ComposerMediaItem[];
  pollOptions: string[];
  location: LocationData | null;
  sources: Source[];
  article: ArticleData | null;
  event: EventData | null;
  room: RoomAttachmentData | null;
  podcast: PodcastAttachmentData | null;
  /** ROOT post only — see `useJobAttachmentManager.ts`. */
  job?: JobAttachmentData | null;
}

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

export const hasPollOption = (options: string[]): boolean => options.some(hasText);

export const hasArticleContent = (
  article: ArticleData | null | undefined,
): article is ArticleData => Boolean(article && (hasText(article.title) || hasText(article.body)));

/** An event the server will accept: it has a name and a date. */
export const isCompleteEvent = (event: EventData | null | undefined): event is EventData =>
  Boolean(event && hasText(event.name) && hasText(event.date));

/** A reference to a room that exists: its id and its title. */
export const hasRoomContent = (
  room: RoomAttachmentData | null | undefined,
): room is RoomAttachmentData => Boolean(room?.roomId && hasText(room.title));

export const hasPodcastContent = (
  podcast: PodcastAttachmentData | null | undefined,
): podcast is PodcastAttachmentData => Boolean(podcast?.syraPodcastId);

export const hasJobContent = (
  job: JobAttachmentData | null | undefined,
): job is JobAttachmentData => Boolean(job?.mentionJobId);

/** Sources that will be published: the ones with a link. */
export const linkedSources = (sources: Source[]): Source[] =>
  sources.filter((source) => hasText(source.url));

const hasSourceWork = (sources: Source[]): boolean =>
  sources.some((source) => hasText(source.title) || hasText(source.url));

/** Whether one box carries something a post can be made of. */
export const boxHasContent = (box: ComposeBox): boolean =>
  hasText(box.text) ||
  box.mediaIds.length > 0 ||
  hasPollOption(box.pollOptions) ||
  box.location !== null ||
  linkedSources(box.sources).length > 0 ||
  hasArticleContent(box.article) ||
  isCompleteEvent(box.event) ||
  hasRoomContent(box.room) ||
  hasPodcastContent(box.podcast) ||
  hasJobContent(box.job);

const rootBox = (content: ComposeContent): ComposeBox => ({
  ...content,
  text: content.postContent,
});

/** Whether the post is publishable: at least one box carries something. */
export const hasPublishableContent = (content: ComposeContent): boolean =>
  boxHasContent(rootBox(content)) || content.threadItems.some(boxHasContent);

/**
 * Whether the composer holds work worth keeping as a draft. Wider than
 * {@link hasPublishableContent}: half-written sources or a rendition in another
 * language are not a post yet, but they are the author's work.
 */
export const hasDraftContent = (
  content: ComposeContent & { variants: ComposeVariantsState },
): boolean =>
  hasPublishableContent(content) ||
  hasVariantWork(content.variants) ||
  hasSourceWork(content.sources) ||
  content.threadItems.some((item) => hasSourceWork(item.sources));

/**
 * The carousel keys of the attachments a box shows, in their default order.
 * The live carousel, a restored draft and a thread box's payload all ask this,
 * so a card cannot appear in one and be missing from another.
 */
export const attachmentKeysOf = (
  box: Omit<ComposeBox, 'text' | 'pollOptions'> & { showPollCreator: boolean; linkUrls?: string[] },
): string[] => [
  ...(box.showPollCreator ? [POLL_ATTACHMENT_KEY] : []),
  ...(hasArticleContent(box.article) ? [ARTICLE_ATTACHMENT_KEY] : []),
  ...(isCompleteEvent(box.event) ? [EVENT_ATTACHMENT_KEY] : []),
  ...(hasRoomContent(box.room) ? [ROOM_ATTACHMENT_KEY] : []),
  ...(hasPodcastContent(box.podcast) ? [PODCAST_ATTACHMENT_KEY] : []),
  ...(hasJobContent(box.job) ? [JOB_ATTACHMENT_KEY] : []),
  ...(box.location ? [LOCATION_ATTACHMENT_KEY] : []),
  ...(linkedSources(box.sources).length > 0 ? [SOURCES_ATTACHMENT_KEY] : []),
  ...(box.linkUrls ?? []).map(createLinkAttachmentKey),
  ...box.mediaIds.map((media) => createMediaAttachmentKey(media.id)),
];

/**
 * An attachment order reconciled against the cards that exist: keys whose
 * attachment is gone are dropped (and duplicates with them), and a card the
 * order never named is appended.
 */
export const reconcileAttachmentOrder = (
  order: readonly string[],
  available: readonly string[],
): string[] => {
  const cards = new Set(available);
  const kept = [...new Set(order)].filter((key) => cards.has(key));
  return [...kept, ...[...cards].filter((key) => !kept.includes(key))];
};
