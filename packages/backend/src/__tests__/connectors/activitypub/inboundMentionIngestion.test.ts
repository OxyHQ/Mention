import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Inbound federated @mention ingestion.
 *
 * A federated Note carries its @mentions in the content HTML (a Mastodon-style
 * `<a class="u-url mention" href="…">@user</a>` anchor) AND in a machine-readable
 * `tag` array (`{ type:'Mention', href:<actorUri>, name:'@user@host' }`). The
 * inbox must resolve each tag's actor to the synced federated/local Oxy user id and
 * rewrite the matching anchor into the internal `[mention:<oxyUserId>]` placeholder
 * so hydration renders `@user@host` linking to that user — instead of the anchor
 * being stripped to dead `@user` text.
 *
 * These pin, on `handleCreate`:
 *   - a Mention tag → the stored body carries `[mention:<oxyUserId>]` (NOT `@user`)
 *     and `post.mentions` holds the resolved id (the one `getOrFetchActor` returns);
 *   - a LOCAL mentioned user gets a `type:'mention'` notification (via the SAME
 *     `createMentionNotifications` util the native path calls);
 *   - a redelivered Create (activityId already stored) never re-notifies;
 *   - a note with NO Mention tags is stored unchanged (empty `mentions`, no notify).
 *
 * Drives the REAL `InboxProcessingService` with the sibling
 * `inboundEngagementNotifications.test.ts` mocking convention: mock the models +
 * notification util + `services/fediverseSharing`, let `actor.service.ts` +
 * `constants.ts` (mention resolution) run for real against the mocked
 * `FederatedActor` model / Oxy client, and mock `outbox.service.ts` wholesale.
 */

const REMOTE = 'https://remote.example';
const AUTHOR_URI = `${REMOTE}/users/carol`;
const AUTHOR_OXY_ID = 'oxy_carol';

// A FEDERATED mentioned actor: Mastodon-style — its in-content anchor points at the
// human profile URL (`/@bob`), its `Mention` tag href at the actor URI (`/users/bob`).
const FED_MENTION_URI = `${REMOTE}/users/bob`;
const FED_MENTION_PROFILE = `${REMOTE}/@bob`;
const FED_MENTION_OXY_ID = 'oxy_fed_bob';

// A LOCAL mentioned user: the tag href is our own actor URI, the anchor our profile URL.
const LOCAL_MENTION_ACTOR_URI = 'https://mention.earth/ap/users/alice';
const LOCAL_MENTION_PROFILE = 'https://mention.earth/@alice';
const LOCAL_MENTION_OXY_ID = 'oxy_alice_local';

const CREATED_POST_ID = 'created_post_1';

const mocks = vi.hoisted(() => ({
  actorFindOne: vi.fn(),
  followExists: vi.fn(),
  postFindOne: vi.fn(),
  postExists: vi.fn(),
  postUpdateOne: vi.fn(),
  postCreatorCreate: vi.fn(),
  ensureFederatedReplyLink: vi.fn(),
  isFediverseSharingEnabled: vi.fn(),
  getProfileByUsername: vi.fn(),
  searchProfiles: vi.fn(),
  createMentionNotifications: vi.fn(),
  createPostAuthorNotifications: vi.fn(),
  createNotification: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock('../../../utils/logger', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: mocks.loggerDebug,
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../../../connectors/activitypub/crypto', () => ({
  getPublicKey: vi.fn(),
  signViaOxy: vi.fn(),
  signRequest: vi.fn(),
}));

vi.mock('../../../models/FederatedActor', () => ({
  default: { findOne: mocks.actorFindOne },
}));

vi.mock('../../../models/FederatedFollow', () => ({
  default: { exists: mocks.followExists },
}));

vi.mock('../../../models/FederationDeliveryQueue', () => ({
  default: {},
  getNextRetryTime: vi.fn(),
}));

vi.mock('../../../models/Post', () => ({
  POST_CLASSIFICATION_PENDING: 'pending',
  Post: {
    findOne: mocks.postFindOne,
    exists: mocks.postExists,
    updateOne: mocks.postUpdateOne,
    deleteOne: vi.fn(),
  },
}));

vi.mock('../../../models/Like', () => ({
  default: { create: vi.fn(), findOneAndDelete: vi.fn() },
}));

vi.mock('../../../models/UserSettings', () => ({
  default: { updateOne: vi.fn() },
}));

vi.mock('../../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({
    getProfileByUsername: mocks.getProfileByUsername,
    searchProfiles: mocks.searchProfiles,
  }),
}));

