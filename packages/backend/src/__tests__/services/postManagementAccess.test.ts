import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveUserSummaries } = vi.hoisted(() => ({ resolveUserSummaries: vi.fn() }));

vi.mock('../../services/PostHydrationService', () => ({ resolveUserSummaries }));
vi.mock('../../utils/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  canManagePostWithoutLookup,
  postManagementRefusal,
} from '../../services/postManagementAccess';

const WRITER = 'human-writer';
const CHANNEL = 'oxy-channel-account';
const OWNER = 'ordinary-author';
const STRANGER = 'somebody-else';

/** Teaches `resolveAccountKind` what kind each account is. */
function accountsAre(kinds: Record<string, string>): void {
  resolveUserSummaries.mockImplementation(async (ids: string[]) => {
    const map = new Map();
    for (const id of ids) {
      if (kinds[id]) map.set(id, { user: { id, kind: kinds[id] } });
    }
    return map;
  });
}

function memberReaderReturning(members: unknown[]) {
  return { listAccountMembers: vi.fn(async () => members as never) };
}

beforeEach(() => {
  vi.clearAllMocks();
  accountsAre({ [CHANNEL]: 'channel', [OWNER]: 'personal', [WRITER]: 'personal' });
});

describe('canManagePostWithoutLookup — the READ path predicate', () => {
  it('admits the account that authored the post', () => {
    expect(canManagePostWithoutLookup({ oxyUserId: OWNER }, OWNER)).toBe(true);
  });

  it('admits the human who wrote a post their channel authored', () => {
    // The defect this exists for: a channel post's `authorship` names only the
    // CHANNEL, so on authorship alone nobody can ever manage one.
    expect(
      canManagePostWithoutLookup({ oxyUserId: CHANNEL, writtenByOxyUserId: WRITER }, WRITER),
    ).toBe(true);
  });

  it('refuses a stranger, and refuses an anonymous viewer', () => {
    expect(
      canManagePostWithoutLookup({ oxyUserId: CHANNEL, writtenByOxyUserId: WRITER }, STRANGER),
    ).toBe(false);
    expect(canManagePostWithoutLookup({ oxyUserId: OWNER }, undefined)).toBe(false);
  });

  it('does not admit a viewer just because the post has no writer recorded', () => {
    // An absent `writtenByOxyUserId` must not read as "matches everybody".
    expect(canManagePostWithoutLookup({ oxyUserId: OWNER }, STRANGER)).toBe(false);
    expect(canManagePostWithoutLookup({ oxyUserId: OWNER, writtenByOxyUserId: '' }, '')).toBe(false);
  });
});

