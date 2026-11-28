import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@oxy.so/services/ui/client';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import {
  saveViewerSettings,
  updateCachedViewerSettings,
  viewerSettingsQuery,
  type UserSettingsResponse,
} from '@/lib/viewerSettings';

/** The viewer's settings, read once the private API is usable. */
export function useViewerSettings() {
  const { user, canUsePrivateApi } = useAuth();
  return useQuery({ ...viewerSettingsQuery(user?.id), enabled: canUsePrivateApi });
}

/** The sections `PUT /profile/settings` merges field by field. */
type MergedSection = 'privacy' | 'notificationPreferences';

const EMPTY_SECTION = Object.freeze({});

/**
 * One section of the viewer's settings and an instant-save `update` for the
 * settings pages. An update paints the cache at once, sends only the changed
 * fields (the server merges them) and puts the previous document back if the
 * save fails — rethrowing, so the page can say so.
 */
export function useViewerSettingsSection<K extends MergedSection>(section: K) {
  const { user } = useAuth();
  const viewerId = user?.id;
  const client = useQueryClient();
  const query = useViewerSettings();
  const update = useCallback(
    async (patch: Partial<NonNullable<UserSettingsResponse[K]>>) => {
      const queryKey = viewerQueryKeys.settings(viewerId);
      await client.cancelQueries({ queryKey });
      const previous = client.getQueryData<UserSettingsResponse>(queryKey);
      updateCachedViewerSettings(client, viewerId, (current) => ({
        ...current,
        [section]: { ...current[section], ...patch },
      }));
      try {
        await saveViewerSettings(viewerId, { [section]: patch }, client);
      } catch (error) {
        client.setQueryData(queryKey, previous);
        throw error;
      }
    },
    [client, viewerId, section],
  );
  const value = (query.data?.[section] ?? EMPTY_SECTION) as Partial<
    NonNullable<UserSettingsResponse[K]>
  >;
  return { value, isLoading: query.isLoading, update };
}
