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
    assetUpdateVisibility: ReturnType<typeof vi.fn>;
  }> = [];
  const control: { reject?: unknown } = {};
  return { instances, control };
});

vi.mock('@oxyhq/core', () => {
  class OxyServices {
    setTokens = vi.fn();
    configureServiceAuth = vi.fn();
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

vi.mock('../../utils/privacyHelpers', () => ({}));

import { ensureProfileMediaPublic } from '../../utils/oxyHelpers';

/** The scoped client is the LAST constructed instance (after the module-level singleton). */
function lastScopedClient() {
  return mockState.instances[mockState.instances.length - 1];
}

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
