import { useMemo } from 'react';
import { type Href } from 'expo-router';
import { getNormalizedUserHandle } from '@oxyhq/core';
import type { AppColorName } from '@oxyhq/bloom/theme';
import { useProfileData, type ProfileData } from '@/hooks/useProfileData';
import { useProfileScreenColor } from '@/hooks/useProfileScreenColor';
import { canonicalProfileHref, type ProfileRouteFamily } from '../profileRoute';

export interface ProfileAccount {
  /** The handle this account was looked up by, with any leading `@` stripped. */
  username: string;
  /** The canonical handle — `user` locally, `user@domain` when federated. */
  handle: string;
  isFederated: boolean;
  profileData: ProfileData | null;
  loading: boolean;
  /** Bloom colour preset for the profile's scope. */
  colorName: AppColorName | undefined;
}

/**
 * Resolving WHICH account a handle names, for both `/@<handle>` and
 * `/c/<handle>`.
 *
 * Deliberately one hook rather than one per screen. The two screens are separate
 * because a channel and a person are different things to READ, but they are the
 * same thing to LOOK UP: one federated-handle rule, one Oxy fetch, one colour
 * scope.
 *
 * It takes the handle as a VALUE and never reads the URL. Its caller is a route,
 * and a route knows its own segment (`useRoutedProfileUsername`) — while the one
 * caller that has a handle and no segment, the `/you` tab, is then not a special
 * case at all. When this hook went and found its own `[username]` it could only
 * serve that caller through an override parameter, which had to double as "and
 * do not canonicalize" as well; both went away with the coupling that caused
 * them.
 */
export function useProfileAccount(routedUsername: string): ProfileAccount {
  const username = routedUsername.startsWith('@') ? routedUsername.slice(1) : routedUsername;

  // A federated handle carries its instance in the segment itself. Channels are
  // local-only accounts, so this can only ever be true on the person route — but
  // it is read the same way on both, because the rule belongs to the handle, not
  // to the screen.
  const isFederated = username.includes('@');
  const { data: profileData, loading } = useProfileData(username);
  const { colorName } = useProfileScreenColor({
    username,
    designColor: profileData?.design?.color,
  });

  const handle = useMemo<string>(
    () =>
      getNormalizedUserHandle({
        username: profileData?.username || username,
        instance: profileData?.instance,
        isFederated: profileData?.isFederated,
      }) || username,
    [profileData?.username, profileData?.instance, profileData?.isFederated, username],
  );

  return { username, handle, isFederated, profileData, loading, colorName };
}

export interface ProfileCanonicalHrefOptions {
  /**
   * Which route FILE is mounted. It says nothing about what the account is —
   * that comes back as `profileData.kind`, and this is how the two are
   * reconciled.
   */
  routedFamily: ProfileRouteFamily;
  account: ProfileAccount;
  /** The sub-surface this screen is, when it is not the profile root. */
  subpath?: string;
}

/**
 * Where a reader sitting on this URL family belongs instead, or `null` when they
 * are already right.
 *
 * SEPARATE from the lookup above, because it is a separate question and only
 * some callers can be asked it. "The family this reader is on disagrees with the
 * account's kind" presupposes that the reader is ON a family, which is true of
 * `/@<handle>` and `/c/<handle>` and of nothing else. The `/you` tab is not a
 * member of either, so it simply does not call this — where before it had to
 * pass a flag that turned canonicalization off, or a viewer whose own account is
 * a `channel` would have been redirected off their own tab the moment it
 * resolved.
 */
export function useProfileCanonicalHref({
  routedFamily,
  account,
  subpath,
}: ProfileCanonicalHrefOptions): Href | null {
  return canonicalProfileHref({
    routedFamily,
    kind: account.profileData?.kind,
    handle: account.handle,
    resolved: Boolean(account.profileData),
    subpath,
  });
}
