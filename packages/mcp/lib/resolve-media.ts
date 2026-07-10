import { api } from "./api-client.js";
import type { MediaInput, PostContentInput } from "./post-content-schema.js";

interface IntentMediaResponse {
  fileId: string;
  contentType?: string;
}

export interface ResolvedMediaItem {
  id: string;
  type?: "image" | "video" | "gif";
  alt?: string;
}

function mediaTypeFromMime(mime?: string, hint?: "image" | "video" | "gif"): "image" | "video" | "gif" {
  if (hint) return hint;
  if (!mime) return "image";
  if (mime === "image/gif" || mime.endsWith("/gif")) return "gif";
  if (mime.startsWith("video/")) return "video";
  return "image";
}

async function uploadFromUrl(url: string): Promise<IntentMediaResponse> {
  return api.post<IntentMediaResponse>("/posts/intent-media", { url });
}

async function uploadFromBase64(base64: string, mimeType: string, filename?: string): Promise<IntentMediaResponse> {
  return api.post<IntentMediaResponse>("/posts/intent-media", {
    base64,
    mimeType,
    ...(filename ? { filename } : {}),
  });
}

/** Resolve MCP media inputs (fileId / url / base64) to wire-format media items. */
export async function resolveMediaInputs(items: MediaInput[]): Promise<ResolvedMediaItem[]> {
  return Promise.all(
    items.map(async (item): Promise<ResolvedMediaItem> => {
      if (item.kind === "fileId") {
        return {
          id: item.fileId,
          ...(item.type ? { type: item.type } : {}),
          ...(item.alt ? { alt: item.alt } : {}),
        };
      }

      if (item.kind === "url") {
        const uploaded = await uploadFromUrl(item.url);
        return {
          id: uploaded.fileId,
          type: mediaTypeFromMime(uploaded.contentType, item.type),
          ...(item.alt ? { alt: item.alt } : {}),
        };
      }

      const uploaded = await uploadFromBase64(item.base64, item.mimeType, item.filename);
      return {
        id: uploaded.fileId,
        type: mediaTypeFromMime(uploaded.contentType, item.type),
        ...(item.alt ? { alt: item.alt } : {}),
      };
    }),
  );
}

/** Build backend `content` object from validated MCP post content. */
export async function buildPostContentPayload(
  content: PostContentInput,
): Promise<Record<string, unknown>> {
  const payload: Record<string, unknown> = {};

  if (content.text !== undefined) payload.text = content.text;
  if (content.media !== undefined) {
    payload.media = await resolveMediaInputs(content.media);
  }
  if (content.poll) payload.poll = content.poll;
  if (content.location) {
    payload.location = {
      type: "Point",
      coordinates: [content.location.longitude, content.location.latitude],
      ...(content.location.address ? { address: content.location.address } : {}),
    };
  }
  if (content.sources) payload.sources = content.sources;
  if (content.article) payload.article = content.article;
  if (content.event) payload.event = content.event;
  if (content.room) payload.room = content.room;
  if (content.podcast) payload.podcast = content.podcast;
  if (content.attachments) payload.attachments = content.attachments;

  return payload;
}
