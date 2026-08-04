import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `GET /channels/:id/deletion-preview` and `DELETE /channels/:id/content` — the
 * trigger `ChannelDeletionService` was deliberately shipped without.
 *
 * The REAL gate runs here. Mocking `assertCanDeleteAccount` would leave the one
 * property these routes exist to hold — that the destructive call is unreachable
 * without `account:delete` — asserted against a stand-in that answers however the
 * test says. So only the identity read and the cascade itself are mocked, and the
 * permission decision is made by the code that makes it in production.
 *
 * Three properties:
 *
 *   * **The cascade is not called for anybody the gate refuses.** Asserted as an
 *     absence on the cascade spy, not merely as a status code: a route that
 *     answered 403 after already deleting would satisfy a status assertion.
 *   * **The PREVIEW is behind the same gate as the deletion.** It is the number a
 *     confirmation states, so a preview readable by somebody the deletion refuses
 *     is a button that appears and then fails. Affordance is a subset of
 *     permission, and this is where that is enforced rather than hoped for.
 *   * **A partially failed cascade is a 500, never a 200.** The client archives
 *     the Oxy account on a 2xx, and that archive is what makes an incomplete
 *     deletion permanent: Oxy's account reads exclude an archived account, so the
 *     cascade could never resolve the kind or the username again.
 */

const CALLER = 'caller-1';
const CHANNEL = 'channel-1';
const ORGANIZATION = 'org-1';

/** The permission sets Oxy derives from its roles, as they arrive on the wire. */
const OWNER_PERMISSIONS = ['account:read', 'account:update', 'account:delete', 'account:act_as'];
/** `editor` — may publish as the channel, may not end it. */
const EDITOR_PERMISSIONS = ['account:read', 'account:act_as'];

const state = vi.hoisted(() => ({
  /** What Oxy answers for each account id, or nothing to make it unresolvable. */
  kindOf: new Map<string, string>(),
  /** The permissions the caller's own membership row carries, or null for none. */
  callerPermissions: null as string[] | null,
}));

const resolveUserSummaries = vi.hoisted(() => vi.fn());
const previewChannelDeletion = vi.hoisted(() => vi.fn());
const deleteChannelContent = vi.hoisted(() => vi.fn());

vi.mock('../../services/PostHydrationService', () => ({ resolveUserSummaries }));

vi.mock('../../services/channelDeletion/ChannelDeletionService', () => {
  class NotAChannelAccountError extends Error {
    readonly resolvedKind: string | null;
    constructor(oxyUserId: string, resolvedKind: string | null) {
      super(`refused: ${oxyUserId} is ${resolvedKind ?? 'unresolvable'}`);
      this.name = 'NotAChannelAccountError';
      this.resolvedKind = resolvedKind;
    }
  }
  return { NotAChannelAccountError, previewChannelDeletion, deleteChannelContent };
});

