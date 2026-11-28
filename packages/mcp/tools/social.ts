import { z } from 'zod/v4';
import { api, formatApiError } from '../lib/api-client.js';
import { withAuthGuard } from '../lib/auth-guard.js';
import type { MentionToolRegistrar } from '../lib/tool-registry.js';

export function registerSocialTools(server: MentionToolRegistrar): void {
  server.tool(
    'follow-user',
    'Follow a Mention user or a federated actor (requires authorization). Pass actorUri: a Mention username (`nate`, `@nate`, `nate@mention.earth`), an Oxy user ID, or a remote ActivityPub URI / acct handle (user@domain.com) / atproto handle.',
    {
      actorUri: z
        .string()
        .describe('Mention username, Oxy user ID, or remote actor URI / acct handle to follow'),
    },
    withAuthGuard(async ({ actorUri }) => {
      try {
        const result = await api.post('/federation/follow', { actorUri });
        const obj = result as Record<string, unknown>;
        const pending = obj.pending === true ? ' (pending approval)' : '';
        const text =
          typeof obj.oxyUserId === 'string'
            ? `${obj.changed === false ? 'Already following' : 'Now following'} ${actorUri}.`
            : `Follow request sent for ${actorUri}${pending}.`;
        return {
          content: [
            {
              type: 'text' as const,
              text,
            },
          ],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'unfollow-user',
    'Unfollow a Mention user or a federated actor (requires authorization). Accepts the same forms as follow-user.',
    {
      actorUri: z
        .string()
        .describe('Mention username, Oxy user ID, or remote actor URI / acct handle to unfollow'),
    },
    withAuthGuard(async ({ actorUri }) => {
      try {
        await api.post('/federation/unfollow', { actorUri });
        return { content: [{ type: 'text' as const, text: `Unfollowed ${actorUri}.` }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'follow-entity',
    'Follow a hashtag or a list, so its posts reach your feeds (requires authorization). Undo with unfollow-entity.',
    {
      entityType: z.enum(['hashtag', 'list']),
      entityId: z
        .string()
        .min(1)
        .max(100)
        .describe('The hashtag (with or without #) or the list ID'),
    },
    withAuthGuard(async ({ entityType, entityId }) => {
      try {
        await api.post('/entity-follows', { entityType, entityId });
        return {
          content: [{ type: 'text' as const, text: `Now following ${entityType} ${entityId}.` }],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'unfollow-entity',
    'Stop following a hashtag or a list (requires authorization).',
    {
      entityType: z.enum(['hashtag', 'list']),
      entityId: z
        .string()
        .min(1)
        .max(100)
        .describe('The hashtag (with or without #) or the list ID'),
    },
    withAuthGuard(async ({ entityType, entityId }) => {
      try {
        await api.delete('/entity-follows', { entityType, entityId });
        return {
          content: [
            { type: 'text' as const, text: `Stopped following ${entityType} ${entityId}.` },
          ],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'subscribe-to-user',
    'Get a notification whenever a user posts (requires authorization). This does not follow them. Undo with unsubscribe-from-user.',
    { userId: z.string().describe('Oxy user ID, as get-post and get-profile show it') },
    withAuthGuard(async ({ userId }) => {
      try {
        await api.post(`/subscriptions/${encodeURIComponent(userId)}`);
        return {
          content: [{ type: 'text' as const, text: `You will be notified when ${userId} posts.` }],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'unsubscribe-from-user',
    "Stop the notifications for a user's new posts (requires authorization).",
    { userId: z.string().describe('Oxy user ID') },
    withAuthGuard(async ({ userId }) => {
      try {
        await api.delete(`/subscriptions/${encodeURIComponent(userId)}`);
        return {
          content: [{ type: 'text' as const, text: `No longer notified when ${userId} posts.` }],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'poke-user',
    'Poke a user: they get a notification that you poked them (requires authorization). Undo with unpoke-user, which withdraws the poke but not a notification already delivered.',
    { userId: z.string().describe('Oxy user ID, as get-post and get-profile show it') },
    withAuthGuard(async ({ userId }) => {
      try {
        await api.post(`/pokes/${encodeURIComponent(userId)}`);
        return { content: [{ type: 'text' as const, text: `Poked ${userId}.` }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'unpoke-user',
    'Withdraw a poke you sent (requires authorization).',
    { userId: z.string().describe('Oxy user ID') },
    withAuthGuard(async ({ userId }) => {
      try {
        await api.delete(`/pokes/${encodeURIComponent(userId)}`);
        return { content: [{ type: 'text' as const, text: `Poke to ${userId} withdrawn.` }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    }),
  );

  server.tool(
    'get-recommendations',
    'Get who-to-follow account recommendations (personalized when authorized).',
    {
      limit: z.number().optional(),
      excludeTypes: z.string().optional(),
      offset: z.number().optional(),
    },
    async ({ limit, excludeTypes, offset }) => {
      try {
        const query: Record<string, string | number | boolean | undefined> = {};
        if (limit) query.limit = limit;
        if (excludeTypes) query.excludeTypes = excludeTypes;
        if (offset) query.offset = offset;

        const result = await api.get('/recommendations', query);
        const recommendations = Array.isArray((result as Record<string, unknown>).recommendations)
          ? ((result as Record<string, unknown>).recommendations as Record<string, unknown>[])
          : [];
        if (recommendations.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No recommendations available.' }] };
        }
        const lines = recommendations.map((profile) => {
          const nameObj =
            profile.name && typeof profile.name === 'object'
              ? (profile.name as Record<string, unknown>)
              : undefined;
          const displayName = typeof nameObj?.displayName === 'string' ? nameObj.displayName : '';
          const username = typeof profile.username === 'string' ? profile.username : '';
          const label = username ? `@${username}` : displayName || 'unknown';
          const suffix = username && displayName ? ` (${displayName})` : '';
          const countObj =
            profile._count && typeof profile._count === 'object'
              ? (profile._count as Record<string, unknown>)
              : undefined;
          const followers = typeof countObj?.followers === 'number' ? countObj.followers : 0;
          const mutual = typeof profile.mutualCount === 'number' ? profile.mutualCount : 0;
          const badges: string[] = [];
          if (profile.verified === true) badges.push('verified');
          if (profile.isFederated === true) badges.push('federated');
          const badgeText = badges.length > 0 ? ` [${badges.join(', ')}]` : '';
          return `${label}${suffix} — ${followers} followers, ${mutual} mutual${badgeText}`;
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: `Recommendations (${recommendations.length}):\n\n${lines.join('\n')}`,
            },
          ],
        };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: formatApiError(error) }], isError: true };
      }
    },
  );
}
