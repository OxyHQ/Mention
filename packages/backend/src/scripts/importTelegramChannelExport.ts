/**
 * ONE-SHOT: import a Telegram channel export into a Mention account.
 *
 * Telegram Desktop exports a channel as `result.json` plus its photos and
 * videos. That export is converted, off-line, into a MANIFEST — one item per
 * post, an album folded into one post, every date taken from `date_unixtime`
 * (UTC; the export's `date` is the exporting machine's local time) — and staged
 * with its media under `telegram-import/<run>/` of the private Cloudflare R2
 * bucket `mention-import-staging`, which deletes every object 30 days after it
 * is written. The operator uploads and presigns with a short-lived token scoped
 * to that bucket (`docs/import.mdx`); this script reads only through the
 * presigned URLs, because Mention's task role calls no storage API and holds no
 * storage credential, and must not start to for one import. The content never
 * goes to GitHub.
 *
 * Every post goes through `postImportService.ingestBatch`, the path Oxy Move's
 * ingest API uses (`docs/import.mdx`): it is an ordinary native post of the
 * target account, dated with its original `createdAt`, recorded in the
 * `post_imports` ledger as platform `telegram` — which is what dedupes a re-run,
 * makes the batch undoable (`DELETE /imports/v1/batches/:batchId`), and
 * records where each post came from. Each media file is uploaded to Oxy first as an
 * asset OWNED BY the target account, the ownership the ingest requires.
 *
 * WHY A SCRIPT AND NOT MOVE. The target is a channel, and a channel can never be
 * the subject of a delegation (`isDelegatedActAsEligibleKind`), so Move — which
 * imports by acting as the user — cannot reach one today. The operator running
 * this workflow is the channel's owner; the script refuses to run unless the
 * target id resolves to the username the operator named.
 *
 * IDEMPOTENT. Items already in the ledger are skipped BEFORE their media is
 * uploaded, so a re-run neither duplicates a post nor re-uploads its files.
 *
 * DRY RUN (the default) reads the manifest, checks every media URL is staged,
 * and reports the plan. It uploads and writes nothing.
 */

import { z } from 'zod';
import { logger } from '../utils/logger';
import { assertAdminMutationAllowed } from './lib/adminScriptSafety';
import { closeAdminScriptResources, registerAdminScriptServices } from './lib/adminScriptLifecycle';
import { connectPostgres } from '../db/postgres';
import { findImportsBySourceIds } from '../db/imports/postImportRepository';
import { getServiceOxyClient } from '../utils/oxyHelpers';
import { resolveUserSummaries } from '../services/PostHydrationService';
import {
  MAX_IMPORT_BATCH_ITEMS,
  MAX_IMPORT_MEDIA_PER_ITEM,
  postImportService,
  type ImportItemInput,
} from '../services/PostImportService';
import { PostVisibility } from '@mention/shared-types';

const SCRIPT_NAME = 'importTelegramChannelExport';

/** Exit code for "some items failed; re-run" — the split `backfillMediaMetadata` uses. */
export const EXIT_INCOMPLETE = 75;

/**
 * The only place a manifest or its media may be read from: the `telegram-import/`
 * prefix of the private R2 bucket `mention-import-staging` (Oxy's Cloudflare
 * account), addressed VIRTUAL-HOSTED — the bucket in the host, so the host alone
 * pins the bucket. A path-style URL (`<account>.r2.cloudflarestorage.com/<bucket>/…`)
 * is refused: its host names every bucket in the account.
 */
export const STAGING_HOST =
  'mention-import-staging.fa4392797e57d4e63ceaaf7b1dc687ed.r2.cloudflarestorage.com';
export const STAGING_PATH_PREFIX = '/telegram-import/';

const MAX_MEDIA_BYTES = 100 * 1024 * 1024;

const TELEGRAM_SOURCE_ID = /^\d+\/\d+$/;
const TELEGRAM_PERMALINK = /^https:\/\/t\.me\/c\/\d+\/\d+$/;
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;

const stagedUrl = z
  .string()
  .url()
  .refine((value) => isStagedUrl(value), 'must be a presigned URL under the staging prefix');

