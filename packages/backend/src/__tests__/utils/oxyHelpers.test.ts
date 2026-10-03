import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shared mock state. Declared via `vi.hoisted` so it is initialised before the
 * hoisted `vi.mock` factory below runs (vitest lifts `vi.mock` to the top of the
 * module). Records every constructed Oxy client instance so each test can
 * inspect the scoped client built inside `ensureProfileMediaPublic` (tokens
 * planted + visibility call). The class is mocked because the helper otherwise
 * performs a real network PATCH to Oxy.
 */
const mockState = vi.hoisted(() => {
  const instances: Array<{
    session: { setAccessToken: ReturnType<typeof vi.fn> };
    serviceRequest: ReturnType<typeof vi.fn>;
    assets: { setVisibility: ReturnType<typeof vi.fn> };
  }> = [];
  const control: { reject?: unknown } = {};
  /**
   * One fake for both clients: the service singleton is an `OxyServer`
   * (`@oxy.so/core/server`), the per-request clients are `OxyServices`.
   */
  class FakeOxyClient {
    session = { setAccessToken: vi.fn() };
    serviceRequest = vi.fn().mockResolvedValue({
      data: { blockedIds: [], restrictedIds: [], followingIds: [], mutualIds: [] },
    });
    assets = {
      setVisibility: vi.fn().mockImplementation(() =>
        control.reject !== undefined
          ? Promise.reject(control.reject)
          : Promise.resolve({ file: { id: 'x', visibility: 'public' } }),
      ),
    };

    constructor() {
      instances.push(this);
    }
  }
  return { instances, control, FakeOxyClient };
});

vi.mock('@oxy.so/core', () => ({ OxyServices: mockState.FakeOxyClient }));
vi.mock('@oxy.so/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxy.so/core/server')>()),
  OxyServer: mockState.FakeOxyClient,
}));

// Was `() => ({})`, which stubbed the module out entirely — including the
// `OxyPrivacyUnavailableError` the delegated client throws. The real module is
// imported instead: it is pure error/id-shape logic and reaches no network.
vi.mock('../../utils/privacyHelpers', async (importOriginal) => importOriginal());

import {
  createScopedOxyClient,
  createUserScopedOxyServices,
  createForegroundOxyProfileClient,
  ensureProfileMediaPublic,
} from '../../utils/oxyHelpers';

/** The scoped client is the LAST constructed instance (after the module-level singleton). */
function lastScopedClient() {
  return mockState.instances[mockState.instances.length - 1];
}

