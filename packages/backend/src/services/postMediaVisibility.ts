/**
 * Post media has to be PUBLIC on Oxy for anyone to see it.
 *
 * Every post's media is rendered from `cloud.oxy.so/<fileId>`
 * (`mediaResolver` builds it with `assets.publicUrl`), and that CDN answers 404
 * for any asset that is not `visibility: 'public'`. But the uploads that feed a
 * post are created private: Oxy's `POST /assets/upload` defaults to `private`,
 * and none of Mention's clients (the composer's file picker, the camera, the
 * share sheet) ask for anything else. So a native post's video or photos were a
 * 404 for every viewer, the author included — a 28 MB reel on 2026-10-10 was
 * the one that surfaced it.
 *
 * The author promotes it at write time, here, rather than each client at upload:
 * this covers every client at once, including native builds already installed.
 * Oxy's `PATCH /assets/:id/visibility` is owner-only and session-only (a service
 * token is refused), so it runs with the author's own bearer, exactly like
 * `ensureProfileMediaPublic` does for the banner.
 */
import type { OxyServices } from '@oxy.so/core';
import { authorVariants } from './postVariants';
import { logger } from '../utils/logger';
import { createUserScopedOxyServices } from '../utils/oxyHelpers';

type PostMediaContent = Parameters<typeof authorVariants>[0];

/**
 * A bare Oxy file id. Client-side temp ids and absolute URLs (federated or
 * external media, which has no Oxy visibility) are not.
 */
export function isOxyFileId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && !id.startsWith('temp-') && !/^https?:\/\//i.test(id);
}

/**
 * Every Oxy file id a post's content references, deduped: the shared
 * `content.media`, each author variant's replacement set, and the media ids a
 * variant's `alt` map localizes (those keys are file ids).
 */
export function postMediaFileIds(content: PostMediaContent | null | undefined): string[] {
  if (!content) return [];
  const fileIds = new Set<string>();
  const sharedMedia = Array.isArray(content.media) ? content.media : [];
  for (const m of sharedMedia) {
    if (isOxyFileId(m?.id)) fileIds.add(m.id);
  }
  for (const variant of authorVariants(content)) {
    if (Array.isArray(variant.media)) {
      for (const m of variant.media) {
        if (isOxyFileId(m?.id)) fileIds.add(m.id);
      }
    }
    if (variant.alt) {
      for (const mediaId of Object.keys(variant.alt)) {
        if (isOxyFileId(mediaId)) fileIds.add(mediaId);
      }
    }
  }
  return [...fileIds];
}

/**
 * Bound on one visibility change, in ms. Oxy moves the original AND every
 * variant under the `public/` prefix before it answers, one S3 copy after
 * another, so a long video takes seconds — past the SDK's 5s default for JSON
 * calls. Timing out there would not undo the change (Oxy finishes it), but the
 * post would be written before its media is servable.
 */
export const POST_MEDIA_VISIBILITY_TIMEOUT_MS = 60_000;

/** The author's own Oxy session, with room for {@link POST_MEDIA_VISIBILITY_TIMEOUT_MS}. */
export function createPostMediaOwnerClient(req: Parameters<typeof createUserScopedOxyServices>[0]) {
  return createUserScopedOxyServices(req, { requestTimeout: POST_MEDIA_VISIBILITY_TIMEOUT_MS });
}

/**
 * Make a post's media public with the author's own Oxy session.
 *
 * Awaited by the write paths so the post is never served before its media is,
 * but it never fails the write: no session (an MCP caller, whose uploads are
 * already public), an asset the caller does not own, or an Oxy error is logged
 * and the post goes ahead. Making an already-public asset public is a no-op.
 */
export async function ensurePostMediaPublic(
  client: Pick<OxyServices, 'assets'> | undefined,
  content: PostMediaContent | null | undefined,
): Promise<void> {
  if (!client) return;
  const fileIds = postMediaFileIds(content);
  if (fileIds.length === 0) return;
  const results = await Promise.allSettled(fileIds.map((fileId) => client.assets.setVisibility(fileId, 'public')));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      logger.warn('[postMediaVisibility] Failed to make post media public', {
        fileId: fileIds[index],
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  });
}
