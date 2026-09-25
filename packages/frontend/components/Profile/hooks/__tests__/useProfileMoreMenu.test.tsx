import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ActionMenuAction } from '@/components/common/actionMenuGroups';
import type { ProfileData } from '@/hooks/useProfileData';
import { useProfileMoreMenu, type ProfileMoreMenuOptions } from '../useProfileMoreMenu';

/**
 * Which rows the profile "…" menu offers, and whether it exists at all.
 *
 * Signed out, every shared row (lists, starter packs, mute, block, report) is a
 * write on the viewer's own account and could only answer 401 (#1126), so none
 * is offered — and with nothing left, the hook returns `null` so neither
 * profile screen renders a "…" that opens an empty sheet.
 */

let mockAuth = { canUsePrivateApi: true, oxyServices: { blockUser: jest.fn() } };
jest.mock('@oxy.so/services/ui/client', () => ({ useAuth: () => mockAuth }));

const mockShowActionMenu = jest.fn();
jest.mock('@/components/common/ActionMenu', () => ({
  showActionMenu: (...args: unknown[]) => mockShowActionMenu(...args),
}));

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
    BottomSheetContext: createContext({ setBottomSheetContent: jest.fn(), openBottomSheet: jest.fn() }),
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
const channelSettings: ActionMenuAction = { icon: null, label: 'Channel settings', onPress: jest.fn() };

let latest: (() => void) | null = null;
function Probe(props: Omit<ProfileMoreMenuOptions, 'profileData'>) {
  latest = useProfileMoreMenu({ profileData, ...props });
  return null;
}

async function render(props: Omit<ProfileMoreMenuOptions, 'profileData'>) {
  await act(async () => {
    TestRenderer.create(<Probe {...props} />);
  });
  return latest;
}

function openedLabels(open: (() => void) | null): string[][] {
  expect(open).not.toBeNull();
  act(() => open?.());
  const { groups } = mockShowActionMenu.mock.calls.at(-1)?.[0] as { groups: ActionMenuAction[][] };
  return groups.map((group) => group.map((action) => String(action.label)));
}

beforeEach(() => {
  mockShowActionMenu.mockClear();
  mockAuth = { canUsePrivateApi: true, oxyServices: { blockUser: jest.fn() } };
});

describe('useProfileMoreMenu', () => {
  it("offers a signed-in reader lists, starter packs, mute, block and report on someone else's profile", async () => {
    const open = await render({ viewerOperatesAccount: false });
    expect(openedLabels(open)).toEqual([
      ['lists.addTo.menuItem', 'starterPacks.addTo.menuItem', 'profile.muteUser'],
      ['profile.blockUser', 'profile.reportUser'],
    ]);
  });

  it('keeps curation but withholds mute, block and report from an operator', async () => {
    const open = await render({ viewerOperatesAccount: true, leadingActions: [channelSettings] });
    expect(openedLabels(open)).toEqual([
      ['Channel settings', 'lists.addTo.menuItem', 'starterPacks.addTo.menuItem'],
      [],
    ]);
  });

  it('gives a signed-out reader no menu at all', async () => {
    mockAuth = { ...mockAuth, canUsePrivateApi: false };
    expect(await render({ viewerOperatesAccount: false })).toBeNull();
    expect(mockShowActionMenu).not.toHaveBeenCalled();
  });

  it('signed out, keeps only rows the caller supplied, never the viewer-account ones', async () => {
    mockAuth = { ...mockAuth, canUsePrivateApi: false };
    const open = await render({ viewerOperatesAccount: false, leadingActions: [channelSettings] });
    expect(openedLabels(open)).toEqual([['Channel settings'], []]);
  });
});
