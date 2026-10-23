import { z } from 'zod';

/** Narrow publishing contract for Mention's existing scoped MCP HTTP surface. */
export const MentionPublishInput = z
  .object({
    content: z.object({ text: z.string().trim().min(1).max(50000) }).strict(),
    visibility: z.literal('public').default('public'),
    status: z.literal('published').default('published'),
  })
  .strict();
export const MentionPublishResponse = z.object({
  success: z.literal(true),
  post: z.object({ id: z.string().min(1) }).passthrough(),
});
export const MentionIdentity = z.object({
  oxyUserId: z.string().min(1),
  handle: z.string(),
  displayName: z.string(),
});
export const MentionEffectRefusal = z.object({
  error: z.enum(['mcp_effect_already_reserved', 'mcp_idempotency_conflict']),
  previousStatus: z.string().optional(),
  previousResponseStatus: z.number().nullable().optional(),
});
export type MentionPublishInput = z.infer<typeof MentionPublishInput>;

export * from './events';

export * from './imports';
