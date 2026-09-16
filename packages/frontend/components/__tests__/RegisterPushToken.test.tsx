import React from 'react';
import TestRenderer, { type ReactTestRenderer } from 'react-test-renderer';

import { RegisterPushToken } from '../RegisterPushToken';

/**
 * The bug this pins: the effect re-ran on an account switch (`user?.id` is in
 * its deps), but its dedup guard compared only `lastTokenRef.current ===
 * token.token` — the device's PHYSICAL push token, which is often IDENTICAL
 * across accounts on the same handset. Switching A → B with the same device
 * token found the ref already equal to it (from A's earlier registration) and
 * skipped the POST that would register B, leaving the row owned by A on the
 * backend's last-write-wins `push_tokens.token` unique constraint.
 *
 * Every fixture below runs the SAME device token across accounts on purpose —
 * that is the exact condition the bug needed to reproduce.
 */

const mockAuth: { isAuthenticated: boolean; user: { id: string } | undefined } = {
  isAuthenticated: false,
  user: undefined,
};
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => mockAuth,
}));

const mockPost = jest.fn();
jest.mock('@/utils/api', () => ({
  authenticatedClient: { post: (...args: unknown[]) => mockPost(...args) },
}));

const mockStorageGet = jest.fn();
jest.mock('@/utils/storage', () => ({
  Storage: { get: (...args: unknown[]) => mockStorageGet(...args) },
}));

const mockGetDevicePushToken = jest.fn();
jest.mock('@/utils/notifications', () => ({
  getDevicePushToken: () => mockGetDevicePushToken(),
}));

jest.mock('@oxy.so/core/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn() } }));

const DEVICE_TOKEN = { token: 'device-token-shared-by-both-accounts', type: 'fcm' };

async function flush(): Promise<void> {
  // Two microtask/macrotask turns: one for `Storage.get`, one for
  // `getDevicePushToken`/the POST — each is its own `await` inside the effect.
  await TestRenderer.act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderAs(renderer: ReactTestRenderer | undefined): Promise<ReactTestRenderer> {
  if (renderer) {
    await TestRenderer.act(async () => {
      renderer!.update(<RegisterPushToken />);
    });
    return renderer;
  }
  let created!: ReactTestRenderer;
  await TestRenderer.act(async () => {
    created = TestRenderer.create(<RegisterPushToken />);
  });
  return created;
}

beforeEach(() => {
  mockPost.mockReset().mockResolvedValue({ data: { ok: true } });
  mockStorageGet.mockReset().mockResolvedValue(null);
  mockGetDevicePushToken.mockReset().mockResolvedValue(DEVICE_TOKEN);
  mockAuth.isAuthenticated = false;
  mockAuth.user = undefined;
});

describe('RegisterPushToken — switching accounts on the same device', () => {
  it('registers B even though the device token is identical to A\'s', async () => {
    mockAuth.isAuthenticated = true;
    mockAuth.user = { id: 'account-a' };
    let renderer = await renderAs(undefined);
    await flush();
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(mockPost).toHaveBeenNthCalledWith(1, '/notifications/push-token', expect.objectContaining({
      token: DEVICE_TOKEN.token,
    }));

    mockAuth.user = { id: 'account-b' };
    renderer = await renderAs(renderer);
    await flush();

    // The fix: B's own POST goes out, not skipped because the ref already
    // matched this device token from A's registration.
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('re-registers after A logs out and B logs in', async () => {
    mockAuth.isAuthenticated = true;
    mockAuth.user = { id: 'account-a' };
    let renderer = await renderAs(undefined);
    await flush();
    expect(mockPost).toHaveBeenCalledTimes(1);

    mockAuth.isAuthenticated = false;
    mockAuth.user = undefined;
    renderer = await renderAs(renderer);
    await flush();
    expect(mockPost).toHaveBeenCalledTimes(1); // signed out: no registration attempt

    mockAuth.isAuthenticated = true;
    mockAuth.user = { id: 'account-b' };
    renderer = await renderAs(renderer);
    await flush();
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('does not let a late-resolving POST from A overwrite the dedup state after switching to B', async () => {
    let releaseA: (() => void) | undefined;
    mockPost.mockImplementationOnce(
      () => new Promise((resolve) => { releaseA = () => resolve({ data: { ok: true } }); }),
    );

    mockAuth.isAuthenticated = true;
    mockAuth.user = { id: 'account-a' };
    let renderer = await renderAs(undefined);
    await TestRenderer.act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // A's POST is in flight (deliberately not released yet).

    mockAuth.user = { id: 'account-b' };
    renderer = await renderAs(renderer);
    await flush();
    expect(mockPost).toHaveBeenCalledTimes(2); // B's own POST already went out

    // Now A's stale POST finally resolves.
    await TestRenderer.act(async () => {
      releaseA?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    // If A's late completion had recorded "account-a:<token>" as registered,
    // a THIRD render for B would be considered redundant and skipped. It must
    // not be — the dedup state belongs to whichever run is still current.
    renderer = await renderAs(renderer);
    await flush();
    expect(mockPost).toHaveBeenCalledTimes(2); // still B, already registered — no spurious re-POST
  });

  it('does not register when the account has turned notifications off', async () => {
    mockStorageGet.mockResolvedValue(false);
    mockAuth.isAuthenticated = true;
    mockAuth.user = { id: 'account-a' };
    await renderAs(undefined);
    await flush();

    expect(mockPost).not.toHaveBeenCalled();
    expect(mockStorageGet).toHaveBeenCalledWith('pref:account-a:notificationsEnabled');
  });

  it('swallows a registration failure without throwing, and retries on the next relevant render', async () => {
    mockPost.mockRejectedValueOnce(new Error('network down'));
    mockAuth.isAuthenticated = true;
    mockAuth.user = { id: 'account-a' };
    let renderer = await renderAs(undefined);
    await flush();
    expect(mockPost).toHaveBeenCalledTimes(1);

    // A retry needs an actual dependency change (the effect does not loop on
    // its own) — an account switch is a normal way that happens.
    mockAuth.user = { id: 'account-b' };
    renderer = await renderAs(renderer);
    await flush();
    expect(mockPost).toHaveBeenCalledTimes(2);
  });
});
