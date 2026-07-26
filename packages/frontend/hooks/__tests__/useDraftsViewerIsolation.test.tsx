import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useAuth } from '@oxyhq/services/ui/client';
import {
  getDraftsStorageKey,
  useDrafts,
  type Draft,
} from '../useDrafts';

let mockViewerId: string | null = 'viewer-a';
const mockStorageGet = jest.fn();
const mockStorageSet = jest.fn(
  (_key: string, _value: unknown) => Promise.resolve(true),
);
const mockStorageRemove = jest.fn(
  (_key: string) => Promise.resolve(true),
);

jest.mock('@oxyhq/services/ui/client', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/utils/storage', () => ({
  Storage: {
    get: (...args: unknown[]) => mockStorageGet(...args),
    set: (key: string, value: unknown) => mockStorageSet(key, value),
    remove: (key: string) => mockStorageRemove(key),
  },
}));

jest.mock('@/lib/logger', () => ({
  createScopedLogger: jest.fn(() => ({
    debug: jest.fn(),
    error: jest.fn(),
  })),
}));

const mockUseAuth = useAuth as jest.Mock;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function draft(id: string, updatedAt: number): Draft {
  return {
    id,
    postContent: id,
    mediaIds: [],
    pollOptions: [],
    showPollCreator: false,
    location: null,
    threadItems: [],
    mentions: [],
    postingMode: 'beast',
    createdAt: updatedAt,
    updatedAt,
  };
}

type DraftsResult = ReturnType<typeof useDrafts>;
let latestResult: DraftsResult | null = null;

function Probe() {
  latestResult = useDrafts();
  return null;
}

describe('useDrafts viewer isolation', () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    latestResult = null;
    mockViewerId = 'viewer-a';
    mockStorageSet.mockResolvedValue(true);
    mockStorageRemove.mockResolvedValue(true);
    mockUseAuth.mockImplementation(() => ({
      user: mockViewerId ? { id: mockViewerId } : null,
    }));
  });

  it('loads only B drafts when A resolves after the account switch', async () => {
    const pendingA = deferred<Draft[] | null>();
    const pendingB = deferred<Draft[] | null>();
    mockStorageGet.mockImplementation((key: string) => {
      if (key === getDraftsStorageKey('viewer-a')) {
        return pendingA.promise;
      }
      if (key === getDraftsStorageKey('viewer-b')) {
        return pendingB.promise;
      }
      return Promise.resolve(null);
    });

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe />);
    });

    mockViewerId = 'viewer-b';
    await act(async () => {
      renderer!.update(<Probe />);
    });

    await act(async () => {
      pendingB.resolve([draft('draft-b', 2)]);
      await pendingB.promise;
      await Promise.resolve();
    });
    expect(latestResult?.drafts.map((item) => item.id)).toEqual([
      'draft-b',
    ]);

    await act(async () => {
      pendingA.resolve([draft('draft-a', 3)]);
      await pendingA.promise;
      await Promise.resolve();
    });
    expect(latestResult?.drafts.map((item) => item.id)).toEqual([
      'draft-b',
    ]);

    act(() => {
      renderer!.unmount();
    });
  });

  it('does not persist drafts without an authenticated owner', async () => {
    mockViewerId = null;
    mockStorageGet.mockResolvedValue(null);

    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe />);
    });

    await expect(
      latestResult!.saveDraft({
        postContent: 'private draft',
        mediaIds: [],
        pollOptions: [],
        showPollCreator: false,
        location: null,
        threadItems: [],
        mentions: [],
        postingMode: 'beast',
      }),
    ).rejects.toThrow('authenticated viewer');
    expect(mockStorageSet).not.toHaveBeenCalled();

    act(() => {
      renderer!.unmount();
    });
  });
});
