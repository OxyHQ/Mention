import { z } from "zod";
import { logger } from '@/lib/logger';

// Actor/profile coming from actorId_populated
export const ZActor = z.object({
  _id: z.string().optional(),
  id: z.string().optional(),
  username: z.string().optional(),
  // Canonical resolved display name (profile-identity contract). The backend
  // serializer always emits `name.displayName`; clients render it directly.
  name: z.object({ displayName: z.string().optional() }).partial().optional(),
  avatar: z.string().optional(),
}).partial();

// Embedded post user — the canonical Oxy `User` shape emitted by
// `PostHydrationService` (Oxy owns identity). Render `name.displayName` directly,
// derive the handle via `getNormalizedUserHandle`, and resolve `avatar` (a bare
// Oxy file id OR absolute remote URL) through Bloom's ImageResolver. No flat
// `displayName` / `handle` / `avatarUrl` shims.
export const ZEmbeddedUser = z.object({
  id: z.string().optional(),
  username: z.string().optional(),
  name: z.object({ displayName: z.string().optional() }).partial().optional(),
  avatar: z.string().nullable().optional(),
  verified: z.boolean().optional(),
  isFederated: z.boolean().optional(),
  instance: z.string().optional(),
  federation: z.object({ domain: z.string().optional() }).partial().optional(),
});

// Embedded post object shape (loose to be resilient)
export const ZEmbeddedPost = z.object({
  id: z.string(),
  user: ZEmbeddedUser,
  content: z
    .union([
      z.object({ text: z.string().optional() }).passthrough(),
      z.string(),
    ])
    .optional(),
  date: z.any().optional(),
  engagement: z
    .object({
      replies: z.number().optional(),
      boosts: z.number().optional(),
      likes: z.number().optional(),
    })
    .optional(),
  isLiked: z.boolean().optional(),
  isBoosted: z.boolean().optional(),
  isSaved: z.boolean().optional(),
  isThread: z.boolean().optional(),
});

// Raw notification as received from API
export const ZRawNotification = z
  .object({
    _id: z.string(),
    recipientId: z.any(),
    actorId: z.any(),
    type: z.string(),
    entityId: z.any(),
    entityType: z.string(),
    read: z.boolean().default(false),
    createdAt: z.string(),
    updatedAt: z.any().optional(),
    preview: z.string().optional(),
    post: ZEmbeddedPost.optional(),
    actorId_populated: ZActor.optional(),
  })
  .passthrough();

export type TEmbeddedPost = z.infer<typeof ZEmbeddedPost>;
export type TRawNotification = z.infer<typeof ZRawNotification>;

export const validateNotifications = (items: any[]): TRawNotification[] => {
  if (!Array.isArray(items)) return [];
  const valid: TRawNotification[] = [];
  for (const it of items) {
    const parsed = ZRawNotification.safeParse(it);
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      logger.warn("Dropping invalid notification", { issue: parsed.error?.issues?.[0] });
    }
  }
  return valid;
};
