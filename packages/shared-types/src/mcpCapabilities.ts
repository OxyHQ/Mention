import type { CatalogTool } from '@oxy.so/contracts';

export const MENTION_MCP_RESOURCE = 'https://mcp.mention.earth';
export const MENTION_CAPABILITY_AUDIENCE = 'mention-api';

export type MentionToolPolicy = Pick<
  CatalogTool,
  | 'capabilityPackage'
  | 'requiredCapabilities'
  | 'resourceTypes'
  | 'effect'
  | 'idempotency'
  | 'rollback'
  | 'exposure'
  | 'limitKeys'
  | 'invocation'
>;

const account = ['mention_account'];
const post = ['mention_account', 'post'];
const job = ['mention_account', 'job'];

function read(
  path: string,
  capability: string,
  resourceTypes: string[] = post,
  limit = false,
): MentionToolPolicy {
  return {
    capabilityPackage: 'read',
    requiredCapabilities: [capability],
    resourceTypes,
    effect: 'read',
    idempotency: 'none',
    rollback: 'none',
    exposure: ['internal', 'mcp'],
    limitKeys: limit ? [{ key: 'limit', kind: 'maximum_number' }] : [],
    invocation: { method: 'GET', path },
  };
}

function effect(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  capabilityPackage: MentionToolPolicy['capabilityPackage'],
  capability: string,
  resourceTypes: string[],
  options: {
    idempotency?: Exclude<MentionToolPolicy['idempotency'], 'none'>;
    rollback?: MentionToolPolicy['rollback'];
  } = {},
): MentionToolPolicy {
  return {
    capabilityPackage,
    requiredCapabilities: [capability],
    resourceTypes,
    effect: 'external',
    // The MCP transport derives a stable key from the authenticated JSON-RPC
    // invocation and Mention reserves it durably before entering the route.
    idempotency: options.idempotency ?? 'required',
    rollback: options.rollback ?? 'manual',
    exposure: ['internal', 'mcp'],
    limitKeys: [],
    invocation: { method, path },
  };
}

function write(
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  capabilityPackage: MentionToolPolicy['capabilityPackage'],
  capability: string,
  resourceTypes: string[],
  options: {
    idempotency?: Exclude<MentionToolPolicy['idempotency'], 'none'>;
    rollback?: MentionToolPolicy['rollback'];
  } = {},
): MentionToolPolicy {
  return {
    ...effect(method, path, capabilityPackage, capability, resourceTypes, options),
    effect: 'write',
  };
}

function mcpOnly(policy: MentionToolPolicy): MentionToolPolicy {
  return { ...policy, exposure: ['mcp'] };
}

