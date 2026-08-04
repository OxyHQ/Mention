import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveUserSummaries } = vi.hoisted(() => ({ resolveUserSummaries: vi.fn() }));

vi.mock('../../services/PostHydrationService', () => ({ resolveUserSummaries }));
vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { viewerOperatesAccount } from '../../services/operatedAccountAccess';

/**
 * The unit-level cases the route files cannot reach through an HTTP request,
 * because the routes validate them away first. They are here rather than nowhere
 * because this function's contract differs from the one it delegates to in
 * exactly these places, and a difference nothing pins is a difference that gets
 * refactored out.
 */

const CALLER = 'oxy-caller';
const CHANNEL = 'oxy-channel';

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
  accountsAre({ [CHANNEL]: 'channel', [CALLER]: 'personal' });
});

describe('viewerOperatesAccount — an absent target is not an operated account', () => {
  it('answers false for an empty, blank or missing target id', async () => {
    // The guard this pins is NOT redundant, and that is the whole point of the
    // case. `assertCanPublishAsAccount` reads an absent target as "publish as
    // yourself" and returns SUCCESS — the right answer to its question, and the
    // exact inversion of the right answer to this one. Without the guard, a
    // caller who reaches here with no target is reported as operating it, and
    // whatever action was being gated is refused for everybody.
    const reader = memberReaderReturning([]);

    for (const target of ['', '   ', null, undefined]) {
      expect(
        await viewerOperatesAccount({ targetOxyUserId: target, callerId: CALLER, memberReader: reader }),
      ).toBe(false);
    }
  });

  it('answers false when there is no caller', async () => {
    expect(
      await viewerOperatesAccount({
        targetOxyUserId: CHANNEL,
        callerId: undefined,
        memberReader: memberReaderReturning([]),
      }),
    ).toBe(false);
  });
});

describe('viewerOperatesAccount — "is it me" is one case of it', () => {
  it('answers true for the caller themselves, with no lookup at all', async () => {
    const reader = memberReaderReturning([]);

    expect(
      await viewerOperatesAccount({
        targetOxyUserId: CALLER,
        callerId: CALLER,
        memberReader: reader,
      }),
    ).toBe(true);
    expect(reader.listAccountMembers).not.toHaveBeenCalled();
    expect(resolveUserSummaries).not.toHaveBeenCalled();
  });

  it('tolerates surrounding whitespace on either id', async () => {
    expect(
      await viewerOperatesAccount({
        targetOxyUserId: ` ${CALLER} `,
        callerId: CALLER,
        memberReader: memberReaderReturning([]),
      }),
    ).toBe(true);
  });
});

describe('viewerOperatesAccount — no member reader', () => {
  it('answers false rather than throwing, so the action goes ahead', async () => {
    // An MCP caller has no user-scoped Oxy client. The publish-as gate refuses on
    // that grounds; here the same fact simply means we cannot confirm anything.
    expect(
      await viewerOperatesAccount({
        targetOxyUserId: CHANNEL,
        callerId: CALLER,
        memberReader: undefined,
      }),
    ).toBe(false);
  });
});
