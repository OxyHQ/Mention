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
const embeddedUserShape = {
  id: z.string(),
  username: z.string().optional(),
  name: z.object({ displayName: z.string().optional() }).passthrough(),
  avatar: z.string().nullable().optional(),
  verified: z.boolean().optional(),
  isFederated: z.boolean().optional(),
  instance: z.string().optional(),
  federation: z.object({ domain: z.string().optional() }).passthrough().optional(),
  badges: z.array(z.string()).optional(),
};

export const ZEmbeddedUser = z
  .object(embeddedUserShape)
  .passthrough()
  .superRefine((user, context) => {
    for (const field of ['handle', 'avatarUrl', 'isVerified'] as const) {
      if (field in user) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Legacy identity field "${field}" is not allowed`,
          path: [field],
        });
      }
    }
  });

const ZEmbeddedAuthor = z
  .object({
    ...embeddedUserShape,
    role: z.enum(['owner', 'collaborator']),
    status: z.enum(['pending', 'accepted', 'declined', 'stopped']),
  })
  .passthrough()
  .superRefine((author, context) => {
    for (const field of ['handle', 'avatarUrl', 'isVerified'] as const) {
      if (field in author) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Legacy identity field "${field}" is not allowed`,
          path: [field],
        });
      }
    }
  });

// Embedded posts are hydrated by PostHydrationService. Keep the validator
// aligned with that canonical contract so old identity/viewer shims cannot
// silently re-enter through notifications.
export const ZEmbeddedPost = z
  .object({
    id: z.string(),
    user: ZEmbeddedUser,
    authors: z.array(ZEmbeddedAuthor),
    content: z.object({ text: z.string().optional() }).passthrough(),
    attachments: z.object({}).passthrough(),
    linkPreviews: z.array(z.object({ url: z.string() }).passthrough()).optional(),
    engagement: z
      .object({
        replies: z.number().nullable(),
        boosts: z.number().nullable(),
        likes: z.number().nullable(),
        downvotes: z.number().nullable(),
        saves: z.number().nullable().optional(),
        views: z.number().nullable().optional(),
        impressions: z.number().nullable().optional(),
      })
      .passthrough(),
    viewerState: z
      .object({
        isOwner: z.boolean(),
        isCollaborator: z.boolean(),
        isLiked: z.boolean(),
        isDownvoted: z.boolean(),
        isBoosted: z.boolean(),
        isSaved: z.boolean(),
        collabInvitePending: z.boolean().optional(),
        viewerRole: z.enum(['owner', 'collaborator']).optional(),
      })
      .passthrough(),
    permissions: z
      .object({
        canReply: z.boolean(),
        canDelete: z.boolean(),
        canPin: z.boolean(),
        canViewSources: z.boolean(),
      })
      .passthrough(),
    metadata: z
      .object({
        visibility: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
      })
      .passthrough(),
    parentPostId: z.string().optional(),
  })
  .passthrough()
  .superRefine((post, context) => {
    for (const field of ['isLiked', 'isDownvoted', 'isBoosted', 'isSaved'] as const) {
      if (field in post) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Legacy viewer field "${field}" is not allowed`,
          path: [field],
        });
      }
    }
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

export const validateNotifications = (items: unknown): TRawNotification[] => {
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
