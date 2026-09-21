import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { logger } from '@oxy.so/core/logger';
import { useAccountThemeSync, useThemeControls } from '../useAccountTheme';

/**
 * Theme changes write back to the Oxy account only when there is a session that
 * can reach it. Without one the account write used to run anyway and reject with
 * AUTH_REQUIRED_OFFLINE_SESSION on the appearance screen; the effective source is
 * `app` instead, while a signed-in viewer on the `account` source still syncs.
 */

jest.mock('@oxy.so/core/logger', () => ({ logger: { error: jest.fn() } }));

const mockUpdateThemePreference = jest.fn();
const mockSetMode = jest.fn();
const mockSetColorPreset = jest.fn();
const mockSetSource = jest.fn();
let mockAuth: { canUsePrivateApi: boolean; isAuthenticated?: boolean; user: unknown };
let mockColorPreset = 'teal';
let mockEntitled = true;
const mockHydrate = jest.fn();
let mockSource: 'account' | 'app' = 'account';

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ ...mockAuth, oxyServices: { updateThemePreference: mockUpdateThemePreference } }),
}));

jest.mock('@oxy.so/bloom/theme', () => ({
  APP_COLOR_PRESETS: { teal: {}, oxy: {} },
  useBloomTheme: () => ({
    mode: 'light',
    colorPreset: mockColorPreset,
    setMode: mockSetMode,
    setColorPreset: mockSetColorPreset,
  }),
}));

jest.mock('@/stores/themeSourceStore', () => ({
  useThemeSourceStore: (select: (state: unknown) => unknown) =>
    select({ source: mockSource, setSource: mockSetSource, hydrated: true, hydrate: mockHydrate }),
}));

jest.mock('@/lib/colorEntitlement', () => ({
  APP_DEFAULT_COLOR_PRESET: 'teal',
  isColorEntitled: () => mockEntitled,
}));

let controls: ReturnType<typeof useThemeControls>;
function Probe() {
  controls = useThemeControls();
  return null;
}

function mount() {
  act(() => {
    TestRenderer.create(<Probe />);
  });
}

describe('useThemeControls', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockColorPreset = 'teal';
    mockEntitled = true;
    mockSource = 'account';
    mockUpdateThemePreference.mockResolvedValue(undefined);
  });

  it('keeps a mode change local when signed out', async () => {
    mockAuth = { canUsePrivateApi: false, user: undefined };
    mount();
    await act(() => controls.changeThemeMode('dark'));
    expect(mockSetMode).toHaveBeenCalledWith('dark');
    expect(mockUpdateThemePreference).not.toHaveBeenCalled();
  });

  it('reports the app source when signed out, whatever is stored', () => {
    mockAuth = { canUsePrivateApi: false, user: undefined };
    mount();
    expect(controls.source).toBe('app');
  });

  it('does not seed the account theme when sync is enabled signed out', () => {
    mockAuth = { canUsePrivateApi: false, user: undefined };
    mount();
    act(() => controls.changeThemeSource('account'));
    expect(mockSetSource).toHaveBeenCalledWith('account');
    expect(mockUpdateThemePreference).not.toHaveBeenCalled();
  });

  it('keeps a colour change local when signed out', async () => {
    mockAuth = { canUsePrivateApi: false, user: undefined };
    mount();
    await act(() => controls.changeColorPreset('oxy'));
    expect(mockSetColorPreset).toHaveBeenCalledWith('oxy');
    expect(mockUpdateThemePreference).not.toHaveBeenCalled();
  });

  it('writes the portable theme to the account when signed in on the account source', async () => {
    mockAuth = { canUsePrivateApi: true, user: { username: 'ada' } };
    mount();
    await act(() => controls.changeThemeMode('adaptive'));
    expect(mockUpdateThemePreference).toHaveBeenCalledWith({ mode: 'system', colorPreset: 'teal' });
  });

  it('stays local on the app source even when signed in', async () => {
    mockAuth = { canUsePrivateApi: true, user: { username: 'ada' } };
    mockSource = 'app';
    mount();
    await act(() => controls.changeThemeMode('dark'));
    expect(mockUpdateThemePreference).not.toHaveBeenCalled();
  });

  it('reports a failed first-time account seed without an unhandled rejection', async () => {
    const error = new Error('network unavailable');
    mockAuth = { canUsePrivateApi: true, user: { username: 'ada' } };
    mockUpdateThemePreference.mockRejectedValueOnce(error);
    mount();
    await act(async () => { controls.changeThemeSource('account'); });
    expect(mockSetSource).toHaveBeenCalledWith('account');
    expect(logger.error).toHaveBeenCalledWith('Failed to seed account theme preference', error);
  });

  it('seeds the account theme when sync is enabled and none exists yet', () => {
    mockAuth = { canUsePrivateApi: true, user: { username: 'ada', themePreference: undefined } };
    mount();
    act(() => controls.changeThemeSource('account'));
    expect(mockSetSource).toHaveBeenCalledWith('account');
    expect(mockUpdateThemePreference).toHaveBeenCalledWith({ mode: 'light', colorPreset: 'teal' });
  });
});

describe('useAccountThemeSync', () => {
  function SyncProbe() {
    useAccountThemeSync();
    return null;
  }
  function mountSync() {
    act(() => {
      TestRenderer.create(<SyncProbe />);
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockColorPreset = 'teal';
    mockEntitled = true;
    mockSource = 'account';
  });

  it("applies the signed-in viewer's account theme on the account source", () => {
    mockAuth = {
      canUsePrivateApi: true,
      isAuthenticated: true,
      user: { username: 'ada', themePreference: { mode: 'dark', colorPreset: 'oxy' } },
    };
    mountSync();
    expect(mockHydrate).toHaveBeenCalled();
    expect(mockSetMode).toHaveBeenCalledWith('dark');
    expect(mockSetColorPreset).toHaveBeenCalledWith('oxy');
  });

  it('leaves the local theme alone on the app source', () => {
    mockSource = 'app';
    mockAuth = {
      canUsePrivateApi: true,
      isAuthenticated: true,
      user: { username: 'ada', themePreference: { mode: 'dark', colorPreset: 'oxy' } },
    };
    mountSync();
    expect(mockSetMode).not.toHaveBeenCalled();
  });

  it('revokes a colour the viewer is no longer entitled to', () => {
    mockSource = 'app';
    mockColorPreset = 'oxy';
    mockEntitled = false;
    mockAuth = { canUsePrivateApi: true, isAuthenticated: true, user: { username: 'ada' } };
    mountSync();
    expect(mockSetColorPreset).toHaveBeenCalledWith('teal');
  });
});
