import { type QueryClient, queryOptions } from '@tanstack/react-query';
import type { ExternalEmbedsSettings } from '@mention/shared-types';
import type { FeedSettings } from '@/hooks/useFeedSettings';
import type { UserAppearance } from '@/stores/appearanceStore';
import { queryClient } from '@/lib/queryClient';
import { viewerQueryKeys, type ViewerId } from '@/lib/viewerQueryKeys';
import { authenticatedClient, isNotFoundError } from '@/utils/api';

export interface PrivacySettings {
  profileVisibility?: 'public' | 'private' | 'followers_only';
  showContactInfo?: boolean;
  allowTags?: boolean;
  allowMentions?: boolean;
  showOnlineStatus?: boolean;
  /** Other people can see this account's likes. Default false. */
  showLikes?: boolean;
  hideLikeCounts?: boolean;
  hideShareCounts?: boolean;
  hideReplyCounts?: boolean;
  hideSaveCounts?: boolean;
  showSensitiveContent?: boolean;
  /** Search engines may index the profile and posts. Default true. */
  searchEngineIndexing?: boolean;
  hiddenWords?: string[];
  restrictedUsers?: string[];
}

export interface NotificationPreferences {
  pushEnabled?: boolean;
  likes?: boolean;
  boosts?: boolean;
  follows?: boolean;
  mentions?: boolean;
  replies?: boolean;
  quotes?: boolean;
}

/**
 * The viewer's own settings document, as `GET /profile/settings/me` and
 * `PUT /profile/settings` both answer it (the backend `UserSettings` record):
 * the appearance store's design fields plus everything only the owner reads.
 */
export interface UserSettingsResponse extends Partial<Omit<UserAppearance, 'privacy'>> {
  privacy?: PrivacySettings;
  feedSettings?: FeedSettings;
  notificationPreferences?: NotificationPreferences;
  externalEmbeds?: ExternalEmbedsSettings;
  /**
   * When the account finished or skipped `/welcome`; `null` until then. Absent
   * only from a server that predates the flow. Owner-only.
   */
  welcomeCompletedAt?: string | null;
}

/**
 * The ONE read of the viewer's settings. The appearance and embed stores, feed
 * ranking settings and every settings page share its cached answer, so a
 * signed-in boot asks once and a page reads what is already there instead of
 * fetching again before each save. A viewer with no document yet gets `{}`,
 * which every reader treats as "all defaults".
 */
export function viewerSettingsQuery(viewerId: ViewerId) {
  return queryOptions({
    queryKey: viewerQueryKeys.settings(viewerId),
    queryFn: async ({ signal }): Promise<UserSettingsResponse> => {
      try {
        const response = await authenticatedClient.get<UserSettingsResponse>(
          '/profile/settings/me',
          { signal },
        );
        return response.data ?? {};
      } catch (error) {
        if (isNotFoundError(error)) return {};
        throw error;
      }
    },
    staleTime: 5 * 60 * 1000,
  });
}

/** The cached settings when fresh, else one shared read — for stores and other non-React callers. */
export function fetchViewerSettings(viewerId: ViewerId): Promise<UserSettingsResponse> {
  return queryClient.fetchQuery(viewerSettingsQuery(viewerId));
}

/** Paint a change onto the cached settings (an optimistic edit). */
export function updateCachedViewerSettings(
  client: QueryClient,
  viewerId: ViewerId,
  update: (current: UserSettingsResponse) => UserSettingsResponse,
): void {
  client.setQueryData<UserSettingsResponse>(viewerQueryKeys.settings(viewerId), (current) =>
    update(current ?? {}),
  );
}

/**
 * `PUT /profile/settings` with a partial document — the server merges it field by
 * field — and store the saved document it answers with as the cached copy.
 */
export async function saveViewerSettings(
  viewerId: ViewerId,
  patch: Record<string, unknown>,
  client: QueryClient = queryClient,
): Promise<UserSettingsResponse> {
  const response = await authenticatedClient.put<UserSettingsResponse>('/profile/settings', patch);
  const saved = response.data ?? {};
  client.setQueryData(viewerQueryKeys.settings(viewerId), saved);
  return saved;
}