/** Policy-only metadata. Tool names, descriptions, schemas and handlers live once in the tool modules. */
export const MENTION_TOOL_POLICIES: Readonly<Record<string, MentionToolPolicy>> = {
  'get-feed': read('/feed/mtn', 'social.read', post, true),
  'get-for-you-feed': read('/feed/mtn', 'social.read', post, true),
  'get-explore-feed': read('/feed/mtn', 'social.read', post, true),
  'get-following-feed': read('/feed/mtn', 'social.read', post, true),
  'get-videos-feed': read('/feed/mtn', 'social.read', post, true),
  'get-user-feed': read('/feed/mtn', 'social.read', post, true),
  'get-replies': read('/feed/replies/{parentId}', 'social.read', post, true),
  'get-feed-item': read('/feed/item/{id}', 'social.read', post),
  search: read('/search', 'social.search', post, true),
  'get-trending-hashtags': read('/trending', 'social.read', ['mention_account', 'hashtag'], true),
  'get-posts-by-hashtag': read(
    '/feed/mtn',
    'social.read',
    ['mention_account', 'hashtag', 'post'],
    true,
  ),
  'get-profile': read('/profile/design/{userId}', 'social.profile.read', [
    'mention_account',
    'profile',
  ]),
  'get-recommendations': read(
    '/recommendations',
    'social.profile.read',
    ['mention_account', 'profile'],
    true,
  ),
  'get-poll': read('/polls/{id}', 'social.read', ['mention_account', 'poll']),
  'get-poll-results': read('/polls/{id}/results', 'social.read', ['mention_account', 'poll']),
  'get-post': read('/feed/item/{id}', 'social.posts.read', post),
  'get-drafts': read('/posts/drafts', 'social.posts.read', post, true),
  'get-scheduled-posts': read('/posts/scheduled', 'social.posts.read', post, true),
  'get-saved-posts': read('/posts/saved', 'social.posts.read', post, true),
  'get-bookmark-folders': read('/posts/bookmarks/folders', 'social.posts.read', post),
  'get-muted-users': read('/mute', 'social.mutes.read', ['mention_account', 'profile']),
  'get-muted-words': read('/mute-words', 'social.mutes.read', account),
  'get-muted-lanes': read('/lanes/muted', 'social.mutes.read', ['mention_account', 'lane']),
  'get-lists': read('/lists', 'social.lists.read', ['mention_account', 'list']),
  'list-lanes': read('/lanes/mine', 'social.lanes.read', ['mention_account', 'lane']),
  'get-list-timeline': read(
    '/lists/{id}/timeline',
    'social.lists.read',
    ['mention_account', 'list', 'post'],
    true,
  ),
  'get-notifications': read(
    '/notifications',
    'social.notifications.read',
    ['mention_account', 'notification'],
    true,
  ),
  'get-unread-count': read('/notifications/unread-count', 'social.notifications.read', [
    'mention_account',
    'notification',
  ]),
  'get-starter-pack': read('/starter-packs/{id}', 'social.starter_packs.read', [
    'mention_account',
    'starter_pack',
  ]),
  'get-starter-packs': read(
    '/starter-packs',
    'social.starter_packs.read',
    ['mention_account', 'starter_pack'],
    true,
  ),
  'search-gifs': read('/gifs/search', 'social.media.read', ['mention_account', 'media'], true),
  whoami: mcpOnly(read('/mcp/bundles/me', 'social.accounts.read', account)),
  'list-accounts': mcpOnly(read('/mcp/bundles/accounts', 'social.accounts.read', account)),

  'create-post': effect('POST', '/posts', 'publish', 'social.posts.publish', post, {
    rollback: 'none',
  }),
  'create-thread': effect('POST', '/posts/thread', 'publish', 'social.posts.publish', post, {
    rollback: 'none',
  }),
  'update-post': effect('PUT', '/posts/{id}', 'publish', 'social.posts.update', post),
  'move-post-to-lane': write(
    'PATCH',
    '/posts/{id}/lane',
    'administer',
    'social.posts.update',
    ['mention_account', 'post', 'lane'],
    { rollback: 'supported' },
  ),
  'delete-post': effect('DELETE', '/posts/{id}', 'publish', 'social.posts.delete', post, {
    rollback: 'none',
  }),
  'publish-post-now': effect(
    'POST',
    '/posts/{id}/publish',
    'publish',
    'social.posts.publish',
    post,
    { rollback: 'none' },
  ),
  'pin-post': write('PATCH', '/posts/{id}/settings', 'administer', 'social.posts.update', post, {
    rollback: 'supported',
  }),
  'unpin-post': write('PATCH', '/posts/{id}/settings', 'administer', 'social.posts.update', post, {
    rollback: 'supported',
  }),
  'update-post-settings': write(
    'PATCH',
    '/posts/{id}/settings',
    'administer',
    'social.posts.update',
    post,
    { rollback: 'supported' },
  ),
  'accept-collab-invite': effect(
    'POST',
    '/posts/{id}/collaborators/accept',
    'publish',
    'social.collaboration.manage',
    post,
    { rollback: 'supported' },
  ),
  'decline-collab-invite': effect(
    'POST',
    '/posts/{id}/collaborators/decline',
    'publish',
    'social.collaboration.manage',
    post,
    { rollback: 'supported' },
  ),
  'stop-collab-sharing': effect(
    'POST',
    '/posts/{id}/collaborators/stop-sharing',
    'publish',
    'social.collaboration.manage',
    post,
    { rollback: 'none' },
  ),
  'like-post': effect('POST', '/posts/{id}/like', 'communicate', 'social.interact', post, {
    rollback: 'supported',
  }),
  'unlike-post': effect('DELETE', '/posts/{id}/like', 'communicate', 'social.interact', post, {
    rollback: 'supported',
  }),
  'save-post': write('POST', '/posts/{id}/save', 'administer', 'social.posts.save', post, {
    rollback: 'supported',
  }),
  'unsave-post': write('DELETE', '/posts/{id}/save', 'administer', 'social.posts.save', post, {
    rollback: 'supported',
  }),
  boost: effect('POST', '/feed/boost', 'communicate', 'social.interact', post, {
    rollback: 'supported',
  }),
  unboost: effect('DELETE', '/feed/{postId}/boost', 'communicate', 'social.interact', post, {
    rollback: 'supported',
  }),
  'move-saved-post-to-folder': write(
    'PATCH',
    '/posts/bookmarks/by-post/{postId}/folder',
    'administer',
    'social.posts.save',
    post,
    { rollback: 'supported' },
  ),
  'quote-post': effect('POST', '/posts', 'publish', 'social.posts.publish', post, {
    rollback: 'none',
  }),
  'vote-poll': effect(
    'POST',
    '/polls/{id}/vote',
    'communicate',
    'social.polls.vote',
    ['mention_account', 'poll'],
    { rollback: 'none' },
  ),
  'follow-user': effect(
    'POST',
    '/federation/follow',
    'communicate',
    'social.follow',
    ['mention_account', 'profile'],
    { rollback: 'supported' },
  ),
  'unfollow-user': effect(
    'POST',
    '/federation/unfollow',
    'communicate',
    'social.follow',
    ['mention_account', 'profile'],
    { rollback: 'supported' },
  ),
  'follow-entity': write(
    'POST',
    '/entity-follows',
    'administer',
    'social.follow',
    ['mention_account', 'hashtag', 'list'],
    { rollback: 'supported' },
  ),
  'unfollow-entity': write(
    'DELETE',
    '/entity-follows',
    'administer',
    'social.follow',
    ['mention_account', 'hashtag', 'list'],
    { rollback: 'supported' },
  ),
  'poke-user': effect(
    'POST',
    '/pokes/{userId}',
    'communicate',
    'social.interact',
    ['mention_account', 'profile'],
    { rollback: 'supported' },
  ),
  'unpoke-user': effect(
    'DELETE',
    '/pokes/{userId}',
    'communicate',
    'social.interact',
    ['mention_account', 'profile'],
    { rollback: 'supported' },
  ),
  'mark-notifications-read': write(
    'PATCH',
    '/notifications/read-all',
    'administer',
    'social.notifications.manage',
    ['mention_account', 'notification'],
    { rollback: 'supported' },
  ),
  'mark-notification-read': write(
    'PATCH',
    '/notifications/{id}/read',
    'administer',
    'social.notifications.manage',
    ['mention_account', 'notification'],
    { rollback: 'supported' },
  ),
  'subscribe-to-user': write(
    'POST',
    '/subscriptions/{authorId}',
    'administer',
    'social.notifications.manage',
    ['mention_account', 'profile'],
    { rollback: 'supported' },
  ),
  'unsubscribe-from-user': write(
    'DELETE',
    '/subscriptions/{authorId}',
    'administer',
    'social.notifications.manage',
    ['mention_account', 'profile'],
    { rollback: 'supported' },
  ),
  'mute-user': write(
    'POST',
    '/mute',
    'administer',
    'social.mutes.manage',
    ['mention_account', 'profile'],
    { rollback: 'supported' },
  ),
  'unmute-user': write(
    'DELETE',
    '/mute/{mutedId}',
    'administer',
    'social.mutes.manage',
    ['mention_account', 'profile'],
    { rollback: 'supported' },
  ),
  'mute-word': write('POST', '/mute-words', 'administer', 'social.mutes.manage', account, {
    rollback: 'supported',
  }),
  'unmute-word': write('DELETE', '/mute-words/{id}', 'administer', 'social.mutes.manage', account, {
    rollback: 'supported',
  }),
  'mute-lane': write(
    'POST',
    '/lanes/{id}/mute',
    'administer',
    'social.mutes.manage',
    ['mention_account', 'lane'],
    { rollback: 'supported' },
  ),
  'unmute-lane': write(
    'DELETE',
    '/lanes/{id}/mute',
    'administer',
    'social.mutes.manage',
    ['mention_account', 'lane'],
    { rollback: 'supported' },
  ),

  'create-list': write(
    'POST',
    '/lists',
    'create',
    'social.lists.create',
    ['mention_account', 'list'],
    { rollback: 'supported' },
  ),
  'update-list': write(
    'PUT',
    '/lists/{id}',
    'administer',
    'social.lists.update',
    ['mention_account', 'list'],
    { rollback: 'supported' },
  ),
  'create-lane': write(
    'POST',
    '/lanes',
    'create',
    'social.lanes.manage',
    ['mention_account', 'lane'],
    { rollback: 'supported' },
  ),
  'update-lane': write(
    'PATCH',
    '/lanes/{id}',
    'administer',
    'social.lanes.manage',
    ['mention_account', 'lane'],
    { rollback: 'supported' },
  ),
  'delete-lane': write(
    'DELETE',
    '/lanes/{id}',
    'administer',
    'social.lanes.manage',
    ['mention_account', 'lane'],
    { rollback: 'none' },
  ),
  'delete-list': write(
    'DELETE',
    '/lists/{id}',
    'administer',
    'social.lists.delete',
    ['mention_account', 'list'],
    { rollback: 'none' },
  ),
  'add-list-members': write(
    'POST',
    '/lists/{id}/members',
    'administer',
    'social.lists.update',
    ['mention_account', 'list', 'profile'],
    { rollback: 'supported' },
  ),
  'remove-list-members': write(
    'DELETE',
    '/lists/{id}/members',
    'administer',
    'social.lists.update',
    ['mention_account', 'list', 'profile'],
    { rollback: 'supported' },
  ),
  'create-starter-pack': write(
    'POST',
    '/starter-packs',
    'create',
    'social.starter_packs.create',
    ['mention_account', 'starter_pack'],
    { rollback: 'supported' },
  ),
  'update-starter-pack': write(
    'PUT',
    '/starter-packs/{id}',
    'administer',
    'social.starter_packs.update',
    ['mention_account', 'starter_pack'],
    { rollback: 'supported' },
  ),
  'delete-starter-pack': write(
    'DELETE',
    '/starter-packs/{id}',
    'administer',
    'social.starter_packs.delete',
    ['mention_account', 'starter_pack'],
    { rollback: 'none' },
  ),
  'add-starter-pack-members': write(
    'POST',
    '/starter-packs/{id}/members',
    'administer',
    'social.starter_packs.update',
    ['mention_account', 'starter_pack'],
    { rollback: 'supported' },
  ),
  'remove-starter-pack-members': write(
    'DELETE',
    '/starter-packs/{id}/members',
    'administer',
    'social.starter_packs.update',
    ['mention_account', 'starter_pack'],
    { rollback: 'supported' },
  ),
  'use-starter-pack': effect(
    'POST',
    '/starter-packs/{id}/use',
    'communicate',
    'social.follow',
    ['mention_account', 'starter_pack', 'profile'],
    { rollback: 'none' },
  ),
  'upload-media-from-url': write(
    'POST',
    '/posts/intent-media',
    'create',
    'social.media.create',
    ['mention_account', 'media'],
    { rollback: 'supported' },
  ),
  'upload-media': write(
    'POST',
    '/posts/intent-media',
    'create',
    'social.media.create',
    ['mention_account', 'media'],
    { rollback: 'supported' },
  ),
  'use-gif': write(
    'POST',
    '/gifs/use',
    'create',
    'social.media.create',
    ['mention_account', 'media'],
    { rollback: 'supported' },
  ),
  'link-account': mcpOnly(
    write('POST', '/mcp/bundles/link-token', 'delegate', 'social.accounts.link', account, {
      rollback: 'none',
    }),
  ),
  'switch-account': mcpOnly(
    write('POST', '/mcp/bundles/active', 'administer', 'social.accounts.switch', account, {
      rollback: 'supported',
    }),
  ),

  'list-my-jobs': read('/jobs/mine', 'social.jobs.read', job, true),
  'search-job-places': read('/jobs/places/search', 'social.jobs.read', job, true),
  'get-job-applications': read(
    '/jobs/{id}/applications',
    'social.jobs.applications.read',
    ['mention_account', 'job', 'job_application'],
    true,
  ),
  'create-job': write('POST', '/jobs', 'create', 'social.jobs.create', job, {
    rollback: 'supported',
  }),
  'update-job': write('PUT', '/jobs/{id}', 'administer', 'social.jobs.update', job, {
    rollback: 'supported',
  }),
  'publish-job': write('POST', '/jobs/{id}/publish', 'administer', 'social.jobs.update', job, {
    rollback: 'supported',
  }),
  'pause-job': write('POST', '/jobs/{id}/pause', 'administer', 'social.jobs.update', job, {
    rollback: 'supported',
  }),
  'close-job': write('POST', '/jobs/{id}/close', 'administer', 'social.jobs.update', job, {
    rollback: 'none',
  }),
};

