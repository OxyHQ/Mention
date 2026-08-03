import React, { memo } from 'react';
import { View } from 'react-native';
import { ZoomableAvatar } from '@/components/ZoomableAvatar';
import { showChannelInfo } from '@/components/Channels/ChannelInfoDialog';
import { PrivateBadge } from './PrivateBadge';
import type { ChannelActionsProps, ChannelHeaderProps } from './types';

/**
 * The avatar's edge-to-edge footprint.
 *
 * Exported because `ProfileSkeleton` draws the placeholder that this avatar
 * replaces, and a skeleton exists to hold the EXACT box the real content lands
 * in. Two copies of this number is a layout shift at the moment the data
 * arrives — the one thing the skeleton is there to prevent — so the two read the
 * same constant rather than agreeing by convention.
 */
export const CHANNEL_AVATAR_SIZE = 96;

/**
 * A CHANNEL's profile header: a CENTRED masthead — the avatar on top, then the
 * name, then the handle, then the follow control, each centred under the last.
 *
 * The centring is composed for what a channel page IS rather than inherited
 * from the person page. A person's header is asymmetric because it has a banner
 * to hang off: the avatar is pinned left and pulled up to overlap the band, and
 * the controls fill the space beside it. `UpdateAccountInput` has no banner
 * field, so a channel has no band, and the person layout with the band deleted
 * leaves an avatar pushed to one side of a row that no longer has anything on
 * the other — an alignment that was a consequence of the banner, kept after the
 * banner was gone. With nothing to overlap, the avatar is the top of the page,
 * and the top of a page with no other anchor is its centre. (This is why the
 * header is its own component at all: it used to be `ProfileHeaderMinimalist`,
 * chosen by a `design.minimalistMode` flag that was itself defined as
 * `kind === 'channel'` — a layout name for an account fact. Nothing here should
 * become a flag on the person header again.)
 *
 * WHAT IS CENTRED STOPS AT THE FOLLOW BUTTON, and the boundary is deliberate.
 * Below it `ProfileContent` renders the bio, the joined/location row, the stats,
 * the links and the communities, all left-aligned, sharing one gutter with the
 * tab strip and the feed rows beneath them. Two reasons that body does not
 * follow the masthead:
 *
 *  - The bio is PROSE, and centred ragged prose gives the eye no fixed left edge
 *    to return to. It also carries inline links and a "Read more" toggle, which
 *    centring would park at a different x on every channel.
 *  - The stats row is a denser rendering of the TAB STRIP — its cells are jump
 *    links that scroll to the posts and boosts tabs, or navigate to the follower
 *    lists. Keeping it on the same left gutter as the strip it points into keeps
 *    that relationship legible; centred, it would float free of the thing it
 *    controls.
 *
 * The column needs no `max-width` of its own, and that is measured rather than
 * assumed. The shell caps the center panel long before the viewport does, and
 * the panel is WIDEST in the middle of the range rather than at the end:
 * measured in a browser, a 1600px viewport gives a 592px panel while a 900px
 * one gives 817px (the RightBar is gone by then, so the center takes the room).
 * 817px is the worst case a centred masthead ever sees, and it reads fine.
 * A `max-width` would not move anything anyway — every item in the stack is
 * intrinsically sized and centred — it would only shift the axis they centre on.
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
  return (
    <View className="items-center w-full">
      {/* No live badge and no presence dot, and neither is an omission: both
          report on a SESSION, and `isActAsEligibleKind` refuses `channel`, so no
          session can ever have one as its subject. A channel cannot be online
          and cannot host a live room — the states could not occur, rather than
          being hidden. */}
      <ZoomableAvatar
        source={avatarUri}
        size={CHANNEL_AVATAR_SIZE}
        className="border-[3px] border-background bg-secondary"
        style={{
          width: CHANNEL_AVATAR_SIZE,
          height: CHANNEL_AVATAR_SIZE,
          borderRadius: CHANNEL_AVATAR_SIZE / 2,
        }}
        imageStyle={{}}
      />
      <UserNameComponent
        name={displayName}
        handle={username}
        // Inline, next to the name, rather than the corner badge this header
        // used to pin to the avatar. That badge was positioned against the
        // avatar's left edge — coherent only while the avatar sat at the right
        // end of a row — and it drew `checkmark-circle` from Ionicons where
        // every other identity surface in the app draws the shared
        // `VerifiedIcon` through `UserName`. Inline also puts it beside the
        // channel marker below, so the two facts about this identity read as
        // one cluster instead of two conventions.
        verified={verified}
        // Not a guess and not a conditional: this component only ever draws a
        // channel (the route canonicalizes anything else away before it
        // renders), so the marker states what the page is.
        kind="channel"
        // THE opt-in, and the only one. A channel is an unfamiliar kind of
        // account, and this is the one screen where a reader who wants to know
        // what it is has room for the answer — everywhere else the marker sits
        // in a row that is already a tap going somewhere, so it stays inert
        // there (see `AccountBadge`). The handler is channel-specific on
        // purpose: it cannot reach the fediverse explainer, nor that one this.
        onExplainChannel={showChannelInfo}
        align="center"
        variant="default"
        trailingBadge={trailingBadge}
        style={{
          name: { fontSize: 24, fontWeight: 'bold' as const, marginTop: 12, marginBottom: 4 },
          handle: { fontSize: 15 },
          container: undefined,
        }}
      />
      {/* `PrivateBadge` is `self-start`, which would pull it to the left edge of
          this centred column. The wrapper shrinks to the badge's own width, so
          starting inside it and being centred are the same position. */}
      {isPrivate && (
        <View className="mt-1">
          <PrivateBadge privacySettings={privacySettings} />
        </View>
      )}
    </View>
  );
});

/**
 * The follow control under a channel's header — centred, as the last element of
 * the masthead above it.
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
    <View className="flex-row items-center justify-center gap-3">
      <FollowButtonComponent userId={profileId} initiallyFollowing={isFollowing} />
    </View>
  );
});