describe('request-scoped Oxy clients', () => {
  it('accepts one well-formed session bearer', () => {
    const before = mockState.instances.length;
    const client = createScopedOxyClient({
      headers: { authorization: 'Bearer owner-token' },
    });

    expect(client).toBeDefined();
    expect(mockState.instances.length).toBe(before + 1);
    expect(lastScopedClient().session.setAccessToken).toHaveBeenCalledWith('owner-token');
  });

  it('rejects combined and duplicate bearer credentials', () => {
    const before = mockState.instances.length;

    expect(createScopedOxyClient({
      headers: { authorization: 'Bearer first, Bearer second' },
    })).toBeUndefined();
    expect(createUserScopedOxyServices({
      headers: { authorization: ['Bearer first', 'Bearer second'] },
    })).toBeUndefined();
    expect(mockState.instances.length).toBe(before);
  });

  it('never forwards a resource-bound MCP bearer into OxyServices', () => {
    const before = mockState.instances.length;

    expect(createUserScopedOxyServices({
      headers: { authorization: 'Bearer mcp-access-token' },
      mcp: { activeUserId: 'assigned-account' },
    })).toBeUndefined();
    expect(mockState.instances.length).toBe(before);
  });

  it('refuses unproved capability viewer graph without forwarding the ticket or acting as a viewer', async () => {
    const serviceClient = mockState.instances[0];
    const before = mockState.instances.length;
    const client = createScopedOxyClient({
      headers: { authorization: 'Capability signed-ticket' },
      capability: {
        claims: { resource: { effectiveAccountId: 'assigned-account' } },
      },
    });

    await expect(client?.follows.viewerGraph()).rejects.toMatchObject({ code: 'SERVICE_DELEGATION_NOT_AUTHORIZED' });
    expect(mockState.instances.length).toBe(before);
    expect(serviceClient.serviceRequest).not.toHaveBeenCalled();
    expect(serviceClient.session.setAccessToken).not.toHaveBeenCalledWith('signed-ticket');
    expect(createUserScopedOxyServices({
      headers: { authorization: 'Capability signed-ticket' },
      capability: {
        claims: { resource: { effectiveAccountId: 'assigned-account' } },
      },
    })).toBeUndefined();
  });

  /**
   * Oxy answers `/users/me/graph` with the EMPTY graph for a service credential
   * on purpose — blocks and restrictions are private relationship data it will
   * not disclose to one. Reading the privacy lists off that 200 said "this
   * viewer blocks nobody", which is the fail-OPEN the privacy path exists to
   * prevent. A delegated caller with no proof Oxy accepts — a capability
   * request — must be told it cannot resolve them.
   */
  it('refuses to answer a delegated privacy read rather than reporting no blocks', async () => {
    const client = createScopedOxyClient({
      headers: { authorization: 'Capability signed-ticket' },
      capability: { claims: { resource: { effectiveAccountId: 'assigned-account' } } },
    });

    await expect(client?.privacy.blocked()).rejects.toMatchObject({
      name: 'OxyPrivacyUnavailableError',
      code: 'SERVICE_DELEGATION_NOT_AUTHORIZED',
    });
    await expect(client?.privacy.restricted()).rejects.toMatchObject({
      name: 'OxyPrivacyUnavailableError',
      code: 'SERVICE_DELEGATION_NOT_AUTHORIZED',
    });
  });
});

describe('central MCP privacy reads', () => {
  const graph = {
    followingIds: ['followed-account'],
    mutualIds: [],
    blockedIds: ['blocked-account'],
    restrictedIds: ['restricted-account'],
  };

  function centralClient() {
    return createScopedOxyClient({
      headers: { authorization: 'Bearer mcp-access-token' },
      mcp: { activeUserId: 'served-account' },
    });
  }

  /**
   * The connector's token is the proof Oxy takes for the served account's
   * privacy: presented in the BODY of a service-credential call, never installed
   * as a session, and one Oxy round trip answers all three reads.
   */
  it('reads blocks and restrictions of the served account with the connection token as proof', async () => {
    const serviceClient = mockState.instances[0];
    serviceClient.serviceRequest.mockClear();
    serviceClient.serviceRequest.mockResolvedValueOnce({ account_id: 'served-account', graph });
    const before = mockState.instances.length;
    const client = centralClient();

    await expect(client?.privacy.blocked()).resolves.toEqual([{ blockedId: 'blocked-account' }]);
    await expect(client?.privacy.restricted()).resolves.toEqual([{ restrictedId: 'restricted-account' }]);
    await expect(client?.follows.viewerGraph()).resolves.toMatchObject({ followingIds: ['followed-account'] });

    expect(serviceClient.serviceRequest).toHaveBeenCalledTimes(1);
    expect(serviceClient.serviceRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/mcp/oauth/connections/viewer-graph',
      { token: 'mcp-access-token' },
    );
    expect(serviceClient.session.setAccessToken).not.toHaveBeenCalledWith('mcp-access-token');
    expect(mockState.instances.length).toBe(before);
  });

  it('refuses the lists when Oxy answers for an account other than the one served', async () => {
    const serviceClient = mockState.instances[0];
    serviceClient.serviceRequest.mockResolvedValueOnce({ account_id: 'another-account', graph });
    const client = centralClient();

    await expect(client?.privacy.blocked()).rejects.toMatchObject({
      code: 'MCP_CONNECTION_ACCOUNT_MISMATCH',
    });
  });

  it('refuses a graph with no privacy lists instead of reading it as "blocks nobody"', async () => {
    const serviceClient = mockState.instances[0];
    serviceClient.serviceRequest.mockResolvedValueOnce({
      account_id: 'served-account',
      graph: { followingIds: [] },
    });
    const client = centralClient();

    await expect(client?.privacy.blocked()).rejects.toThrow(/missing blockedIds/);
  });
});

