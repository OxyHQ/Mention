import { describe, expect, it, vi } from 'vitest';

/**
 * Whether a federated actor is a community is Oxy's account kind, and only a
 * `Group` is asked about. Oxy is the boundary here: its answer per account id.
 */
const h = vi.hoisted(() => ({
  kinds: new Map<string, string>([
    ['oxy-lemmy-community', 'community'],
    ['oxy-peertube-channel', 'channel'],
    ['oxy-person', 'community'],
  ]),
  resolveUserSummaries: vi.fn(),
}));

vi.mock('../../../services/PostHydrationService', () => ({
  resolveUserSummaries: h.resolveUserSummaries.mockImplementation(
    async (ids: string[]) =>
      new Map(ids.map((id) => [id, { user: { id, kind: h.kinds.get(id) } }])),
  ),
}));

import { communityAccountIds } from '../../../services/federation/community';

describe('communityAccountIds', () => {
  it("answers with Oxy's kind, and asks only about Group actors", async () => {
    const ids = await communityAccountIds([
      { type: 'Group', oxyUserId: 'oxy-lemmy-community' },
      // A Group Oxy recorded as a channel (PeerTube, `postingRestrictedToMods`).
      { type: 'Group', oxyUserId: 'oxy-peertube-channel' },
      // Not a Group: never looked up, whatever Oxy would say.
      { type: 'Person', oxyUserId: 'oxy-person' },
      { type: 'Group', oxyUserId: undefined },
    ]);

    expect([...ids]).toEqual(['oxy-lemmy-community']);
    expect(h.resolveUserSummaries).toHaveBeenCalledWith([
      'oxy-lemmy-community',
      'oxy-peertube-channel',
    ]);
  });
});
