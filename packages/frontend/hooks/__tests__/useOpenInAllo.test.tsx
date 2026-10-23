import TestRenderer, { act } from 'react-test-renderer';
import { Linking, Platform } from 'react-native';
import type { ActionMenuAction } from '@/components/common/actionMenuGroups';
import { useOpenInAllo } from '../useOpenInAllo';

/**
 * Binds `@oxy.so/allo-sdk/links` (whose own tests cover which URL opens when)
 * to the platform: `Linking` for the app scheme, `openExternalLink` for the web
 * app, and the app's action menu for the "not installed" offer.
 */

const mockShowActionMenu = jest.fn();
jest.mock('@/components/common/ActionMenu', () => ({
  showActionMenu: (...args: unknown[]) => mockShowActionMenu(...args),
}));
const mockOpenExternalLink = jest.fn().mockResolvedValue(undefined);
jest.mock('@/utils/openExternalLink', () => ({
  openExternalLink: (...args: unknown[]) => mockOpenExternalLink(...args),
}));
jest.mock('@oxy.so/bloom/theme', () => ({ useTheme: () => ({ colors: { text: '#000' } }) }));
jest.mock('@oxy.so/bloom/icons/RiDownloadLine', () => ({ RiDownloadLine: () => null }));
jest.mock('@oxy.so/bloom/icons/RiGlobalLine', () => ({ RiGlobalLine: () => null }));
let mockPlayStoreUrl = '';
jest.mock('@/config', () => ({
  ALLO_APP_STORE_URL: '',
  get ALLO_PLAY_STORE_URL() {
    return mockPlayStoreUrl;
  },
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const LINKS = { app: 'allo://c/abc', web: 'https://allo.you/c/abc' };

function renderHook(): () => void {
  let press: () => void = () => undefined;
  function Probe() {
    const open = useOpenInAllo();
    press = () => open(LINKS, 'Allo is not installed.');
    return null;
  }
  act(() => {
    TestRenderer.create(<Probe />);
  });
  return press;
}

/** Let the open's promise chain settle. */
const flush = () => act(async () => {});

const originalOS = Platform.OS;
const setOS = (os: typeof Platform.OS) =>
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });

let openURL: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  openURL = jest.spyOn(Linking, 'openURL');
  mockPlayStoreUrl = '';
});
afterEach(() => {
  openURL.mockRestore();
  setOS(originalOS);
});

it('hands the app link to the OS', async () => {
  setOS('android');
  openURL.mockResolvedValue(true);
  renderHook()();
  await flush();
  expect(openURL).toHaveBeenCalledWith(LINKS.app);
  expect(mockOpenExternalLink).not.toHaveBeenCalled();
});

it('offers "Get Allo" and the web app, under the caller\'s label, when Allo is not installed', async () => {
  setOS('android');
  const store = 'https://play.google.com/store/apps/details?id=com.allo.app';
  mockPlayStoreUrl = store;
  openURL
    .mockRejectedValueOnce(new Error('No Activity found to handle Intent'))
    .mockResolvedValue(true);
  renderHook()();
  await flush();

  expect(mockShowActionMenu).toHaveBeenCalledTimes(1);
  const [{ label, groups }] = mockShowActionMenu.mock.calls[0] as [
    { label: string; groups: ActionMenuAction[][] },
  ];
  expect(label).toBe('Allo is not installed.');
  const [getApp, openWeb] = groups[0];
  expect(getApp.label).toBe('allo.getApp');
  expect(openWeb.label).toBe('allo.openWeb');

  getApp.onPress();
  expect(openURL).toHaveBeenLastCalledWith(store);
  openWeb.onPress();
  expect(mockOpenExternalLink).toHaveBeenCalledWith(LINKS.web);
});
