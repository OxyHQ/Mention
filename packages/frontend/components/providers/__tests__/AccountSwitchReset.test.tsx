import React from 'react';
import { View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxyhq/services/ui/client';
import { useBloomTheme } from '@oxyhq/bloom/theme';
import { useAppearanceStore } from '@/stores/appearanceStore';
import { usePostsStore } from '@/stores/postsStore';
import { usePrivacyStore } from '@/stores/privacyStore';
import { useEntityFollowStore } from '@/stores/entityFollowStore';
import { useExternalEmbedsStore } from '@/stores/externalEmbedsStore';
import { useLiveRoomsStore } from '@/stores/liveRoomsStore';
import { useTrendsStore } from '@/stores/trendsStore';
import { clearAllFeedMemoryCaches } from '@/stores/feedScrollStore';
import { resetEngagementInvalidation } from '@/stores/engagementInvalidation';
import { setFeedViewerRequestScope } from '@/services/feedService';
import { searchService } from '@/services/searchService';
import { socketService } from '@/services/socketService';
import { liveRoomRuntimeController } from '@/context/LiveRoomContext';
import { claimViewerCache } from '@/db';
import { AccountSwitchReset } from '../AccountSwitchReset';

let mockUser: { id: string } | null = { id: 'viewer-a' };
let mockIsAuthResolved = true;
let mockPersistedViewerId: string | null = 'viewer-a';
const mockQueryClientClear = jest.fn();
const mockResetAppearance = jest.fn();
const mockResetTheme = jest.fn();
const mockResetPosts = jest.fn();
const mockResetPrivacy = jest.fn();
const mockResetEntityFollows = jest.fn();
const mockResetExternalEmbeds = jest.fn();
const mockResetLiveRooms = jest.fn();
const mockResetTrends = jest.fn();
const mockResetRecommendationFilters = jest.fn();
const mockResetPrivacySettingsCache = jest.fn();
const mockChildRender = jest.fn();

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: jest.fn(),
}));

jest.mock('@oxyhq/services/ui/client', () => ({
  useAuth: jest.fn(),
}));

// The provider reads the account's declared locales through the SDK. Mocked to
// its identity behaviour, like every other SDK boundary in this suite, so the
// barrel (and the crypto polyfill behind it) stays out of the module graph.
jest.mock('@oxyhq/core', () => ({
  getUserLanguages: (user: { languages?: string[] } | null | undefined) => user?.languages ?? [],
}));

jest.mock('@oxyhq/bloom/theme', () => ({
  useBloomTheme: jest.fn(),
}));

jest.mock('@/stores/appearanceStore', () => ({
  useAppearanceStore: jest.fn(),
}));

jest.mock('@/stores/postsStore', () => ({
  usePostsStore: {
    getState: jest.fn(),
  },
}));

jest.mock('@/stores/privacyStore', () => ({
  usePrivacyStore: {
    getState: jest.fn(),
  },
}));

jest.mock('@/stores/entityFollowStore', () => ({
  useEntityFollowStore: {
    getState: jest.fn(),
  },
}));

jest.mock('@/stores/externalEmbedsStore', () => ({
  useExternalEmbedsStore: {
    getState: jest.fn(),
  },
}));

jest.mock('@/stores/liveRoomsStore', () => ({
  useLiveRoomsStore: {
    getState: jest.fn(),
  },
}));

jest.mock('@/stores/trendsStore', () => ({
  useTrendsStore: {
    getState: jest.fn(),
  },
}));

jest.mock('@/lib/recommendationFilters', () => ({
  resetRecommendationFiltersViewer: (...args: unknown[]) =>
    mockResetRecommendationFilters(...args),
}));

jest.mock('@/hooks/usePrivacySettings', () => ({
  resetCurrentUserPrivacySettingsCache: (...args: unknown[]) =>
    mockResetPrivacySettingsCache(...args),
}));

jest.mock('@/stores/feedScrollStore', () => ({
  clearAllFeedMemoryCaches: jest.fn(),
}));

jest.mock('@/stores/engagementInvalidation', () => ({
  resetEngagementInvalidation: jest.fn(),
}));

jest.mock('@/services/feedService', () => ({
  setFeedViewerRequestScope: jest.fn(),
}));

