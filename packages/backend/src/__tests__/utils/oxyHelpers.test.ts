import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shared mock state. Declared via `vi.hoisted` so it is initialised before the
 * hoisted `vi.mock` factory below runs (vitest lifts `vi.mock` to the top of the
 * module). The server singleton is faked because the helpers otherwise reach
 * Oxy; every user client it builds (`asUser` / `withUser`) is recorded with the
 * bearer it was given, so each test can see whose session a call carried.
 */
const mockState = vi.hoisted(() => {
  const userClients: Array<{
    bearer: string;
    assets: { setVisibility: ReturnType<typeof vi.fn> };
    withCallOptions: ReturnType<typeof vi.fn>;
  }> = [];
  const control: { reject?: unknown } = {};
  class FakeUserClient {
    assets = {
      setVisibility: vi
        .fn()
        .mockImplementation(() =>
          control.reject !== undefined
            ? Promise.reject(control.reject)
            : Promise.resolve({ file: { id: 'x', visibility: 'public' } }),
        ),
    };
    /** The SDK's call scope: the same client's namespaces, with these options. */
    withCallOptions = vi.fn(() => this);

    constructor(readonly bearer: string) {
      userClients.push(this);
    }
  }
  /** The process `OxyServer`: one per process, never handed a user's bearer. */
  class FakeOxyServer {
    session = { setAccessToken: vi.fn() };
    serviceRequest = vi.fn().mockResolvedValue({
      data: { blockedIds: [], restrictedIds: [], followingIds: [], mutualIds: [] },
    });
    withRequester = vi.fn(() => ({
      privacy: { blocked: vi.fn(), restricted: vi.fn() },
      follows: { viewerGraph: vi.fn() },
    }));
    asUser = vi.fn((bearer: string) => new FakeUserClient(bearer));
    withUser = vi.fn(async (bearer: string, use: (user: FakeUserClient) => unknown) =>
      use(new FakeUserClient(bearer)),
    );
    accountAccessFor = vi.fn();
  }
  return { userClients, control, FakeOxyServer };
});

vi.mock('@oxy.so/core/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@oxy.so/core/server')>()),
  OxyServer: mockState.FakeOxyServer,
}));

// Was `() => ({})`, which stubbed the module out entirely — including the
// `OxyPrivacyUnavailableError` the delegated client throws. The real module is
// imported instead: it is pure error/id-shape logic and reaches no network.
vi.mock('../../utils/privacyHelpers', async (importOriginal) => importOriginal());

import {
  getServiceOxyClient,
  callerAccountAccess,
  callerOxyUser,
  createScopedOxyClient,
  createForegroundOxyProfileClient,
  ensureProfileMediaPublic,
  MEDIA_VISIBILITY_TIMEOUT_MS,
} from '../../utils/oxyHelpers';

type FakeServer = InstanceType<typeof mockState.FakeOxyServer>;

function serviceClient(): FakeServer {
  return getServiceOxyClient() as unknown as FakeServer;
}

/** The user client most recently built. */
function lastUserClient() {
  return mockState.userClients[mockState.userClients.length - 1];
}

describe('request-scoped Oxy clients', () => {
  it('gives a verified session its own user client, bound to the verified bearer', () => {
    const before = mockState.userClients.length;
    const client = createScopedOxyClient({ accessToken: 'owner-token' });

    expect(client).toBeDefined();
    expect(mockState.userClients.length).toBe(before + 1);
    expect(lastUserClient().bearer).toBe('owner-token');
    expect(serviceClient().session.setAccessToken).not.toHaveBeenCalled();
  });

  /**
   * Only what the auth middleware verified (`req.accessToken`) is a session. A
   * raw `Authorization` header the optional mount refused — or never saw — is
   * not one, so no user client is built from it.
   */
  it('never builds a user client from a raw Authorization header', () => {
    const before = mockState.userClients.length;

    expect(createScopedOxyClient({ headers: { authorization: 'Bearer unverified' } })).toBe(
      undefined,
    );
    expect(callerOxyUser({ headers: { authorization: 'Bearer unverified' } })).toBeUndefined();
    expect(
      callerAccountAccess({ headers: { authorization: 'Bearer unverified' } }),
    ).toBeUndefined();
    expect(mockState.userClients.length).toBe(before);
  });

  it('never forwards a resource-bound MCP bearer into a user client', () => {
    const before = mockState.userClients.length;
    const mcp = {
      accessToken: 'mcp-access-token',
      headers: { authorization: 'Bearer mcp-access-token' },
      mcp: { activeUserId: 'assigned-account' },
    };

    expect(callerOxyUser(mcp)).toBeUndefined();
    expect(callerAccountAccess(mcp)).toBeUndefined();
    expect(mockState.userClients.length).toBe(before);
  });

  it('uses the centrally derived service context without reusing a task or service JWT as a session', () => {
    const service = serviceClient();
    const own = {
      user: { id: 'original-person' },
      accessToken: 'service-jwt',
      serviceApp: { authority: 'first_party' as const },
      serviceActingAs: {
        userId: 'original-person',
        authority: 'first_party' as const,
        requesterContext: 'verified-context',
      },
    };
    expect(createScopedOxyClient(own)).toBeDefined();
    expect(service.withRequester).toHaveBeenCalledWith({ requesterContext: 'verified-context' });
    expect(service.session.setAccessToken).not.toHaveBeenCalledWith('service-jwt');
    expect(service.asUser).not.toHaveBeenCalledWith('service-jwt');
    expect(callerOxyUser(own)).toBeUndefined();
    expect(callerAccountAccess(own)).toBeUndefined();
    expect(() => createScopedOxyClient({ ...own, user: { id: 'other-account' } })).toThrow(
      'requester proof',
    );
    expect(() => createScopedOxyClient({ ...own, serviceActingAs: undefined })).toThrow(
      'requester proof',
    );
  });

  it('requires the actual capability ticket and never plants it as a session', () => {
    expect(() =>
      createScopedOxyClient({
        capability: { claims: { resource: { effectiveAccountId: 'assigned-account' } } },
      }),
    ).toThrow('proof is missing');
    const service = serviceClient();
    const result = createScopedOxyClient({
      headers: { authorization: 'Capability signed-ticket' },
      capability: {
        ticket: 'signed-ticket',
        claims: { resource: { effectiveAccountId: 'assigned-account' } },
      },
    });
    expect(result).toBeDefined();
    expect(service.withRequester).toHaveBeenCalledWith({ capabilityTicket: 'signed-ticket' });
    expect(service.session.setAccessToken).not.toHaveBeenCalledWith('signed-ticket');
  });
});

