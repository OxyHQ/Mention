import { z } from 'zod/v4';
import { api, formatApiError } from '../lib/api-client.js';
import { unwrapApiResponse } from '../lib/api-response.js';
import { withAuthGuard } from '../lib/auth-guard.js';
import { formatPost } from '../lib/formatters.js';
import { buildPostContentPayload } from '../lib/resolve-media.js';
import { mediaInputSchema } from '../lib/post-content-schema.js';
import type { MentionToolRegistrar } from '../lib/tool-registry.js';

export function registerInteractionsTools(server: MentionToolRegistrar): void {
  server.tool(
    'like-post',
    'Like a post (requires authorization).',
    { id: z.string().describe('The post ID to like') },
    withAuthGuard(async ({ id }) => {
      try {
        await api.post(`/posts/${encodeURIComponent(id)}/like`);
        return { content: [{ type: 'text' as const, text: `Post ${id} liked.` }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'unlike-post',
    'Remove your like from a post (requires authorization).',
    { id: z.string() },
    withAuthGuard(async ({ id }) => {
      try {
        await api.delete(`/posts/${encodeURIComponent(id)}/like`);
        return { content: [{ type: 'text' as const, text: `Post ${id} unliked.` }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'save-post',
    'Bookmark a post (requires authorization).',
    { id: z.string() },
    withAuthGuard(async ({ id }) => {
      try {
        await api.post(`/posts/${encodeURIComponent(id)}/save`);
        return { content: [{ type: 'text' as const, text: `Post ${id} saved to bookmarks.` }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'unsave-post',
    'Remove a post from bookmarks (requires authorization).',
    { id: z.string() },
    withAuthGuard(async ({ id }) => {
      try {
        await api.delete(`/posts/${encodeURIComponent(id)}/save`);
        return { content: [{ type: 'text' as const, text: `Post ${id} removed from bookmarks.` }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'boost',
    'Boost a post to your followers (requires authorization).',
    { id: z.string() },
    withAuthGuard(async ({ id }) => {
      try {
        const result = await api.post('/feed/boost', {
          originalPostId: id,
          content: { text: '' },
          mentions: [],
          hashtags: [],
        });
        const boost = unwrapApiResponse<Record<string, unknown>>(
          (result as { boost?: unknown }).boost ?? result,
        );
        return {
          content: [{ type: 'text' as const, text: `Post ${id} boosted.\n\n${formatPost(boost)}` }],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'unboost',
    "Remove your boost of a post (requires authorization). Pass the ORIGINAL post's ID, the same one given to boost.",
    { id: z.string().describe('The original post ID you boosted') },
    withAuthGuard(async ({ id }) => {
      try {
        await api.delete(`/feed/${encodeURIComponent(id)}/boost`);
        return { content: [{ type: 'text' as const, text: `Boost of post ${id} removed.` }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'get-bookmark-folders',
    'List the folders your saved posts are sorted into (requires authorization). Pass a folder name to get-saved-posts to read one.',
    {},
    withAuthGuard(async () => {
      try {
        const result = await api.get<{ folders?: unknown }>('/posts/bookmarks/folders');
        const folders = Array.isArray(result.folders)
          ? result.folders.filter((folder): folder is string => typeof folder === 'string')
          : [];
        if (folders.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No bookmark folders yet.' }] };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: `Bookmark folders (${folders.length}):\n\n${folders.join('\n')}`,
            },
          ],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'move-saved-post-to-folder',
    'Move one of your saved posts into a bookmark folder, creating the folder if it is new, or back out of every folder with folder null (requires authorization). The post must already be saved.',
    {
      id: z.string().describe("The saved post's ID"),
      folder: z
        .string()
        .min(1)
        .nullable()
        .describe('Folder name, or null to take the post out of its folder'),
    },
    withAuthGuard(async ({ id, folder }) => {
      try {
        await api.patch(`/posts/bookmarks/by-post/${encodeURIComponent(id)}/folder`, { folder });
        const text =
          folder === null
            ? `Saved post ${id} taken out of its folder.`
            : `Saved post ${id} moved to folder "${folder}".`;
        return { content: [{ type: 'text' as const, text }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'quote-post',
    'Quote a post with commentary and optional media (requires authorization).',
    {
      id: z.string(),
      text: z.string().describe('Your commentary'),
      media: z.array(mediaInputSchema).max(10).optional(),
    },
    withAuthGuard(async ({ id, text, media }) => {
      try {
        const content = await buildPostContentPayload({
          text,
          ...(media ? { media } : {}),
        });
        const result = await api.post('/posts', {
          content,
          hashtags: [],
          mentions: [],
          visibility: 'public',
          quoted_post_id: id,
        });
        const post = unwrapApiResponse(result);
        return {
          content: [{ type: 'text' as const, text: `Quote post created.\n\n${formatPost(post)}` }],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );
}