jest.mock('@/services/searchService', () => ({
  searchService: { clearSearchHistory: jest.fn(() => Promise.resolve()) },
}));

jest.mock('@/services/socketService', () => ({
  socketService: { disconnect: jest.fn() },
}));

jest.mock('@/context/LiveRoomContext', () => ({
  liveRoomRuntimeController: { resetViewerState: jest.fn() },
}));

jest.mock('@/db', () => ({
  claimViewerCache: jest.fn(),
}));

const mockUseQueryClient = useQueryClient as jest.Mock;
const mockUseAuth = useAuth as jest.Mock;
const mockUseBloomTheme = useBloomTheme as jest.Mock;
const mockUseAppearanceStore = useAppearanceStore as unknown as jest.Mock;
const mockGetPostsState = usePostsStore.getState as jest.Mock;
const mockGetPrivacyState = usePrivacyStore.getState as jest.Mock;
const mockGetEntityFollowState = useEntityFollowStore.getState as jest.Mock;
const mockGetExternalEmbedsState =
  useExternalEmbedsStore.getState as jest.Mock;
const mockGetLiveRoomsState = useLiveRoomsStore.getState as jest.Mock;
const mockGetTrendsState = useTrendsStore.getState as jest.Mock;
const mockSetReaderLanguages = jest.fn();
const mockClearFeedMemory = clearAllFeedMemoryCaches as jest.Mock;
const mockResetEngagementInvalidation = resetEngagementInvalidation as jest.Mock;
const mockSetFeedViewerRequestScope =
  setFeedViewerRequestScope as jest.Mock;
const mockClearSearchHistory = searchService.clearSearchHistory as jest.Mock;
const mockDisconnectSocket = socketService.disconnect as jest.Mock;
const mockResetLiveRoom =
  liveRoomRuntimeController.resetViewerState as jest.Mock;
const mockClaimViewerCache = claimViewerCache as jest.Mock;

function Probe({ viewerId }: { viewerId: string | null }) {
  mockChildRender(viewerId);
  return null;
}

// Stands in for the boot visual (<AppSplashScreen/>) that the real tree passes
// as `fallback`. Rendered as a host element so "did the gate paint anything?"
// is asserted against the actual output tree, not just a spy.
const BOOT_VISUAL_ID = 'boot-visual';
function BootVisual() {
  return <View testID={BOOT_VISUAL_ID} />;
}

const renderBoundary = () => (
  <AccountSwitchReset fallback={<BootVisual />}>
    <Probe viewerId={mockUser?.id ?? null} />
  </AccountSwitchReset>
);

/** Is the boot visual present in the rendered output? */
const bootVisualShown = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.findAllByProps({ testID: BOOT_VISUAL_ID }).length > 0;

