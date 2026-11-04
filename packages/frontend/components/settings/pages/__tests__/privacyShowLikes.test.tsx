import type React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryClient';

import PrivacyScreen from '../privacy';

/**
 * Settings → Privacy → "Show my likes on my profile".
 *
 * What an account has liked is private unless it opts in, so the switch starts
 * off for an account that never set it, and turning it on is saved as
 * `privacy.showLikes` on the same settings document as every other toggle.
 */

const mockApi = { get: jest.fn(), put: jest.fn() };

jest.mock('@/utils/api', () => ({
  authenticatedClient: {
    get: (...args: unknown[]) => mockApi.get(...args),
    put: (...args: unknown[]) => mockApi.put(...args),
  },
  isNotFoundError: () => false,
}));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({
    user: { id: 'viewer-1' },
    isAuthenticated: true,
    isAuthResolved: true,
    canUsePrivateApi: true,
    isPrivateApiPending: false,
  }),
  OxyAuthPrompt: () => null,
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@/context/MentionSettingsContext', () => ({
  useSettingsRouter: () => ({ push: jest.fn() }),
}));
jest.mock('@/components/SupervisedFeatureGate', () => ({
  SupervisedFeatureGate: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/components/loading/ContentSkeleton', () => ({ SettingsSkeleton: () => null }));
jest.mock('@/lib/recommendationFilters', () => ({
  DEFAULT_RECOMMENDATION_FILTERS: {},
  getRecommendationFilters: jest.fn(async () => ({})),
  saveRecommendationFilters: jest.fn(async () => undefined),
}));
jest.mock('@/stores/safetyInvalidation', () => ({ invalidateSafetyFilters: jest.fn() }));
jest.mock('@oxy.so/bloom/button', () => ({ Button: () => null }));
jest.mock('@oxy.so/bloom/icons/RiEarthLine', () => ({ RiEarthLine: () => null }));
jest.mock('@oxy.so/bloom/icons/RiRefreshLine', () => ({ RiRefreshLine: () => null }));
jest.mock('@oxy.so/bloom/icons/RiSparklingLine', () => ({ RiSparklingLine: () => null }));
jest.mock('@oxy.so/bloom/settings-modal', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { SettingsCard: View, SettingsSection: View, SettingsRow: View };
});
jest.mock('@oxy.so/bloom/switch', () => {
  const { TouchableOpacity } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Switch: ({
      checked,
      onCheckedChange,
      accessibilityLabel,
    }: {
      checked: boolean;
      onCheckedChange: (value: boolean) => void;
      accessibilityLabel?: string;
    }) => (
      <TouchableOpacity
        accessibilityLabel={accessibilityLabel}
        accessibilityState={{ checked }}
        onPress={() => onCheckedChange(!checked)}
      />
    ),
  };
});

/** React Query notifies subscribers on a macrotask; let the read and the save land. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('Settings → Privacy → show my likes', () => {
  it('starts off and saves showLikes when turned on', async () => {
    mockApi.get.mockResolvedValue({ data: { privacy: { profileVisibility: 'public' } } });
    mockApi.put.mockResolvedValue({
      data: { privacy: { profileVisibility: 'public', showLikes: true } },
    });

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <QueryClientProvider client={queryClient}>
          <PrivacyScreen />
        </QueryClientProvider>,
      );
    });
    await settle();

    const toggle = () =>
      renderer.root.findByProps({ accessibilityLabel: 'settings.privacy.showLikes' });
    expect(toggle().props.checked).toBe(false);

    await act(async () => {
      toggle().props.onCheckedChange(true);
    });
    await settle();

    // Only the changed field: the server merges a privacy patch field by field.
    expect(mockApi.put).toHaveBeenCalledWith('/profile/settings', {
      privacy: { showLikes: true },
    });
    expect(toggle().props.checked).toBe(true);
    // The page read the shared settings document once and did not re-read it to save.
    expect(mockApi.get).toHaveBeenCalledTimes(1);
  });
});
