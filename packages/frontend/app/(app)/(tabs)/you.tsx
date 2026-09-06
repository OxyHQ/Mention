import React from 'react';
import { Platform } from 'react-native';
import { Redirect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { OxyAuthPrompt, useAuth } from '@oxyhq/services/ui/client';

import { Loading } from '@oxyhq/bloom/loading';
import { ThemedView } from '@/components/ThemedView';
import ProfileScreen from '@/components/ProfileScreen';

const IS_WEB = Platform.OS === 'web';

/**
 * The viewer's OWN profile, as a tab.
 *
 * A tab needs a route that does not change from one viewer to the next, and
 * `/@<handle>` is not one — a tab navigator's route set is fixed at build time,
 * while that URL only exists once somebody has signed in. So the tab is `/you`,
 * and the account it renders comes from the session rather than from a
 * `[username]` segment (`usernameOverride`, documented on `useProfileAccount`).
 *
 * `/@<handle>` is untouched and keeps every one of its jobs: it is the URL a
 * post row links every author to, the app's catch-all for unknown single-segment
 * paths, and the route family `canonicalProfileHref` reconciles against. Your own
 * profile is therefore reachable both ways, exactly as it is on Instagram — the
 * tab, and a pushed copy when you arrive at it through a link.
 *
 * WEB REDIRECTS instead of rendering. On web the profile page is split in two —
 * the chrome (banner, summary, tab strip) belongs to the `[username]` LAYOUT and
 * only the tab's content is the routed screen, so that switching profile tabs
 * cannot unmount the chrome (`components/Profile/ProfileChromeFrame.web.tsx`
 * carries the measurement: 597ms of blank chrome when it did). Rendering
 * `ProfileScreen` here on web would produce a profile with no chrome at all, and
 * a second copy of that layout is precisely the duplication that file exists to
 * prevent. Web has no tab navigator either (see `(tabs)/_layout.tsx`), so there
 * is nothing a `/you` route buys there. `<Redirect>` replaces rather than
 * pushes, so it costs no history entry.
 */
export default function YouTab() {
  const { t } = useTranslation();
  const { user, isAuthResolved, isAuthenticated } = useAuth();

  // Cold-boot SSO restore takes seconds; deciding "signed out" before it lands
  // would flash the sign-in prompt at a viewer whose session is about to
  // return. Same rule as the anon CTA in `app/(app)/_layout.tsx`.
  if (!isAuthResolved) {
    return (
      <ThemedView className="flex-1 justify-center items-center">
        <Loading className="text-primary" size="large" />
      </ThemedView>
    );
  }

  if (!isAuthenticated || !user?.username) {
    return (
      <OxyAuthPrompt
        label={t('profile.signInRequired', { defaultValue: 'Sign in to see your profile' })}
        description={t('profile.signInRequiredDesc', {
          defaultValue: 'Your posts, replies and saved items live here once you sign in.',
        })}
      />
    );
  }

  if (IS_WEB) {
    return <Redirect href={`/@${user.username}`} />;
  }

  return <ProfileScreen usernameOverride={user.username} />;
}