describe('AccountSwitchReset identity boundary', () => {
  beforeAll(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mockUser = { id: 'viewer-a' };
    mockIsAuthResolved = true;
    mockPersistedViewerId = 'viewer-a';
    jest.clearAllMocks();
    mockUseQueryClient.mockReturnValue({ clear: mockQueryClientClear });
    mockUseAuth.mockImplementation(() => ({
      user: mockUser,
      isAuthResolved: mockIsAuthResolved,
      isAuthenticated: mockIsAuthResolved && mockUser !== null,
    }));
    mockClaimViewerCache.mockImplementation((viewerId: string) => {
      const previousViewerId = mockPersistedViewerId;
      const reset = previousViewerId !== viewerId;
      mockPersistedViewerId = viewerId;
      return { reset, previousViewerId, trusted: true };
    });
    mockUseBloomTheme.mockReturnValue({ resetTheme: mockResetTheme });
    mockUseAppearanceStore.mockImplementation(
      (selector: (state: {
        resetViewerState: typeof mockResetAppearance;
      }) => unknown) =>
        selector({ resetViewerState: mockResetAppearance }),
    );
    mockGetPostsState.mockReturnValue({ resetViewerState: mockResetPosts });
    mockGetPrivacyState.mockReturnValue({ reset: mockResetPrivacy });
    mockGetEntityFollowState.mockReturnValue({
      reset: mockResetEntityFollows,
    });
    mockGetExternalEmbedsState.mockReturnValue({
      resetViewerState: mockResetExternalEmbeds,
    });
    mockGetLiveRoomsState.mockReturnValue({
      resetViewerState: mockResetLiveRooms,
    });
    mockGetTrendsState.mockReturnValue({
      resetViewerState: mockResetTrends,
      // The provider also pushes the reader's content languages, which order
      // the trending list server-side.
      setReaderLanguages: mockSetReaderLanguages,
    });
    mockClearSearchHistory.mockResolvedValue(undefined);
  });

  it('clears private state and appearance on A → logout before anonymous UI renders', () => {
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(renderBoundary());
    });

    expect(mockQueryClientClear).not.toHaveBeenCalled();

    mockUser = null;
    act(() => {
      renderer!.update(renderBoundary());
    });

    expect(mockDisconnectSocket).toHaveBeenCalledTimes(1);
    expect(mockResetLiveRoom).toHaveBeenCalledTimes(1);
    expect(mockQueryClientClear).toHaveBeenCalledTimes(1);
    expect(mockResetPosts).toHaveBeenCalledWith({
      clearCachedData: false,
    });
    expect(mockResetPrivacy).toHaveBeenCalledTimes(1);
    expect(mockResetEntityFollows).toHaveBeenCalledTimes(1);
    expect(mockResetExternalEmbeds).toHaveBeenCalledWith('viewer-a');
    expect(mockResetLiveRooms).toHaveBeenCalledTimes(1);
    expect(mockResetTrends).toHaveBeenCalledTimes(1);
    expect(mockResetRecommendationFilters).toHaveBeenCalledWith('viewer-a');
    expect(mockResetPrivacySettingsCache).toHaveBeenCalledWith('viewer-a');
    expect(mockClearFeedMemory).toHaveBeenCalledTimes(1);
    expect(mockResetEngagementInvalidation).toHaveBeenCalledTimes(1);
    expect(mockResetAppearance).toHaveBeenCalledTimes(1);
    expect(mockResetTheme).toHaveBeenCalledTimes(1);
    expect(mockClearSearchHistory).toHaveBeenCalledWith('viewer-a');

    const clearOrder = mockQueryClientClear.mock.invocationCallOrder[0];
    const anonymousRenderOrder = mockChildRender.mock.invocationCallOrder.at(-1);
    expect(clearOrder).toBeLessThan(anonymousRenderOrder!);

    act(() => {
      renderer!.unmount();
    });
  });

  it('does not reuse A state when B is selected directly', () => {
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(renderBoundary());
    });

    mockUser = { id: 'viewer-b' };
    act(() => {
      renderer!.update(renderBoundary());
    });

    expect(mockQueryClientClear).toHaveBeenCalledTimes(1);
    expect(mockResetPosts).toHaveBeenCalledTimes(1);
    expect(mockSetFeedViewerRequestScope).toHaveBeenLastCalledWith('viewer-b');
    expect(mockDisconnectSocket).toHaveBeenCalledTimes(1);

    const clearOrder = mockQueryClientClear.mock.invocationCallOrder[0];
    const viewerBRenderCall = mockChildRender.mock.calls.findIndex(
      ([viewerId]) => viewerId === 'viewer-b',
    );
    expect(viewerBRenderCall).toBeGreaterThanOrEqual(0);
    expect(clearOrder).toBeLessThan(
      mockChildRender.mock.invocationCallOrder[viewerBRenderCall],
    );

    act(() => {
      renderer!.unmount();
    });
  });

  it('clears at both A → logout and anonymous → B boundaries', () => {
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(renderBoundary());
    });

    mockUser = null;
    act(() => {
      renderer!.update(renderBoundary());
    });

    mockUser = { id: 'viewer-b' };
    act(() => {
      renderer!.update(renderBoundary());
    });

    expect(mockQueryClientClear).toHaveBeenCalledTimes(2);
    expect(mockResetAppearance).toHaveBeenCalledTimes(2);
    expect(mockChildRender).toHaveBeenLastCalledWith('viewer-b');

    act(() => {
      renderer!.unmount();
    });
  });

  it('does not render or claim cache while auth restoration is unresolved', () => {
    mockIsAuthResolved = false;
    mockUser = null;

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(renderBoundary());
    });

    expect(mockClaimViewerCache).not.toHaveBeenCalled();
    expect(mockChildRender).not.toHaveBeenCalled();

    mockIsAuthResolved = true;
    mockUser = { id: 'viewer-a' };
    act(() => {
      renderer!.update(renderBoundary());
    });

    expect(mockClaimViewerCache).toHaveBeenCalledWith('viewer-a');
    expect(mockChildRender).toHaveBeenLastCalledWith('viewer-a');

    act(() => {
      renderer!.unmount();
    });
  });

  it('disconnects and cancels A immediately when an established auth session becomes unresolved', () => {
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(renderBoundary());
    });

    mockIsAuthResolved = false;
    mockUser = null;
    act(() => {
      renderer!.update(renderBoundary());
    });

    expect(mockDisconnectSocket).toHaveBeenCalledTimes(1);
    expect(mockQueryClientClear).toHaveBeenCalledTimes(1);
    expect(mockResetPosts).toHaveBeenCalledWith({
      clearCachedData: true,
    });
    expect(mockChildRender).toHaveBeenCalledTimes(1);

    act(() => {
      renderer!.unmount();
    });
  });

  it('wipes an A-owned cold cache before the first B render', () => {
    mockPersistedViewerId = 'viewer-a';
    mockUser = { id: 'viewer-b' };

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(renderBoundary());
    });

    expect(mockQueryClientClear).toHaveBeenCalledTimes(1);
    expect(mockResetPosts).toHaveBeenCalledWith({
      clearCachedData: false,
    });
    const clearOrder = mockQueryClientClear.mock.invocationCallOrder[0];
    const firstBRenderOrder = mockChildRender.mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(firstBRenderOrder);

    act(() => {
      renderer!.unmount();
    });
  });

  /*
   * This gate sits ABOVE the root layout's own splash branch, so whatever it
   * renders while closed IS the entire screen. Returning nothing here is what
   * produced the multi-second blank boot: on a returning viewer whose warm
   * access token has expired the device-secret mint is a real network
   * round-trip, and `isAuthResolved` stays false for its whole duration. These
   * cover the boot visual across every reason the gate stays closed, while the
   * suite above keeps proving descendants stay unmounted.
   */
  it('renders the boot visual instead of nothing while auth restoration is unresolved', () => {
    mockIsAuthResolved = false;
    mockUser = null;

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(renderBoundary());
    });

    // Something is on screen...
    expect(renderer!.toJSON()).not.toBeNull();
    expect(bootVisualShown(renderer!)).toBe(true);
    // ...but it is emphatically NOT the app: descendants stay unmounted, so the
    // route tree cannot render and no (auth)↔(app) swap can run yet.
    expect(mockChildRender).not.toHaveBeenCalled();
    expect(mockClaimViewerCache).not.toHaveBeenCalled();

    mockIsAuthResolved = true;
    mockUser = { id: 'viewer-a' };
    act(() => {
      renderer!.update(renderBoundary());
    });

    // Once resolved the app takes over and the boot visual is gone.
    expect(mockChildRender).toHaveBeenLastCalledWith('viewer-a');
    expect(bootVisualShown(renderer!)).toBe(false);

    act(() => {
      renderer!.unmount();
    });
  });

  it('renders the boot visual instead of nothing while the persisted cache is untrusted', () => {
    mockClaimViewerCache.mockReturnValue({
      reset: true,
      previousViewerId: 'viewer-a',
      trusted: false,
    });
    mockUser = { id: 'viewer-b' };

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(renderBoundary());
    });

    expect(renderer!.toJSON()).not.toBeNull();
    expect(bootVisualShown(renderer!)).toBe(true);
    expect(mockChildRender).not.toHaveBeenCalled();

    act(() => {
      renderer!.unmount();
    });
  });

  it('keeps descendants gated when the persisted cache cannot be trusted', () => {
    mockClaimViewerCache.mockReturnValue({
      reset: true,
      previousViewerId: 'viewer-a',
      trusted: false,
    });
    mockUser = { id: 'viewer-b' };

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(renderBoundary());
    });

    expect(mockChildRender).not.toHaveBeenCalled();
    expect(mockQueryClientClear).not.toHaveBeenCalled();

    act(() => {
      renderer!.unmount();
    });
  });
});
