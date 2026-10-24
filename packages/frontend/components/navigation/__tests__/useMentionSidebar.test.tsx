import TestRenderer, { act } from 'react-test-renderer';
import type { SidebarProps } from '@oxy.so/bloom/sidebar';

const mockSelectDestination = jest.fn();

jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: { text: '#000' } }) }));
jest.mock('@oxy.so/bloom/tab-pager', () => ({
  useTabPager: () => ({ selectDestination: mockSelectDestination }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ navigate: jest.fn() }) }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ signIn: jest.fn() }),
  ProfileButton: () => null,
}));
jest.mock('@/assets/logo', () => ({ LogoIcon: () => null }));
jest.mock('@oxy.so/bloom/app-shell', () => ({ useAppShell: () => ({ closeDrawer: jest.fn() }) }));

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
