import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE REPLY AND THE BOOST COMMENT ARE WRITE BOUNDARIES TOO.
 *
 * `feed.controller` persists both documents itself rather than through
 * `PostCreationService`, so each carries its own copy of the mention
 * reconciliation — and would have carried its own omission of the profile-link
 * fold. A rule that holds for `POST /posts` and not for a reply is not a rule;
 * it is a coincidence of which handler somebody edited.
 *
 * These pin both, driven through the real handlers: the stored document's
 * `mentions` carries the id a pasted profile link named, and its body carries the
 * placeholder — plus the must-stay-a-link case on the reply path.
 */
const hoisted = vi.hoisted(() => {
  class HoistedMockPost {
    [key: string]: unknown;
    constructor(data: Record<string, unknown>) {
      Object.assign(this, data);
    }
    save = vi.fn().mockResolvedValue(undefined);
    markModified = vi.fn();
    toObject(): Record<string, unknown> {
      return { ...this };
    }
    _id = 'mock_written_post';
  }
  return {
    MockPost: HoistedMockPost,
    written: [] as Array<Record<string, unknown>>,
    parentPost: null as Record<string, unknown> | null,
    isBlockedDomain: vi.fn((_host: string) => false),
    resolveOxyUser: vi.fn(),
    findExistingActor: vi.fn(),
  };
});

vi.mock('../../models/Post', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // Every constructed document is captured, so the assertions read the row the
  // handler actually built rather than the request it was handed.
  class CapturingPost extends hoisted.MockPost {
    constructor(data: Record<string, unknown>) {
      super(data);
      hoisted.written.push(this as unknown as Record<string, unknown>);
    }
  }
  return {
    ...actual,
    Post: Object.assign(CapturingPost, {
      findById: () => ({
        maxTimeMS: () => ({ lean: async () => hoisted.parentPost }),
        select: () => ({ lean: async () => hoisted.parentPost }),
        lean: async () => hoisted.parentPost,
      }),
      findByIdAndUpdate: vi.fn(async () => null),
      findOne: () => ({ maxTimeMS: async () => null }),
      find: () => ({ select: () => ({ lean: async () => [] }) }),
      updateOne: vi.fn(async () => ({ modifiedCount: 0 })),
    }),
  };
});

vi.mock('../../services/PostHydrationService', () => ({
  postHydrationService: { hydratePosts: vi.fn(async (objs: object[]) => objs) },
  resolveUserSummaries: vi.fn(async () => new Map()),
  degradedActorSummary: (id: string) => ({ id, username: '', name: { displayName: 'Unknown user' } }),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  createScopedOxyClient: vi.fn(() => ({})),
  getServiceOxyClient: vi.fn(() => ({})),
}));

vi.mock('../../utils/notificationUtils', () => ({
  createNotification: vi.fn().mockResolvedValue(undefined),
  createMentionNotifications: vi.fn().mockResolvedValue(undefined),
  createBatchNotifications: vi.fn().mockResolvedValue(undefined),
  createPostAuthorNotifications: vi.fn().mockResolvedValue(undefined),
}));

// The signed-record dual write. `createBoost` AWAITS `emitRepostCreated` outside
// any try/catch, so leaving the real one in place hangs the boost case rather
// than failing it.
vi.mock('../../services/mtn/MentionRecordEmitter', () => ({
  emitPostCreated: vi.fn().mockResolvedValue(undefined),
  emitRepostCreated: vi.fn().mockResolvedValue(undefined),
  emitTombstone: vi.fn(),
  repostRecordUri: () => 'at://test',
}));

vi.mock('../../services/PostRecentReplierService', () => ({
  recordRecentReplierForPost: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/AffinityEventService', () => ({
  affinityEventService: { record: vi.fn().mockResolvedValue(undefined) },
}));

// Reaches Mongo directly; with no connection Mongoose buffers the query forever,
// which reads as the handler hanging rather than as a missing stub.
vi.mock('../../services/UserPreferenceService', () => ({
  userPreferenceService: { recordInteraction: vi.fn().mockResolvedValue(undefined) },
  readInteractionSurface: vi.fn(() => undefined),
}));

