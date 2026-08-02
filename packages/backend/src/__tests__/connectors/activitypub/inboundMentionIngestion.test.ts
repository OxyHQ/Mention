import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { closePostgres, connectPostgres } from '../../../db/postgres';
import {
  clearFederationScope,
  federationScope,
  seedActor,
  seedFollow,
  seedPost,
} from '../../../__tests__/helpers/federationFixtures';

const scope = federationScope('inbound-mention-ingestion');

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

const REMOTE = scope.origin;
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

/** Seed each actor URI (author + federated mentions) with its resolved Oxy id. */
async function seedActors(byUri: Record<string, string>): Promise<void> {
  let index = 0;
  for (const [uri, oxyUserId] of Object.entries(byUri)) {
    index += 1;
    await seedActor(scope, {
      username: `actor${index}`,
      uri,
      oxyUserId,
      lastFetchedAt: new Date(),
    });
  }
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

beforeAll(async () => {
  await connectPostgres();
});

beforeEach(async () => {
  vi.clearAllMocks();
  await clearFederationScope(scope);
  mocks.postExists.mockResolvedValue(null);
  mocks.postUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  mocks.postCreatorCreate.mockResolvedValue({ id: CREATED_POST_ID });
  mocks.ensureFederatedReplyLink.mockResolvedValue(null);
  mocks.isFediverseSharingEnabled.mockResolvedValue(true);
  mocks.postFindOne.mockReturnValue({ lean: async () => null });
  await seedActors({ [AUTHOR_URI]: AUTHOR_OXY_ID, [FED_MENTION_URI]: FED_MENTION_OXY_ID });
  // A local user follows the author, so `handleCreate`'s follower gate passes.
  await seedFollow(scope, { remoteActorUri: AUTHOR_URI, direction: 'outbound', status: 'accepted' });
});

describe('handleCreate — inbound @mention ingestion', () => {
  it('rewrites a FEDERATED mention anchor to a [mention:<oxyUserId>] placeholder and stores post.mentions', async () => {
    const content =
      `<p>hey <span class="h-card"><a href="${REMOTE}/@bob" class="u-url mention">@<span>bob</span></a></span> look</p>`;
    const activity = createActivity(content, [
      { type: 'Mention', href: FED_MENTION_URI, name: `@bob@${scope.domain}` },
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
    // The dedupe is a REAL uniqueness check on `federation.activity_id`, so the
    // premise is a stored row rather than a stubbed `exists` answer — otherwise
    // "did not re-notify" passes just as well against a dedupe that never runs.
    await seedPost(scope, {
      oxyUserId: AUTHOR_OXY_ID,
      federation: { activityId: `${AUTHOR_URI}/statuses/1`, actorUri: AUTHOR_URI },
    });
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
    // Only the author resolves; the mentioned actor has no row at all.
    await clearFederationScope(scope);
    await seedActors({ [AUTHOR_URI]: AUTHOR_OXY_ID });
    await seedFollow(scope, { remoteActorUri: AUTHOR_URI, direction: 'outbound', status: 'accepted' });
    const content =
      `<p>hi <a href="${REMOTE}/@ghost" class="u-url mention">@<span>ghost</span></a></p>`;
    const activity = createActivity(content, [
      { type: 'Mention', href: `${REMOTE}/users/ghost`, name: `@ghost@${scope.domain}` },
    ]);

    await inboxProcessingService.processInboxActivity(activity, AUTHOR_URI);

    expect(createdPost().mentions).toEqual([]);
    expect(primaryVariantText()).not.toContain('[mention:');
    expect(mocks.createMentionNotifications).not.toHaveBeenCalled();
  });
});

afterEach(async () => {
  await clearFederationScope(scope);
});

afterAll(async () => {
  await closePostgres();
});

/**
 * The broadcast rule, applied on the NOTE'S count rather than on the local subset.
 *
 * The measured pile-up (annihilation.social, 1,870 posts, 28.9 mentions/post) is 76
 * REMOTE authors talking to each other; the one local user who gets pulled in is a
 * single id inside a 29-name list. Judging the fan-out by the list
 * `createMentionNotifications` receives would read that as "one mention, notify" and
 * ring them once per post, thousands of times — which is the exact failure this cap
 * exists to stop. So the inbox must pass the note's TOTAL resolved mention count.
 */
describe('handleCreate — broadcast notes notify nobody', () => {
  /**
   * A note naming `remoteCount` remote users plus the one local user, alice.
   * `alicePosition` places her tag in the note's declaration order, which is what
   * the per-post ceiling keeps by.
   *
   * The scope is cleared and re-seeded rather than added to, because the outer
   * `beforeEach` already seeded two actors under this scope and the actor rows
   * carry unique `(domain, username)` and `acct` constraints — seeding on top of
   * them would collide rather than accumulate.
   */
  async function broadcastActivity(
    remoteCount: number,
    alicePosition: 'first' | 'last' = 'last',
  ): Promise<Record<string, unknown>> {
    const remotes = Array.from({ length: remoteCount }, (_, i) => ({
      uri: `${REMOTE}/users/r${i}`,
      oxyId: `oxy_r${i}`,
    }));
    await clearFederationScope(scope);
    await seedActors({
      [AUTHOR_URI]: AUTHOR_OXY_ID,
      ...Object.fromEntries(remotes.map((r) => [r.uri, r.oxyId])),
    });
    // Re-seeded with the actors: `handleCreate`'s follower gate reads it.
    await seedFollow(scope, { remoteActorUri: AUTHOR_URI, direction: 'outbound', status: 'accepted' });

    const aliceAnchor = `<a href="${LOCAL_MENTION_PROFILE}" class="u-url mention">@alice</a>`;
    const aliceTag = {
      type: 'Mention',
      href: LOCAL_MENTION_ACTOR_URI,
      name: '@alice@mention.earth',
    };
    const remoteAnchors = remotes.map(
      (_r, i) => `<a href="${REMOTE}/@r${i}" class="u-url mention">@r${i}</a>`,
    );
    const remoteTags = remotes.map((r, i) => ({
      type: 'Mention',
      href: r.uri,
      name: `@r${i}@remote.example`,
    }));

    const anchors = alicePosition === 'first'
      ? [aliceAnchor, ...remoteAnchors]
      : [...remoteAnchors, aliceAnchor];
    const tags = alicePosition === 'first' ? [aliceTag, ...remoteTags] : [...remoteTags, aliceTag];
    return createActivity(`<p>${anchors.join(' ')}</p>`, tags);
  }

  beforeEach(() => {
    mocks.getProfileByUsername.mockResolvedValue({ _id: LOCAL_MENTION_OXY_ID, username: 'alice' });
  });

  it('notifies the one local user when the note is AT the notification cap (8 total)', async () => {
    await inboxProcessingService.processInboxActivity(await broadcastActivity(7), AUTHOR_URI);

    expect(createdPost().mentions).toHaveLength(8);
    expect(mocks.createMentionNotifications).toHaveBeenCalledWith(
      [LOCAL_MENTION_OXY_ID],
      CREATED_POST_ID,
      AUTHOR_OXY_ID,
      'post',
    );
  });

  it('notifies NOBODY one over the cap (9 total), even though only ONE is local', async () => {
    await inboxProcessingService.processInboxActivity(await broadcastActivity(8), AUTHOR_URI);

    // Stored and rendered exactly as before — only the interrupt is withheld.
    expect(createdPost().mentions).toHaveLength(9);
    expect(createdPost().mentions).toContain(LOCAL_MENTION_OXY_ID);
    expect(mocks.createMentionNotifications).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      '[Federation] suppressed mention notifications for a broadcast note',
      { mentioned: 9, local: 1 },
    );
  });

  it('stays silent at the measured pile-up shape even when the local user survives truncation', async () => {
    // 29 mentions — the measured mean — with alice declared FIRST, so the per-post
    // ceiling keeps her. The note is still a broadcast, so nobody is notified: the
    // suppression is the mention COUNT's doing, not an artifact of her being cut.
    await inboxProcessingService.processInboxActivity(
      await broadcastActivity(28, 'first'),
      AUTHOR_URI,
    );

    expect(createdPost().mentions).toHaveLength(16);
    expect(createdPost().mentions).toContain(LOCAL_MENTION_OXY_ID);
    expect(mocks.createMentionNotifications).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      '[Federation] suppressed mention notifications for a broadcast note',
      { mentioned: 16, local: 1 },
    );
  });

  it('truncates the surplus out of the stored list, and says so', async () => {
    // Same 29-mention note with alice declared LAST: she falls outside the per-post
    // ceiling and is dropped wholesale — no stored id, so no rendered link and no
    // entry in her mentions feed either. That is the containment working as designed
    // on a broadcast, and it is logged with both counts rather than dropped quietly.
    await inboxProcessingService.processInboxActivity(
      await broadcastActivity(28, 'last'),
      AUTHOR_URI,
    );

    expect(createdPost().mentions).toHaveLength(16);
    expect(createdPost().mentions).not.toContain(LOCAL_MENTION_OXY_ID);
    expect(mocks.createMentionNotifications).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      '[Federation] truncated inbound mentions above the per-post ceiling',
      { mentioned: 29, kept: 16 },
    );
  });
});
