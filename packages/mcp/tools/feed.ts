import { z } from 'zod/v4';
import { isValidFeedDescriptor, parseFeedDescriptor } from '@mention/shared-types';
import { api, formatApiError } from '../lib/api-client.js';
import { authRequiredResponse, getMcpToken, withAuthGuard } from '../lib/auth-guard.js';
import { fetchMtnFeed, paginationParams } from '../lib/mtn-feed.js';
import { formatFeed } from '../lib/formatters.js';
import type { MentionToolRegistrar } from '../lib/tool-registry.js';

export function registerFeedTools(server: MentionToolRegistrar): void {
  server.tool(
    'get-feed',
    'Get a feed by descriptor (default: explore). Returns the complete API feed as structuredContent, including slices, timestamps, reasons and pagination. Personalized feeds require authorization. Use get-saved-posts and get-list-timeline for saved posts and lists.',
    {
      descriptor: z
        .string()
        .refine(isValidFeedDescriptor, 'Invalid feed descriptor')
        .refine(
          (value) => value !== 'saved' && !value.startsWith('list|'),
          'Use get-saved-posts or get-list-timeline for this feed',
        )
        .optional()
        .describe(
          'explore, for_you, following, following_direct, trending, videos, media, mutuals, friends_popular, friends_of_friends, author|id[|filter], hashtag|tag, topic|topic, trend|term, lane|id, custom|id, feedgen|uri',
        ),
      limit: z.number().optional().describe('Number of posts (default: 20, max: 100)'),
      cursor: z.string().optional().describe('Pagination cursor from a previous response'),
    },
    async ({ descriptor = 'explore', limit, cursor }) => {
      try {
        if (!isValidFeedDescriptor(descriptor)) throw new Error('Invalid feed descriptor');
        const { source } = parseFeedDescriptor(descriptor);
        if (
          [
            'for_you',
            'following',
            'following_direct',
            'videos',
            'media',
            'mutuals',
            'friends_popular',
            'friends_of_friends',
            'custom',
          ].includes(source) &&
          !getMcpToken()
        ) {
          return authRequiredResponse();
        }
        const result = await fetchMtnFeed(descriptor, { limit, cursor });
        return {
          content: [{ type: 'text' as const, text: formatFeed(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  server.tool(
    'get-for-you-feed',
    'Get your personalized For You feed (requires Mention authorization).',
    {
      limit: z.number().optional().describe('Number of posts (default: 20, max: 100)'),
      cursor: z.string().optional().describe('Pagination cursor'),
    },
    withAuthGuard(async ({ limit, cursor }) => {
      try {
        const result = await fetchMtnFeed('for_you', { limit, cursor });
        return {
          content: [{ type: 'text' as const, text: formatFeed(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'get-explore-feed',
    'Get the explore feed with popular and trending posts (public).',
    {
      limit: z.number().optional().describe('Number of posts (default: 20, max: 100)'),
      cursor: z.string().optional().describe('Pagination cursor'),
    },
    async ({ limit, cursor }) => {
      try {
        const result = await fetchMtnFeed('explore', { limit, cursor });
        return {
          content: [{ type: 'text' as const, text: formatFeed(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  server.tool(
    'get-following-feed',
    'Get posts from accounts you follow (requires Mention authorization).',
    {
      limit: z.number().optional().describe('Number of posts (default: 20, max: 100)'),
      cursor: z.string().optional().describe('Pagination cursor'),
    },
    withAuthGuard(async ({ limit, cursor }) => {
      try {
        const result = await fetchMtnFeed('following', { limit, cursor });
        return {
          content: [{ type: 'text' as const, text: formatFeed(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'get-videos-feed',
    'Get the ranked videos/reels feed (requires Mention authorization for personalized ranking).',
    {
      limit: z.number().optional().describe('Number of posts (default: 20, max: 100)'),
      cursor: z.string().optional().describe('Pagination cursor'),
    },
    withAuthGuard(async ({ limit, cursor }) => {
      try {
        const result = await fetchMtnFeed('videos', { limit, cursor });
        return {
          content: [{ type: 'text' as const, text: formatFeed(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'get-user-feed',
    "Get posts from a specific user's profile (public posts visible without auth).",
    {
      userId: z.string().describe('The Oxy user ID whose posts to fetch'),
      limit: z.number().optional().describe('Number of posts (default: 20, max: 100)'),
      cursor: z.string().optional().describe('Pagination cursor'),
    },
    async ({ userId, limit, cursor }) => {
      try {
        const result = await fetchMtnFeed(`author|${userId}`, { limit, cursor });
        return {
          content: [{ type: 'text' as const, text: formatFeed(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  server.tool(
    'get-replies',
    'Get replies to a specific post.',
    {
      parentId: z.string().describe('The post ID to get replies for'),
      limit: z.number().optional().describe('Number of replies (default: 20, max: 100)'),
      cursor: z.string().optional().describe('Pagination cursor'),
    },
    async ({ parentId, limit, cursor }) => {
      try {
        const result = await api.get<Record<string, unknown>>(
          `/feed/replies/${encodeURIComponent(parentId)}`,
          paginationParams(limit, cursor),
        );
        return {
          content: [{ type: 'text' as const, text: formatFeed(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    },
  );

  server.tool(
    'get-feed-item',
    'Get a single feed item with full hydration (author, engagement).',
    {
      id: z.string().describe('The post ID'),
    },
    async ({ id }) => {
      try {
        const result = await api.get<Record<string, unknown>>(
          `/feed/item/${encodeURIComponent(id)}`,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: formatFeed({ items: [result as Record<string, unknown>] }),
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    },
  );
}
