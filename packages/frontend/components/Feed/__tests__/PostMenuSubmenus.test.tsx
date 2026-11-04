import TestRenderer, { act } from 'react-test-renderer';
import type { HydratedPost } from '@mention/shared-types';
import { PostLaneSubmenu, PostReplySettingsSubmenu } from '../PostMenuSubmenus';

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
jest.mock('@/hooks/usePublisherLanes', () => ({
  usePublisherLanes: () => ({ lanes: [{ id: 'l2', name: 'Dev notes' }], isLoading: false }),
}));
jest.mock('@/lib/navigation/router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
const mockToast = jest.fn();
jest.mock('@oxy.so/bloom/toast', () => ({ toast: (...args: unknown[]) => mockToast(...args) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/bloom/dropdown-menu', () => ({
  DropdownMenuItem: 'DropdownMenuItem',
  DropdownMenuRadioGroup: 'DropdownMenuRadioGroup',
  DropdownMenuRadioItem: 'DropdownMenuRadioItem',
  DropdownMenuSeparator: 'DropdownMenuSeparator',
}));
jest.mock('@/components/Compose/ReplySettingsMenuItems', () => ({
  ReplySettingsMenuItems: 'ReplySettingsMenuItems',
}));

const post = { id: 'p1', metadata: { replyPermission: ['anyone'] } } as unknown as HydratedPost;

function render(element: React.ReactElement) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(element);
  });
  return tree;
}

beforeEach(() => jest.clearAllMocks());

it('saves reply settings as they change, and says when one is refused', async () => {
  const tree = render(<PostReplySettingsSubmenu post={post} />);
  const items = () => tree.root.findByType('ReplySettingsMenuItems' as never).props;
  expect(items().replyPermission).toEqual(['anyone']);

  await act(() => items().onReplyPermissionChange(['followers']));
  expect(mockSave).toHaveBeenCalledWith('p1', { replyPermission: ['followers'] });
  expect(mockToast).not.toHaveBeenCalled();

  mockSave.mockResolvedValueOnce(false);
  await act(() => items().onQuotesDisabledChange(true));
  expect(mockSave).toHaveBeenLastCalledWith('p1', { quotesDisabled: true });
  expect(mockToast).toHaveBeenCalledWith('postActions.failedToUpdateQuoteSettings', {
    type: 'error',
  });
});

it('moves the post to the chosen lane, or off every lane, and says when it fails', async () => {
  const tree = render(<PostLaneSubmenu post={post} />);
  const group = () => tree.root.findByType('DropdownMenuRadioGroup' as never).props;

  await act(() => group().onValueChange('l2'));
  expect(mockSetLane).toHaveBeenCalledWith('p1', 'l2');
  expect(mockUpdate).toHaveBeenCalled();

  mockSetLane.mockRejectedValueOnce(new Error('no'));
  await act(() => group().onValueChange(''));
  expect(mockSetLane).toHaveBeenLastCalledWith('p1', null);
  expect(mockToast).toHaveBeenCalledWith('lanes.postActions.moveFailed', { type: 'error' });
});
