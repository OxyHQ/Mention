import TestRenderer, { act } from 'react-test-renderer';
import type { SidebarProps } from '@oxy.so/bloom/sidebar';

const mockNavigateOrReselect = jest.fn();
const mockClose = jest.fn();
const mockOpenSettings = jest.fn();

jest.mock('expo-router', () => ({
  usePathname: () => '/',
  useRouter: () => ({ push: jest.fn(), navigate: jest.fn() }),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/bloom/avatar', () => ({ Avatar: () => null }));
jest.mock('@oxy.so/services', () => ({ ProfileButton: () => null }));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: { id: 'viewer', username: 'nate' }, signIn: jest.fn() }),
}));
jest.mock('@/components/Profile/profileRoute', () => ({
  profileHrefForUser: (user: { username: string }) => `/@${user.username}`,
}));
jest.mock('@/hooks/useUnreadCount', () => ({ useUnreadCount: () => 0 }));
jest.mock('@/assets/logo', () => ({ LogoIcon: () => null }));
jest.mock('@/context/MentionSettingsContext', () => ({
  useMentionSettings: () => ({ open: mockOpenSettings }),
}));
jest.mock('@/context/DrawerContext', () => ({ useDrawer: () => ({ close: mockClose }) }));
const mockAskAlia = jest.fn();
jest.mock('@/context/AskAliaContext', () => ({ useAskAlia: () => ({ open: mockAskAlia }) }));
jest.mock('@/hooks/useNavigateOrReselect', () => ({
  useNavigateOrReselect: () => mockNavigateOrReselect,
}));

// The mocks above must be installed first.
import { useMentionSidebar } from '../useMentionSidebar';

let sidebar!: SidebarProps;
function Probe() {
  sidebar = useMentionSidebar();
  return null;
}

beforeEach(() => {
  jest.clearAllMocks();
  act(() => {
    TestRenderer.create(<Probe />);
  });
});

it('sends every destination row through navigate-or-reselect, after closing the drawer', () => {
  const home = sidebar.items?.find((item) => item.key === '/');
  act(() => home?.onPress?.());
  expect(mockClose).toHaveBeenCalled();
  expect(mockNavigateOrReselect).toHaveBeenCalledWith('/');
});

it('sends the profile row to the viewer’s own profile the same way', () => {
  const profile = sidebar.items?.find((item) => item.key === 'sidebar.profile');
  act(() => profile?.onPress?.());
  expect(mockNavigateOrReselect).toHaveBeenCalledWith('/@nate');
});

it('treats the logo as the Home link', () => {
  act(() => sidebar.logo?.onPress?.());
  expect(mockNavigateOrReselect).toHaveBeenCalledWith('/');
});

it('opens the Alia sheet from Ask Alia, closing the drawer and navigating nowhere', () => {
  const askAlia = sidebar.items?.find((item) => item.key === 'sidebar.askAlia');
  expect(askAlia?.href).toBeUndefined();
  act(() => askAlia?.onPress?.());
  expect(mockClose).toHaveBeenCalled();
  expect(mockAskAlia).toHaveBeenCalled();
  expect(mockNavigateOrReselect).not.toHaveBeenCalled();
});

it('keeps settings a sheet, not a page to reselect', () => {
  const settings = sidebar.items?.find((item) => item.key === '/settings');
  act(() => settings?.onPress?.());
  expect(mockOpenSettings).toHaveBeenCalled();
  expect(mockNavigateOrReselect).not.toHaveBeenCalled();
});
