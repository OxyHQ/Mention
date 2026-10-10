import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  serviceRequest: vi.fn(),
  getMentionOxyClientId: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ serviceRequest: mocks.serviceRequest }),
  getMentionOxyClientId: mocks.getMentionOxyClientId,
}));

import { OxyRankingClient } from '../../services/OxyRankingClient';

const CLIENT_ID = 'app_mention_123';

function makeItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    username: 'alice',
    name: { displayName: 'Alice', first: 'Alice' },
    avatar: 'file_avatar_1',
    description: 'hello',
    verified: true,
    trustTier: 'gold',
    mutualCount: 3,
    isFederated: false,
    isAgent: false,
    isAutomated: false,
    _count: { followers: 10, following: 5 },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMentionOxyClientId.mockReturnValue(CLIENT_ID);
});

describe('OxyRankingClient.rank', () => {
  it('sends application-scoped anonymous clientId, limit and filters without delegation', async () => {
    mocks.serviceRequest.mockResolvedValue({ data: [makeItem()] });
    const client = new OxyRankingClient();

    await client.rank({
      clientId: CLIENT_ID,
      limit: 25,
      excludeIds: ['x1', 'x2'],
      excludeTypes: ['federated'],
    });

    expect(mocks.serviceRequest).toHaveBeenCalledTimes(1);
    const [method, url, body, options] = mocks.serviceRequest.mock.calls[0];
    expect(method).toBe('POST');
    expect(url).toBe('/profiles/recommendations');
    expect(body).toEqual({
      clientId: CLIENT_ID,
      limit: 25,
      excludeIds: ['x1', 'x2'],
      excludeTypes: ['federated'],
    });
    expect(options).toBeUndefined();
  });

  it('forwards a positive pagination offset in the request body', async () => {
    mocks.serviceRequest.mockResolvedValue({ data: [] });
    const client = new OxyRankingClient();

    await client.rank({ limit: 20, offset: 40 });

    const body = mocks.serviceRequest.mock.calls[0][2];
    expect(body.offset).toBe(40);
  });

  it('omits offset when it is zero or absent', async () => {
    mocks.serviceRequest.mockResolvedValue({ data: [] });
    const client = new OxyRankingClient();

    await client.rank({ limit: 20, offset: 0 });
    expect('offset' in mocks.serviceRequest.mock.calls[0][2]).toBe(false);

    mocks.serviceRequest.mockClear();
    await client.rank({ limit: 20 });
    expect('offset' in mocks.serviceRequest.mock.calls[0][2]).toBe(false);
  });

  it('returns the raw upstream count alongside the mapped profiles', async () => {
    // Three raw items, one of which has neither displayName nor handle → dropped from
    // `profiles` but still counted in `rawCount` so the caller can page correctly.
    mocks.serviceRequest.mockResolvedValue({
      data: [
        makeItem({ id: 'a' }),
        makeItem({ id: 'b' }),
        makeItem({ id: 'c', username: undefined, name: { first: 'X' } }),
      ],
    });
    const client = new OxyRankingClient();

    const page = await client.rank({ limit: 3 });
    expect(page.profiles.map((p) => p.id)).toEqual(['a', 'b']);
    expect(page.rawCount).toBe(3);
  });

  it('falls back to MENTION_OXY_CLIENT_ID when no clientId is passed', async () => {
    mocks.serviceRequest.mockResolvedValue({ data: [] });
    const client = new OxyRankingClient();

    await client.rank({ limit: 10 });

    const body = mocks.serviceRequest.mock.calls[0][2];
    expect(body.clientId).toBe(CLIENT_ID);
  });

  it('omits clientId entirely when none is configured', async () => {
    mocks.getMentionOxyClientId.mockReturnValue(undefined);
    mocks.serviceRequest.mockResolvedValue({ data: [] });
    const client = new OxyRankingClient();

    await client.rank({ limit: 10 });

    const body = mocks.serviceRequest.mock.calls[0][2];
    expect('clientId' in body).toBe(false);
  });

  it('omits viewerId (anonymous) when the caller is logged out', async () => {
    mocks.serviceRequest.mockResolvedValue({ data: [] });
    const client = new OxyRankingClient();

    await client.rank({ limit: 10 });

    const options = mocks.serviceRequest.mock.calls[0][3];
    expect(options?.actAs).toBeUndefined();
  });

  it('maps the response to the frontend DTO and resolves the avatar URL', async () => {
    mocks.serviceRequest.mockResolvedValue({ data: [makeItem()] });
    const client = new OxyRankingClient();

    const result = await client.rank({ limit: 10 });

    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]).toMatchObject({
      id: 'u1',
      username: 'alice',
      name: { displayName: 'Alice' },
      // Bare Oxy file id passed through untouched — the client resolves it via
      // Bloom's ImageResolver, same as `post.user.avatar` (Oxy owns identity).
      avatar: 'file_avatar_1',
      verified: true,
      trustTier: 'gold',
      mutualCount: 3,
      isFederated: false,
      _count: { followers: 10, following: 5 },
    });
  });

  it('passes the account colour through, and adds none when Oxy sends none', async () => {
    mocks.serviceRequest.mockResolvedValue({
      data: [makeItem({ color: 'teal' }), makeItem({ id: 'u2' })],
    });
    const client = new OxyRankingClient();

    const result = await client.rank({ limit: 10 });

    expect(result.profiles[0].color).toBe('teal');
    expect(result.profiles[1]).not.toHaveProperty('color');
  });

  it('unwraps a bare array response too', async () => {
    mocks.serviceRequest.mockResolvedValue([makeItem({ id: 'u2' })]);
    const client = new OxyRankingClient();

    const result = await client.rank({ limit: 10 });
    expect(result.profiles.map((r) => r.id)).toEqual(['u2']);
  });

  it('drops items missing an id or both display label and valid handle', async () => {
    mocks.serviceRequest.mockResolvedValue({
      data: [
        makeItem({ id: 'good' }),
        makeItem({ id: '', _id: '' }), // no id
        makeItem({ id: 'noname', username: undefined, name: { first: 'X' } }), // no displayName
      ],
    });
    const client = new OxyRankingClient();

    const result = await client.rank({ limit: 10 });
    expect(result.profiles.map((r) => r.id)).toEqual(['good']);
  });

  it('uses the one normalized handle fallback when displayName is absent', async () => {
    mocks.serviceRequest.mockResolvedValue({
      data: [
        makeItem({ id: 'local', username: 'alice', name: { first: 'Never synthesize' } }),
        makeItem({
          id: 'federated',
          username: 'remote',
          instance: 'example.test',
          isFederated: true,
          name: {},
        }),
        makeItem({ id: 'nameless', username: 'handle_only', name: undefined }),
        makeItem({
          id: 'invalid_handle',
          username: '/profile/path',
          name: { first: 'Do not use' },
        }),
      ],
    });
    const result = await new OxyRankingClient().rank({ limit: 10 });
    expect(result.profiles.map((profile) => profile.id)).toEqual([
      'local',
      'federated',
      'nameless',
    ]);
    expect(result.profiles.map((profile) => profile.name.displayName)).toEqual([
      'alice',
      'remote@example.test',
      'handle_only',
    ]);
    expect(result.rawCount).toBe(4);
  });

  it('propagates a transport error (soft-fail policy lives in the service)', async () => {
    mocks.serviceRequest.mockRejectedValue(new Error('oxy down'));
    const client = new OxyRankingClient();

    await expect(client.rank({ limit: 10 })).rejects.toThrow('oxy down');
  });
});
