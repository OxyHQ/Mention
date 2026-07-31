import { z } from "zod";
import { logger } from "@oxyhq/core/logger";

/**
 * Reject legacy fields that the profile-identity contract retired, so a shim
 * cannot re-enter through notifications. Shared by the three embedded shapes
 * that each guard their own list.
 *
 * `z.looseObject(...)` is what makes this necessary: unknown keys are
 * preserved rather than stripped, so without an explicit refusal a
 * resurrected `handle` or `isLiked` would ride along and be read downstream.
 */
const refuseLegacyFields =
  (
    kind: string,
    fields: readonly string[],
  ): ((value: object, context: z.RefinementCtx) => void) =>
  (value, context) => {
    for (const field of fields) {
      if (field in value) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Legacy ${kind} field "${field}" is not allowed`,
          path: [field],
        });
      }
    }
  };

/** Identity shims replaced by `username` / `avatar` / `verified`. */
const LEGACY_IDENTITY_FIELDS = ["handle", "avatarUrl", "isVerified"] as const;

/** Viewer-state shims that moved onto `viewerState`. */
const LEGACY_VIEWER_FIELDS = [
  "isLiked",
  "isDownvoted",
  "isBoosted",
  "isSaved",
] as const;

// Actor/profile coming from actorId_populated
export const ZActor = z.object({
  _id: z.string().optional(),
  id: z.string().optional(),
  username: z.string().optional(),
  // Canonical resolved display name (profile-identity contract). The backend
  // serializer always emits `name.displayName`; clients render it directly.
  name: z.object({ displayName: z.string().optional() }).optional(),
  avatar: z.string().optional(),
});

// Embedded post user — the canonical Oxy `User` shape emitted by
// `PostHydrationService` (Oxy owns identity). Render `name.displayName` directly,
// derive the handle via `getNormalizedUserHandle`, and resolve `avatar` (a bare
// Oxy file id OR absolute remote URL) through Bloom's ImageResolver. No flat
// `displayName` / `handle` / `avatarUrl` shims.
const embeddedUserShape = {
  id: z.string(),
  username: z.string().optional(),
  name: z.looseObject({ displayName: z.string().optional() }),
  avatar: z.string().nullable().optional(),
  verified: z.boolean().optional(),
  isFederated: z.boolean().optional(),
  instance: z.string().optional(),
  federation: z.looseObject({ domain: z.string().optional() }).optional(),
};

export const ZEmbeddedUser = z
  .looseObject(embeddedUserShape)
  .superRefine(refuseLegacyFields("identity", LEGACY_IDENTITY_FIELDS));

const ZEmbeddedAuthor = z
  .looseObject({
    ...embeddedUserShape,
    role: z.enum(["owner", "collaborator"]),
    status: z.enum(["pending", "accepted", "declined", "stopped"]),
  })
  .superRefine(refuseLegacyFields("identity", LEGACY_IDENTITY_FIELDS));

// Embedded posts are hydrated by PostHydrationService. Keep the validator
// aligned with that canonical contract so old identity/viewer shims cannot
// silently re-enter through notifications.
export const ZEmbeddedPost = z
  .looseObject({
    id: z.string(),
    user: ZEmbeddedUser,
    authors: z.array(ZEmbeddedAuthor),
    content: z.looseObject({ text: z.string().optional() }),
    attachments: z.looseObject({}),
    linkPreviews: z.array(z.looseObject({ url: z.string() })).optional(),
    engagement: z.looseObject({
      replies: z.number().nullable(),
      boosts: z.number().nullable(),
      likes: z.number().nullable(),
      downvotes: z.number().nullable(),
      saves: z.number().nullable().optional(),
      views: z.number().nullable().optional(),
      impressions: z.number().nullable().optional(),
    }),
    viewerState: z.looseObject({
      isOwner: z.boolean(),
      isCollaborator: z.boolean(),
      isLiked: z.boolean(),
      isDownvoted: z.boolean(),
      isBoosted: z.boolean(),
      isSaved: z.boolean(),
      collabInvitePending: z.boolean().optional(),
      viewerRole: z.enum(["owner", "collaborator"]).optional(),
    }),
    permissions: z.looseObject({
      canReply: z.boolean(),
      canDelete: z.boolean(),
      canPin: z.boolean(),
      canViewSources: z.boolean(),
    }),
    metadata: z.looseObject({
      visibility: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
    }),
    parentPostId: z.string().optional(),
  })
  .superRefine(refuseLegacyFields("viewer", LEGACY_VIEWER_FIELDS));

// Raw notification as received from API
export const ZRawNotification = z.looseObject({
  _id: z.string(),
  // `recipientId` and `actorId` hold Oxy user ids (the backend model types both
  // as `String`, never a Mongoose ref — hence the separate `actorId_populated`).
  // `entityId` is an ObjectId that serializes to its hex string over JSON.
  recipientId: z.string(),
  actorId: z.string(),
  type: z.string(),
  entityId: z.string(),
  entityType: z.string(),
  read: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  preview: z.string().optional(),
  post: ZEmbeddedPost.optional(),
  actorId_populated: ZActor.optional(),
});

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
      logger.warn("Dropping invalid notification", {
        issue: parsed.error?.issues?.[0],
      });
    }
  }
  return valid;
};
