import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { BottomBar } from '../../BottomBar';
import { BAR_TABS, pageIndexByName } from '../tabs';

const mockSelectTab = jest.fn();
const mockRefresh = jest.fn();
const mockAccount = jest.fn();
const mockProgress = { value: 1.25 };
const mockMinimize = { value: 0.4 };
let mockActiveIndex = 0;
let mockBarProps: Record<string, any> = {};
jest.mock('@oxy.so/bloom/bottom-bar', () => ({ BottomBar: (props: Record<string, any>) => { mockBarProps = props; return props.action; } }));
jest.mock('@oxy.so/bloom/fab', () => ({ Fab: () => null }));
jest.mock('@oxy.so/bloom/avatar', () => ({ Avatar: () => null }));
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => ({ user: { id: 'viewer' }, showBottomSheet: mockAccount }) }));
jest.mock('@oxy.so/bloom/hooks', () => ({ useHaptics: () => jest.fn() }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('react-native-reanimated', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return { __esModule: true, default: { View: RN.View }, useAnimatedStyle: (fn: () => unknown) => fn() };
});
jest.mock('@/context/HomeRefreshContext', () => ({ useHomeRefresh: () => ({ triggerHomeRefresh: mockRefresh }) }));
jest.mock('@/context/BottomBarVisibilityContext', () => ({ useBottomBarHidden: () => mockMinimize }));
jest.mock('@/context/TabPagerContext', () => ({ useTabPager: () => ({ progress: mockProgress, chromeProgress: { value: 0 }, activeIndex: mockActiveIndex, activePage: 1, selectTab: mockSelectTab }) }));
jest.mock('@/hooks/useUnreadCount', () => ({ useUnreadCount: () => 2 }));
jest.mock('@/components/notifications/UnreadBadge', () => ({ UnreadBadge: () => null }));

beforeEach(() => { jest.clearAllMocks(); mockActiveIndex = 0; });
it('preserves pager motion and destinations while compose is the action', async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<BottomBar />); });
  expect(mockBarProps.activeProgress).toBe(mockProgress);
  expect(mockBarProps.minimizeProgress).toBe(mockMinimize);
  expect(mockBarProps.items.map((item: { name: string }) => item.name)).toEqual(BAR_TABS.map(tab => tab.name));
  expect(mockBarProps.items.some((item: { name: string }) => item.name === 'write')).toBe(false);
  act(() => mockBarProps.onValueChange('notifications'));
  expect(mockSelectTab).toHaveBeenLastCalledWith(pageIndexByName('notifications'));
  act(() => mockBarProps.action.props.onPress());
  expect(mockSelectTab).toHaveBeenLastCalledWith(pageIndexByName('write'));
  await act(async () => renderer.unmount());
});
it('retaps Home to refresh and reserves long press for account switching', async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => { renderer = TestRenderer.create(<BottomBar />); });
  act(() => mockBarProps.onValueChange('index'));
  expect(mockRefresh).toHaveBeenCalledTimes(1);
  expect(mockSelectTab).not.toHaveBeenCalled();
  act(() => mockBarProps.onValueLongPress('index'));
  expect(mockAccount).not.toHaveBeenCalled();
  act(() => mockBarProps.onValueLongPress('you'));
  expect(mockAccount).toHaveBeenCalledWith('ManageAccount');
  await act(async () => renderer.unmount());
});
