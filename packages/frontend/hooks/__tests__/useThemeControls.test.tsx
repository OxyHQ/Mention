import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { useThemeControls } from '../useAccountTheme';

/**
 * Theme changes write back to the Oxy account only when there is one. Signed
 * out, the account write used to run anyway and reject with
 * AUTH_REQUIRED_OFFLINE_SESSION on the appearance screen; the change must stay
 * local instead, while a signed-in viewer on the `account` source still syncs.
 */

const mockUpdateThemePreference = jest.fn();
const mockSetMode = jest.fn();
const mockSetColorPreset = jest.fn();
const mockSetSource = jest.fn();
let mockAuth: { isAuthenticated: boolean; user: unknown };
let mockSource: 'account' | 'app' = 'account';

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ ...mockAuth, oxyServices: { updateThemePreference: mockUpdateThemePreference } }),
}));

jest.mock('@oxy.so/bloom/theme', () => ({
  APP_COLOR_PRESETS: { teal: {}, oxy: {} },
  useBloomTheme: () => ({
    mode: 'light',
    colorPreset: 'teal',
    setMode: mockSetMode,
    setColorPreset: mockSetColorPreset,
  }),
}));

jest.mock('@/stores/themeSourceStore', () => ({
  useThemeSourceStore: (select: (state: unknown) => unknown) =>
    select({ source: mockSource, setSource: mockSetSource }),
}));

jest.mock('@/lib/colorEntitlement', () => ({
  APP_DEFAULT_COLOR_PRESET: 'teal',
  isColorEntitled: () => true,
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
    mockSource = 'account';
    mockUpdateThemePreference.mockResolvedValue(undefined);
  });

  it('keeps a mode change local when signed out', async () => {
    mockAuth = { isAuthenticated: false, user: undefined };
    mount();
    await act(() => controls.changeThemeMode('dark'));
    expect(mockSetMode).toHaveBeenCalledWith('dark');
    expect(mockUpdateThemePreference).not.toHaveBeenCalled();
  });

  it('keeps a colour change local when signed out', async () => {
    mockAuth = { isAuthenticated: false, user: undefined };
    mount();
    await act(() => controls.changeColorPreset('oxy'));
    expect(mockSetColorPreset).toHaveBeenCalledWith('oxy');
    expect(mockUpdateThemePreference).not.toHaveBeenCalled();
  });

  it('writes the portable theme to the account when signed in on the account source', async () => {
    mockAuth = { isAuthenticated: true, user: { username: 'ada' } };
    mount();
    await act(() => controls.changeThemeMode('adaptive'));
    expect(mockUpdateThemePreference).toHaveBeenCalledWith({ mode: 'system', colorPreset: 'teal' });
  });

  it('stays local on the app source even when signed in', async () => {
    mockAuth = { isAuthenticated: true, user: { username: 'ada' } };
    mockSource = 'app';
    mount();
    await act(() => controls.changeThemeMode('dark'));
    expect(mockUpdateThemePreference).not.toHaveBeenCalled();
  });

  it('seeds the account theme when sync is enabled and none exists yet', () => {
    mockAuth = { isAuthenticated: true, user: { username: 'ada', themePreference: undefined } };
    mount();
    act(() => controls.changeThemeSource('account'));
    expect(mockSetSource).toHaveBeenCalledWith('account');
    expect(mockUpdateThemePreference).toHaveBeenCalledWith({ mode: 'light', colorPreset: 'teal' });
  });
});