vi.mock('../../../services/mediaCache/cacheWorker', () => ({
  persistRemoteMediaForFederatedOwnerDetailed: vi.fn(),
}));

vi.mock('../../../services/mediaCache/cacheStore', () => ({
  recordAccessAndMaybeEnqueue: vi.fn(),
}));

vi.mock('../../../services/serviceRegistry', () => ({
  getPostCreator: () => ({ create: mocks.postCreatorCreate }),
  registerPostFederator: vi.fn(),
  registerPostCreator: vi.fn(),
  getPostFederator: vi.fn(),
}));

vi.mock('../../../services/fediverseSharing', () => ({
  isFediverseSharingEnabled: (...args: unknown[]) => mocks.isFediverseSharingEnabled(...args),
}));

// Notification utils are imported LAZILY inside the handlers (to avoid the load-time
// server cycle); this module mock intercepts that dynamic import too.
vi.mock('../../../utils/notificationUtils', () => ({
  createMentionNotifications: mocks.createMentionNotifications,
  createPostAuthorNotifications: mocks.createPostAuthorNotifications,
  createNotification: mocks.createNotification,
  createWelcomeNotification: vi.fn(),
  createBatchNotifications: vi.fn(),
}));

vi.mock('../../../connectors/activitypub/outbox.service', () => ({
  outboxSyncService: {
    ensureFederatedReplyLink: (...args: unknown[]) => mocks.ensureFederatedReplyLink(...args),
    importAnnounce: vi.fn(),
    syncOutboxPosts: vi.fn(),
  },
}));

import { inboxProcessingService } from '../../../connectors/activitypub/inbox.service';

/** Map each actor URI (author + federated mentions) to its resolved Oxy id. */
function stubActors(byUri: Record<string, string>): void {
  mocks.actorFindOne.mockImplementation((filter: { uri?: string }) => ({
    lean: async () => {
      const oxyUserId = filter.uri ? byUri[filter.uri] : undefined;
      return oxyUserId ? { uri: filter.uri, oxyUserId, lastFetchedAt: new Date() } : null;
    },
  }));
}

/** The captured `create()` params of the single stored post. */
function createdPost(): {
  mentions?: string[];
  content?: { variants?: Array<{ text: string }> };
} {
  return mocks.postCreatorCreate.mock.calls[0]?.[0] as {
    mentions?: string[];
    content?: { variants?: Array<{ text: string }> };
  };
}

function primaryVariantText(): string {
  return createdPost().content?.variants?.[0]?.text ?? '';
}