const manifestSchema = z.strictObject({
  channel: z.strictObject({ name: z.string().min(1), telegramId: z.number().int() }),
  items: z
    .array(
      z.strictObject({
        /**
         * `<channel id>/<message id>` — the item's stable key in the ledger, which
         * dedupes on (author, platform, source id). Never the bare message id:
         * message ids restart in every channel, so two channels imported into one
         * account would collide on it.
         */
        sourceId: z.string().regex(TELEGRAM_SOURCE_ID),
        /** The message's permalink, `https://t.me/c/<channel id>/<message id>`. */
        sourceUrl: z.string().regex(TELEGRAM_PERMALINK),
        /** The Telegram channel id, without Telegram's `-100` prefix. */
        sourceAccountId: z.string().regex(/^\d+$/),
        /** The message id within that channel (an album's first message). */
        sourceItemId: z.string().regex(/^\d+$/),
        createdAt: z.string().datetime(),
        text: z.string(),
        media: z
          .array(
            z.strictObject({
              url: stagedUrl,
              mimeType: z.string().regex(/^(image|video)\//),
              fileName: z.string().min(1).max(255),
            }),
          )
          .max(MAX_IMPORT_MEDIA_PER_ITEM),
      }),
    )
    .min(1),
});

export type TelegramManifest = z.infer<typeof manifestSchema>;

export function isStagedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.host === STAGING_HOST &&
      url.pathname.startsWith(STAGING_PATH_PREFIX) &&
      !url.pathname.includes('..')
    );
  } catch {
    return false;
  }
}

export function parseManifest(raw: unknown): TelegramManifest {
  const manifest = manifestSchema.parse(raw);
  const seen = new Set<string>();
  for (const item of manifest.items) {
    if (seen.has(item.sourceId)) throw new Error(`duplicate sourceId ${item.sourceId}`);
    // The key, the link and the structured ids are three spellings of ONE
    // message; a manifest where they disagree is refused, not repaired.
    const key = `${item.sourceAccountId}/${item.sourceItemId}`;
    if (item.sourceId !== key || item.sourceUrl !== `https://t.me/c/${key}`) {
      throw new Error(`item ${item.sourceId} names another message's link or ids`);
    }
    seen.add(item.sourceId);
    if (!item.text.trim() && item.media.length === 0) {
      throw new Error(`item ${item.sourceId} has neither text nor media`);
    }
  }
  return manifest;
}

export type Fetcher = (url: string, maxBytes: number) => Promise<Buffer>;

