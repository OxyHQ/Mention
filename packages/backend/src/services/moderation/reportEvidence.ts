import { asc, eq } from 'drizzle-orm';
import type { MediaItem } from '@mention/shared-types';
import { getDb } from '../../db/postgres';
import { moderationReportEvidenceFiles } from '../../db/schema/moderation';
import { logger } from '../../utils/logger';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { isOxyFileId } from '../postMediaVisibility';
import { describeOxyError, oxyErrorCode, oxyErrorStatus } from '../oxyFiles/oxyErrors';
import type { ModerationResource } from './subjects/types';

/**
 * A reported post's media, as CrowdSource evidence (ADR 0043;
 * `docs/oxy-files.md`).
 *
 * CrowdSource accepts an evidence file only when the reporting APPLICATION owns
 * it (or its organization's account does) and it holds exactly the declared
 * SHA-256. A post's media belongs to its author, so Mention sends a COPY it
 * owns: Oxy gives the Mention application its own `unlisted` file of the post
 * file's bytes (`adoptAppFile`, ADR 0043 stage 4b). The stored object is
 * SHARED — nothing is downloaded or uploaded again — and the copy outlives the
 * author deleting theirs; Oxy answers the copy's `sha256` itself, so the
 * declared digest is Oxy's own record of the bytes, the source's exactly.
 *
 * ## Once per report
 *
 * The copies are made at the report's FIRST delivery attempt and stored in
 * `moderation_report_evidence_files`; every later attempt reads them back.
 * CrowdSource fingerprints the whole envelope, so evidence re-made per attempt
 * — a file deleted between two attempts, an import answering differently —
 * would turn a retry into a permanent 409.
 *
 * ## What is only declared
 *
 * An item becomes an `AssetRef` only when Oxy made the copy. A federated item
 * the media cache never re-hosted (its id is a URL), an item Mention withholds,
 * and a file Oxy refuses to adopt (gone: 404; taken down: 451; private, which an
 * `unlisted` copy would widen: 400 `VISIBILITY_WIDER_THAN_SOURCE`) are stored
 * with an `unavailable_reason` and sent as nothing — the post's media summary
 * already declares them. Anything else (Oxy down, 5xx, 429) throws, and the
 * outbox retries the delivery.
 *
 * Each copy is referenced as entity `moderation_report` while its report exists
 * (trigger, migration 0077), and CrowdSource references it as its `case`; once
 * neither does, Oxy collects it.
 */

/** Items per report: a post carries a handful; a bound keeps one report's adoptions bounded. */
export const MAX_EVIDENCE_ITEMS = 10;

type EvidenceRow = typeof moderationReportEvidenceFiles.$inferSelect;

/** An Oxy answer that will be the same on every attempt: the file cannot be copied. */
function isPermanentRefusal(error: unknown): boolean {
  const status = oxyErrorStatus(error);
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** The evidence media of a post: its shared set and its primary variant's override. */
export function evidenceMediaOf(media: readonly (MediaItem | undefined)[]): MediaItem[] {
  const seen = new Set<string>();
  const items: MediaItem[] = [];
  for (const item of media) {
    if (!item || typeof item.id !== 'string' || item.id.length === 0 || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
    if (items.length === MAX_EVIDENCE_ITEMS) break;
  }
  return items;
}

async function copyOne(
  reportId: string,
  item: MediaItem,
  position: number,
): Promise<typeof moderationReportEvidenceFiles.$inferInsert> {
  const base = {
    reportId,
    position,
    sourceFileId: item.id,
    mediaType: item.type,
    sourceUrl: item.remoteUrl ?? (isOxyFileId(item.id) ? null : item.id),
  };
  if (!isOxyFileId(item.id)) return { ...base, unavailableReason: 'not_rehosted' };
  if (item.withheld) return { ...base, unavailableReason: `withheld:${item.withheld}` };

  try {
    const adopted = await getServiceOxyClient().assets.adoptAppFile(item.id, {
      visibility: 'unlisted',
    });
    return {
      ...base,
      evidenceFileId: adopted.file.id,
      mimeType: adopted.file.mime,
      sha256: adopted.file.sha256,
      sizeBytes: Number.isFinite(adopted.file.size) ? adopted.file.size : null,
      width: item.width ?? null,
      height: item.height ?? null,
      durationSeconds: item.durationSec ?? null,
    };
  } catch (error) {
    if (!isPermanentRefusal(error)) throw error;
    logger.info('[CrowdSource] evidence item could not be copied; declared only', {
      reportId,
      position,
      reason: describeOxyError(error),
    });
    return {
      ...base,
      unavailableReason: (oxyErrorCode(error) ?? `HTTP_${oxyErrorStatus(error)}`).slice(0, 64),
    };
  }
}

async function storedEvidence(reportId: string): Promise<EvidenceRow[]> {
  return getDb()
    .select()
    .from(moderationReportEvidenceFiles)
    .where(eq(moderationReportEvidenceFiles.reportId, reportId))
    .orderBy(asc(moderationReportEvidenceFiles.position));
}

/** One stored copy as the contract's resource: an `image` or `video` with its `AssetRef`. */
function toResource(row: EvidenceRow): ModerationResource | null {
  if (!row.evidenceFileId || !row.sha256 || !row.mimeType) return null;
  const asset = {
    fileId: row.evidenceFileId,
    mimeType: row.mimeType,
    sha256: row.sha256,
    ...(row.sizeBytes === null ? {} : { sizeBytes: row.sizeBytes }),
    ...(row.width === null ? {} : { width: row.width }),
    ...(row.height === null ? {} : { height: row.height }),
    ...(row.durationSeconds === null ? {} : { durationSeconds: row.durationSeconds }),
    ...(row.sourceUrl ? { url: row.sourceUrl } : {}),
  };
  // A GIF is an mp4 Mention plays as an image; the bytes say video.
  const isVideo = row.mediaType === 'video' || row.mimeType.startsWith('video/');
  return isVideo ? { type: 'video', asset } : { type: 'image', asset };
}

/**
 * The evidence of one report — made at the first call, read back on every
 * later one. Throws (retryable) when Oxy could not answer.
 */
export async function ensureReportEvidence(
  reportId: string,
  media: readonly MediaItem[],
): Promise<ModerationResource[]> {
  let rows = await storedEvidence(reportId);
  if (rows.length === 0 && media.length > 0) {
    const copies = [];
    for (const [position, item] of evidenceMediaOf(media).entries()) {
      copies.push(await copyOne(reportId, item, position));
    }
    // A concurrent attempt may have stored its own: the first write wins, and
    // both read back the same rows.
    await getDb().insert(moderationReportEvidenceFiles).values(copies).onConflictDoNothing();
    rows = await storedEvidence(reportId);
  }
  return rows
    .map(toResource)
    .filter((resource): resource is ModerationResource => resource !== null);
}
