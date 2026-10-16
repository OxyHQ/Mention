import { FILE_EVENT_TYPES, type FileEvent } from '@oxy.so/core/server';
import { eq, sql } from 'drizzle-orm';
import { forceResendFileReferences } from '../../db/oxyFiles/fileReferenceSyncRepository';
import { getDb, type DatabaseOrTransaction } from '../../db/postgres';
import { gifs } from '../../db/schema/discovery';
import { mentionJobApplications } from '../../db/schema/jobs';
import {
  OXY_FILE_EVENT_TYPES,
  OXY_FILE_OWNER_KINDS,
  OXY_FILE_STATE_RETENTION_SECONDS,
  oxyFileEvents,
  oxyFileStates,
} from '../../db/schema/oxyFiles';
import type { MEDIA_WITHHELD_REASONS } from '../../db/schema/postContent';
import { userSettings } from '../../db/schema/userProfile';
import { logger } from '../../utils/logger';
import { invalidate as invalidatePostDetailCache } from '../postDetailCache';

/**
 * What Mention does when Oxy says a file it uses or owns changed
 * (ADR 0043 D9/D10; the route is `routes/oxyFileEvents.routes.ts`).
 *
 * ## One rule: the file's state decides
 *
 * Every event carries the file's status and visibility AFTER the change, so the
 * latest event (by `occurredAt`; delivery is unordered and at least once) says
 * everything: Mention WITHHOLDS a file Oxy does not serve to a public reader —
 *
 *   status `deleted` → `deleted` (terminal: nothing releases it)
 *   status `blocked` → `blocked` (a rights or privacy takedown)
 *   status `trash`   → `trashed`
 *   active + `private` → `private`
 *   active + public/unlisted → served again
 *
 * — whatever the event type was called. An older event than the one applied
 * changes nothing (recorded, `applied = false`).
 *
 * ## What withholding does
 *
 * - Posts: every post and variant media row with the file id is marked
 *   `withheld` (`post_media.withheld`); the row and its Oxy reference stay, so
 *   the item comes back when the file does (`file.unblocked`, `file.restored`
 *   reach only applications that still reference it). Readers drop withheld
 *   items: the DTOs, ActivityPub, MTN records, the Videos lane. New rows take
 *   the file's state by trigger, so an edit cannot un-withhold an item.
 * - `deleted` / `blocked` (permanent from Mention's side): the GIF library row
 *   using the file is removed (Oxy collects the application file it stops
 *   referencing), and a profile banner or a job-application resume naming it is
 *   cleared.
 * - Mention's OWN application file in trash means Oxy saw it unreferenced — a
 *   reference lost to a bug or an outage. Its GIF references are re-sent, which
 *   restores it (a reference brings an application's file back from trash).
 *
 * The event row (`oxy_file_events`) is written in the same transaction as all
 * of it: the dedupe record, and the audit of what was done.
 */

type WithheldReason = (typeof MEDIA_WITHHELD_REASONS)[number];

// The SDK's event types ARE the stored ones (the CHECK on `oxy_file_events.type`).
const _sdkEventTypesAreStored: readonly (typeof OXY_FILE_EVENT_TYPES)[number][] = FILE_EVENT_TYPES;
const _storedEventTypesAreSdk: readonly (typeof FILE_EVENT_TYPES)[number][] = OXY_FILE_EVENT_TYPES;
void _sdkEventTypesAreStored;
void _storedEventTypesAreSdk;

/** The withholding a file's reported state calls for; `undefined` for a status this build does not know. */
export function withholdingFor(file: FileEvent['file']): WithheldReason | null | undefined {
  switch (file.status) {
    case 'deleted':
      return 'deleted';
    case 'blocked':
      return 'blocked';
    case 'trash':
      return 'trashed';
    case 'active':
      return file.visibility === 'private' ? 'private' : null;
    default:
      return undefined;
  }
}

export interface FileEventOutcome {
  duplicate: boolean;
  applied: boolean;
  withheld: WithheldReason | null;
  mediaRowsChanged: number;
  gifsRemoved: number;
  bannersCleared: number;
  resumesCleared: number;
  referencesResent: number;
}

const NOTHING_DONE = {
  mediaRowsChanged: 0,
  gifsRemoved: 0,
  bannersCleared: 0,
  resumesCleared: 0,
  referencesResent: 0,
};

/** Rewrite `withheld` on every media row of the file; the posts touched. */
async function rewriteMediaWithholding(
  tx: DatabaseOrTransaction,
  fileId: string,
  withheld: WithheldReason | null,
): Promise<{ rows: number; postIds: string[] }> {
  const shared = await tx.execute<{ post_id: string }>(sql`
    update post_media set withheld = ${withheld}
    where media_id = ${fileId} and withheld is distinct from ${withheld}
    returning post_id
  `);
  const variants = await tx.execute<{ post_id: string }>(sql`
    update post_variant_media vm set withheld = ${withheld}
    from post_content_variants v
    where v.id = vm.variant_id and vm.media_id = ${fileId} and vm.withheld is distinct from ${withheld}
    returning v.post_id
  `);
  const rows = [...shared, ...variants];
  return { rows: rows.length, postIds: [...new Set(rows.map((row) => row.post_id))] };
}

/**
 * Apply one verified event. Idempotent on `event.id`; throws only on a database
 * error (the route answers 5xx and Oxy retries).
 */