vi.mock('../../utils/oxyHelpers', () => ({
  createUserScopedOxyServices: () => ({
    async listAccountMembers(accountId: string) {
      if (state.callerPermissions === null) return [];
      return [
        {
          _id: 'member-row-1',
          accountId,
          memberUserId: CALLER,
          role: 'owner',
          permissions: state.callerPermissions,
          inherit: true,
          status: 'active',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ];
    },
  }),
}));

vi.mock('@oxyhq/core/server', () => ({
  getRequiredOxyUserId: (req: express.Request & { user?: { id: string } }) => req.user?.id ?? '',
}));

// Real Redis stores are not reachable from a unit run, and the limiters are
// production-gated out of the handler chain anyway.
vi.mock('../../middleware/security', () => ({
  channelDeletionRateLimiter: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { default: channelDeletionRoutes } = await import('../../routes/channelDeletion.routes');

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    (req as express.Request & { user?: { id: string } }).user = { id: CALLER };
    next();
  });
  app.use('/channels', channelDeletionRoutes);
  return app;
}

beforeEach(() => {
  state.kindOf = new Map([
    [CHANNEL, 'channel'],
    [ORGANIZATION, 'organization'],
  ]);
  state.callerPermissions = OWNER_PERMISSIONS;
  resolveUserSummaries.mockReset();
  resolveUserSummaries.mockImplementation(async (ids: string[]) => {
    const map = new Map<string, { user: { id: string; kind?: string; name: object } }>();
    for (const id of ids) {
      const kind = state.kindOf.get(id);
      if (kind) map.set(id, { user: { id, kind, name: {} } });
    }
    return map;
  });
  previewChannelDeletion.mockReset();
  previewChannelDeletion.mockResolvedValue({
    channelOxyUserId: CHANNEL,
    posts: 42,
    boostsByOthers: 7,
    replies: 0,
    quotesByOthersKept: 3,
    federatedFollowers: 12,
  });
  deleteChannelContent.mockReset();
  deleteChannelContent.mockResolvedValue({
    steps: {},
    delegated: [],
    retained: [],
    preview: {
      channelOxyUserId: CHANNEL,
      posts: 42,
      boostsByOthers: 7,
      replies: 0,
      quotesByOthersKept: 3,
      federatedFollowers: 12,
    },
    dryRun: false,
  });
});

describe('an owner', () => {
  it('reads the counts a confirmation states, and nothing operational', async () => {
    const res = await request(buildApp())
      .get(`/channels/${CHANNEL}/deletion-preview`)
      .expect(200);

    // Exactly the two numbers, and no `channelOxyUserId`, `replies`,
    // `quotesByOthersKept` or `federatedFollowers`: those are facts for a log,
    // not numbers to put in front of somebody about to destroy an archive.
    expect(res.body.data).toEqual({ posts: 42, boostsByOthers: 7 });
    expect(previewChannelDeletion).toHaveBeenCalledWith(CHANNEL);
  });

  it('deletes, and reports what went', async () => {
    const res = await request(buildApp()).delete(`/channels/${CHANNEL}/content`).expect(200);

    expect(res.body.data).toEqual({ posts: 42, boostsByOthers: 7 });
    expect(deleteChannelContent).toHaveBeenCalledWith(CHANNEL, { dryRun: false });
  });
});

describe('somebody the account graph does not authorise', () => {
  it('refuses an EDITOR, who may publish as the channel', async () => {
    // The fixture the route turns on. Bare membership, or a check on
    // `account:act_as`, admits this caller — and Oxy would then refuse them the
    // account archive, leaving a channel with no posts and an account standing.
    state.callerPermissions = EDITOR_PERMISSIONS;
    const app = buildApp();

    await request(app).delete(`/channels/${CHANNEL}/content`).expect(403);

    expect(deleteChannelContent).not.toHaveBeenCalled();
  });

  it('refuses an EDITOR the PREVIEW too, so no confirmation can be built', async () => {
    state.callerPermissions = EDITOR_PERMISSIONS;

    await request(buildApp()).get(`/channels/${CHANNEL}/deletion-preview`).expect(403);

    expect(previewChannelDeletion).not.toHaveBeenCalled();
  });

  it('refuses somebody with no membership at all', async () => {
    state.callerPermissions = null;

    await request(buildApp()).delete(`/channels/${CHANNEL}/content`).expect(403);

    expect(deleteChannelContent).not.toHaveBeenCalled();
  });
});

describe('a target that is not a deletable channel', () => {
  it('refuses an ORGANIZATION the caller genuinely owns', async () => {
    // The gate ALLOWS this caller — they hold `account:delete` over it — and the
    // route still refuses, because `CHANNEL_CASCADE` describes a channel and
    // nothing else. Two different questions, answered in two places.
    await request(buildApp()).delete(`/channels/${ORGANIZATION}/content`).expect(400);

    expect(deleteChannelContent).not.toHaveBeenCalled();
  });

  it('refuses an account Oxy cannot resolve at all', async () => {
    await request(buildApp()).delete('/channels/nobody-1/content').expect(400);

    expect(deleteChannelContent).not.toHaveBeenCalled();
  });
});

describe('a cascade that did not finish', () => {
  it('answers 500, because the client archives the Oxy account on a 2xx', async () => {
    deleteChannelContent.mockRejectedValue(new Error('2 cascade step(s) failed'));

    await request(buildApp()).delete(`/channels/${CHANNEL}/content`).expect(500);
  });

  it('answers 400 when the service itself refuses the account as not a channel', async () => {
    // Its own guard, one layer below this route's. Reported as a refusal rather
    // than as a fault, so a client sees the same answer either place it is made.
    const { NotAChannelAccountError } = await import(
      '../../services/channelDeletion/ChannelDeletionService'
    );
    deleteChannelContent.mockRejectedValue(new NotAChannelAccountError(CHANNEL, 'personal'));

    await request(buildApp()).delete(`/channels/${CHANNEL}/content`).expect(400);
  });
});
