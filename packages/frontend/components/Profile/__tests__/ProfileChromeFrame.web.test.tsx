import type React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * The web `[username]` layout draws no chrome of its own: it feeds
 * `ProfileShell` (the chrome native and channels use too) and hands it the
 * route's navigator as `children`. These pin what the frame decides on the way
 * in. It turns the pathname into active or inactive, the view into loading, and
 * the strip's reselect into the jump the stats row makes.
 */

let mockPathname = '/@nate';
const mockPush = jest.fn();
const mockShell = jest.fn();
const mockTabs = jest.fn();
const mockViewArgs = jest.fn();
const mockScrollToContent = jest.fn();
let mockView: Record<string, unknown>;

jest.mock('expo-router', () => ({
  router: { push: (href: string) => mockPush(href) },
  usePathname: () => mockPathname,
}));
jest.mock('@oxy.so/bloom/theme', () => ({
  BloomColorScope: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@oxy.so/bloom/tabs/expo-router', () => ({
  RouterTabs: (props: object) => {
    mockTabs(props);
    return null;
  },
}));
jest.mock('../ProfileShell', () => ({
  ProfileShell: (props: { children?: React.ReactNode; tabBar?: React.ReactNode }) => {
    mockShell(props);
    return (
      <>
        {props.tabBar}
        {props.children}
      </>
    );
  },
}));
jest.mock('../ProfileTabBarRow', () => ({
  ProfileTabBarRow: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../ProfilePageHeader', () => ({
  profileTabsOffset: (height: number) => 125 + height,
}));
jest.mock('../hooks/useRoutedProfileUsername', () => ({ useRoutedProfileUsername: () => 'nate' }));
jest.mock('../hooks/usePersonProfileView', () => ({
  usePersonProfileView: (args: object) => {
    mockViewArgs(args);
    return mockView;
  },
}));

import ProfileChromeFrame from '../ProfileChromeFrame.web';

function makeView(overrides: Record<string, unknown> = {}) {
  return {
    loading: false,
    canonicalHref: null,
    profileData: { id: 'nate' },
    notFound: false,
    refresh: jest.fn(),
    bannerUri: 'https://example.com/banner.jpg',
    headerActions: null,
    summary: <Text>summary</Text>,
    seo: null,
    colorName: 'teal',
    isOwnProfile: false,
    handle: 'nate',
    tabDescriptors: [
      { key: 'posts', tab: 'posts', label: 'Posts' },
      { key: 'media', tab: 'media', label: 'Media' },
    ],
    chrome: { contentHeight: 255, scrollToContent: mockScrollToContent },
    ...overrides,
  };
}

function render() {
  let tree!: TestRenderer.ReactTestRenderer;
  act(() => {
    tree = TestRenderer.create(
      <ProfileChromeFrame>
        <Text testID="navigator">Slot</Text>
      </ProfileChromeFrame>,
    );
  });
  return tree;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPathname = '/@nate';
  mockView = makeView();
});

test('a tab route draws the shared shell, with the navigator as its content', () => {
  const tree = render();
  const shell = mockShell.mock.calls.at(-1)?.[0];
  expect(shell).toMatchObject({
    active: true,
    loading: false,
    banner: { uri: 'https://example.com/banner.jpg' },
  });
  expect(tree.root.findByProps({ testID: 'navigator' })).toBeTruthy();
  expect(mockViewArgs.mock.calls.at(-1)?.[0]).toMatchObject({
    active: true,
    activeKey: 'posts',
    username: 'nate',
  });
  expect(mockTabs.mock.calls.at(-1)?.[0].items).toEqual([
    { value: 'posts', label: 'Posts', href: '/@nate' },
    { value: 'media', label: 'Media', href: '/@nate/media' },
  ]);
  act(() => tree.unmount());
});

test('a sibling route (/followers) turns the chrome off but keeps the navigator', () => {
  mockPathname = '/@nate/followers';
  const tree = render();
  expect(mockShell.mock.calls.at(-1)?.[0].active).toBe(false);
  expect(tree.root.findByProps({ testID: 'navigator' })).toBeTruthy();
  act(() => tree.unmount());
});

test('a wrong-family URL holds the skeleton while the screen redirects', () => {
  mockView = makeView({ canonicalHref: '/c/nate' });
  const tree = render();
  expect(mockShell.mock.calls.at(-1)?.[0].loading).toBe(true);
  act(() => tree.unmount());
});

test('re-selecting the active tab jumps to where the strip starts, overlap included', () => {
  const tree = render();
  act(() => {
    mockTabs.mock.calls.at(-1)?.[0].onReselect();
  });
  expect(mockScrollToContent).toHaveBeenCalledWith(125 + 255);
  act(() => tree.unmount());
});

test('the stats row jumps to another tab by pushing its route', () => {
  const tree = render();
  const { onSelectTab } = mockViewArgs.mock.calls.at(-1)?.[0] as {
    onSelectTab: (d: object, href: string) => void;
  };
  act(() => onSelectTab({ key: 'media' }, '/@nate/media'));
  expect(mockPush).toHaveBeenCalledWith('/@nate/media');
  act(() => tree.unmount());
});
