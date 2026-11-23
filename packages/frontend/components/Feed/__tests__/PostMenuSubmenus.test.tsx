import type { HydratedPost } from '@mention/shared-types';
import { changePostSetting, movePostToLane, NO_LANE } from '../PostMenuSubmenus';

const mockUpdate = jest.fn();
jest.mock('@/stores/postsStore', () => ({
  usePostsStore: { getState: () => ({ updatePostEverywhere: mockUpdate }) },
}));
const mockSave = jest.fn(async (_id: string, _patch: object) => true);
jest.mock('../postSettings', () => ({
  savePostSettings: (id: string, patch: object) => mockSave(id, patch),
}));
const mockSetLane = jest.fn(async (_id: string, _lane: string | null) => null);
jest.mock('@/services/lanesService', () => ({
  lanesService: { setPostLane: (id: string, lane: string | null) => mockSetLane(id, lane) },
}));
jest.mock('@/stores/laneInvalidation', () => ({ noteLaneListsChanged: jest.fn() }));
const mockToast = jest.fn();
jest.mock('@oxy.so/bloom/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));

const post = { id: 'p1', metadata: { replyPermission: ['anyone'] } } as unknown as HydratedPost;

beforeEach(() => jest.clearAllMocks());

it('saves a post setting, and says when it is refused', async () => {
  await changePostSetting('p1', { replyPermission: ['followers'] }, 'failed');
  expect(mockSave).toHaveBeenCalledWith('p1', { replyPermission: ['followers'] });
  expect(mockToast).not.toHaveBeenCalled();

  mockSave.mockResolvedValueOnce(false);
  await changePostSetting(
    'p1',
    { quotesDisabled: true },
    'postActions.failedToUpdateQuoteSettings',
  );
  expect(mockSave).toHaveBeenLastCalledWith('p1', { quotesDisabled: true });
  expect(mockToast).toHaveBeenCalledWith('postActions.failedToUpdateQuoteSettings', {
    type: 'error',
  });
});

it('moves the post to the chosen lane, or off every lane, and says when it fails', async () => {
  await movePostToLane(post, 'l2', 'failed');
  expect(mockSetLane).toHaveBeenCalledWith('p1', 'l2');
  expect(mockUpdate).toHaveBeenCalled();

  mockSetLane.mockRejectedValueOnce(new Error('no'));
  await movePostToLane(post, NO_LANE, 'lanes.postActions.moveFailed');
  expect(mockSetLane).toHaveBeenLastCalledWith('p1', null);
  expect(mockToast).toHaveBeenCalledWith('lanes.postActions.moveFailed', { type: 'error' });
});
