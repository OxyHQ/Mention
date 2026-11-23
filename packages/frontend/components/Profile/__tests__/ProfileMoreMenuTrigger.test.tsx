import type React from 'react';
import type { TFunction } from 'i18next';
import TestRenderer, { act } from 'react-test-renderer';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';
import { RiMoreFill } from '@oxy.so/bloom/icons/RiMoreFill';
import { Button, Icon, toElement } from '@oxy.so/bloom-language';
import type { ProfileData } from '@/hooks/useProfileData';
import { ProfileMoreMenu } from '../ProfileMoreMenu';

/**
 * The profile's "…" opens its menu when the language draws the button.
 *
 * The menu's trigger slot (`asChild`) hands its child the press that opens the
 * menu and its expanded state, by cloning it. A button placed with `toElement`
 * sits under the language's own boundary, which takes neither, so the tap once
 * did nothing on the device; the language's `Menu` draws its trigger as the
 * slot's own child, so the slot reaches Bloom's button itself.
 *
 * Bloom's dropdown menu does not load under Jest (see
 * `test-support/bloomDropdownMenu.js`), so the trigger here clones its child as
 * Bloom's `TriggerSlot` does (the press opens the menu, `aria-expanded` says so),
 * and the root is controlled as Bloom's is when given `open` and `onOpenChange`.
 */
/** Whether the menu is open, and its setter. */
type MockOpenState = [boolean, (open: boolean) => void];

jest.mock('@oxy.so/bloom/dropdown-menu', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const { Text, View } = jest.requireActual<typeof import('react-native')>('react-native');
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
      const [open, setOpen] = R.useContext(Open);
      return R.cloneElement(R.Children.only(children), {
        onPress: () => setOpen(true),
        'aria-expanded': open,
      } as object);
    },
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => {
      const [open] = R.useContext(Open);
      return open ? R.createElement(View, null, children) : null;
    },
    DropdownMenuSeparator: () => null,
    DropdownMenuItem: ({ children }: { children: React.ReactNode }) =>
      R.createElement(Text, { accessibilityRole: 'menuitem' }, children),
  };
});

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ canUsePrivateApi: true, oxyServices: {}, user: { id: 'me' } }),
}));
jest.mock('@oxy.so/bloom/toast', () => ({ toast: jest.fn() }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('@/utils/sheet', () => ({ presentSheet: jest.fn() }));
jest.mock('@/components/report/ReportModal', () => ({ ReportModal: () => null }));
jest.mock('@/components/Lists/AddToListSheet', () => ({ AddToListSheet: () => null }));
jest.mock('@/components/AddToStarterPackSheet', () => ({ AddToStarterPackSheet: () => null }));
jest.mock('@/services/muteService', () => ({ muteService: { muteUser: jest.fn() } }));
jest.mock('@/services/privacyService', () => ({ refreshPrivacyLists: jest.fn() }));
jest.mock('@/services/reportService', () => ({ reportService: { reportUser: jest.fn() } }));
jest.mock('@/utils/alerts', () => ({ confirmDialog: jest.fn() }));

const profileData = { id: 'u1', username: 'ana' } as ProfileData;

/** The pressable host Bloom's button draws, named by the chain's label. */
function trigger(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(
    (node) =>
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === 'More' &&
      typeof node.props.onPress === 'function' &&
      String(node.type).includes('Pressable'),
  );
}

function rows(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => String(node.type) === 'Text' && node.props.accessibilityRole === 'menuitem')
    .flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'));
}

it('opens the menu from a button the language draws', async () => {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <BloomThemeProvider fonts={false}>
        {toElement(
          ProfileMoreMenu(Button(Icon(RiMoreFill)).shape('circle').label('More'), {
            profileData,
            viewerOperatesAccount: false,
            canUsePrivateApi: true,
            t: ((key: string) => key) as unknown as TFunction,
          }),
        )}
      </BloomThemeProvider>,
    );
  });
  expect(rows(renderer)).toEqual([]);
  await act(async () => {
    trigger(renderer).props.onPress({ defaultPrevented: false });
  });
  expect(rows(renderer)).toEqual([
    'lists.addTo.menuItem',
    'starterPacks.addTo.menuItem',
    'profile.muteUser',
    'profile.blockUser',
    'profile.reportUser',
  ]);
});
