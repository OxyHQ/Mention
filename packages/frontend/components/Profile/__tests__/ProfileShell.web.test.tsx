import React from 'react';
import { Animated, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { ProfileShell, type ProfileShellProps } from '../ProfileShell';

const mockScrollPosition = { value: 0 };
const mockHeader = jest.fn();
const mockTabs = jest.fn();
const mockList = jest.fn();
const mockDock = jest.fn();
const mockSticky = jest.fn();
const mockCover = jest.fn();
let mockDockInset = 84;

// The shell decides its branch from `Platform.OS` at module load.
jest.mock('@oxy.so/bloom/styles', () => ({ useSurfaceFill: () => 'rgb(20, 55, 84)' }));
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return Object.defineProperty(Object.create(actual), 'Platform', {
    value: {
      ...actual.Platform,
      OS: 'web',
      select: (spec: Record<string, unknown>) => spec.web ?? spec.default,
    },
  });
});
jest.mock('@oxy.so/bloom/layout', () => ({
  HeaderDockProvider: (props: { children: React.ReactNode }) => {
    mockDock(props);
    return props.children;
  },
  StickySection: (props: { children: React.ReactNode }) => {
    mockSticky(props);
    return props.children;
  },
  useHeaderDockInset: () => mockDockInset,
}));
jest.mock('@oxy.so/bloom/page-header', () => ({
  PageHeader: (props: object) => {
    mockHeader(props);
    return null;
  },
}));
jest.mock('@oxy.so/bloom/cover-header', () => ({
  CoverHeader: (props: { children: React.ReactNode }) => {
    mockCover(props);
    return props.children;
  },
}));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ isDark: false }) }));
jest.mock('@/context/LayoutScrollContext', () => ({
  useLayoutScroll: () => ({ scrollPosition: mockScrollPosition }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options: { defaultValue: string }) => options.defaultValue,
  }),
}));
jest.mock('@/hooks/useSafeBack', () => ({ useSafeBack: () => jest.fn() }));
jest.mock('@/components/UserName', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/common/EmptyState', () => ({ EmptyState: () => null }));
jest.mock('@/assets/illustrations/NoUpdates', () => ({ NoUpdatesIllustration: () => null }));
jest.mock('../ProfileSkeleton', () => ({ ProfileSkeleton: () => null }));
jest.mock('../ProfileTabs', () => ({
  ProfileTabs: (props: {
    listHeaderComponent?: React.ReactNode;
    listStickyHeaderComponent?: React.ReactNode;
  }) => {
    mockTabs(props);
    return (
      <>
        {props.listHeaderComponent}
        {props.listStickyHeaderComponent}
      </>
    );
  },
}));
jest.mock('@shopify/flash-list', () => {
  const React_ = require('react') as typeof React;
  type MockProps = {
    ListHeaderComponent?: React.ReactNode;
    data: readonly string[];
    renderItem: (info: { item: string }) => React.ReactNode;
  };
  return {
    FlashList: React_.forwardRef<unknown, MockProps>((props, _ref) => {
      mockList(props);
      return (
        <>
          {props.ListHeaderComponent}
          {props.data.map((item) => (
            <React_.Fragment key={item}>{props.renderItem({ item })}</React_.Fragment>
          ))}
        </>
      );
    }),
  };
});

type TabsProps = NonNullable<ProfileShellProps['tabs']>;
function makeProps(tab: TabsProps['tab'] = 'lists'): ProfileShellProps & { tabs: TabsProps } {
  return {
    chrome: {
      scrollY: new Animated.Value(0),
      scrollRef: { current: null },
      onScroll: jest.fn(),
      assignScrollRef: jest.fn(),
      scrollToContent: jest.fn(),
      contentHeight: 0,
      setContentHeight: jest.fn(),
    },
    loading: false,
    notFound: false,
    onRetry: jest.fn(async () => undefined),
    profileData: {
      id: 'person',
      username: 'person',
      name: { displayName: 'Person' },
      design: { displayName: 'Person' },
    },
    banner: { uri: 'https://example.com/banner.jpg' },
    headerActions: null,
    summary: <Text>Profile summary</Text>,
    tabBar: <Text>Profile tabs</Text>,
    tabs: { tab, profileId: 'person', isOwnProfile: false, isPrivate: false },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDockInset = 84;
});

const navigator = <Text testID="navigator">Slot</Text>;
function webProps(): ProfileShellProps {
  const { tabs: _tabs, ...base } = makeProps();
  return base;
}

test('the navigator keeps ONE tree position through every state', () => {
  const base = webProps();
  const states: Partial<ProfileShellProps>[] = [
    { loading: true, profileData: null },
    { loading: false, profileData: null, notFound: true },
    {},
    { active: false },
    {},
  ];
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <ProfileShell {...base} {...states[0]}>
        {navigator}
      </ProfileShell>,
    );
  });
  const first = tree.root.findByProps({ testID: 'navigator' });
  for (const state of states.slice(1)) {
    act(() =>
      tree.update(
        <ProfileShell {...base} {...state}>
          {navigator}
        </ProfileShell>,
      ),
    );
    // Same instance: React kept it mounted rather than rebuilding it.
    expect(tree.root.findByProps({ testID: 'navigator' })).toBe(first);
  }
  expect(mockTabs).not.toHaveBeenCalled();
  act(() => tree.unmount());
});

test('web paints the header block, and leaves the page and the feed to the content panel', () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<ProfileShell {...webProps()}>{navigator}</ProfileShell>);
  });
  const [root, header] = tree.root.findAllByType(View);
  expect(root.props.style).toBeUndefined();
  expect(header.props.style).toMatchObject({ backgroundColor: 'rgb(20, 55, 84)' });
  act(() => tree.unmount());
});

test('inactive, it draws no chrome at all', () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <ProfileShell {...webProps()} active={false}>
        {navigator}
      </ProfileShell>,
    );
  });
  expect(mockHeader).not.toHaveBeenCalled();
  expect(mockCover).not.toHaveBeenCalled();
  expect(mockSticky).not.toHaveBeenCalled();
  act(() => tree.unmount());
});

test('ready, it draws the same chrome as native around the navigator', () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<ProfileShell {...webProps()}>{navigator}</ProfileShell>);
  });
  expect(mockHeader.mock.calls.at(-1)?.[0]).toMatchObject({ placement: 'overlap' });
  expect(mockCover.mock.calls.at(-1)?.[0]).toMatchObject({
    testID: 'profile-hero',
    coverHeight: 170,
    overlap: 45,
  });
  expect(mockSticky).toHaveBeenCalled();
  expect(mockList).not.toHaveBeenCalled();
  act(() => tree.unmount());
});

test('without children (a channel on web), it renders the tabs itself', () => {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(<ProfileShell {...makeProps()} banner={null} />);
  });
  expect(mockTabs).toHaveBeenCalled();
  expect(mockCover).not.toHaveBeenCalled();
  act(() => tree.unmount());
});
