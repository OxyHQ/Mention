import React from 'react';
import { useTranslation } from 'react-i18next';
import { OxyAuthPrompt, useAuth } from '@oxyhq/services/ui/client';

import { Loading } from '@oxyhq/bloom/loading';
import { ThemedView } from '@/components/ThemedView';
import ProfileScreen from '@/components/ProfileScreen';

/**
 * The viewer's OWN profile, as a tab.
 *
 * A tab needs a route that does not change from one viewer to the next, and
 * `/@<handle>` is not one — a tab navigator's route set is fixed at build time,
 * while that URL only exists once somebody has signed in. So the tab is `/you`,
 * and the account it renders comes from the session rather than from a
 * `[username]` segment: it is handed down as an ordinary `username` prop, the
 * same way the `[username]` routes hand down the one they read from the URL.
 *
 * `/@<handle>` is untouched and keeps every one of its jobs: it is the URL a
 * post row links every author to, the app's catch-all for unknown single-segment
 * paths, and the route family `canonicalProfileHref` reconciles against. Your own
 * profile is therefore reachable both ways, exactly as it is on Instagram — the
 * tab, and a pushed copy when you arrive at it through a link.
 *
 * NATIVE ONLY, and the route file never says so — the bar simply does not point
 * here on web. There the profile page is split in two: the chrome (banner,
 * summary, tab strip) belongs to the `[username]` LAYOUT and only the tab's
 * content is the routed screen, so a `/you` rendering `ProfileScreen` would
 * produce a profile with no chrome at all. Web also has no tab navigator (see
 * `(tabs)/_layout.tsx`), so a static route buys it nothing either — which is why
 * `profileTabHrefForPlatform` sends web straight to `/@<handle>`, the URL the
 * sidebar has always used. This route used to answer that by rendering a
 * `<Redirect>`, and chaining a redirect onto a tab press is what broke the tab.
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

  return <ProfileScreen username={user.username} />;
}
