import { useMemo } from 'react';
import { useLocalSearchParams, type Href } from 'expo-router';
import { getNormalizedUserHandle } from '@oxyhq/core';
import type { AppColorName } from '@oxyhq/bloom/theme';
import { useProfileData, type ProfileData } from '@/hooks/useProfileData';
import { useProfileScreenColor } from '@/hooks/useProfileScreenColor';
import { canonicalProfileHref, type ProfileRouteFamily } from '../profileRoute';

export interface ProfileAccount {
  /** The `[username]` segment with a leading `@` stripped. */
  username: string;
  /** The canonical handle — `user` locally, `user@domain` when federated. */
  handle: string;
  isFederated: boolean;
  profileData: ProfileData | null;
  loading: boolean;
  /** Bloom colour preset for the profile's scope. */
  colorName: AppColorName | undefined;
  /** Where this reader belongs instead, or `null` when already canonical. */
  canonicalHref: Href | null;
}

/**
 * Resolving WHICH account a profile URL names, for both `/@<handle>` and
 * `/c/<handle>`.
 *
 * Deliberately one hook rather than one per screen. The two screens are separate
 * because a channel and a person are different things to READ, but they are the
 * same thing to LOOK UP: one `[username]` segment, one federated-handle rule, one
 * Oxy fetch, one colour scope, and — the piece that genuinely cannot be
 * duplicated — one canonicalization. Splitting the lookup as well is how the two
 * URL families end up disagreeing about what a handle means.
 *
 * `routedFamily` is the only thing a caller supplies, and it says which route
 * FILE is mounted, never what the account is. What the account is comes back in
 * `profileData.kind`, and `canonicalHref` is how the two are reconciled.
 */
export function useProfileAccount(
  routedFamily: ProfileRouteFamily,
  /** The sub-surface this screen is, when it is not the profile root. */
  subpath?: string,
  /**
   * The account to look up when the URL does not name one.
   *
   * The `/you` tab is the only caller: it is "the viewer's own profile", which
   * is a route with no `[username]` segment to read. Everything downstream —
   * the federated-handle rule, the Oxy fetch, the colour scope — is identical,
   * because none of it ever cared where the handle came from.
   *
   * It also suppresses canonicalization, and that is not a shortcut. `/you` is
   * not a member of either URL family, so "the family this reader is on
   * disagrees with the account's kind" is not a question it can be asked; a
   * viewer whose own account is a `channel` would otherwise be redirected off
   * their own tab to `/c/<handle>` the moment the account resolved.
   */
  usernameOverride?: string,
): ProfileAccount {
  const { username: urlUsername } = useLocalSearchParams<{ username: string }>();
  const routedUsername = usernameOverride ?? urlUsername;
  const username =
    (routedUsername?.startsWith('@') ? routedUsername.slice(1) : routedUsername) || '';

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

  const canonicalHref = usernameOverride
    ? null
    : canonicalProfileHref({
        routedFamily,
        kind: profileData?.kind,
        handle,
        resolved: Boolean(profileData),
        subpath,
      });

  return { username, handle, isFederated, profileData, loading, colorName, canonicalHref };
}
