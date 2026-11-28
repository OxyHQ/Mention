import TestRenderer, { act } from 'react-test-renderer';
import { markPresetSelection, useAccountThemeSync } from '../useAccountTheme';

/**
 * Mention's paywall on top of the SDK's account theme: the account colour is
 * handed to `useAccountTheme` gated by entitlement, and a preset already
 * applied is revoked when the viewer is not entitled to it.
 */

const mockSetColorPreset = jest.fn();
let mockAuth: { isAuthenticated: boolean; user: unknown };
let mockColorPreset = 'teal';
let mockEntitled = true;

const mockUseAccountTheme = jest.fn();
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => mockAuth,
  useAccountTheme: (options: unknown) => mockUseAccountTheme(options),
}));

jest.mock('@oxy.so/bloom/theme', () => ({
  APP_COLOR_PRESETS: { teal: {}, oxy: {} },
  useBloomTheme: () => ({ colorPreset: mockColorPreset, setColorPreset: mockSetColorPreset }),
}));

jest.mock('../useMentionColorViewer', () => ({
  useMentionColorViewer: () => ({ mentionMono: mockEntitled }),
}));

jest.mock('@/lib/colorEntitlement', () => ({
  APP_DEFAULT_COLOR_PRESET: 'teal',
  // The free default is always entitled; anything else follows the viewer.
  isColorEntitled: (preset: string) => preset === 'teal' || mockEntitled,
}));

function SyncProbe() {
  useAccountThemeSync();
  return null;
}

let renderer: TestRenderer.ReactTestRenderer;
function render() {
  act(() => {
    renderer = TestRenderer.create(<SyncProbe />);
  });
}
function rerender() {
  act(() => {
    renderer.update(<SyncProbe />);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockColorPreset = 'teal';
  mockEntitled = true;
  mockAuth = { isAuthenticated: true, user: { username: 'ada' } };
});

it('hands the account colour to the shared hook gated by entitlement', () => {
  mockEntitled = false;
  render();
  const { canUse } = mockUseAccountTheme.mock.calls[0][0];
  expect(canUse('oxy')).toBe(false);
  expect(canUse('teal')).toBe(true);
});

it('revokes a colour the viewer is no longer entitled to', () => {
  mockColorPreset = 'oxy';
  mockEntitled = false;
  render();
  expect(mockSetColorPreset).toHaveBeenCalledWith('teal');
});

describe('while the permission read is pending', () => {
  beforeEach(() => {
    mockColorPreset = 'oxy';
    mockEntitled = false;
    mockAuth = { isAuthenticated: true, user: { id: 'ada-id', username: 'ada' } };
  });

  it('withholds the saved preset, then restores it once the permission arrives', () => {
    render();
    expect(mockSetColorPreset).toHaveBeenLastCalledWith('teal');
    mockColorPreset = 'teal';
    rerender();
    mockEntitled = true;
    rerender();
    expect(mockSetColorPreset).toHaveBeenLastCalledWith('oxy');
  });

  it('keeps the free preset when the permission is denied', () => {
    render();
    mockColorPreset = 'teal';
    rerender();
    rerender();
    expect(mockSetColorPreset.mock.calls).toEqual([['teal']]);
  });

  it('never restores over a newer selection', () => {
    render();
    mockColorPreset = 'teal';
    rerender();
    markPresetSelection();
    mockEntitled = true;
    rerender();
    expect(mockSetColorPreset).not.toHaveBeenCalledWith('oxy');
  });

  it("never restores one account's preset for another account", () => {
    render();
    mockColorPreset = 'teal';
    mockAuth = { isAuthenticated: true, user: { id: 'bob-id', username: 'bob' } };
    mockEntitled = true;
    rerender();
    expect(mockSetColorPreset).not.toHaveBeenCalledWith('oxy');
  });
});
