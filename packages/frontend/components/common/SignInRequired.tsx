import React, { type ReactNode } from 'react';
import { View } from 'react-native';
import { Loading } from '@oxy.so/bloom/loading';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';

export interface SignInRequiredProps {
  /** The prompt's title, e.g. "Sign in to create a list". */
  label: string;
  description?: string;
  /**
   * What a signed-in reader sees. Omitted by a screen that has already branched
   * on `canUsePrivateApi` and only needs the pending/prompt half.
   */
  children?: ReactNode;
}

/**
 * The body of a screen that only means something with a session: the create
 * forms (lists, starter packs, channels, jobs, feeds, rooms) and the
 * directories of things the viewer owns.
 *
 * Signed out, such a screen used to render its form anyway, and the submit then
 * failed with a 401 the reader never saw. This is the same three-way gate the
 * Notifications and Saved screens use, in one place:
 *
 *   * a spinner while the SSO restore is still resolving (it can take several
 *     seconds on cold boot, and the prompt must not flash for a signed-in
 *     reader);
 *   * `OxyAuthPrompt` when the private API is unusable — `canUsePrivateApi`,
 *     never bare `isAuthenticated`, which is true before the session can make a
 *     private call;
 *   * the children otherwise.
 *
 * The screen keeps its own header, so Back still works from the prompt. Entry
 * points that START a create flow (a header "New" button, an empty state's
 * action) are hidden on `canUsePrivateApi` by their screen rather than routed
 * here, so a signed-out reader is not offered a button whose only outcome is
 * this prompt.
 */
export function SignInRequired({ label, description, children }: SignInRequiredProps) {
  const { isAuthResolved, isPrivateApiPending, canUsePrivateApi } = useAuth();

  if (!isAuthResolved || isPrivateApiPending) {
    return (
      <View className="flex-1 justify-center items-center" testID="sign-in-required-pending">
        <Loading className="text-primary" size="large" />
      </View>
    );
  }

  if (!canUsePrivateApi) {
    return <OxyAuthPrompt label={label} description={description} />;
  }

  return <>{children}</>;
}
