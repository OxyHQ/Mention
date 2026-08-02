import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { usePostsStore } from '@/stores/postsStore';
import { usePostSave } from '../usePostSave';

/**
 * What the hook itself owns, now that telling the read caches a list changed is
 * `postsStore`'s job (see `stores/__tests__/engagementInvalidationWiring.test.ts`
 * — it has to live there because `usePostVote` and the videos screen call the
 * store without going through any of these hooks): the save/unsave choice, the
 * attribution that rides along with a SAVE only, the re-entrancy guard, and
 * swallowing a failure instead of surfacing it as an unhandled rejection.
 */

const mockSavePost = jest.fn();
const mockUnsavePost = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('@/stores/postsStore', () => ({
  usePostsStore: jest.fn(),
}));

jest.mock('@oxyhq/core/logger', () => ({
  ...jest.requireActual('@oxyhq/core/logger'),
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}));

const mockUsePostsStore = usePostsStore as unknown as jest.Mock;

let toggleSave: (() => Promise<void>) | undefined;

function Probe({
  isSaved,
  source,
}: {
  isSaved: boolean;
  source?: string;
}) {
  toggleSave = usePostSave('post-1', isSaved, source);
  return null;
}

describe('usePostSave', () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    toggleSave = undefined;
    mockSavePost.mockResolvedValue(undefined);
    mockUnsavePost.mockResolvedValue(undefined);
    mockUsePostsStore.mockReturnValue({
      savePost: mockSavePost,
      unsavePost: mockUnsavePost,
    });
  });

  it('saves with the originating feed as attribution', async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Probe isSaved={false} source="for_you" />);
    });

    await act(async () => {
      await toggleSave?.();
    });

    expect(mockSavePost).toHaveBeenCalledWith({ postId: 'post-1' }, 'for_you');
    expect(mockUnsavePost).not.toHaveBeenCalled();

    act(() => {
      renderer!.unmount();
    });
  });

  it('unsaves without attribution — removing a bookmark carries no interest signal', async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Probe isSaved source="for_you" />);
    });

    await act(async () => {
      await toggleSave?.();
    });

    expect(mockUnsavePost).toHaveBeenCalledWith({ postId: 'post-1' });
    expect(mockSavePost).not.toHaveBeenCalled();

    act(() => {
      renderer!.unmount();
    });
  });

  it('ignores a second press while the first write is in flight', async () => {
    let release!: () => void;
    mockSavePost.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Probe isSaved={false} />);
    });

    let firstPress!: Promise<void>;
    act(() => {
      firstPress = toggleSave!();
    });
    await act(async () => {
      await toggleSave?.();
    });
    expect(mockSavePost).toHaveBeenCalledTimes(1);

    release();
    await act(async () => {
      await firstPress;
    });

    act(() => {
      renderer!.unmount();
    });
  });

  it('logs a failed command instead of rejecting', async () => {
    mockUnsavePost.mockRejectedValueOnce(new Error('network'));

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Probe isSaved />);
    });

    await act(async () => {
      await expect(toggleSave?.()).resolves.toBeUndefined();
    });

    expect(mockLoggerError).toHaveBeenCalled();

    act(() => {
      renderer!.unmount();
    });
  });
});
