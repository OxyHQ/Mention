import type React from 'react';
import type { TFunction } from 'i18next';
import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';
import { Item, Text as LText, toElement } from '@oxy.so/bloom-language';
import type { ProfileData } from '@/hooks/useProfileData';
import { ProfileMoreMenu, type ProfileMoreMenuProps } from '../ProfileMoreMenu';

/**
 * Which rows the profile "…" menu offers, and whether it exists at all.
 *
 * Signed out, every shared row (lists, starter packs, mute, block, report) is a
 * write on the viewer's own account and could only answer 401 (#1126), so none
 * is offered — and with nothing left, the menu renders nothing so neither
 * profile screen renders a "…" that opens an empty menu.
 */

/** Whether the menu is open, and its setter. */
type MockOpenState = [boolean, (open: boolean) => void];

// Bloom's menu, controlled as the language's menu holds it (`open`, `onOpenChange`): the
// trigger's press opens it, and its rows are read once it is open.
jest.mock('@oxy.so/bloom/dropdown-menu', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const { Text: RNText, View } = jest.requireActual<typeof import('react-native')>('react-native');
  const Open = R.createContext<MockOpenState>([false, () => {}]);
  return {
    DropdownMenu: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children: React.ReactNode;
    }) => R.createElement(Open.Provider, { value: [open, onOpenChange] }, children),
    DropdownMenuTrigger: ({ children }: { children: React.ReactElement }) => {
      const [, setOpen] = R.useContext(Open);
      return R.cloneElement(R.Children.only(children), { onPress: () => setOpen(true) } as object);
    },
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
      R.createElement(View, null, children),
    DropdownMenuSeparator: () => null,
    DropdownMenuItem: ({ children }: { children: React.ReactNode }) =>
      R.createElement(RNText, { accessibilityRole: 'menuitem' }, children),
  };
});

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ oxyServices: { blockUser: jest.fn() }, user: { id: 'me' } }),
}));

jest.mock('@oxy.so/bloom/toast', () => ({ toast: jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
// The sheets the rows open are never rendered here; stubbing them keeps their
// service graphs out of the test.
jest.mock('@/utils/sheet', () => ({ presentSheet: jest.fn() }));
jest.mock('@/components/report/ReportModal', () => ({ ReportModal: () => null }));
jest.mock('@/components/Lists/AddToListSheet', () => ({ AddToListSheet: () => null }));
jest.mock('@/components/AddToStarterPackSheet', () => ({ AddToStarterPackSheet: () => null }));
jest.mock('@/services/muteService', () => ({ muteService: { muteUser: jest.fn() } }));
jest.mock('@/services/privacyService', () => ({ refreshPrivacyLists: jest.fn() }));
jest.mock('@/services/reportService', () => ({ reportService: { reportUser: jest.fn() } }));
jest.mock('@/utils/alerts', () => ({ confirmDialog: jest.fn() }));

const profileData = { id: 'u1', username: 'ana' } as ProfileData;
const channelSettings = [Item('Channel settings')];
const t = ((key: string) => key) as unknown as TFunction;

type Options = Omit<ProfileMoreMenuProps, 'profileData' | 't' | 'canUsePrivateApi'> & {
  canUsePrivateApi?: boolean;
};

/** The labels of the menu's rows once its trigger opens it, or `null` when there is no menu. */
async function render({ canUsePrivateApi = true, ...props }: Options) {
  const menu = ProfileMoreMenu(LText('more'), { profileData, canUsePrivateApi, t, ...props });
  if (menu === null) return null;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <BloomThemeProvider fonts={false}>{toElement(menu)}</BloomThemeProvider>,
    );
  });
  await act(async () => {
    renderer.root.find((node) => node.type === Text && node.props.onPress).props.onPress();
  });
  return renderer.root
    .findAll((node) => node.type === Text && node.props.accessibilityRole === 'menuitem')
    .map((node) => String(node.props.children));
}

describe('ProfileMoreMenu', () => {
  it("offers a signed-in reader lists, starter packs, mute, block and report on someone else's profile", async () => {
    expect(await render({ viewerOperatesAccount: false })).toEqual([
      'lists.addTo.menuItem',
      'starterPacks.addTo.menuItem',
      'profile.muteUser',
      'profile.blockUser',
      'profile.reportUser',
    ]);
  });

  it('keeps curation but withholds mute, block and report from an operator', async () => {
    expect(await render({ viewerOperatesAccount: true, leadingItems: channelSettings })).toEqual([
      'Channel settings',
      'lists.addTo.menuItem',
      'starterPacks.addTo.menuItem',
    ]);
  });

  it('gives a signed-out reader no menu at all', async () => {
    expect(await render({ viewerOperatesAccount: false, canUsePrivateApi: false })).toBeNull();
  });

  it('signed out, keeps only rows the caller supplied, never the viewer-account ones', async () => {
    expect(
      await render({
        viewerOperatesAccount: false,
        canUsePrivateApi: false,
        leadingItems: channelSettings,
      }),
    ).toEqual(['Channel settings']);
  });
});