/** A Create(Note) with the given content HTML and Mention tags. */
function createActivity(
  content: string,
  tag: Array<{ type: string; href: string; name: string }>,
): Record<string, unknown> {
  return {
    id: `${AUTHOR_URI}/statuses/1/activity`,
    type: 'Create',
    actor: AUTHOR_URI,
    object: {
      id: `${AUTHOR_URI}/statuses/1`,
      type: 'Note',
      attributedTo: AUTHOR_URI,
      content,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      tag,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.followExists.mockResolvedValue({ _id: 'follow_1' });
  mocks.postExists.mockResolvedValue(null);
  mocks.postUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.postCreatorCreate.mockResolvedValue({ _id: CREATED_POST_ID });
  mocks.ensureFederatedReplyLink.mockResolvedValue(null);
  mocks.isFediverseSharingEnabled.mockResolvedValue(true);
  mocks.postFindOne.mockReturnValue({ lean: async () => null });
  stubActors({ [AUTHOR_URI]: AUTHOR_OXY_ID, [FED_MENTION_URI]: FED_MENTION_OXY_ID });
});

describe('handleCreate — inbound @mention ingestion', () => {
  it('rewrites a FEDERATED mention anchor to a [mention:<oxyUserId>] placeholder and stores post.mentions', async () => {
    const content =
      '<p>hey <span class="h-card"><a href="https://remote.example/@bob" class="u-url mention">@<span>bob</span></a></span> look</p>';
    const activity = createActivity(content, [
      { type: 'Mention', href: FED_MENTION_URI, name: '@bob@remote.example' },
    ]);

    await inboxProcessingService.processInboxActivity(activity, AUTHOR_URI);

    expect(mocks.postCreatorCreate).toHaveBeenCalledTimes(1);
    // The resolved id is the one getOrFetchActor returns for the tag's actor URI.
    expect(createdPost().mentions).toEqual([FED_MENTION_OXY_ID]);
    // Body carries the placeholder, never the bare visible handle.
    expect(primaryVariantText()).toContain(`[mention:${FED_MENTION_OXY_ID}]`);
    expect(primaryVariantText()).not.toContain('@bob');
    // A federated mention has no Mention inbox → no notification.
    expect(mocks.createMentionNotifications).not.toHaveBeenCalled();
  });

  it('notifies a LOCAL mentioned user with type:"mention" (native util) and stores the local id', async () => {
    mocks.getProfileByUsername.mockResolvedValue({ _id: LOCAL_MENTION_OXY_ID, username: 'alice' });
    const content =
      '<p>cc <span class="h-card"><a href="https://mention.earth/@alice" class="u-url mention">@<span>alice</span></a></span></p>';
    const activity = createActivity(content, [
      { type: 'Mention', href: LOCAL_MENTION_ACTOR_URI, name: '@alice@mention.earth' },
    ]);

    await inboxProcessingService.processInboxActivity(activity, AUTHOR_URI);

    expect(createdPost().mentions).toEqual([LOCAL_MENTION_OXY_ID]);
    expect(primaryVariantText()).toContain(`[mention:${LOCAL_MENTION_OXY_ID}]`);
    // Same util the native compose path calls: (recipients, postId, actorId, entityType).
    expect(mocks.createMentionNotifications).toHaveBeenCalledWith(
      [LOCAL_MENTION_OXY_ID],
      CREATED_POST_ID,
      AUTHOR_OXY_ID,
      'post',
    );
  });

  it('does NOT notify a local mention when that user has fediverse sharing off', async () => {
    mocks.getProfileByUsername.mockResolvedValue({ _id: LOCAL_MENTION_OXY_ID, username: 'alice' });
    mocks.isFediverseSharingEnabled.mockResolvedValue(false);
    const content =
      '<p>cc <a href="https://mention.earth/@alice" class="u-url mention">@<span>alice</span></a></p>';
    const activity = createActivity(content, [
      { type: 'Mention', href: LOCAL_MENTION_ACTOR_URI, name: '@alice@mention.earth' },
    ]);

    await inboxProcessingService.processInboxActivity(activity, AUTHOR_URI);

    // The mention is still ingested (stored + placeholder), only the notify is gated.
    expect(createdPost().mentions).toEqual([LOCAL_MENTION_OXY_ID]);
    expect(mocks.createMentionNotifications).not.toHaveBeenCalled();
  });

  it('does NOT re-notify on a redelivered Create (activityId already stored)', async () => {
    mocks.getProfileByUsername.mockResolvedValue({ _id: LOCAL_MENTION_OXY_ID, username: 'alice' });
    mocks.postExists.mockResolvedValue({ _id: 'already_here' });
    const content =
      '<p>cc <a href="https://mention.earth/@alice" class="u-url mention">@<span>alice</span></a></p>';
    const activity = createActivity(content, [
      { type: 'Mention', href: LOCAL_MENTION_ACTOR_URI, name: '@alice@mention.earth' },
    ]);

    await inboxProcessingService.processInboxActivity(activity, AUTHOR_URI);

    expect(mocks.postCreatorCreate).not.toHaveBeenCalled();
    expect(mocks.createMentionNotifications).not.toHaveBeenCalled();
  });

  it('leaves a note with NO Mention tags unchanged (empty mentions, no notify)', async () => {
    const activity = createActivity('<p>just some plain text</p>', []);

    await inboxProcessingService.processInboxActivity(activity, AUTHOR_URI);

    expect(mocks.postCreatorCreate).toHaveBeenCalledTimes(1);
    expect(createdPost().mentions).toEqual([]);
    expect(primaryVariantText()).toBe('just some plain text');
    expect(primaryVariantText()).not.toContain('[mention:');
    expect(mocks.createMentionNotifications).not.toHaveBeenCalled();
  });

  it('does NOT rewrite an anchor whose href matches no resolved mention (degrades gracefully)', async () => {
    // An unresolvable mention actor (getOrFetchActor returns no oxyUserId): the
    // anchor stays, no placeholder, no stored mention — the prior bare-text behavior.
    stubActors({ [AUTHOR_URI]: AUTHOR_OXY_ID });
    const content =
      '<p>hi <a href="https://remote.example/@ghost" class="u-url mention">@<span>ghost</span></a></p>';
    const activity = createActivity(content, [
      { type: 'Mention', href: `${REMOTE}/users/ghost`, name: '@ghost@remote.example' },
    ]);

    await inboxProcessingService.processInboxActivity(activity, AUTHOR_URI);

    expect(createdPost().mentions).toEqual([]);
    expect(primaryVariantText()).not.toContain('[mention:');
    expect(mocks.createMentionNotifications).not.toHaveBeenCalled();
  });
});