describe('ensureProfileMediaPublic', () => {
  beforeEach(() => {
    mockState.control.reject = undefined;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('promotes a bare Oxy file id to public using the owner access token', async () => {
    const before = mockState.instances.length;
    await ensureProfileMediaPublic('owner-token', 'file-123');

    // A new scoped client was constructed for this call.
    expect(mockState.instances.length).toBe(before + 1);
    const client = lastScopedClient();
    expect(client.session.setAccessToken).toHaveBeenCalledWith('owner-token');
    expect(client.assets.setVisibility).toHaveBeenCalledWith('file-123', 'public');
  });

  it('does nothing when there is no access token', async () => {
    const before = mockState.instances.length;
    await ensureProfileMediaPublic(undefined, 'file-123');
    expect(mockState.instances.length).toBe(before);
  });

  it('skips empty, temp, and absolute-URL refs', async () => {
    const before = mockState.instances.length;
    await ensureProfileMediaPublic('owner-token', '');
    await ensureProfileMediaPublic('owner-token', 'temp-abc');
    await ensureProfileMediaPublic('owner-token', 'https://example.com/banner.png');
    await ensureProfileMediaPublic('owner-token', 'http://example.com/banner.png');
    expect(mockState.instances.length).toBe(before);
  });

  it('never throws when the visibility call fails', async () => {
    mockState.control.reject = new Error('403 Access denied');
    await expect(
      ensureProfileMediaPublic('owner-token', 'file-456'),
    ).resolves.toBeUndefined();
    expect(lastScopedClient().assets.setVisibility).toHaveBeenCalledWith('file-456', 'public');
  });
});


describe('verified foreground profile client selection', () => {
  const previous = process.env.MENTION_OXY_FOREGROUND_CATALOG_BINDING;
  afterEach(() => {
    if (previous === undefined) Reflect.deleteProperty(process.env, 'MENTION_OXY_FOREGROUND_CATALOG_BINDING');
    else process.env.MENTION_OXY_FOREGROUND_CATALOG_BINDING = previous;
  });
  it('requires explicit exact catalogue pin and verified accessToken', () => {
    process.env.MENTION_OXY_FOREGROUND_CATALOG_BINDING = JSON.stringify({ registrationId: 'registered', version: '1.0.0', digest: 'a'.repeat(64) });
    expect(createForegroundOxyProfileClient({ user: { id: 'subject' }, accessToken: 'requester' })).toBeDefined();
    expect(() => createForegroundOxyProfileClient({ user: { id: 'subject' }, headers: { authorization: 'Bearer free-header' } })).toThrow('FOREGROUND_RANKING_NOT_CONFIGURED');
  });
  it('never treats attribution or MCP tokens as the foreground requester', () => {
    expect(createForegroundOxyProfileClient({ user: { id: 'subject' }, accessToken: 'requester', mcp: { activeUserId: 'subject' } })).toBeUndefined();
    expect(createForegroundOxyProfileClient({ user: { id: 'subject' }, accessToken: 'requester', capability: { claims: { resource: { effectiveAccountId: 'subject' } } } })).toBeUndefined();
    expect(createForegroundOxyProfileClient({ accessToken: 'unverified' })).toBeUndefined();
  });
  it('fails closed for missing rollout configuration', () => {
    Reflect.deleteProperty(process.env, 'MENTION_OXY_FOREGROUND_CATALOG_BINDING');
    expect(() => createForegroundOxyProfileClient({ user: { id: 'subject' }, accessToken: 'requester' })).toThrow('FOREGROUND_RANKING_NOT_CONFIGURED');
  });
  it('rejects extra free authority fields in configuration', () => {
    process.env.MENTION_OXY_FOREGROUND_CATALOG_BINDING = JSON.stringify({ registrationId: 'registered', version: '1.0.0', digest: 'a'.repeat(64), accountId: 'free-selector' });
    expect(() => createForegroundOxyProfileClient({ user: { id: 'subject' }, accessToken: 'requester' })).toThrow();
  });
});
