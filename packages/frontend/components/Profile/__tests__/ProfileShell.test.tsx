import React from 'react';
import { Animated, ScrollView, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { ProfileShell, type ProfileShellProps } from '../ProfileShell';
import { ProfileUnavailable } from '../ProfileUnavailable';

const mockScrollPosition = { value: 0 };
const mockHeader = jest.fn();
const mockTabs = jest.fn();
const mockList = jest.fn();
const mockDock = jest.fn();
const mockSticky = jest.fn();
const mockCover = jest.fn();
let mockDockInset = 84;

jest.mock('@oxy.so/bloom/styles', () => ({ useSurfaceFill: () => 'rgb(20, 55, 84)' }));
jest.mock('@oxy.so/bloom/layout', () => ({
  HeaderDockProvider: (props: { children: React.ReactNode }) => { mockDock(props); return props.children; },
  StickySection: (props: { children: React.ReactNode }) => { mockSticky(props); return props.children; },
  useHeaderDockInset: () => mockDockInset,
}));
jest.mock('@oxy.so/bloom/page-header', () => ({
  PageHeader: (props: object) => { mockHeader(props); return null; },
}));
jest.mock('@oxy.so/bloom/cover-header', () => ({
  CoverHeader: (props: { children: React.ReactNode }) => { mockCover(props); return props.children; },
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

type TabsProps = NonNullable<ProfileShellProps['tabs']>;
function makeProps(tab: TabsProps['tab'] = 'lists'): ProfileShellProps & { tabs: TabsProps } {
  return {
    chrome: {
      scrollY: new Animated.Value(0), scrollRef: { current: null }, onScroll: jest.fn(),
      assignScrollRef: jest.fn(), scrollToContent: jest.fn(), contentHeight: 0, setContentHeight: jest.fn(),
    },
    loading: false,
    notFound: false,
    onRetry: jest.fn(async () => undefined),
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
  // The strip's dock target is its Y in the list: the measured header block.
  // The header inset is the list's sticky clearance, not the strip's position.
  expect(mockSticky.mock.calls.at(-1)?.[0].offset).toBeUndefined();
  const header = tree.root.findAllByType(View).find(node => typeof node.props.onLayout === 'function');
  act(() => { header!.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 357 } } }); });
  expect(mockSticky.mock.calls.at(-1)?.[0].offset).toBe(357);
  expect(mockList.mock.calls.at(-1)?.[0].stickyHeaderConfig).toEqual({ offset: 84 });
  act(() => tree.unmount());
});

test.each(['posts', 'media'] as const)('%s retains its own virtualized scroll owner', tab => {
  const props = makeProps(tab);
  const tree = renderShell(props);
  expect(mockList).not.toHaveBeenCalled();
  const tabs = mockTabs.mock.calls.at(-1)?.[0];
  expect(tabs.listOwnsScroll).toBe(true);
  expect(tabs.listContentHeaderComponent).toBeTruthy();
  expect(tabs.listStickyHeaderComponent).toBeTruthy();
  expect(tabs.listOnScroll).toBe(tab === 'media' ? props.chrome.onScroll : undefined);
  expect(tabs.listScrollRef).toBe(tab === 'media' ? props.chrome.assignScrollRef : undefined);
  act(() => tree.unmount());
});

test('the summary rises into the banner through Bloom CoverHeader, and only there', () => {
  const props = makeProps();
  const tree = renderShell(props);
  expect(mockCover).toHaveBeenCalledTimes(1);
  expect(mockCover.mock.calls[0][0]).toMatchObject({
    testID: 'profile-hero',
    coverSource: 'https://example.com/banner.jpg',
    coverHeight: 170,
    overlap: 45,
    children: props.summary,
  });
  // No second mechanism: nothing in the shell moves the summary itself.
  for (const node of tree.root.findAllByType(View)) {
    const style = [node.props.style].flat(Infinity).filter(Boolean) as Record<string, unknown>[];
    expect(style.some(entry => 'transform' in entry || (typeof entry.marginTop === 'number' && entry.marginTop < 0))).toBe(false);
  }
  act(() => tree.unmount());
});

test('native paints the route in the surface the chrome paints, not the theme background', () => {
  const tree = renderShell(makeProps());
  const root = tree.root.findAllByType(View)[0];
  expect([root.props.style].flat()).toContainEqual({ backgroundColor: 'rgb(20, 55, 84)' });
  act(() => tree.unmount());
});

test('banner, summary and tabs are one block painted in the surface fill', () => {
  const tree = renderShell(makeProps());
  const header = tree.root.findAllByType(View).find(node => typeof node.props.onLayout === 'function');
  expect(header!.props.style).toMatchObject({ backgroundColor: 'rgb(20, 55, 84)' });
  act(() => tree.unmount());
});

test('a channel without media keeps its inline header and Bloom zero inset', () => {
  mockDockInset = 0;
  const tree = renderShell({ ...makeProps(), banner: null });
  expect(mockCover).not.toHaveBeenCalled();
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

// The `/you` tab is a ROOT tab. Bloom's PageHeader draws Back whenever it is
// handed `onBack`, so the shell withholds it there, while a pushed profile
// (`/@handle`) keeps its Back.
test('a pushed profile has Back; the root profile tab does not', () => {
  const pushed = renderShell(makeProps());
  expect(typeof mockHeader.mock.calls.at(-1)?.[0].onBack).toBe('function');
  act(() => pushed.unmount());

  mockHeader.mockClear();
  const rootTab = renderShell({ ...makeProps(), isRootTab: true });
  expect(mockHeader).toHaveBeenCalled();
  expect(mockHeader.mock.calls.at(-1)?.[0].onBack).toBeUndefined();
  act(() => rootTab.unmount());
});

test('with no profile, it says "not found" or offers a retry — whichever the lookup answered', () => {
  const onRetry = jest.fn(async () => undefined);
  const missing = renderShell({ ...makeProps(), profileData: null, notFound: true, onRetry });
  expect(missing.root.findByType(ProfileUnavailable).props).toMatchObject({ notFound: true, onRetry });
  act(() => missing.unmount());

  const failed = renderShell({ ...makeProps(), profileData: null, notFound: false, onRetry });
  expect(failed.root.findByType(ProfileUnavailable).props.notFound).toBe(false);
  act(() => failed.unmount());

  const loading = renderShell({ ...makeProps(), loading: true, profileData: null, notFound: false, onRetry });
  expect(loading.root.findAllByType(ProfileUnavailable)).toHaveLength(0);
  act(() => loading.unmount());
});

