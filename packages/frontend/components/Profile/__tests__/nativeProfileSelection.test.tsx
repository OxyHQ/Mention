import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import ProfileScreen from '@/components/ProfileScreen';
import type { ProfileTabDescriptor } from '../types';

const mockReplace = jest.fn();
const mockPush = jest.fn();
jest.mock('@/lib/navigation/router', () => ({
  useRouter: () => ({ replace: mockReplace, push: mockPush }),
  Redirect: () => null,
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/bloom/tabs', () => {
  const React = require('react');
  return {
    Tabs: (props: Record<string, unknown>) =>
      React.createElement('ProfileTabStrip', { ...props, testID: 'profile-tab-strip' }),
    TabsTrigger: () => null,
  };
});
jest.mock('@/components/Profile', () => {
  const React = require('react');
  const descriptors: ProfileTabDescriptor[] = [
    { key: 'posts', tab: 'posts', label: 'Posts' },
    { key: 'replies', tab: 'replies', label: 'Replies' },
    { key: 'media', tab: 'media', label: 'Media' },
    { key: 'lane:lane-a', tab: 'posts', laneId: 'lane-a', label: 'Lane' },
  ];
  return {
    laneTabKey: (id: string) => `lane:${id}`,
    ProfileTabBarRow: ({ children }: { children: React.ReactNode }) => children,
    ProfileShell: ({ tabBar, tabs }: { tabBar: React.ReactNode; tabs: React.ReactNode }) =>
      React.createElement(React.Fragment, null, tabBar, tabs),
    usePersonProfileView: ({
      activeKey,
      onSelectTab,
      username,
    }: {
      activeKey: string;
      username: string;
      onSelectTab: (descriptor: ProfileTabDescriptor, href: string) => void;
    }) => ({
      activeDescriptor: descriptors.find((item) => item.key === activeKey),
      tabDescriptors: descriptors,
      tabs: React.createElement('SelectedProfileContent', {
        tabKey: activeKey,
        testID: 'selected-profile-content',
      }),
      selectTab: (key: string) => {
        const descriptor = descriptors.find((item) => item.key === key);
        if (!descriptor) throw new Error('Unknown fixture tab');
        const path = descriptor.laneId ? `lane/${descriptor.laneId}` : descriptor.tab;
        onSelectTab(descriptor, `/@${username}/${path}`);
      },
    }),
  };
});

let renderer: TestRenderer.ReactTestRenderer;
beforeEach(() => jest.clearAllMocks());
afterEach(() => {
  if (renderer) act(() => renderer.unmount());
});

it.each(['media', 'replies', 'lane:lane-a'])(
  'keeps root profile %s selection inside the retained tab instead of replacing the root stack',
  (key) => {
    act(() => {
      renderer = TestRenderer.create(<ProfileScreen username="reader" isRootTab />);
    });
    const strip = renderer.root.find((node) => node.props.testID === 'profile-tab-strip');
    act(() => strip.props.onValueChange(key));
    expect(
      renderer.root.find((node) => node.props.testID === 'selected-profile-content').props.tabKey,
    ).toBe(key);
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    // A parent tab focus update must not recreate this profile's local selection.
    act(() => renderer.update(<ProfileScreen username="reader" isRootTab />));
    expect(
      renderer.root.find((node) => node.props.testID === 'selected-profile-content').props.tabKey,
    ).toBe(key);
  },
);

it('keeps canonical URL replacement for a pushed profile without adding history for each internal tab', () => {
  act(() => {
    renderer = TestRenderer.create(<ProfileScreen username="other" />);
  });
  act(() =>
    renderer.root
      .find((node) => node.props.testID === 'profile-tab-strip')
      .props.onValueChange('media'),
  );
  expect(mockReplace).toHaveBeenCalledWith('/@other/media');
  expect(mockPush).not.toHaveBeenCalled();
});
