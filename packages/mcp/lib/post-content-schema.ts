import { z } from "zod/v4";
import { MAX_AUTHOR_VARIANTS } from "@mention/shared-types/language";

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

/**
 * One author-written rendition of the post in a named language. The server
 * validates the tag (BCP-47) and the length exactly as it does for the composer.
 */
export const languageVariantSchema = z.object({
  tag: z.string().min(2).max(35).describe("BCP-47 language tag, e.g. \"en\" or \"es-ES\""),
  text: z.string().describe("The post body in this language"),
  article: articleInputSchema.optional().describe("The article in this language, when the post has one"),
});

export const languageVariantsSchema = z
  .array(languageVariantSchema)
  .min(1)
  .max(MAX_AUTHOR_VARIANTS)
  .optional()
  .describe(
    `The same post written in up to ${MAX_AUTHOR_VARIANTS} languages. The FIRST variant is the primary body; ` +
    "readers see the variant in their language. Send either variants or text, not both.",
  );

export const laneIdSchema = z
  .string()
  .optional()
  .describe("Id of one of the author's lanes (see list-lanes). Not allowed on replies.");

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
  variants: languageVariantsSchema,
});

export const postMetadataSchema = z.object({
  isSensitive: z.boolean().optional(),
});

export const threadPostSchema = z.object({
  content: postContentSchema,
  laneId: laneIdSchema,
  visibility: visibilitySchema,
  hashtags: z.array(z.string()).optional(),
  mentions: z.array(z.string()).optional(),
  replyPermission: replyPermissionSchema,
  reviewReplies: z.boolean().optional(),
  quotesDisabled: z.boolean().optional(),
  metadata: postMetadataSchema.optional(),
});

export type LanguageVariantInput = z.infer<typeof languageVariantSchema>;
export type MediaInput = z.infer<typeof mediaInputSchema>;
export type PostContentInput = z.infer<typeof postContentSchema>;