export async function applyFileEvent(event: FileEvent): Promise<FileEventOutcome> {
  const fileId = event.file.id;
  const occurredAt = new Date(event.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) throw new Error('File event has no valid occurredAt');
  const ownerKind = (OXY_FILE_OWNER_KINDS as readonly string[]).includes(event.file.ownerKind)
    ? event.file.ownerKind
    : 'platform';
  const desired = withholdingFor(event.file);

  const { outcome, postIds } = await getDb().transaction(async (tx) => {
    const inserted = await tx
      .insert(oxyFileEvents)
      .values({
        eventId: event.id,
        type: event.type,
        fileId,
        ownerKind,
        fileStatus: String(event.file.status).slice(0, 32),
        fileVisibility: String(event.file.visibility).slice(0, 32),
        occurredAt,
        applied: false,
        referencesListed: Array.isArray(event.references) ? event.references.length : 0,
      })
      .onConflictDoNothing({ target: oxyFileEvents.eventId })
      .returning({ eventId: oxyFileEvents.eventId });
    if (inserted.length === 0) {
      return {
        outcome: { duplicate: true, applied: false, withheld: null, ...NOTHING_DONE },
        postIds: [] as string[],
      };
    }

    // Serialize events of one file, and read what was applied before.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`oxy-file-event:${fileId}`}))`);
    const [previous] = await tx
      .select()
      .from(oxyFileStates)
      .where(eq(oxyFileStates.fileId, fileId))
      .limit(1);

    const stale = previous !== undefined && previous.lastEventAt.getTime() > occurredAt.getTime();
    const terminal = previous?.withheld === 'deleted' && desired !== 'deleted';
    if (desired === undefined || stale || terminal) {
      if (desired === undefined) {
        logger.error('[FileEvents] file status this build does not know; event not applied', {
          eventId: event.id,
          status: String(event.file.status).slice(0, 32),
        });
      }
      return {
        outcome: {
          duplicate: false,
          applied: false,
          withheld: previous?.withheld ?? null,
          ...NOTHING_DONE,
        },
        postIds: [] as string[],
      };
    }

    await tx
      .insert(oxyFileStates)
      .values({
        fileId,
        status: String(event.file.status).slice(0, 32),
        visibility: String(event.file.visibility).slice(0, 32),
        withheld: desired,
        lastEventId: event.id,
        lastEventAt: occurredAt,
        expiresAt: desired
          ? null
          : sql`now() + (${OXY_FILE_STATE_RETENTION_SECONDS} * interval '1 second')`,
      })
      .onConflictDoUpdate({
        target: oxyFileStates.fileId,
        set: {
          status: String(event.file.status).slice(0, 32),
          visibility: String(event.file.visibility).slice(0, 32),
          withheld: desired,
          lastEventId: event.id,
          lastEventAt: occurredAt,
          expiresAt: desired
            ? null
            : sql`now() + (${OXY_FILE_STATE_RETENTION_SECONDS} * interval '1 second')`,
          updatedAt: new Date(),
        },
      });

    const done = { ...NOTHING_DONE };
    const media = await rewriteMediaWithholding(tx, fileId, desired);
    done.mediaRowsChanged = media.rows;

    if (desired === 'deleted' || desired === 'blocked') {
      const removedGifs = await tx
        .delete(gifs)
        .where(sql`${gifs.mp4FileId} = ${fileId} or ${gifs.previewFileId} = ${fileId}`)
        .returning({ id: gifs.id });
      done.gifsRemoved = removedGifs.length;
      const banners = await tx
        .update(userSettings)
        .set({ profileHeaderImage: null })
        .where(eq(userSettings.profileHeaderImage, fileId))
        .returning({ id: userSettings.oxyUserId });
      done.bannersCleared = banners.length;
      const resumes = await tx
        .update(mentionJobApplications)
        .set({ resumeFileId: null })
        .where(eq(mentionJobApplications.resumeFileId, fileId))
        .returning({ id: mentionJobApplications.id });
      done.resumesCleared = resumes.length;
    }

    if (desired === 'trashed' && event.file.ownerKind === 'application') {
      const users = await tx
        .select({ id: gifs.id })
        .from(gifs)
        .where(sql`${gifs.mp4FileId} = ${fileId} or ${gifs.previewFileId} = ${fileId}`);
      await forceResendFileReferences(
        users.map((row) => ({ fileId, entityType: 'gif' as const, entityId: row.id })),
        tx,
      );
      done.referencesResent = users.length;
    }

    await tx
      .update(oxyFileEvents)
      .set({ applied: true, withheld: desired, ...done })
      .where(eq(oxyFileEvents.eventId, event.id));

    return {
      outcome: { duplicate: false, applied: true, withheld: desired, ...done },
      postIds: media.postIds,
    };
  });

  // After commit: the post-record cache would keep serving the item until its
  // TTL. Best effort — a failed invalidation only delays the change by the TTL.
  for (const postId of postIds) {
    await invalidatePostDetailCache(postId).catch(() => undefined);
  }

  if (outcome.applied) {
    logger.info('[FileEvents] file event applied', {
      eventId: event.id,
      type: event.type,
      withheld: outcome.withheld,
      mediaRowsChanged: outcome.mediaRowsChanged,
      gifsRemoved: outcome.gifsRemoved,
      bannersCleared: outcome.bannersCleared,
      resumesCleared: outcome.resumesCleared,
      referencesResent: outcome.referencesResent,
    });
  }
  return outcome;
}
