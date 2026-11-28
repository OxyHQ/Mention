// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

const mockPost = jest.fn();
jest.mock('@/utils/api', () => ({
  authenticatedClient: { post: (...args: unknown[]) => mockPost(...args) },
  publicClient: {},
  isNotFoundError: () => false,
}));
jest.mock('@/lib/oxyServices', () => ({
  oxyServices: { getClient: () => ({ getAccessToken: () => null }), getCurrentUserId: () => null },
}));
import { feedService } from '../feedService';

beforeEach(() => mockPost.mockReset());
it.each(['accept', 'decline'] as const)(
  'sends the intended subject on guarded %s',
  async (action) => {
    mockPost.mockResolvedValue({ data: { success: true, post: null } });
    const result =
      action === 'accept'
        ? await feedService.acceptCollabInvite('p', 'A')
        : await feedService.declineCollabInvite('p', 'A');
    expect(result.success).toBe(true);
    expect(mockPost).toHaveBeenCalledWith(`/posts/p/collaborators/_viewer/${action}`, undefined, {
      headers: { 'X-Mention-Expected-Viewer': 'A' },
    });
  },
);
it('does not claim success for a response that did not confirm it', async () => {
  mockPost.mockResolvedValue({ data: { success: false, post: null } });
  expect((await feedService.acceptCollabInvite('p', 'A')).success).toBe(false);
});
it('does not retry the old endpoint after a 404', async () => {
  mockPost.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
  await expect(feedService.acceptCollabInvite('p', 'A')).rejects.toMatchObject({ status: 404 });
  expect(mockPost).toHaveBeenCalledTimes(1);
  expect(mockPost.mock.calls[0][0]).toBe('/posts/p/collaborators/_viewer/accept');
});
