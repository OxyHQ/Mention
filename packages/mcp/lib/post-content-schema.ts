import { z } from "zod";

export const visibilitySchema = z
  .enum(["public", "private", "followers", "followers_only"])
  .optional()
  .describe("Post visibility (default: public)");

export const replyPermissionSchema = z
  .array(z.enum(["anyone", "followers", "following", "mentioned", "nobody"]))
  .optional()
  .describe("Who may reply to this post");

export const sourceLinkSchema = z.object({
  url: z.string().min(1).describe("Source URL"),
  title: z.string().optional().describe("Optional display title"),
});

export const mediaByFileIdSchema = z.object({
  kind: z.literal("fileId"),
  fileId: z.string().describe("Oxy file id from upload-media or Mention compose"),
  type: z.enum(["image", "video", "gif"]).optional().describe("Media type hint"),
  alt: z.string().max(2000).optional().describe("Accessibility alt text"),
});

export const mediaByUrlSchema = z.object({
  kind: z.literal("url"),
  url: z.string().url().describe("Remote image/video URL — fetched server-side before attach"),
  type: z.enum(["image", "video", "gif"]).optional(),
  alt: z.string().max(2000).optional(),
});

export const mediaByBase64Schema = z.object({
  kind: z.literal("base64"),
  base64: z.string().describe("Base64-encoded image/video bytes or data: URL"),
  mimeType: z.string().describe("MIME type, e.g. image/jpeg or video/mp4"),
  filename: z.string().optional().describe("Optional filename"),
  type: z.enum(["image", "video", "gif"]).optional(),
  alt: z.string().max(2000).optional(),
});

export const mediaInputSchema = z.discriminatedUnion("kind", [
  mediaByFileIdSchema,
  mediaByUrlSchema,
  mediaByBase64Schema,
]);

export const pollInputSchema = z.object({
  question: z.string().min(1).describe("Poll question"),
  options: z.array(z.string().min(1)).min(2).max(4).describe("2–4 answer options"),
  endTime: z.string().optional().describe("ISO end time (default ~7 days)"),
  isMultipleChoice: z.boolean().optional(),
  isAnonymous: z.boolean().optional(),
});

export const locationInputSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  address: z.string().optional(),
});

export const articleInputSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
});

export const eventInputSchema = z.object({
  name: z.string().min(1),
  date: z.string().describe("ISO date/time"),
  location: z.string().optional(),
  description: z.string().optional(),
});

export const roomInputSchema = z.object({
  roomId: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["scheduled", "live", "ended"]).optional(),
  topic: z.string().optional(),
  host: z.string().optional(),
});

export const podcastInputSchema = z.object({
  syraPodcastId: z.string().min(1).describe("Syra podcast show id"),
});

export const attachmentDescriptorSchema = z.object({
  type: z.enum(["media", "poll", "article", "location", "sources", "event", "room", "podcast"]),
  id: z.string().optional(),
  mediaType: z.enum(["image", "video", "gif"]).optional(),
});

export const postContentSchema = z.object({
  text: z.string().optional().describe("Post body text"),
  media: z.array(mediaInputSchema).max(10).optional().describe("Images/videos/gifs"),
  poll: pollInputSchema.optional(),
  location: locationInputSchema.optional(),
  sources: z.array(sourceLinkSchema).max(5).optional(),
  article: articleInputSchema.optional(),
  event: eventInputSchema.optional(),
  room: roomInputSchema.optional(),
  podcast: podcastInputSchema.optional(),
  attachments: z.array(attachmentDescriptorSchema).optional().describe("Render order"),
});

export const postMetadataSchema = z.object({
  isSensitive: z.boolean().optional(),
});

export const threadPostSchema = z.object({
  content: postContentSchema,
  visibility: visibilitySchema,
  hashtags: z.array(z.string()).optional(),
  mentions: z.array(z.string()).optional(),
  replyPermission: replyPermissionSchema,
  reviewReplies: z.boolean().optional(),
  quotesDisabled: z.boolean().optional(),
  metadata: postMetadataSchema.optional(),
});

export type MediaInput = z.infer<typeof mediaInputSchema>;
export type PostContentInput = z.infer<typeof postContentSchema>;
