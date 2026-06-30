/**
 * MTN node-blob mirror — makes a content-addressed media blob from an INGESTED
 * record resolvable in Oxy S3.
 *
 * A `mention-node` serves media bytes by `sha256` (content address). Mention's
 * feed renders by Oxy `fileId` (`cloud.oxy.so/<fileId>`), and the read-side
 * resolver ({@link import('./PostMaterializer').resolveEmbedToMedia}) turns a
 * blob `sha256` back into a `fileId` via the REVERSE lookup
 * `getServiceAssetMetadataBySha256`. That lookup only finds a blob that already
 * lives in OUR S3. For a record ingested from a node whose blobs are
 * content-addressed (not yet in our S3), this module pulls the bytes from the
 * node ONCE and mirrors them into Oxy S3 — owned by the record's author — via the
 * EXISTING durable federated-media upload path. After mirroring, the SAME bytes
 * (identical `sha256`) are resolvable, so the resolver produces a fileId and the
 * post renders byte-identically to native media. No new render path; no fake URL.
 *
 * ## Invariants
 *  - BACKGROUND-ONLY: runs exclusively in the node ingest worker
 *    (`MentionNodeSyncService`), NEVER on a request/read path. A down/slow node
 *    only leaves media unmirrored (the post renders text-only until a later run);
 *    it never slows a reader.
 *  - BOUNDED: at most {@link MENTION_NODE_BLOB_MIRROR_MAX_ITEMS} blobs per record,
 *    each ≤ {@link MENTION_NODE_BLOB_MIRROR_MAX_BYTES}. A single record can never
 *    balloon a run.
 *  - FAIL-SOFT — NEVER THROWS: every step (existence check, node fetch, temp-file
 *    write, upload) is best-effort per blob. Any failure is logged and that blob
 *    is left unresolvable (no media materialized for it) — projection still
 *    succeeds with whatever resolved.
 *  - IDEMPOTENT: a blob already present in our S3 (active asset) is skipped before
 *    any fetch, so re-ingesting a record never re-uploads. Oxy dedupes by `sha256`
 *    upstream, so even a race converges to one asset.
 *  - GATED: when the federated-media write side is disabled
 *    (`FEDERATION_MEDIA_CACHE_WRITE_ENABLED` ≠ `'true'`) this is a clean no-op — no
 *    node fetch, no temp files, no upload traffic.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MentionPostRecord, MtnEmbedMediaItem } from '@mention/shared-types';
import { getServiceOxyClient } from '../../utils/oxyHelpers';
import { logger } from '../../utils/logger';
import { isMediaCacheEnabled, uploadFederatedMedia } from '../mediaCache/oxyMediaStore';
import { isAllowedMediaType } from '../mediaCache/mediaTypes';
import {
  MENTION_NODE_BLOB_MIRROR_MAX_ITEMS,
  MENTION_NODE_BLOB_MIRROR_MAX_BYTES,
} from './mentionNodes.constants';

/** Fetch a content-addressed blob's bytes by `sha256`; `null` when the node has none. */
export type NodeBlobFetcher = (sha256: string) => Promise<Buffer | null>;

/** Per-`mediaType` fallback content-type when the blob ref carries no `mime`. */
const DEFAULT_CONTENT_TYPE: Record<MtnEmbedMediaItem['blob']['mediaType'], string> = {
  image: 'image/jpeg',
  video: 'video/mp4',
  gif: 'image/gif',
};

/** Temp-dir prefix for node-blob mirror downloads (under the OS tmpdir). */
const TEMP_DIR_PREFIX = 'mtn-node-blob-';

/** The Oxy asset metadata `app` tag so mirrored node blobs are attributable. */
const MIRROR_OXY_APP = 'mention-node-blob-mirror' as const;

/**
 * Resolve the content-type to send for a blob: its declared `mime` when present
 * AND policy-allowed (image/video/audio family, never SVG), else the per-kind
 * default. Returns `null` when even the default is somehow disallowed (never
 * happens for the three media kinds, but keeps the contract total).
 */
function resolveContentType(blob: MtnEmbedMediaItem['blob']): string | null {
  if (typeof blob.mime === 'string' && blob.mime.length > 0) {
    const family = blob.mime.split(';')[0].trim().toLowerCase();
    if (isAllowedMediaType(family)) return family;
  }
  const fallback = DEFAULT_CONTENT_TYPE[blob.mediaType];
  return isAllowedMediaType(fallback) ? fallback : null;
}

/**
 * The distinct, in-bounds blobs of a post record that are candidates for
 * mirroring: deduped by `sha256`, capped at {@link
 * MENTION_NODE_BLOB_MIRROR_MAX_ITEMS}, with any blob whose advertised `size`
 * already exceeds {@link MENTION_NODE_BLOB_MIRROR_MAX_BYTES} dropped up front
 * (before any fetch).
 */
function candidateBlobs(record: MentionPostRecord): MtnEmbedMediaItem['blob'][] {
  const items = record.embed?.items;
  if (!Array.isArray(items) || items.length === 0) return [];

  const seen = new Set<string>();
  const out: MtnEmbedMediaItem['blob'][] = [];
  for (const item of items) {
    const blob = item?.blob;
    if (!blob || typeof blob.sha256 !== 'string' || blob.sha256.length === 0) continue;
    if (seen.has(blob.sha256)) continue;
    // Drop an over-cap blob before fetching its bytes.
    if (typeof blob.size === 'number' && Number.isFinite(blob.size) && blob.size > MENTION_NODE_BLOB_MIRROR_MAX_BYTES) {
      continue;
    }
    seen.add(blob.sha256);
    out.push(blob);
    if (out.length >= MENTION_NODE_BLOB_MIRROR_MAX_ITEMS) break;
  }
  return out;
}

