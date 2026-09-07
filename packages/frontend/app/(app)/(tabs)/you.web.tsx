import React from 'react';
import { Redirect } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { OxyAuthPrompt, useAuth } from '@oxyhq/services/ui/client';

import { Loading } from '@oxyhq/bloom/loading';
import { ThemedView } from '@/components/ThemedView';

/**
 * `/you` on WEB, where the bottom bar does not point here.
 *
 * `tabHref` sends a signed-in reader straight to `/@<handle>` — the profile
 * chrome lives in the `[username]` layout, so that is the only URL on web that
 * can draw a whole profile, and it is where the sidebar has always pointed. This
 * route is therefore reached only by someone who typed it or followed an old
 * link, and its whole job is to be the two things `/@<handle>` cannot be:
 *
 *  - SIGNED OUT it is the sign-in prompt, because there is no handle to send to.
 *    That is also the href `tabHref` hands the bar in that state.
 *  - SIGNED IN it is a canonical redirect for a URL nobody links to any more.
 *
 * The redirect is deliberately NOT on the tab's path. It used to be, and chaining
 * it onto a tab press is what stopped the profile tab opening: `dismissAll`'s
 * `POP_TO_TOP` and `navigate`'s link do not compose, because the queue computes
 * the link's action against a tree the pop has already changed.
 */
export default function YouTabWeb() {
  const { t } = useTranslation();
  const { user, isAuthResolved, isAuthenticated } = useAuth();

  // Cold-boot SSO restore takes seconds; deciding "signed out" before it lands
  // would flash the sign-in prompt at a viewer whose session is about to return.
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

  return <Redirect href={`/@${user.username}`} />;
}
