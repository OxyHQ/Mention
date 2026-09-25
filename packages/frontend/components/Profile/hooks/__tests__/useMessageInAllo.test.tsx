import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { Linking, Platform } from 'react-native';
import type { ActionMenuAction } from '@/components/common/actionMenuGroups';
import { useMessageInAllo } from '../useMessageInAllo';

/**
 * The profile's envelope button binds `lib/alloDirectMessage` to the platform:
 * `Linking` for the app scheme, `openExternalLink` for the web app, and the
 * app's action menu for the "not installed" offer.
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

const ID = '01929c4e-7b1a-7c3d-9e2f-0a1b2c3d4e5f';
const WEB = `https://allo.you/c/${ID}`;

function renderHook(): () => void {
  let press: () => void = () => undefined;
  function Probe() {
    press = useMessageInAllo(ID, 'alice');
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
const setOS = (os: typeof Platform.OS) => Object.defineProperty(Platform, 'OS', { value: os, configurable: true });

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

it('opens the conversation in the installed app', async () => {
  setOS('android');
  openURL.mockResolvedValue(true);
  renderHook()();
  await flush();
  expect(openURL).toHaveBeenCalledWith(`allo://c/${ID}`);
  expect(mockOpenExternalLink).not.toHaveBeenCalled();
});

it('opens the web app when Allo is not installed and has no listing', async () => {
  setOS('android');
  openURL.mockRejectedValue(new Error('No Activity found to handle Intent'));
  renderHook()();
  await flush();
  expect(mockOpenExternalLink).toHaveBeenCalledWith(WEB);
  expect(mockShowActionMenu).not.toHaveBeenCalled();
});

it('offers "Get Allo" and the web app when a listing is configured', async () => {
  setOS('android');
  const store = 'https://play.google.com/store/apps/details?id=com.allo.app';
  mockPlayStoreUrl = store;
  openURL.mockRejectedValueOnce(new Error('No Activity found to handle Intent')).mockResolvedValue(true);
  renderHook()();
  await flush();

  expect(mockShowActionMenu).toHaveBeenCalledTimes(1);
  const [{ label, groups }] = mockShowActionMenu.mock.calls[0] as [{ label: string; groups: ActionMenuAction[][] }];
  expect(label).toBe('profile.allo.notInstalled');
  const [getApp, openWeb] = groups[0];
  expect(getApp.label).toBe('profile.allo.getApp');
  expect(openWeb.label).toBe('profile.allo.openWeb');

  getApp.onPress();
  expect(openURL).toHaveBeenLastCalledWith(store);
  openWeb.onPress();
  expect(mockOpenExternalLink).toHaveBeenCalledWith(WEB);
});

it('opens the web app in a new tab on web', async () => {
  setOS('web');
  renderHook()();
  await flush();
  expect(mockOpenExternalLink).toHaveBeenCalledWith(WEB);
  expect(openURL).not.toHaveBeenCalled();
});
