import { isValidElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { SidebarProps } from '@oxy.so/bloom/sidebar';
import { ProfileButton } from '@oxy.so/services/ui/client';

const mockSelectDestination = jest.fn();
const mockCloseDrawer = jest.fn();

jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: { text: '#000' } }) }));
jest.mock('@oxy.so/bloom/tab-pager', () => ({
  useTabPager: () => ({ selectDestination: mockSelectDestination }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: jest.fn() }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/services/ui/client', () => ({
  ProfileButton: () => null,
}));
jest.mock('@/assets/logo', () => ({ LogoIcon: () => null }));
jest.mock('@oxy.so/bloom/app-shell', () => ({
  useAppShell: () => ({ closeDrawer: mockCloseDrawer }),
}));

// The mocks above must be installed first.
import { useMentionSidebar } from '../useMentionSidebar';

let sidebar!: SidebarProps;
function Probe() {
  sidebar = useMentionSidebar();
  return null;
}

it('leaves the rows to the destinations and sends the logo Home through them', () => {
  act(() => {
    TestRenderer.create(<Probe />);
  });
  expect(sidebar.items).toBeUndefined();
  act(() => sidebar.logo?.onPress?.());
  expect(mockSelectDestination).toHaveBeenCalledWith('index');
});

it('closes the drawer before the Oxy shared add-account flow', () => {
  act(() => {
    TestRenderer.create(<Probe />);
  });
  const renderFooter = sidebar.footer;
  if (typeof renderFooter !== 'function') throw new Error('Expected a sidebar footer renderer');
  const renderedFooter = renderFooter({ collapsed: false });
  if (!isValidElement(renderedFooter)) throw new Error('Expected a sidebar footer element');
  let footer!: TestRenderer.ReactTestRenderer;
  act(() => {
    footer = TestRenderer.create(renderedFooter);
  });
  const profile = footer.root.findByType(ProfileButton);
  expect(profile.props.onAddAccount).toBeUndefined();
  act(() => profile.props.onBeforeAddAccount());
  expect(mockCloseDrawer).toHaveBeenCalledTimes(1);
  act(() => profile.props.onNavigateProfile());
  expect(mockCloseDrawer).toHaveBeenCalledTimes(2);
  expect(mockSelectDestination).toHaveBeenCalledWith('you');
});
