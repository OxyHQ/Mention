import type { HydratedPost } from '@mention/shared-types';
import { savePostSettings } from '../postSettings';

let mockPost = { id: 'p1', metadata: { quotesDisabled: false } } as unknown as HydratedPost;
jest.mock('@/stores/postsStore', () => ({
  usePostsStore: {
    getState: () => ({
      updatePostEverywhere: (_id: string, update: (prev: HydratedPost) => HydratedPost) => {
        mockPost = update(mockPost);
      },
    }),
  },
}));
const mockWrite = jest.fn(async () => ({ success: true, data: null }));
jest.mock('@/services/feedService', () => ({
  feedService: { updatePostSettings: () => mockWrite() },
}));

it('shows a setting at once, keeps it when saved, and puts it back when refused', async () => {
  await expect(savePostSettings('p1', { quotesDisabled: true })).resolves.toBe(true);
  expect(mockPost.metadata?.quotesDisabled).toBe(true);

  mockWrite.mockRejectedValueOnce(new Error('no'));
  await expect(savePostSettings('p1', { quotesDisabled: false })).resolves.toBe(false);
  expect(mockPost.metadata?.quotesDisabled).toBe(true);
});
