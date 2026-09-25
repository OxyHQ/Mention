import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shared mock state. Declared via `vi.hoisted` so it is initialised before the
 * hoisted `vi.mock` factory below runs (vitest lifts `vi.mock` to the top of the
 * module). Records every constructed OxyServices instance so each test can
 * inspect the scoped client built inside `ensureProfileMediaPublic` (tokens
 * planted + visibility call). The class is mocked because the helper otherwise
 * performs a real network PATCH to Oxy.
 */
const mockState = vi.hoisted(() => {
  const instances: Array<{
    setTokens: ReturnType<typeof vi.fn>;
    makeServiceRequest: ReturnType<typeof vi.fn>;
    assetUpdateVisibility: ReturnType<typeof vi.fn>;
  }> = [];
  const control: { reject?: unknown } = {};
  return { instances, control };
});

vi.mock('@oxy.so/core', () => {
  class OxyServices {
    setTokens = vi.fn();
    configureServiceAuth = vi.fn();
    makeServiceRequest = vi.fn().mockResolvedValue({
      data: { blockedIds: [], restrictedIds: [], followingIds: [], mutualIds: [] },
    });
    assetUpdateVisibility = vi.fn().mockImplementation(() =>
      mockState.control.reject !== undefined
        ? Promise.reject(mockState.control.reject)
        : Promise.resolve({ file: { id: 'x', visibility: 'public' } }),
    );

    constructor() {
      mockState.instances.push(this);
    }
  }
  return { OxyServices };
});

// Was `() => ({})`, which stubbed the module out entirely — including the
// `OxyPrivacyUnavailableError` the delegated client throws. The real module is
// imported instead: it is pure error/id-shape logic and reaches no network.
vi.mock('../../utils/privacyHelpers', async (importOriginal) => importOriginal());

import {
  createScopedOxyClient,
  createUserScopedOxyServices,
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
    expect(lastScopedClient().setTokens).toHaveBeenCalledWith('owner-token');
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

  it('uses service delegation for the capability-assigned account without forwarding the ticket', async () => {
    const serviceClient = mockState.instances[0];
    const before = mockState.instances.length;
    const client = createScopedOxyClient({
      headers: { authorization: 'Capability signed-ticket' },
      capability: {
        claims: { resource: { effectiveAccountId: 'assigned-account' } },
      },
    });

    await expect(client?.getViewerGraph()).resolves.toMatchObject({ blockedIds: [] });
    expect(mockState.instances.length).toBe(before);
    expect(serviceClient.makeServiceRequest).toHaveBeenCalledWith(
      'GET',
      '/users/me/graph',
      undefined,
      'assigned-account',
    );
    expect(serviceClient.setTokens).not.toHaveBeenCalledWith('signed-ticket');
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
   * prevent. A delegated caller must be told it cannot resolve them.
   */
  it('refuses to answer a delegated privacy read rather than reporting no blocks', async () => {
    const client = createScopedOxyClient({
      headers: { authorization: 'Bearer mcp-access-token' },
      mcp: { activeUserId: 'assigned-account' },
    });

    await expect(client?.getBlockedUsers()).rejects.toMatchObject({
      name: 'OxyPrivacyUnavailableError',
      code: 'SERVICE_DELEGATION_NOT_AUTHORIZED',
    });
    await expect(client?.getRestrictedUsers()).rejects.toMatchObject({
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
      mcp: { activeUserId: 'served-account', authMode: 'central' },
    });
  }

  /**
   * The connector's token is the proof Oxy takes for the served account's
   * privacy: presented in the BODY of a service-credential call, never installed
   * as a session, and one Oxy round trip answers all three reads.
   */
  it('reads blocks and restrictions of the served account with the connection token as proof', async () => {
    const serviceClient = mockState.instances[0];
    serviceClient.makeServiceRequest.mockClear();
    serviceClient.makeServiceRequest.mockResolvedValueOnce({ account_id: 'served-account', graph });
    const before = mockState.instances.length;
    const client = centralClient();

    await expect(client?.getBlockedUsers()).resolves.toEqual([{ blockedId: 'blocked-account' }]);
    await expect(client?.getRestrictedUsers()).resolves.toEqual([{ restrictedId: 'restricted-account' }]);
    await expect(client?.getViewerGraph()).resolves.toMatchObject({ followingIds: ['followed-account'] });

    expect(serviceClient.makeServiceRequest).toHaveBeenCalledTimes(1);
    expect(serviceClient.makeServiceRequest).toHaveBeenCalledWith(
      'POST',
      '/auth/mcp/oauth/connections/viewer-graph',
      { token: 'mcp-access-token' },
    );
    expect(serviceClient.setTokens).not.toHaveBeenCalledWith('mcp-access-token');
    expect(mockState.instances.length).toBe(before);
  });

  it('refuses the lists when Oxy answers for an account other than the one served', async () => {
    const serviceClient = mockState.instances[0];
    serviceClient.makeServiceRequest.mockResolvedValueOnce({ account_id: 'another-account', graph });
    const client = centralClient();

    await expect(client?.getBlockedUsers()).rejects.toMatchObject({
      code: 'MCP_CONNECTION_ACCOUNT_MISMATCH',
    });
  });

  it('refuses a graph with no privacy lists instead of reading it as "blocks nobody"', async () => {
    const serviceClient = mockState.instances[0];
    serviceClient.makeServiceRequest.mockResolvedValueOnce({
      account_id: 'served-account',
      graph: { followingIds: [] },
    });
    const client = centralClient();

    await expect(client?.getBlockedUsers()).rejects.toThrow(/missing blockedIds/);
  });

  it('keeps a legacy MCP token fail-closed: it is not proof Oxy accepts', async () => {
    const client = createScopedOxyClient({
      headers: { authorization: 'Bearer legacy-token' },
      mcp: { activeUserId: 'served-account', authMode: 'legacy' },
    });

    await expect(client?.getBlockedUsers()).rejects.toMatchObject({
      name: 'OxyPrivacyUnavailableError',
      code: 'SERVICE_DELEGATION_NOT_AUTHORIZED',
    });
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
    expect(client.setTokens).toHaveBeenCalledWith('owner-token');
    expect(client.assetUpdateVisibility).toHaveBeenCalledWith('file-123', 'public');
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
    expect(lastScopedClient().assetUpdateVisibility).toHaveBeenCalledWith('file-456', 'public');
  });
});
