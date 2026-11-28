import type { HydratedPost } from '@mention/shared-types';

/**
 * When a scheduled post is due to publish.
 *
 * Reads `metadata.scheduledFor`, which `PostHydrationService` emits alongside
 * `status` — the hydrated DTO is the only place the composer learns this, since
 * hydration drops an unpublished post for anyone but its owner.
 *
 * `null` when the post carries no usable time, so callers render that as its own
 * state rather than as an `Invalid Date`.
 */
export function scheduledDate(post: HydratedPost): Date | null {
  const raw = post.metadata?.scheduledFor;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * True once the publish time has passed.
 *
 * The publisher sweeps every 60s, so a post can legitimately sit past-due and
 * still be `scheduled` — or have published moments ago while the list was open.
 * Either way the row must stop advertising a future time, and the cancel copy
 * must stop promising the post was never published.
 */
export function isPastDue(post: HydratedPost, now: number = Date.now()): boolean {
  const date = scheduledDate(post);
  return date !== null && date.getTime() <= now;
}
