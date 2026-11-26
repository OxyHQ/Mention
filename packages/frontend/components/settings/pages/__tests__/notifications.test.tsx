import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { toElement } from '@oxy.so/bloom-language';
import { BloomThemeProvider } from '@oxy.so/bloom/theme';

import { NotificationSettingsScreen } from '../notifications.bloom';

/**
 * Settings → Notifications, written in Bloom's own language (`notifications.bloom`)
 * and compiled under the unit config by `test-support/bloomTransform.js`.
 *
 * A preference the server never stored is on, and turning one off is saved as
 * that one field: the server merges the patch into the stored section.
 */

const mockUpdate = jest.fn();
const mockToast = jest.fn();
let mockStored: Record<string, boolean> = {};

jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ canUsePrivateApi: true, isPrivateApiPending: false }),
  OxyAuthPrompt: () => null,
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@oxy.so/core/logger', () => ({ logger: { error: jest.fn() } }));
jest.mock('@oxy.so/bloom/toast', () => ({
  toast: (...args: unknown[]) => mockToast(...args),
}));
jest.mock('@/context/MentionSettingsContext', () => ({
  useSettingsRouter: () => ({ push: jest.fn() }),
}));
jest.mock('@/hooks/useViewerSettings', () => ({
  useViewerSettingsSection: () => ({
    value: mockStored,
    isLoading: false,
    update: (patch: Record<string, boolean>) => mockUpdate(patch),
  }),
}));
jest.mock('@/components/loading/ContentSkeleton', () => ({ SettingsSkeleton: () => null }));
jest.mock('@oxy.so/bloom/settings-modal', () => ({
  SettingsSection: require('react-native').View,
}));
jest.mock('@oxy.so/bloom/grouped-section', () => require('@/test-support/bloomGroupedSection'));

function themed(element: React.ReactElement): React.ReactElement {
  return <BloomThemeProvider fonts={false}>{element}</BloomThemeProvider>;
}

function render(): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = TestRenderer.create(themed(toElement(NotificationSettingsScreen())));
  });
  if (!renderer) throw new Error('the screen did not render');
  return renderer;
}

/** The switch labelled `label`: the host element that carries its checked state. */
function toggle(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [match] = renderer.root.findAll(
    (node) =>
      typeof node.type === 'string' &&
      node.props.accessibilityLabel === label &&
      node.props.accessibilityState?.checked !== undefined,
  );
  if (!match) throw new Error(`no switch labelled ${label}`);
  return match;
}

/** Press `node` as a tap does: the nearest element up from it that takes `onPress`. */
function press(node: TestRenderer.ReactTestInstance): void {
  let current: TestRenderer.ReactTestInstance | null = node;
  while (current && typeof current.props.onPress !== 'function') current = current.parent;
  if (!current) throw new Error('nothing to press');
  current.props.onPress();
}

beforeEach(() => {
  mockStored = {};
  mockUpdate.mockReset().mockResolvedValue({ ok: true });
  mockToast.mockReset();
});

it('shows a preference the server never stored as on', () => {
  mockStored = { likes: false };
  const renderer = render();
  expect(toggle(renderer, 'settings.notifications.likes').props.accessibilityState.checked).toBe(
    false,
  );
  expect(toggle(renderer, 'settings.notifications.replies').props.accessibilityState.checked).toBe(
    true,
  );
});

it('saves a turned-off preference as that one field', async () => {
  const renderer = render();
  await act(async () => {
    press(toggle(renderer, 'settings.notifications.mentions'));
  });
  expect(mockUpdate).toHaveBeenCalledWith({ mentions: false });
  expect(mockToast).not.toHaveBeenCalled();
});
