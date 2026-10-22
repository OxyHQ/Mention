import TestRenderer, { act } from 'react-test-renderer';
import { Text } from 'react-native';
import { DropdownMenuItem } from '@oxy.so/bloom/dropdown-menu';
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

let mockAuth = { canUsePrivateApi: true, oxyServices: { blockUser: jest.fn() } };
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockAuth }));

jest.mock('@oxy.so/bloom/toast', () => ({ toast: jest.fn() }));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: { error: '#f00' } }) }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
// The sheets the rows open are never rendered here; stubbing them keeps their
// service graphs out of the test.
jest.mock('@/context/BottomSheetContext', () => {
  const { createContext } = jest.requireActual('react');
  return {
    BottomSheetContext: createContext({
      setBottomSheetContent: jest.fn(),
      openBottomSheet: jest.fn(),
    }),
  };
});
jest.mock('@/components/report/ReportModal', () => ({ ReportModal: () => null }));
jest.mock('@/components/Lists/AddToListSheet', () => ({ AddToListSheet: () => null }));
jest.mock('@/components/AddToStarterPackSheet', () => ({ AddToStarterPackSheet: () => null }));
jest.mock('@/services/muteService', () => ({ muteService: { muteUser: jest.fn() } }));
jest.mock('@/services/privacyService', () => ({ refreshPrivacyLists: jest.fn() }));
jest.mock('@/services/reportService', () => ({ reportService: { reportUser: jest.fn() } }));
jest.mock('@/utils/alerts', () => ({ confirmDialog: jest.fn() }));

const profileData = { id: 'u1', username: 'ana' } as ProfileData;
const channelSettings = <DropdownMenuItem>Channel settings</DropdownMenuItem>;

/** The labels of the menu's rows, or `null` when the component renders nothing. */
async function render(props: Omit<ProfileMoreMenuProps, 'profileData' | 'children'>) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <ProfileMoreMenu profileData={profileData} {...props}>
        <Text>more</Text>
      </ProfileMoreMenu>,
    );
  });
  if (renderer.toJSON() === null) return null;
  return renderer.root
    .findAll((node) => node.type === Text && node.props.accessibilityRole === 'menuitem')
    .map((node) => String(node.props.children));
}

beforeEach(() => {
  mockAuth = { canUsePrivateApi: true, oxyServices: { blockUser: jest.fn() } };
});

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
    mockAuth = { ...mockAuth, canUsePrivateApi: false };
    expect(await render({ viewerOperatesAccount: false })).toBeNull();
  });

  it('signed out, keeps only rows the caller supplied, never the viewer-account ones', async () => {
    mockAuth = { ...mockAuth, canUsePrivateApi: false };
    expect(await render({ viewerOperatesAccount: false, leadingItems: channelSettings })).toEqual([
      'Channel settings',
    ]);
  });
});
