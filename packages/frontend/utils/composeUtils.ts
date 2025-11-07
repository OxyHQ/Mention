/**
 * Utility functions for the compose screen
 */

export const MEDIA_CARD_WIDTH = 280;
export const MEDIA_CARD_HEIGHT = 180;
export const POLL_ATTACHMENT_KEY = "poll";
export const ARTICLE_ATTACHMENT_KEY = "article";
export const LOCATION_ATTACHMENT_KEY = "location";
export const SOURCES_ATTACHMENT_KEY = "sources";
export const MEDIA_ATTACHMENT_PREFIX = "media:";

export const createMediaAttachmentKey = (id: string) => `${MEDIA_ATTACHMENT_PREFIX}${id}`;
export const isMediaAttachmentKey = (key: string) => key.startsWith(MEDIA_ATTACHMENT_PREFIX);
export const getMediaIdFromAttachmentKey = (key: string) => key.slice(MEDIA_ATTACHMENT_PREFIX.length);

export type ComposerMediaType = "image" | "video" | "gif";
export type ComposerMediaItem = { id: string; type: ComposerMediaType };

export const toComposerMediaType = (value?: string, mime?: string): ComposerMediaType => {
  const lowerValue = typeof value === "string" ? value.toLowerCase() : "";
  const lowerMime = typeof mime === "string" ? mime.toLowerCase() : "";

  if (lowerValue === "video" || lowerMime.startsWith("video/")) return "video";
  if (lowerValue === "gif" || lowerMime.includes("gif")) return "gif";
  return "image";
};

export const normalizeUrl = (raw: string): string | null => {
  if (!raw || typeof raw !== "string") return null;
  let value = raw.trim();
  if (!value) return null;
  if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(value)) {
    value = `https://${value}`;
  }
  try {
    const parsed = new URL(value);
    return parsed.toString();
  } catch {
    return null;
  }
};

export const sanitizeSourcesForSubmit = (list: Array<{ id: string; title: string; url: string }> | undefined): Array<{ url: string; title?: string }> => {
  if (!Array.isArray(list) || list.length === 0) return [];

  const MAX_SOURCES = 5;
  const normalized: Array<{ url: string; title?: string }> = [];

  list.forEach((item) => {
    const normalizedUrl = normalizeUrl(item.url);
    if (!normalizedUrl) return;
    const title = item.title?.trim();
    normalized.push(title ? { url: normalizedUrl, title } : { url: normalizedUrl });
  });

  const deduped = normalized.filter((source, index, self) => self.findIndex((s) => s.url === source.url) === index);
  return deduped.slice(0, MAX_SOURCES);
};

export const isValidSourceUrl = (value: string) => {
  if (!value || value.trim().length === 0) return true;
  return Boolean(normalizeUrl(value));
};

export const generateSourceId = () => `source_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