const fetchStaged: Fetcher = async (url, maxBytes) => {
  if (!isStagedUrl(url)) throw new Error('refusing a URL outside the staging prefix');
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`staged object answered ${response.status}`);
  const length = Number(response.headers.get('content-length') ?? '0');
  if (length > maxBytes) throw new Error(`staged object is ${length} bytes, over ${maxBytes}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error(`staged object is over ${maxBytes} bytes`);
  return buffer;
};

export interface TelegramImportDeps {
  fetchStaged: Fetcher;
  uploadMedia(params: {
    taskId: string;
    ownerUserId: string;
    buffer: Buffer;
    contentType: string;
    fileName: string;
  }): Promise<{ fileId: string; contentType: string }>;
  ingestBatch: typeof postImportService.ingestBatch;
}

const defaultDeps: TelegramImportDeps = {
  fetchStaged,
  async uploadMedia(params) {
    const file = await getServiceOxyClient()
      .assets.withRequester({ taskId: params.taskId, accountId: params.ownerUserId })
      .uploadUserMedia(params.ownerUserId, new Uint8Array(params.buffer), params.contentType, {
        originalName: params.fileName,
        visibility: 'public',
      });
    return { fileId: file.id, contentType: params.contentType };
  },
  ingestBatch: (params) => postImportService.ingestBatch(params),
};

export interface TelegramImportResult {
  items: number;
  alreadyImported: number;
  created: number;
  failed: number;
  failedItems: string[];
}

export async function importTelegramChannelExport(
  manifest: TelegramManifest,
  opts: { targetOxyUserId: string; batchId: string; dryRun?: boolean; taskId?: string },
  deps: TelegramImportDeps = defaultDeps,
): Promise<TelegramImportResult> {
  const dryRun = opts.dryRun ?? true;
  const known = await findImportsBySourceIds(
    opts.targetOxyUserId,
    'telegram',
    manifest.items.map((item) => item.sourceId),
  );
  // Oldest first, so the account's timeline is written in the order it was lived.
  const pending = manifest.items
    .filter((item) => !known.has(item.sourceId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const result: TelegramImportResult = {
    items: manifest.items.length,
    alreadyImported: manifest.items.length - pending.length,
    created: 0,
    failed: 0,
    failedItems: [],
  };
  logger.info('[TelegramImport] plan', {
    dryRun,
    channel: manifest.channel.name,
    ...result,
    pending: pending.length,
    mediaFiles: pending.reduce((n, item) => n + item.media.length, 0),
  });
  if (dryRun || pending.length === 0) return result;
  if (!opts.taskId)
    throw new Error(
      'IMPORT_OXY_TASK_ID must identify the original account-authorized Mention task',
    );

  for (let i = 0; i < pending.length; i += MAX_IMPORT_BATCH_ITEMS) {
    const chunk = pending.slice(i, i + MAX_IMPORT_BATCH_ITEMS);
    const items: ImportItemInput[] = [];
    for (const item of chunk) {
      try {
        const media: ImportItemInput['media'] = [];
        for (const entry of item.media) {
          const buffer = await deps.fetchStaged(entry.url, MAX_MEDIA_BYTES);
          const uploaded = await deps.uploadMedia({
            taskId: opts.taskId,
            ownerUserId: opts.targetOxyUserId,
            buffer,
            contentType: entry.mimeType,
            fileName: entry.fileName,
          });
          media.push({ assetId: uploaded.fileId });
        }
        items.push({
          sourceId: item.sourceId,
          sourceUrl: item.sourceUrl,
          sourceAccountId: item.sourceAccountId,
          sourceItemId: item.sourceItemId,
          createdAt: new Date(item.createdAt),
          text: item.text,
          language: 'es',
          visibility: PostVisibility.PUBLIC,
          media,
        });
      } catch (error) {
        logger.warn('[TelegramImport] media staging failed', {
          sourceId: item.sourceId,
          error: error instanceof Error ? error.message : String(error),
        });
        result.failed++;
        result.failedItems.push(item.sourceId);
      }
    }
    if (items.length === 0) continue;
    const results = await deps.ingestBatch({
      oxyUserId: opts.targetOxyUserId,
      platform: 'telegram',
      batchId: opts.batchId,
      items,
    });
    for (const entry of results) {
      if (entry.status === 'created' || entry.status === 'existing') result.created++;
      else {
        result.failed++;
        result.failedItems.push(`${entry.sourceId}:${entry.error ?? entry.status}`);
      }
    }
    logger.info('[TelegramImport] progress', {
      done: i + chunk.length,
      of: pending.length,
      ...result,
    });
  }

  logger.info('[TelegramImport] complete', { channel: manifest.channel.name, ...result });
  return result;
}

async function main(): Promise<number> {
  const dryRun = (process.env.IMPORT_DRY_RUN ?? 'true') !== 'false';
  const manifestUrl = process.env.IMPORT_MANIFEST_URL ?? '';
  const targetOxyUserId = (process.env.IMPORT_TARGET_OXY_USER_ID ?? '').trim();
  const targetUsername = (process.env.IMPORT_TARGET_USERNAME ?? '').trim().replace(/^@/, '');
  const batchId = (process.env.IMPORT_BATCH_ID ?? '').trim();
  const taskId = (process.env.IMPORT_OXY_TASK_ID ?? '').trim();
  if (!targetOxyUserId || !targetUsername || !batchId) {
    throw new Error(
      'IMPORT_TARGET_OXY_USER_ID, IMPORT_TARGET_USERNAME and IMPORT_BATCH_ID are required',
    );
  }

  assertAdminMutationAllowed({ scriptName: SCRIPT_NAME, dryRun });
  await connectPostgres();
  await registerAdminScriptServices();
  try {
    const summary = (await resolveUserSummaries([targetOxyUserId])).get(targetOxyUserId);
    if (summary?.user?.username !== targetUsername) {
      throw new Error(
        `target ${targetOxyUserId} is @${summary?.user?.username ?? '?'}, not @${targetUsername}`,
      );
    }
    const manifest = parseManifest(
      JSON.parse((await fetchStaged(manifestUrl, MAX_MANIFEST_BYTES)).toString('utf8')),
    );
    const result = await importTelegramChannelExport(manifest, {
      targetOxyUserId,
      batchId,
      dryRun,
      taskId,
    });
    return result.failed > 0 ? EXIT_INCOMPLETE : 0;
  } finally {
    await closeAdminScriptResources();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      logger.error('[TelegramImport] import failed', {
        reason: error instanceof Error ? error.message : 'unknown',
      });
      process.exit(1);
    });
}