describe('callerAccountAccess', () => {
  const req = { user: { id: 'caller' }, userId: 'caller', sessionId: 's1', accessToken: 'tok' };

  beforeEach(() => {
    serviceClient().accountAccessFor.mockReset();
  });

  it('asks Oxy fresh, with the request itself, once per account per request', async () => {
    const access = { accountId: 'org', has: () => true };
    serviceClient().accountAccessFor.mockResolvedValue(access);
    const read = callerAccountAccess(req);

    await Promise.all([read?.('org'), read?.('org')]);
    await read?.('org');
    await read?.('channel');

    expect(serviceClient().accountAccessFor.mock.calls).toEqual([
      [req, 'org', { fresh: true }],
      [req, 'channel', { fresh: true }],
    ]);
  });

  /**
   * Within ONE request a failure is shared, so a batch refuses consistently.
   * The next request builds its own reader and asks Oxy again: an outage is
   * never remembered as an answer.
   */
  it('shares a failure within a request, and asks again on the next request', async () => {
    const outage = new Error('oxy 502');
    serviceClient()
      .accountAccessFor.mockRejectedValueOnce(outage)
      .mockResolvedValueOnce({ accountId: 'org', has: () => true });
    const first = callerAccountAccess(req);

    await expect(first?.('org')).rejects.toBe(outage);
    await expect(first?.('org')).rejects.toBe(outage);
    await expect(callerAccountAccess(req)?.('org')).resolves.toMatchObject({ accountId: 'org' });
    expect(serviceClient().accountAccessFor).toHaveBeenCalledTimes(2);
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
    const serviceClient = getServiceOxyClient() as unknown as FakeServer;
    serviceClient.serviceRequest.mockClear();
    serviceClient.serviceRequest.mockResolvedValueOnce({ account_id: 'served-account', graph });
    const before = mockState.userClients.length;
    const client = centralClient();

    await expect(client?.privacy.blocked()).resolves.toEqual([{ blockedId: 'blocked-account' }]);
    await expect(client?.privacy.restricted()).resolves.toEqual([
      { restrictedId: 'restricted-account' },
    ]);
    await expect(client?.follows.viewerGraph()).resolves.toMatchObject({
      followingIds: ['followed-account'],
    });

    expect(serviceClient.serviceRequest).toHaveBeenCalledTimes(1);
    expect(serviceClient.serviceRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/mcp/oauth/connections/viewer-graph',
      { token: 'mcp-access-token' },
    );
    expect(serviceClient.session.setAccessToken).not.toHaveBeenCalledWith('mcp-access-token');
    expect(mockState.userClients.length).toBe(before);
  });

  it('refuses the lists when Oxy answers for an account other than the one served', async () => {
    const serviceClient = getServiceOxyClient() as unknown as FakeServer;
    serviceClient.serviceRequest.mockResolvedValueOnce({ account_id: 'another-account', graph });
    const client = centralClient();

    await expect(client?.privacy.blocked()).rejects.toMatchObject({
      code: 'MCP_CONNECTION_ACCOUNT_MISMATCH',
    });
  });

  it('refuses a graph with no privacy lists instead of reading it as "blocks nobody"', async () => {
    const serviceClient = getServiceOxyClient() as unknown as FakeServer;
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

  it('promotes a bare Oxy file id to public as the owner', async () => {
    const before = mockState.userClients.length;
    await ensureProfileMediaPublic('owner-token', 'file-123');

    // One user client, bound to the owner's bearer, for this call.
    expect(mockState.userClients.length).toBe(before + 1);
    const client = lastUserClient();
    expect(client.bearer).toBe('owner-token');
    expect(client.assets.setVisibility).toHaveBeenCalledWith('file-123', 'public');
    // Oxy moves every variant before it answers: past the SDK's 5 s default.
    expect(client.withCallOptions).toHaveBeenCalledWith({ timeout: MEDIA_VISIBILITY_TIMEOUT_MS });
    expect(MEDIA_VISIBILITY_TIMEOUT_MS).toBeGreaterThan(5_000);
  });

  it('does nothing when there is no access token', async () => {
    const before = mockState.userClients.length;
    await ensureProfileMediaPublic(undefined, 'file-123');
    expect(mockState.userClients.length).toBe(before);
  });

  it('skips empty, temp, and absolute-URL refs', async () => {
    const before = mockState.userClients.length;
    await ensureProfileMediaPublic('owner-token', '');
    await ensureProfileMediaPublic('owner-token', 'temp-abc');
    await ensureProfileMediaPublic('owner-token', 'https://example.com/banner.png');
    await ensureProfileMediaPublic('owner-token', 'http://example.com/banner.png');
    expect(mockState.userClients.length).toBe(before);
  });

  it('never throws when the visibility call fails', async () => {
    mockState.control.reject = new Error('403 Access denied');
    await expect(ensureProfileMediaPublic('owner-token', 'file-456')).resolves.toBeUndefined();
    expect(lastUserClient().assets.setVisibility).toHaveBeenCalledWith('file-456', 'public');
  });
});

describe('verified foreground profile client selection', () => {
  const previous = process.env.MENTION_OXY_FOREGROUND_CATALOG_BINDING;
  afterEach(() => {
    if (previous === undefined)
      Reflect.deleteProperty(process.env, 'MENTION_OXY_FOREGROUND_CATALOG_BINDING');
    else process.env.MENTION_OXY_FOREGROUND_CATALOG_BINDING = previous;
  });
  it('requires explicit exact catalogue pin and verified accessToken', () => {
    process.env.MENTION_OXY_FOREGROUND_CATALOG_BINDING = JSON.stringify({
      registrationId: 'registered',
      version: '1.0.0',
      digest: 'a'.repeat(64),
    });
    expect(
      createForegroundOxyProfileClient({
        user: { id: 'subject' },
        accessToken: 'requester',
        oxyActor: {
          schemaVersion: 1,
          actorAccountId: 'operator',
          effectiveAccountId: 'subject',
          delegated: true,
        },
      }),
    ).toBeDefined();
    expect(() =>
      createForegroundOxyProfileClient({
        user: { id: 'subject' },
        headers: { authorization: 'Bearer free-header' },
      }),
    ).toThrow('FOREGROUND_RANKING_NOT_CONFIGURED');
  });
  it('never treats attribution or MCP tokens as the foreground requester', () => {
    expect(
      createForegroundOxyProfileClient({
        user: { id: 'subject' },
        accessToken: 'requester',
        mcp: { activeUserId: 'subject' },
      }),
    ).toBeUndefined();
    expect(
      createForegroundOxyProfileClient({
        user: { id: 'subject' },
        accessToken: 'requester',
        capability: { claims: { resource: { effectiveAccountId: 'subject' } } },
      }),
    ).toBeUndefined();
    expect(createForegroundOxyProfileClient({ accessToken: 'unverified' })).toBeUndefined();
  });
  it('fails closed for missing rollout configuration', () => {
    Reflect.deleteProperty(process.env, 'MENTION_OXY_FOREGROUND_CATALOG_BINDING');
    expect(() =>
      createForegroundOxyProfileClient({
        user: { id: 'subject' },
        accessToken: 'requester',
        oxyActor: {
          schemaVersion: 1,
          actorAccountId: 'operator',
          effectiveAccountId: 'subject',
          delegated: true,
        },
      }),
    ).toThrow('FOREGROUND_RANKING_NOT_CONFIGURED');
  });
  it('rejects extra free authority fields in configuration', () => {
    process.env.MENTION_OXY_FOREGROUND_CATALOG_BINDING = JSON.stringify({
      registrationId: 'registered',
      version: '1.0.0',
      digest: 'a'.repeat(64),
      accountId: 'free-selector',
    });
    expect(() =>
      createForegroundOxyProfileClient({
        user: { id: 'subject' },
        accessToken: 'requester',
        oxyActor: {
          schemaVersion: 1,
          actorAccountId: 'operator',
          effectiveAccountId: 'subject',
          delegated: true,
        },
      }),
    ).toThrow();
  });
});