vi.mock('../../connectors/outboundFederation', () => ({
  federateAsResolvedActor: vi.fn(),
}));

vi.mock('../../services/postEngagementBroadcast', () => ({
  emitPostEngagement: vi.fn(),
  POST_ENGAGEMENT_EVENTS: {
    LIKED: 'post:liked',
    UNLIKED: 'post:unliked',
    BOOSTED: 'post:boosted',
    UNBOOSTED: 'post:unboosted',
    SAVED: 'post:saved',
    UNSAVED: 'post:unsaved',
    REPLIED: 'post:replied',
  },
}));

// PARTIAL: the controller pulls the whole connector graph in, and `actor.service`
// reads `FEDERATION_ENABLED` off this module at import time.
vi.mock('../../connectors/activitypub/constants', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isBlockedDomain: hoisted.isBlockedDomain,
  resolveOxyUser: hoisted.resolveOxyUser,
}));

vi.mock('../../models/FederatedActor', () => ({
  default: { findOne: hoisted.findExistingActor },
}));

import { feedController } from '../../controllers/feed.controller';

const OWN_HOST = 'mention.earth';
const USER_ID = 'oxy-replier';
const PARENT_ID = '650000000000000000000010';
const ALICE_OXY_ID = 'oxy_alice_local';

function buildResponse() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  };
  return { res, captured };
}

/** The one document the handler built, as `mentions` + primary body text. */
function writtenPost(): { mentions: string[]; text: string } {
  expect(hoisted.written).toHaveLength(1);
  const post = hoisted.written[0] as { mentions?: string[]; content?: { text?: string } };
  return { mentions: post.mentions ?? [], text: post.content?.text ?? '' };
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.written = [];
  hoisted.parentPost = {
    _id: PARENT_ID,
    oxyUserId: 'oxy-parent-author',
    threadId: null,
    replyPermission: ['anyone'],
    reviewReplies: false,
    visibility: 'public',
    status: 'published',
    quotesDisabled: false,
  };
  hoisted.isBlockedDomain.mockImplementation(
    (host: string) => host.toLowerCase().replace(/^www\./, '') === OWN_HOST,
  );
  hoisted.resolveOxyUser.mockImplementation(async (username: string) =>
    username === 'alice' ? { _id: ALICE_OXY_ID } : null,
  );
  hoisted.findExistingActor.mockReturnValue({ lean: async () => null });
});

describe('createReply — a pasted profile link becomes a real mention', () => {
  it('stores the id and rewrites the reply body to the placeholder', async () => {
    const { res } = buildResponse();

    await feedController.createReply(
      {
        body: { postId: PARENT_ID, content: { text: `agreed, https://${OWN_HOST}/@alice` } },
        user: { id: USER_ID },
      } as never,
      res as never,
    );

    expect(writtenPost()).toEqual({
      mentions: [ALICE_OXY_ID],
      text: `agreed, [mention:${ALICE_OXY_ID}]`,
    });
  });

  it('leaves a link it cannot resolve as a link, and mentions nobody', async () => {
    const { res } = buildResponse();

    await feedController.createReply(
      {
        body: { postId: PARENT_ID, content: { text: 'see https://mastodon.social/@a-stranger' } },
        user: { id: USER_ID },
      } as never,
      res as never,
    );

    expect(writtenPost()).toEqual({
      mentions: [],
      text: 'see https://mastodon.social/@a-stranger',
    });
  });
});

describe('createBoost — the comment on a boost is a body like any other', () => {
  it('stores the id and rewrites the comment to the placeholder', async () => {
    const { res } = buildResponse();

    await feedController.createBoost(
      {
        body: { originalPostId: PARENT_ID, content: { text: `look, https://${OWN_HOST}/@alice` } },
        user: { id: USER_ID },
      } as never,
      res as never,
    );

    expect(writtenPost()).toEqual({
      mentions: [ALICE_OXY_ID],
      text: `look, [mention:${ALICE_OXY_ID}]`,
    });
  });
});
