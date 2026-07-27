import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services/ui/client';
import { usePostsStore } from '@/stores/postsStore';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { usePostSave } from '../usePostSave';

const mockSavePost = jest.fn();
const mockUnsavePost = jest.fn();
const mockInvalidateQueries = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: jest.fn(),
}));

jest.mock('@oxyhq/services/ui/client', () => ({
  useAuth: jest.fn(),
}));

jest.mock('@/stores/postsStore', () => ({
  usePostsStore: jest.fn(),
}));

jest.mock('@/lib/logger', () => ({
  logger: { error: (...args: unknown[]) => mockLoggerError(...args) },
}));

const mockUseQueryClient = useQueryClient as jest.Mock;
const mockUseAuth = useAuth as jest.Mock;
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

describe('usePostSave saved-query coherence', () => {
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
    mockInvalidateQueries.mockResolvedValue(undefined);
    mockUseQueryClient.mockReturnValue({
      invalidateQueries: mockInvalidateQueries,
    });
    mockUseAuth.mockReturnValue({ user: { id: 'viewer-a' } });
    mockUsePostsStore.mockReturnValue({
      savePost: mockSavePost,
      unsavePost: mockUnsavePost,
    });
  });

  it('revalidates every saved-list filter after a successful unsave', async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Probe isSaved />);
    });

    await act(async () => {
      await toggleSave?.();
    });

    expect(mockUnsavePost).toHaveBeenCalledWith({ postId: 'post-1' });
    expect(mockInvalidateQueries).toHaveBeenCalledWith({
      queryKey: viewerQueryKeys.savedPostsRoot('viewer-a'),
    });

    act(() => {
      renderer!.unmount();
    });
  });

  it('revalidates saved lists after save and preserves attribution', async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <Probe isSaved={false} source="for_you" />,
      );
    });

    await act(async () => {
      await toggleSave?.();
    });

    expect(mockSavePost).toHaveBeenCalledWith(
      { postId: 'post-1' },
      'for_you',
    );
    expect(mockInvalidateQueries).toHaveBeenCalledTimes(1);

    act(() => {
      renderer!.unmount();
    });
  });

  it('does not revalidate a successful list state after a failed command', async () => {
    mockUnsavePost.mockRejectedValueOnce(new Error('network'));

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Probe isSaved />);
    });

    await act(async () => {
      await toggleSave?.();
    });

    expect(mockInvalidateQueries).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalled();

    act(() => {
      renderer!.unmount();
    });
  });
});