describe('postManagementRefusal — the WRITE path gate', () => {
  it('allows the author with NO Oxy call at all', async () => {
    const reader = memberReaderReturning([]);

    const refusal = await postManagementRefusal({
      post: { oxyUserId: OWNER },
      callerId: OWNER,
      memberReader: reader,
    });

    expect(refusal).toBeNull();
    // The cost claim, asserted rather than described: hydration-shaped traffic
    // must not reach Oxy, and this is the path every ordinary post takes.
    expect(reader.listAccountMembers).not.toHaveBeenCalled();
    expect(resolveUserSummaries).not.toHaveBeenCalled();
  });

  it("allows a channel post's writer with NO Oxy call either", async () => {
    const reader = memberReaderReturning([]);

    const refusal = await postManagementRefusal({
      post: { oxyUserId: CHANNEL, writtenByOxyUserId: WRITER },
      callerId: WRITER,
      memberReader: reader,
    });

    expect(refusal).toBeNull();
    expect(reader.listAccountMembers).not.toHaveBeenCalled();
  });

  it('allows a CO-OPERATOR who did not write it, at the cost of one membership read', async () => {
    // The half the DTO deliberately does not offer. Reaching the route is
    // allowed; the button is simply not drawn, which is the safe direction.
    const reader = memberReaderReturning([{ memberUserId: STRANGER, status: 'active' }]);

    const refusal = await postManagementRefusal({
      post: { oxyUserId: CHANNEL, writtenByOxyUserId: WRITER },
      callerId: STRANGER,
      memberReader: reader,
    });

    expect(refusal).toBeNull();
    expect(reader.listAccountMembers).toHaveBeenCalledWith(CHANNEL);
  });

  it('refuses a non-member with the SAME 404 a missing post answers', async () => {
    const reader = memberReaderReturning([{ memberUserId: 'someone-entirely-else', status: 'active' }]);

    const refusal = await postManagementRefusal({
      post: { oxyUserId: CHANNEL, writtenByOxyUserId: WRITER },
      callerId: STRANGER,
      memberReader: reader,
    });

    // 404, never 403: the reply must not distinguish "not yours" from "not
    // there", or it becomes an oracle for whether a given post id exists.
    expect(refusal).toEqual({ status: 404, message: 'Post not found' });
  });

  it('refuses an INACTIVE member', async () => {
    const reader = memberReaderReturning([{ memberUserId: STRANGER, status: 'invited' }]);

    const refusal = await postManagementRefusal({
      post: { oxyUserId: CHANNEL, writtenByOxyUserId: WRITER },
      callerId: STRANGER,
      memberReader: reader,
    });

    expect(refusal?.status).toBe(404);
  });

  it("refuses a stranger against an ordinary person's post", async () => {
    const reader = memberReaderReturning([{ memberUserId: STRANGER, status: 'active' }]);

    const refusal = await postManagementRefusal({
      post: { oxyUserId: OWNER },
      callerId: STRANGER,
      memberReader: reader,
    });

    // A `personal` account is refused before any membership is consulted —
    // nothing can be published as one, so nothing can be managed for one either.
    expect(refusal?.status).toBe(404);
    expect(reader.listAccountMembers).not.toHaveBeenCalled();
  });

  it('answers 503 on an Oxy OUTAGE rather than collapsing it to 404', async () => {
    // The one refusal that must not look like "your post is gone". An operator
    // seeing 404 during an outage would reasonably believe it was deleted.
    const reader = {
      listAccountMembers: vi.fn(async () => {
        throw new Error('oxy is down');
      }),
    };

    const refusal = await postManagementRefusal({
      post: { oxyUserId: CHANNEL, writtenByOxyUserId: WRITER },
      callerId: STRANGER,
      memberReader: reader,
    });

    expect(refusal?.status).toBe(503);
  });

  it('refuses a post with no author at all', async () => {
    const refusal = await postManagementRefusal({
      post: {},
      callerId: OWNER,
      memberReader: memberReaderReturning([]),
    });

    expect(refusal?.status).toBe(404);
  });

  it('refuses when there is no client to ask Oxy with', async () => {
    const refusal = await postManagementRefusal({
      post: { oxyUserId: CHANNEL, writtenByOxyUserId: WRITER },
      callerId: STRANGER,
      memberReader: undefined,
    });

    expect(refusal?.status).toBe(404);
  });
});

describe('affordance ⊆ permission', () => {
  /**
   * The property the whole design rests on: everything the DTO offers, the route
   * accepts. The reverse is allowed — a co-operator is permitted but not offered
   * — and that asymmetry is the deliberate one, because a missing button is a
   * smaller problem than a button that refuses.
   */
  it('never draws a button the route would refuse', async () => {
    const cases: { post: { oxyUserId?: string; writtenByOxyUserId?: string }; caller: string }[] = [
      { post: { oxyUserId: OWNER }, caller: OWNER },
      { post: { oxyUserId: CHANNEL, writtenByOxyUserId: WRITER }, caller: WRITER },
      { post: { oxyUserId: CHANNEL, writtenByOxyUserId: WRITER }, caller: STRANGER },
      { post: { oxyUserId: OWNER }, caller: STRANGER },
      { post: {}, caller: OWNER },
    ];

    let offered = 0;
    for (const testCase of cases) {
      if (!canManagePostWithoutLookup(testCase.post, testCase.caller)) continue;
      offered += 1;
      const refusal = await postManagementRefusal({
        post: testCase.post,
        callerId: testCase.caller,
        memberReader: memberReaderReturning([]),
      });
      expect(refusal).toBeNull();
    }

    // Vacuity floor: if the predicate ever returned false for everything, the
    // loop above would assert nothing at all and still pass.
    expect(offered).toBe(2);
  });
});