export const MENTION_MCP_CAPABILITIES = Object.freeze(
  [
    ...new Set(
      Object.values(MENTION_TOOL_POLICIES).flatMap((policy) => policy.requiredCapabilities),
    ),
  ].sort(),
);

export interface MentionCapabilityRequirement {
  readonly toolName: string;
  readonly requiredCapabilities: readonly string[];
}

const ROUTE_REQUIREMENTS = Object.entries(MENTION_TOOL_POLICIES).map(([toolName, policy]) => ({
  toolName,
  method: policy.invocation.method,
  pathPattern: compileInvocationPath(policy.invocation.path),
  requiredCapabilities: policy.requiredCapabilities,
}));

function compileInvocationPath(template: string): RegExp {
  const pattern = template
    .split('/')
    .map((segment) =>
      /^\{[^{}]+\}$/.test(segment) ? '[^/]+' : segment.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${pattern}$`);
}

/**
 * Resolve every catalog tool whose declared domain invocation matches one API
 * request. More than one requirement is returned when two read tools share the
 * same endpoint; satisfying any one exact capability set authorizes that route.
 */
export function mentionCapabilityRequirementsForRequest(
  method: string,
  pathname: string,
): readonly MentionCapabilityRequirement[] {
  const normalizedMethod = method.toUpperCase();
  return ROUTE_REQUIREMENTS.filter(
    (entry) => entry.method === normalizedMethod && entry.pathPattern.test(pathname),
  ).map(({ toolName, requiredCapabilities }) => ({
    toolName,
    requiredCapabilities,
  }));
}
