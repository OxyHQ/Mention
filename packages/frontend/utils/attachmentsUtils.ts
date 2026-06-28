import { PostAttachmentDescriptor } from "@mention/shared-types";
import { ComposerMediaItem } from "./composeUtils";

export const buildAttachmentsPayload = (
  order: string[],
  mediaList: ComposerMediaItem[],
  options: {
    includePoll?: boolean;
    includeArticle?: boolean;
    includeEvent?: boolean;
    includeLocation?: boolean;
    includeSources?: boolean;
    includeRoom?: boolean;
    /** When set, a `{ type: 'podcast', id }` descriptor is emitted at the podcast slot. */
    podcastId?: string;
  }
): PostAttachmentDescriptor[] => {
  const descriptors: PostAttachmentDescriptor[] = [];
  const mediaMap = new Map<string, ComposerMediaItem>();
  const usedMedia = new Set<string>();

  mediaList.forEach((item) => {
    mediaMap.set(item.id, item);
  });

  const addNonMedia = (type: "poll" | "article" | "event" | "location" | "sources" | "room") => {
    if (!descriptors.some((d) => d.type === type)) {
      descriptors.push({ type });
    }
  };

  const addMedia = (id: string) => {
    if (!id) return;
    if (usedMedia.has(id)) return;
    const mediaItem = mediaMap.get(id);
    if (!mediaItem) return;
    usedMedia.add(id);
    descriptors.push({
      type: "media",
      id,
      mediaType: mediaItem.type,
    });
  };

  const addPodcast = () => {
    if (!options.podcastId) return;
    if (descriptors.some((d) => d.type === "podcast")) return;
    descriptors.push({ type: "podcast", id: options.podcastId });
  };

  const POLL_ATTACHMENT_KEY = "poll";
  const ARTICLE_ATTACHMENT_KEY = "article";
  const EVENT_ATTACHMENT_KEY = "event";
  const LOCATION_ATTACHMENT_KEY = "location";
  const SOURCES_ATTACHMENT_KEY = "sources";
  const ROOM_ATTACHMENT_KEY = "room";
  const PODCAST_ATTACHMENT_KEY = "podcast";
  const MEDIA_ATTACHMENT_PREFIX = "media:";
  const isMediaAttachmentKey = (key: string) => key.startsWith(MEDIA_ATTACHMENT_PREFIX);
  const getMediaIdFromAttachmentKey = (key: string) => key.slice(MEDIA_ATTACHMENT_PREFIX.length);

  order.forEach((key) => {
    if (key === POLL_ATTACHMENT_KEY) {
      if (options.includePoll) addNonMedia("poll");
      return;
    }
    if (key === ARTICLE_ATTACHMENT_KEY) {
      if (options.includeArticle) addNonMedia("article");
      return;
    }
    if (key === EVENT_ATTACHMENT_KEY) {
      if (options.includeEvent) addNonMedia("event");
      return;
    }
    if (key === LOCATION_ATTACHMENT_KEY) {
      if (options.includeLocation) addNonMedia("location");
      return;
    }
    if (key === SOURCES_ATTACHMENT_KEY) {
      if (options.includeSources) addNonMedia("sources");
      return;
    }
    if (key === ROOM_ATTACHMENT_KEY) {
      if (options.includeRoom) addNonMedia("room");
      return;
    }
    if (key === PODCAST_ATTACHMENT_KEY) {
      addPodcast();
      return;
    }
    if (isMediaAttachmentKey(key)) {
      const mediaId = getMediaIdFromAttachmentKey(key);
      addMedia(mediaId);
    }
  });

  if (options.includePoll) addNonMedia("poll");
  if (options.includeArticle) addNonMedia("article");
  if (options.includeEvent) addNonMedia("event");
  if (options.includeLocation) addNonMedia("location");
  if (options.includeSources) addNonMedia("sources");
  if (options.includeRoom) addNonMedia("room");
  addPodcast();

  mediaList.forEach((item) => {
    if (!usedMedia.has(item.id)) {
      addMedia(item.id);
    }
  });

  return descriptors;
};
