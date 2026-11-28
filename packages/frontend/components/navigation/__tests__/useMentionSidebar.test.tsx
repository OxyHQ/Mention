import { isValidElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { SidebarProps } from '@oxy.so/bloom/sidebar';
import { ProfileButton } from '@oxy.so/services/ui/client';

const mockSelectDestination = jest.fn();
const mockCloseDrawer = jest.fn();
const mockSignIn = jest.fn(() => Promise.resolve());
const mockOpenAccountDialog = jest.fn();
const mockAuth = {
  isAuthenticated: true,
  isAuthResolved: true,
  signIn: () => mockSignIn(),
};

jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: { text: '#000' } }) }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: 'Button' }));
jest.mock('@oxy.so/bloom/tab-pager', () => ({
  useTabPager: () => ({ selectDestination: mockSelectDestination }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: jest.fn() }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/services/ui/client', () => ({
  ProfileButton: () => null,
  useAuth: () => mockAuth,
  useOxy: () => ({ openAccountDialog: mockOpenAccountDialog }),
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

beforeEach(() => {
  mockAuth.isAuthenticated = true;
  mockAuth.isAuthResolved = true;
  mockCloseDrawer.mockClear();
  mockSignIn.mockClear();
  mockOpenAccountDialog.mockClear();
  mockSelectDestination.mockClear();
});

function renderFooter(collapsed: boolean) {
  act(() => {
    TestRenderer.create(<Probe />);
  });
  const renderFooterProp = sidebar.footer;
  if (typeof renderFooterProp !== 'function') throw new Error('Expected a sidebar footer renderer');
  const renderedFooter = renderFooterProp({ collapsed });
  if (!isValidElement(renderedFooter)) throw new Error('Expected a sidebar footer element');
  let footer!: TestRenderer.ReactTestRenderer;
  act(() => {
    footer = TestRenderer.create(renderedFooter);
  });
  return footer;
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
  const footer = renderFooter(false);
  const profile = footer.root.findByType(ProfileButton);
  expect(profile.props.onAddAccount).toBeUndefined();
  act(() => profile.props.onBeforeAddAccount());
  expect(mockCloseDrawer).toHaveBeenCalledTimes(1);
  act(() => profile.props.onNavigateProfile());
  expect(mockCloseDrawer).toHaveBeenCalledTimes(2);
  expect(mockSelectDestination).toHaveBeenCalledWith('you');
});

it('offers create account first and sign in second when signed out', () => {
  mockAuth.isAuthenticated = false;
  const footer = renderFooter(false);
  expect(footer.root.findAllByType(ProfileButton)).toHaveLength(0);
  const buttons = footer.root.findAllByType('Button' as never);
  expect(buttons.map((button) => button.props.children)).toEqual([
    'auth.banner.createAccount',
    'auth.banner.signIn',
  ]);
  act(() => buttons[0]?.props.onPress());
  expect(mockCloseDrawer).toHaveBeenCalledTimes(1);
  expect(mockOpenAccountDialog).toHaveBeenCalledWith('signup');
  expect(mockSignIn).not.toHaveBeenCalled();
  act(() => buttons[1]?.props.onPress());
  expect(mockCloseDrawer).toHaveBeenCalledTimes(2);
  expect(mockSignIn).toHaveBeenCalledTimes(1);
});

it('keeps both account actions when the signed-out sidebar is collapsed', () => {
  mockAuth.isAuthenticated = false;
  const footer = renderFooter(true);
  const buttons = footer.root.findAllByType('Button' as never);
  expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual([
    'auth.banner.createAccount',
    'auth.banner.signIn',
  ]);
  act(() => buttons[0]?.props.onPress());
  expect(mockOpenAccountDialog).toHaveBeenCalledWith('signup');
});
