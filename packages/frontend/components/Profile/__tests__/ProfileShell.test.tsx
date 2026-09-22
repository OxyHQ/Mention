import React from 'react';
import { Animated, ScrollView, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { ProfileShell, type ProfileShellProps } from '../ProfileShell';

const mockScrollPosition = { value: 0 };
const mockHeader = jest.fn();
const mockTabs = jest.fn();
const mockList = jest.fn();
const mockDock = jest.fn();
const mockSticky = jest.fn();
let mockDockInset = 84;

jest.mock('@oxy.so/bloom/layout', () => ({
  HeaderDockProvider: (props: { children: React.ReactNode }) => { mockDock(props); return props.children; },
  StickySection: (props: { children: React.ReactNode }) => { mockSticky(props); return props.children; },
  useHeaderDockInset: () => mockDockInset,
}));
jest.mock('@oxy.so/bloom/page-header', () => ({
  PageHeader: (props: object) => { mockHeader(props); return null; },
}));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ isDark: false }) }));
jest.mock('@/context/LayoutScrollContext', () => ({ useLayoutScroll: () => ({ scrollPosition: mockScrollPosition }) }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, options: { defaultValue: string }) => options.defaultValue }),
}));
jest.mock('@/hooks/useSafeBack', () => ({ useSafeBack: () => jest.fn() }));
jest.mock('@/components/UserName', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: () => null }));
jest.mock('@/assets/illustrations/NoUpdates', () => ({ NoUpdatesIllustration: () => null }));
jest.mock('../ProfileSkeleton', () => ({ ProfileSkeleton: () => null }));
jest.mock('../ProfileTabs', () => ({
  ProfileTabs: (props: { listHeaderComponent?: React.ReactNode; listStickyHeaderComponent?: React.ReactNode }) => {
    mockTabs(props);
    return <>{props.listHeaderComponent}{props.listStickyHeaderComponent}</>;
  },
}));
jest.mock('@shopify/flash-list', () => {
  const React_ = require('react') as typeof React;
  type MockProps = { ListHeaderComponent?: React.ReactNode; data: readonly string[]; renderItem: (info: { item: string }) => React.ReactNode };
  return {
    FlashList: React_.forwardRef<unknown, MockProps>((props, _ref) => {
      mockList(props);
      return <>{props.ListHeaderComponent}{props.data.map(item => <React_.Fragment key={item}>{props.renderItem({ item })}</React_.Fragment>)}</>;
    }),
  };
});

function makeProps(tab: ProfileShellProps['tabs']['tab'] = 'lists'): ProfileShellProps {
  return {
    chrome: {
      scrollY: new Animated.Value(0), scrollRef: { current: null }, onScroll: jest.fn(),
      assignScrollRef: jest.fn(), scrollToContent: jest.fn(), contentHeight: 0, setContentHeight: jest.fn(),
    },
    loading: false,
    profileData: { id: 'person', username: 'person', name: { displayName: 'Person' }, design: { displayName: 'Person' } },
    banner: { uri: 'https://example.com/banner.jpg' }, headerActions: null,
    summary: <Text>Profile summary</Text>, tabBar: <Text>Profile tabs</Text>,
    tabs: { tab, profileId: 'person', isOwnProfile: false, isPrivate: false },
  };
}
function renderShell(props: ProfileShellProps) {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => { tree = TestRenderer.create(<ProfileShell {...props} />); });
  return tree;
}

beforeEach(() => { jest.clearAllMocks(); mockDockInset = 84; });

test('non-feed tabs have one list owner and measure docking from its header', () => {
  const props = makeProps();
  const tree = renderShell(props);
  expect(tree.root.findAllByType(ScrollView)).toHaveLength(0);
  expect(mockDock.mock.calls.at(-1)?.[0].scrollY).toBe(mockScrollPosition);
  expect(mockHeader.mock.calls.at(-1)?.[0]).toMatchObject({ placement: 'overlay', titleReveal: 'onDock' });
  expect(mockList.mock.calls.at(-1)?.[0]).toMatchObject({ stickyHeaderIndices: [0], stickyHeaderConfig: { offset: 84 }, onScroll: props.chrome.onScroll });
  expect(mockSticky.mock.calls.at(-1)?.[0].offset).toBe(84);
  const header = tree.root.findAllByType(View).find(node => typeof node.props.onLayout === 'function');
  act(() => { header!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 357 } } }); });
  expect(mockSticky.mock.calls.at(-1)?.[0].offset).toBe(84);
  act(() => tree.unmount());
});

test.each(['posts', 'media'] as const)('%s retains its own virtualized scroll owner', tab => {
  const props = makeProps(tab);
  const tree = renderShell(props);
  expect(mockList).not.toHaveBeenCalled();
  const tabs = mockTabs.mock.calls.at(-1)?.[0];
  expect(tabs.listOwnsScroll).toBe(true);
  expect(tabs.listHeaderComponent).toBeTruthy();
  expect(tabs.listStickyHeaderComponent).toBeTruthy();
  expect(tabs.listOnScroll).toBe(tab === 'media' ? props.chrome.onScroll : undefined);
  expect(tabs.listScrollRef).toBe(tab === 'media' ? props.chrome.assignScrollRef : undefined);
  act(() => tree.unmount());
});

test('a channel without media keeps its inline header and Bloom zero inset', () => {
  mockDockInset = 0;
  const tree = renderShell({ ...makeProps(), banner: null });
  expect(tree.root.findAllByProps({ testID: 'profile-banner' })).toHaveLength(0);
  expect(mockHeader.mock.calls.at(-1)?.[0].placement).toBe('inline');
  expect(mockList.mock.calls.at(-1)?.[0].stickyHeaderConfig).toEqual({ offset: 0 });
  act(() => tree.unmount());
});

test('a private feed uses the shell list instead of mounting another viewport', () => {
  const props = makeProps('posts');
  props.tabs.isPrivate = true;
  const tree = renderShell(props);
  expect(mockList).toHaveBeenCalled();
  expect(mockTabs.mock.calls.at(-1)?.[0].listOwnsScroll).toBeUndefined();
  act(() => tree.unmount());
});
