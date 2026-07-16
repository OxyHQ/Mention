import { useState, useEffect, useCallback } from 'react';
import { authenticatedClient, isUnauthorizedError, isNotFoundError } from '@/utils/api';
import { useAuth } from '@oxyhq/services';
import { createScopedLogger } from '@/lib/logger';
import type { UserSettingsResponse } from '@/hooks/usePrivacySettings';

const logger = createScopedLogger('useFediversePreferredLanguage');

/**
 * The author's default PRIMARY content language — a Mention `UserSettings` field
 * (`fediversePreferredLanguage`, canonical BCP-47) read from `GET /profile/settings/me`
 * and written to `PUT /profile/settings`. It seeds the composer's primary language
 * and is what a post federates as (`content.variants[0]`).
 *
 * `preferredLanguage`: `undefined` while the setting is still resolving, `null`
 * once resolved with no preference set, or the tag string. Reads are gated on
 * `canUsePrivateApi` (the SSO cold-boot window) so they never fire a 401.
 */
export function useFediversePreferredLanguage() {
  const { isAuthenticated, isAuthResolved, canUsePrivateApi, isPrivateApiPending, user } = useAuth();
  const viewerId = user?.id;
  const [preferredLanguage, setPreferredLanguage] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!isAuthResolved || isPrivateApiPending) {
      return;
    }
    if (!canUsePrivateApi) {
      setPreferredLanguage(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const response = await authenticatedClient.get<UserSettingsResponse>('/profile/settings/me');
      setPreferredLanguage(response.data?.fediversePreferredLanguage ?? null);
    } catch (error: unknown) {
      if (!isUnauthorizedError(error) && !isNotFoundError(error)) {
        logger.debug('Could not load fediverse preferred language', { error });
      }
      setPreferredLanguage(null);
    } finally {
      setLoading(false);
    }
    // `isAuthenticated` is a dependency so the per-user setting loads once the SSO
    // session resolves on cold boot — keying on it alone would fetch while anon and
    // never recover.
  }, [canUsePrivateApi, isAuthResolved, isAuthenticated, isPrivateApiPending]);

  /** Writes the preference. Pass `null` to clear it (fall back to detection). */
  const updatePreferredLanguage = useCallback(
    async (tag: string | null): Promise<void> => {
      if (!canUsePrivateApi) {
        throw new Error('Sign in to update your preferred language');
      }
      const response = await authenticatedClient.put<UserSettingsResponse>('/profile/settings', {
        fediversePreferredLanguage: tag,
      });
      setPreferredLanguage(response.data?.fediversePreferredLanguage ?? tag ?? null);
    },
    [canUsePrivateApi],
  );

  useEffect(() => {
    load();
    // `viewerId` covers account switches; `load` re-runs the fetch when the auth
    // session resolves (its identity changes with `isAuthenticated`).
  }, [load, viewerId]);

  return { preferredLanguage, loading, updatePreferredLanguage, reload: load };
}