/**
 * The subset of `sha256s` that are NOT already resolvable as a LIVE asset in our
 * S3. Done with ONE batched reverse lookup so an already-mirrored record makes a
 * single call and fetches nothing. A lookup failure is treated as "all
 * unresolved" so a transient error never blocks a first mirror (Oxy dedupes by
 * `sha256`, so a redundant upload is harmless).
 */
async function unresolvedSha256s(sha256s: string[]): Promise<Set<string>> {
  const unresolved = new Set(sha256s);
  if (sha256s.length === 0) return unresolved;
  try {
    const metadata = await getServiceOxyClient().getServiceAssetMetadataBySha256(sha256s);
    for (const entry of metadata) {
      if (entry.status === 'active' && typeof entry.sha256 === 'string') {
        unresolved.delete(entry.sha256);
      }
    }
  } catch (error) {
    logger.debug('mtnNodeBlobMirror: existence pre-check failed; treating all blobs as unresolved', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return unresolved;
}

/**
 * Fetch one blob's bytes from the node and mirror them into Oxy S3 owned by
 * `ownerOxyUserId`. Best-effort: returns silently on any miss/failure (logged at
 * debug/warn) — NEVER throws.
 */
async function mirrorOneBlob(
  blob: MtnEmbedMediaItem['blob'],
  ownerOxyUserId: string,
  getBlob: NodeBlobFetcher,
): Promise<void> {
  const contentType = resolveContentType(blob);
  if (!contentType) {
    logger.debug('mtnNodeBlobMirror: skipping blob with disallowed content type', {
      sha256: blob.sha256,
      mediaType: blob.mediaType,
    });
    return;
  }

  let bytes: Buffer | null;
  try {
    bytes = await getBlob(blob.sha256);
  } catch (error) {
    logger.debug('mtnNodeBlobMirror: node getBlob failed (non-fatal)', {
      sha256: blob.sha256,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!bytes || bytes.length === 0) {
    // The node does not (yet) hold these bytes — leave the blob unresolvable.
    return;
  }
  // Enforce the byte cap against the ACTUAL fetched length (the advertised `size`
  // was only a hint and was checked earlier as a fast-path).
  if (bytes.length > MENTION_NODE_BLOB_MIRROR_MAX_BYTES) {
    logger.debug('mtnNodeBlobMirror: blob exceeds max bytes; skipping', {
      sha256: blob.sha256,
      bytes: bytes.length,
    });
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX)).catch(() => null);
  if (!dir) {
    logger.warn('mtnNodeBlobMirror: failed to create temp dir; skipping blob', { sha256: blob.sha256 });
    return;
  }
  try {
    const filePath = join(dir, blob.sha256);
    await writeFile(filePath, bytes);
    await uploadFederatedMedia({
      filePath,
      contentType,
      sizeBytes: bytes.length,
      ownerUserId: ownerOxyUserId,
      metadata: { app: MIRROR_OXY_APP, sha256: blob.sha256, mediaType: blob.mediaType },
    });
    logger.debug('mtnNodeBlobMirror: mirrored node blob into Oxy S3', {
      sha256: blob.sha256,
      ownerOxyUserId,
      bytes: bytes.length,
      contentType,
    });
  } catch (error) {
    // A disabled write side, a 403, or any upload failure must never abort ingest.
    logger.warn('mtnNodeBlobMirror: failed to mirror node blob (non-fatal)', {
      sha256: blob.sha256,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Mirror the not-yet-resolvable media blobs of an ingested post record from the
 * node into Oxy S3, so the read-side resolver can later turn each `sha256` into a
 * servable `fileId`. Bounded, background-only, fail-soft, idempotent, gated.
 *
 * @param record   The verified post record being ingested.
 * @param ownerOxyUserId The record author's oxyUserId — the owner of the mirrored
 *                       assets in Oxy S3.
 * @param getBlob  The node's content-addressed blob fetcher (`NodeClient.getBlob`).
 */
export async function mirrorNodeBlobsForRecord(
  record: MentionPostRecord,
  ownerOxyUserId: string,
  getBlob: NodeBlobFetcher,
): Promise<void> {
  // Gate: when the federated-media write side is off, do nothing at all (no node
  // fetch, no temp files) — exactly like the rest of the durable media path.
  if (!isMediaCacheEnabled()) return;

  const blobs = candidateBlobs(record);
  if (blobs.length === 0) return;

  try {
    const unresolved = await unresolvedSha256s(blobs.map((b) => b.sha256));
    const toMirror = blobs.filter((b) => unresolved.has(b.sha256));
    if (toMirror.length === 0) return; // every blob already in our S3 (idempotent)

    // Sequential: ingest is already bounded + background, and serial keeps node /
    // upload pressure modest (a node is untrusted, possibly slow, transport).
    for (const blob of toMirror) {
      await mirrorOneBlob(blob, ownerOxyUserId, getBlob);
    }
  } catch (error) {
    // Defensive: the per-blob path already swallows its errors, but never let a
    // programming error here escape into the ingest worker.
    logger.warn('mtnNodeBlobMirror: mirrorNodeBlobsForRecord encountered an error (non-fatal)', {
      ownerOxyUserId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
