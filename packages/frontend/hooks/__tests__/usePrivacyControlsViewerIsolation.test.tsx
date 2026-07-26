import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useAuth } from '@oxyhq/services/ui/client';
import { usePrivacyStore } from '@/stores/privacyStore';
import { usePrivacyControls } from '../usePrivacyControls';

const mockGetBlockedUsers = jest.fn();
const mockGetRestrictedUsers = jest.fn();
let mockViewerId = 'viewer-a';

jest.mock('@oxyhq/services/ui/client', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  logger: {
    error: jest.fn(),
  },
}));

const mockUseAuth = useAuth as jest.Mock;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function Probe() {
  usePrivacyControls();
  return null;
}

describe('usePrivacyControls viewer isolation', () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockViewerId = 'viewer-a';
    usePrivacyStore.getState().reset();
    mockUseAuth.mockImplementation(() => ({
      oxyServices: {
        getBlockedUsers: mockGetBlockedUsers,
        getRestrictedUsers: mockGetRestrictedUsers,
      },
      isAuthenticated: true,
      isAuthResolved: true,
      canUsePrivateApi: true,
      user: { id: mockViewerId },
    }));
  });

  it('discards A privacy lists when they resolve after B', async () => {
    const blockedA = deferred<Array<{ blockedId: string }>>();
    const blockedB = deferred<Array<{ blockedId: string }>>();
    mockGetBlockedUsers
      .mockReturnValueOnce(blockedA.promise)
      .mockReturnValueOnce(blockedB.promise);
    mockGetRestrictedUsers.mockResolvedValue([]);

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe />);
    });

    await act(async () => {
      renderer!.update(<></>);
    });
    usePrivacyStore.getState().reset();
    mockViewerId = 'viewer-b';
    await act(async () => {
      renderer!.update(<Probe />);
    });

    await act(async () => {
      blockedB.resolve([{ blockedId: 'blocked-by-b' }]);
      await blockedB.promise;
      await Promise.resolve();
    });
    expect(usePrivacyStore.getState().blockedIds).toEqual(['blocked-by-b']);

    await act(async () => {
      blockedA.resolve([{ blockedId: 'blocked-by-a' }]);
      await blockedA.promise;
      await Promise.resolve();
    });
    expect(usePrivacyStore.getState().blockedIds).toEqual(['blocked-by-b']);

    act(() => {
      renderer!.unmount();
    });
  });
});
