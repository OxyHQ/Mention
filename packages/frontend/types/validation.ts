import { z } from "zod";

// Actor/profile coming from actorId_populated
export const ZActor = z.object({
  _id: z.string().optional(),
  username: z.string().optional(),
  name: z.union([z.string(), z.object({ full: z.string() })]).optional(),
  avatar: z.string().optional(),
}).partial();

// Embedded post user
export const ZEmbeddedUser = z.object({
  id: z.string().optional(),
  name: z.string().default("User"),
  handle: z.string().optional(),
  avatar: z.string().optional(),
  verified: z.boolean().optional(),
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
      reposts: z.number().optional(),
      likes: z.number().optional(),
    })
    .optional(),
  isLiked: z.boolean().optional(),
  isReposted: z.boolean().optional(),
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
      console.warn("Dropping invalid notification", parsed.error?.issues?.[0]);
    }
  }
  return valid;
};
