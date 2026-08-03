import React, { memo } from 'react';
import { View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@oxyhq/bloom/theme';
import { ZoomableAvatar } from '@/components/ZoomableAvatar';
import { PrivateBadge } from './PrivateBadge';
import type { ChannelActionsProps, ChannelHeaderProps } from './types';

/**
 * A CHANNEL's profile header: name on the left, a 70px avatar on the right.
 *
 * The compact shape is not a style preference — it is what a channel IS. There
 * is no banner because `UpdateAccountInput` has no banner field to set, so the
 * layout has no band for one rather than an empty band; and the avatar does not
 * collapse on scroll because there is no banner for it to overlap in the first
 * place. This used to be `ProfileHeaderMinimalist`, selected by a
 * `design.minimalistMode` flag that was itself defined as `kind === 'channel'` —
 * a layout name for an account fact, which is exactly the confusion this split
 * removes.
 */
export const ChannelHeader = memo(function ChannelHeader({
  displayName,
  username,
  avatarUri,
  verified,
  isPrivate,
  privacySettings,
  UserNameComponent,
  trailingBadge,
}: ChannelHeaderProps) {
  const theme = useTheme();
  return (
    <View className="flex-row justify-between items-start mb-4 relative w-full gap-4">
      <View className="flex-1">
        <UserNameComponent
          name={displayName}
          handle={username}
          verified={false}
          // Not a guess and not a conditional: this component only ever draws a
          // channel (the route canonicalizes anything else away before it
          // renders), so the marker states what the page is. It stays INERT —
          // `AccountBadge` has no explainer for a channel to open, and the page
          // itself is the explanation.
          kind="channel"
          variant="default"
          trailingBadge={trailingBadge}
          style={{
            name: { fontSize: 24, fontWeight: 'bold' as const, marginTop: 10, marginBottom: 4 },
            handle: { fontSize: 15, marginBottom: 12 },
            container: undefined,
          }}
        />
        {isPrivate && <PrivateBadge privacySettings={privacySettings} />}
      </View>
      {/* No live badge and no presence dot, and neither is an omission: both
          report on a SESSION, and `isActAsEligibleKind` refuses `channel`, so no
          session can ever have one as its subject. A channel cannot be online
          and cannot host a live room — the states could not occur, rather than
          being hidden. */}
      <View className="relative">
        <ZoomableAvatar
          source={avatarUri}
          size={70}
          className="border-[3px] border-background bg-secondary"
          style={{ width: 70, height: 70, borderRadius: 35 }}
          imageStyle={{}}
        />
        {verified && (
          <View
            className="absolute rounded-[10px] p-0.5 bg-background"
            style={{ left: -6, bottom: -2 }}
          >
            <Ionicons name="checkmark-circle" size={18} color={theme.colors.primary} />
          </View>
        )}
      </View>
    </View>
  );
});

/**
 * The follow control under a channel's header.
 *
 * There is no poke here, and its absence is structural rather than suppressed: a
 * poke is addressed to a person, and a channel account can never be signed in as
 * (`isActAsEligibleKind` refuses the kind), so no human is ever at the other end
 * to receive one. The row could not exist, which is why this component simply
 * does not render one rather than hiding it behind a flag.
 *
 * There is no self view either. `isOwnProfile` is unreachable for a channel for
 * the same reason — nobody is signed in as one — so an "Edit profile" branch
 * would be dead code. An OPERATOR configures a channel from
 * `/c/<handle>/settings`, reached from the profile's overflow menu.
 */
export const ChannelActions = memo(function ChannelActions({
  profileId,
  isFollowing,
  FollowButtonComponent,
}: ChannelActionsProps) {
  if (!profileId) return null;
  return (
    <View className="flex-row items-center gap-3">
      <FollowButtonComponent userId={profileId} initiallyFollowing={isFollowing} />
    </View>
  );
});
