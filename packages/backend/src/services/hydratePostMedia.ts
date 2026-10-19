import { OxyServices, type BatchFileAccessEntry } from '@oxy.so/core';
import type { SafetyRequester } from '@oxy.so/contracts';
import type { HydratedPostSummary, MediaItem } from '@mention/shared-types';
import { config } from '../config';
import { isOxyFileId } from './postMediaVisibility';

type FileAccess = Map<string, BatchFileAccessEntry>;

/** The server caps one batch-access call at this many entries. */
const ACCESS_BATCH_SIZE = 100;

/**
 * The reader's own session token, or `undefined` when Oxy's batch ACL cannot
 * answer for them.
 *
 * Oxy's batch ACL answers only for a signed-in session, and it must never
 * inherit Mention's service identity. A reader without one (anonymous, or an
 * adult MCP connection, whose proof is not a session) keeps the stored URLs:
 * Oxy's stream enforces the file's visibility on every byte, so a private file
 * stays unreadable to them. Supervised readers always present a session.
 */
function sessionToken(requester: SafetyRequester): string | undefined {
  return 'accessToken' in requester && requester.accessToken ? requester.accessToken : undefined;
}

/** Ask Oxy's live ACL about `ids` as the reader, one call per server batch. */
async function readFileAccess(ids: readonly string[], token: string): Promise<FileAccess> {
  const client = new OxyServices({ baseURL: config.oxyApiUrl });
  client.session.setAccessToken(token);
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += ACCESS_BATCH_SIZE) {
    batches.push(ids.slice(index, index + ACCESS_BATCH_SIZE));
  }
  const results = await Promise.all(
    batches.map((batch) =>
      client.assets.access(
        batch.map((fileId) => ({ fileId })),
        { context: 'mention-post' },
      ),
    ),
  );
  const access: FileAccess = new Map();
  for (const result of results) {
    for (const [fileId, entry] of Object.entries(result.results)) access.set(fileId, entry);
  }
  return access;
}

/** An ACL lookup already in flight, for {@link hydratePostMedia} to finish from. */
export interface PostMediaAccessPrefetch {
  ids: ReadonlySet<string>;
  access: Promise<FileAccess>;
}

/**
 * Start the reader's file-ACL lookup for files a caller already knows it will
 * render, so the Oxy round trip runs beside whatever else the caller is doing.
 * `undefined` when there is nothing to ask or nobody Oxy can answer for.
 *
 * The caller must only pass files of posts the reader has already been
 * admitted to: the lookup asks Oxy about them in the reader's name.
 */
export function prefetchPostMediaAccess(
  fileIds: Iterable<string>,
  requester: SafetyRequester,
): PostMediaAccessPrefetch | undefined {
  const token = sessionToken(requester);
  if (!token) return undefined;
  const ids = new Set([...fileIds].filter(isOxyFileId));
  if (ids.size === 0) return undefined;
  const access = readFileAccess([...ids], token);
  // Awaited by `hydratePostMedia`; until then a rejection must not surface as
  // unhandled. The awaiting caller still receives it.
  access.catch(() => undefined);
  return { ids, access };
}

/**
 * Resolve the unique native files for the whole graph through Oxy's live ACL.
 * Files a {@link PostMediaAccessPrefetch} already covers are not asked again.
 */
export async function hydratePostMedia(
  posts: readonly Pick<HydratedPostSummary, 'content' | 'attachments'>[],
  requester: SafetyRequester,
  prefetched?: PostMediaAccessPrefetch,
): Promise<void> {
  const collections: MediaItem[][] = [];
  for (const post of posts) {
    if (post.content.media) collections.push(post.content.media);
    if (post.attachments?.media) collections.push(post.attachments.media);
    for (const variant of post.content.variants ?? [])
      if (variant.media) collections.push(variant.media);
  }
  const ids = [
    ...new Set(
      collections.flatMap((items) =>
        items.filter((item) => isOxyFileId(item.id)).map((item) => item.id),
      ),
    ),
  ];
  if (!ids.length) return;
  const token = sessionToken(requester);
  if (!token) return;
  const unasked = prefetched ? ids.filter((id) => !prefetched.ids.has(id)) : ids;
  const [early, late] = await Promise.all([
    prefetched?.access ?? Promise.resolve<FileAccess>(new Map()),
    unasked.length ? readFileAccess(unasked, token) : Promise.resolve<FileAccess>(new Map()),
  ]);
  const access: FileAccess = new Map([...early, ...late]);
  for (const items of collections) {
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index];
      if (!isOxyFileId(item.id)) continue;
      const entry = access.get(item.id);
      const url = entry?.allowed ? entry.url : undefined;
      if (!url) {
        items.splice(index, 1);
        continue;
      }
      // The canonical URL may be protected and scoped. Never derive a CDN URL
      // or retain a public thumbnail beside it; a future variant request must
      // go through the same canonical API.
      if (entry?.visibility === 'public') continue;
      item.url = url;
      delete item.thumbUrl;
      delete item.fullUrl;
      delete item.posterUrl;
      delete item.hlsUrl;
    }
  }
}
