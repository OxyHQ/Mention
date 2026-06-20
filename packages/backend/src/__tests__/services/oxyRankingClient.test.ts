import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  makeServiceRequest: vi.fn(),
  getMentionOxyClientId: vi.fn(),
  resolveAvatarUrl: vi.fn(),
}));

vi.mock('../../utils/oxyHelpers', () => ({
  getServiceOxyClient: () => ({ makeServiceRequest: mocks.makeServiceRequest }),
  getMentionOxyClientId: mocks.getMentionOxyClientId,
}));

vi.mock('../../utils/mediaResolver', () => ({
  resolveAvatarUrl: mocks.resolveAvatarUrl,
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
  // Echo the ref as the resolved URL so assertions are deterministic.
  mocks.resolveAvatarUrl.mockImplementation((ref?: string | null) =>
    ref ? `https://cdn/${ref}` : undefined,
  );
});

describe('OxyRankingClient.rank', () => {
  it('sends clientId + X-Oxy-User-Id (viewerId) + limit + excludeIds + excludeTypes', async () => {
    mocks.makeServiceRequest.mockResolvedValue({ data: [makeItem()] });
    const client = new OxyRankingClient();

    await client.rank({
      clientId: CLIENT_ID,
      viewerId: 'viewer_99',
      limit: 25,
      excludeIds: ['x1', 'x2'],
      excludeTypes: ['federated'],
    });

    expect(mocks.makeServiceRequest).toHaveBeenCalledTimes(1);
    const [method, url, body, userId] = mocks.makeServiceRequest.mock.calls[0];
    expect(method).toBe('POST');
    expect(url).toBe('/profiles/recommendations');
    expect(body).toEqual({
      clientId: CLIENT_ID,
      limit: 25,
      excludeIds: ['x1', 'x2'],
      excludeTypes: ['federated'],
    });
    // The 4th arg becomes the X-Oxy-User-Id header inside makeServiceRequest.
    expect(userId).toBe('viewer_99');
  });

  it('falls back to MENTION_OXY_CLIENT_ID when no clientId is passed', async () => {
    mocks.makeServiceRequest.mockResolvedValue({ data: [] });
    const client = new OxyRankingClient();

    await client.rank({ limit: 10 });

    const body = mocks.makeServiceRequest.mock.calls[0][2];
    expect(body.clientId).toBe(CLIENT_ID);
  });

  it('omits clientId entirely when none is configured', async () => {
    mocks.getMentionOxyClientId.mockReturnValue(undefined);
    mocks.makeServiceRequest.mockResolvedValue({ data: [] });
    const client = new OxyRankingClient();

    await client.rank({ limit: 10 });

    const body = mocks.makeServiceRequest.mock.calls[0][2];
    expect('clientId' in body).toBe(false);
  });

  it('omits viewerId (anonymous) when the caller is logged out', async () => {
    mocks.makeServiceRequest.mockResolvedValue({ data: [] });
    const client = new OxyRankingClient();

    await client.rank({ limit: 10 });

    const userId = mocks.makeServiceRequest.mock.calls[0][3];
    expect(userId).toBeUndefined();
  });

  it('maps the response to the frontend DTO and resolves the avatar URL', async () => {
    mocks.makeServiceRequest.mockResolvedValue({ data: [makeItem()] });
    const client = new OxyRankingClient();

    const result = await client.rank({ limit: 10, viewerId: 'v1' });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'u1',
      username: 'alice',
      name: { displayName: 'Alice' },
      avatar: 'https://cdn/file_avatar_1',
      verified: true,
      trustTier: 'gold',
      mutualCount: 3,
      isFederated: false,
      _count: { followers: 10, following: 5 },
    });
    expect(mocks.resolveAvatarUrl).toHaveBeenCalledWith('file_avatar_1');
  });

  it('unwraps a bare array response too', async () => {
    mocks.makeServiceRequest.mockResolvedValue([makeItem({ id: 'u2' })]);
    const client = new OxyRankingClient();

    const result = await client.rank({ limit: 10 });
    expect(result.map((r) => r.id)).toEqual(['u2']);
  });

  it('drops items missing an id or a canonical displayName', async () => {
    mocks.makeServiceRequest.mockResolvedValue({
      data: [
        makeItem({ id: 'good' }),
        makeItem({ id: '', _id: '' }), // no id
        makeItem({ id: 'noname', name: { first: 'X' } }), // no displayName
      ],
    });
    const client = new OxyRankingClient();

    const result = await client.rank({ limit: 10 });
    expect(result.map((r) => r.id)).toEqual(['good']);
  });

  it('propagates a transport error (soft-fail policy lives in the service)', async () => {
    mocks.makeServiceRequest.mockRejectedValue(new Error('oxy down'));
    const client = new OxyRankingClient();

    await expect(client.rank({ limit: 10 })).rejects.toThrow('oxy down');
  });
});
