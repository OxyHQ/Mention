import { OxyServices, type BatchFileAccessEntry } from '@oxy.so/core';
import type { SafetyRequester } from '@oxy.so/contracts';
import type { HydratedPostSummary, MediaItem } from '@mention/shared-types';
import { config } from '../config';
import { isOxyFileId } from './postMediaVisibility';

/** Resolve the unique native files for the whole graph through Oxy's live ACL. */
export async function hydratePostMedia(
  posts: readonly Pick<HydratedPostSummary, 'content' | 'attachments'>[],
  requester: SafetyRequester,
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
  // Session-only asset ACLs must never inherit Mention's service identity.
  // Adult MCP reads retain public assets; its connection proof is not a session.
  const client = new OxyServices({ baseURL: config.oxyApiUrl });
  if ('accessToken' in requester && requester.accessToken)
    client.session.setAccessToken(requester.accessToken);
  const access = new Map<string, BatchFileAccessEntry>();
  for (let index = 0; index < ids.length; index += 100) {
    const result = await client.assets.access(
      ids.slice(index, index + 100).map((fileId) => ({ fileId })),
      { context: 'mention-post' },
    );
    for (const [fileId, entry] of Object.entries(result.results)) access.set(fileId, entry);
  }
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
