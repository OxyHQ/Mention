import { z } from 'zod';

/** Mention owns this wire contract; importers must not maintain a parallel copy. */
export const MENTION_IMPORT_PLATFORMS = [
  'mastodon',
  'bluesky',
  'threads',
  'instagram',
  'x',
  'facebook',
  'medium',
  'substack',
  'telegram',
] as const;
export const MENTION_IMPORT_BATCH_MAX_ITEMS = 50;
export const MENTION_IMPORT_MAX_MEDIA = 10;
export const MENTION_IMPORT_MAX_LINKS = 10;
export const MENTION_IMPORT_LOOKUP_MAX_IDS = 200;
export const MENTION_IMPORT_MAX_TEXT = 25_000;
export const MENTION_IMPORT_MAX_CONTENT_WARNING = 500;
export const MENTION_IMPORT_MAX_ALT = 4_000;
export const MENTION_IMPORT_MAX_URL = 2_048;
export const mentionImportIdSchema = z.string().trim().min(1).max(512);
const httpUrl = z
  .string()
  .trim()
  .max(MENTION_IMPORT_MAX_URL)
  .refine((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'must be an http(s) URL');
export const mentionImportPlatformSchema = z.enum(MENTION_IMPORT_PLATFORMS);
export const mentionImportItemSchema = z.object({
  sourceId: mentionImportIdSchema,
  sourceUrl: httpUrl,
  sourceAccountId: mentionImportIdSchema.optional(),
  sourceItemId: mentionImportIdSchema.optional(),
  createdAt: z.iso.datetime({ offset: true }),
  text: z.string().max(MENTION_IMPORT_MAX_TEXT).default(''),
  contentWarning: z.string().trim().max(MENTION_IMPORT_MAX_CONTENT_WARNING).optional(),
  language: z.string().trim().min(2).max(35).optional(),
  visibility: z.enum(['public', 'followers_only']),
  replyToSourceId: mentionImportIdSchema.optional(),
  quoteSourceId: mentionImportIdSchema.optional(),
  media: z
    .array(
      z.object({
        assetId: mentionImportIdSchema,
        alt: z.string().max(MENTION_IMPORT_MAX_ALT).optional(),
      }),
    )
    .max(MENTION_IMPORT_MAX_MEDIA)
    .default([]),
  article: z.object({ title: z.string().optional(), body: z.string().optional() }).optional(),
  links: z.array(httpUrl).max(MENTION_IMPORT_MAX_LINKS).optional(),
});
export const mentionImportBatchSchema = z.object({
  platform: mentionImportPlatformSchema,
  batchId: mentionImportIdSchema,
  items: z.array(mentionImportItemSchema).min(1).max(MENTION_IMPORT_BATCH_MAX_ITEMS),
});
export const mentionImportBatchResponseSchema = z.object({
  results: z.array(
    z.object({
      sourceId: z.string(),
      status: z.enum(['created', 'existing', 'deferred', 'failed']),
      postId: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});
export const mentionImportUndoResponseSchema = z.object({
  deleted: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export const mentionImportLookupSchema = z.object({
  platform: mentionImportPlatformSchema,
  sourceIds: z.array(mentionImportIdSchema).max(MENTION_IMPORT_LOOKUP_MAX_IDS).default([]),
  federatedIds: z.array(mentionImportIdSchema).max(MENTION_IMPORT_LOOKUP_MAX_IDS).default([]),
});
export const mentionImportLookupResponseSchema = z.object({
  imported: z.record(z.string(), z.string()),
  federated: z.record(
    z.string(),
    z.object({
      postId: z.string(),
      actorUri: z.string().nullable(),
      url: z.string().nullable(),
      oxyUserId: z.string().nullable(),
    }),
  ),
});
export type MentionImportBatch = z.input<typeof mentionImportBatchSchema>;
export type MentionImportLookup = z.input<typeof mentionImportLookupSchema>;
export type MentionImportItem = z.input<typeof mentionImportItemSchema>;
