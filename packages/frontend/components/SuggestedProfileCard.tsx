import React, { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { FollowButton } from '@oxy.so/services/ui/client';
import { Avatar } from '@oxy.so/bloom/avatar';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { Text } from '@oxy.so/bloom/typography';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { getUserPlaceholderColor } from '@/utils/userPlaceholderColor';
import { useResolvedProfileIdentity, type ProfileCardData } from './ProfileCard';
import UserName from './UserName';

const AVATAR_SIZE = 64;

/**
 * Two lines of bio, reserved even when there is none, so every tile in a row
 * puts its Follow button at the same height.
 */
const BIO_LINES = 2;
const BIO_LINE_HEIGHT = 18;

const IDENTITY_TEXT_STYLES = StyleSheet.create({
  name: { fontSize: 15, fontWeight: '700', lineHeight: 20 },
  handle: { fontSize: 13, lineHeight: 18 },
  column: { gap: 0, alignSelf: 'stretch' },
});

const IDENTITY_STYLE = {
  name: IDENTITY_TEXT_STYLES.name,
  handle: IDENTITY_TEXT_STYLES.handle,
  container: IDENTITY_TEXT_STYLES.column,
};

const styles = StyleSheet.create({
  bio: { minHeight: BIO_LINES * BIO_LINE_HEIGHT, lineHeight: BIO_LINE_HEIGHT },
  followButton: { alignSelf: 'stretch' },
});

interface SuggestedProfileCardProps {
  profile: ProfileCardData;
  /** Overrides the default push to the profile. */
  onPress?: () => void;
  /** Called when the viewer follows or unfollows from this tile. */
  onFollowChange?: (isFollowing: boolean) => void;
  /** Overlaid in the top-right corner (the dismiss X). */
  accessory?: ReactNode;
}

/**
 * The person tile — one suggested account as a vertical card: avatar on top,
 * name and handle, two lines of bio, a full-width Follow button. It is the card
 * X and Instagram put in their "Who to follow" rows, and the feed's suggestion
 * carousels are its surface; lists of people keep the {@link ProfileCard} row.
 *
 * It resolves its identity exactly as the row does
 * ({@link useResolvedProfileIdentity}), so an edit made in this session and the
 * "Unknown user" fallback reach both the same way.
 *
 * The Follow button and the accessory are SIBLINGS of the pressable region, not
 * descendants: on web a real `<button>` would otherwise bubble its click into
 * the tile and navigate away.
 */
export function SuggestedProfileCard({
  profile,
  onPress,
  onFollowChange,
  accessory,
}: SuggestedProfileCardProps) {
  const router = useRouter();
  const { resolved, handle, nameLabel, hasHandle, href } = useResolvedProfileIdentity(profile);
  const canPress = Boolean(onPress) || hasHandle;
  const bio = resolved.description?.trim();

  const handlePress = () => {
    if (onPress) {
      onPress();
    } else if (href) {
      router.push(href);
    }
  };

  return (
    <View className="bg-card border-border flex-1 gap-3 rounded-xl border p-3">
      <PressableScale
        onPress={canPress ? handlePress : undefined}
        disabled={!canPress}
        accessibilityRole={canPress ? 'link' : undefined}
        className="flex-1 items-center gap-2">
        <Avatar
          source={resolved.avatar || undefined}
          size={AVATAR_SIZE}
          variant={MEDIA_VARIANT_AVATAR}
          verified={resolved.verified}
          placeholderColor={getUserPlaceholderColor(resolved)}
        />
        <UserName
          name={nameLabel}
          handle={handle || undefined}
          verified={resolved.verified}
          isFederated={resolved.isFederated}
          kind={resolved.kind}
          isAgent={resolved.isAgent}
          isAutomated={resolved.isAutomated}
          align="center"
          style={IDENTITY_STYLE}
        />
        <Text
          className="text-muted-foreground text-center text-[13px]"
          style={styles.bio}
          numberOfLines={BIO_LINES}>
          {bio ?? ''}
        </Text>
      </PressableScale>
      <FollowButton
        userId={resolved.id}
        username={handle || undefined}
        size="small"
        style={styles.followButton}
        onFollowChange={onFollowChange}
      />
      {accessory}
    </View>
  );
}

/**
 * The loading placeholder for {@link SuggestedProfileCard}, with the same
 * geometry, so the row never shifts when the real tiles land.
 */
export function SuggestedProfileCardSkeleton() {
  return (
    <View className="bg-card border-border gap-3 rounded-xl border p-3">
      <View className="items-center gap-2">
        <Skeleton.Circle size={AVATAR_SIZE} />
        <Skeleton.Text style={{ width: 110, fontSize: 15, lineHeight: 20 }} />
        <Skeleton.Text style={{ width: 80, fontSize: 13, lineHeight: 18 }} />
        <Skeleton.Col style={{ gap: 0, alignItems: 'center', minHeight: BIO_LINES * BIO_LINE_HEIGHT }}>
          <Skeleton.Text style={{ width: 130, fontSize: 13, lineHeight: BIO_LINE_HEIGHT }} />
          <Skeleton.Text style={{ width: 90, fontSize: 13, lineHeight: BIO_LINE_HEIGHT }} />
        </Skeleton.Col>
      </View>
      <Skeleton.Pill size={32} style={{ alignSelf: 'stretch' }} />
    </View>
  );
}
