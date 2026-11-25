import type { ReactNode } from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';
import { FollowButton } from '@/components/FollowButton';
import { AccountAvatar } from '@/components/ui/AccountAvatar';
import { PressableScale } from '@oxy.so/bloom/pressable-scale';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { getUserPlaceholderColor } from '@/utils/userPlaceholderColor';
import { useResolvedProfileIdentity, type ProfileCardData } from './ProfileCard';
import UserName from './UserName';

import { Embed, Text, VStack, toElement, defineModifier } from '@oxy.so/bloom-language';

const AVATAR_SIZE = 64;

/**
 * Two lines of bio, reserved even when there is none, so every tile in a row
 * puts its Follow button at the same height.
 */
const BIO_LINES = 2;
const BIO_LINE_HEIGHT = 18;

/** The tile's identity: the name on a 20pt line over a 13/18 handle, across the tile. */
const IDENTITY_NAME = defineModifier((v) => v.leading('20px'));
const IDENTITY_HANDLE = defineModifier((v) => v.font('sm').leading('18px'));
const IDENTITY_COLUMN = defineModifier((v) => v.alignSelf('stretch'));
/** The skeleton's lines, at the identity's type sizes. */
const SKELETON_LINES = StyleSheet.create({
  name: { fontSize: 15, fontWeight: '700', lineHeight: 20 },
  handle: { fontSize: 13, lineHeight: 18 },
});

/** The tile, as `flex-1 items-center gap-2` drew it. */
const TILE_STYLE: ViewStyle = {
  flexGrow: 1,
  flexShrink: 1,
  flexBasis: '0%',
  alignItems: 'center',
  gap: 8,
};

const styles = StyleSheet.create({
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
  const { resolved, handle, nameLabel, press } = useResolvedProfileIdentity(profile, onPress);
  const bio = resolved.description?.trim();

  return toElement(
    VStack(
      // Bloom's PressableScale as JSX: an inert tile (no route) is a pressable with no role,
      // which a language press host cannot be (it names itself a button).
      Embed((render) => (
        <PressableScale
          onPress={press}
          disabled={!press}
          accessibilityRole={press ? 'link' : undefined}
          style={TILE_STYLE}
        >
          <AccountAvatar
            account={resolved}
            source={resolved.avatar || undefined}
            size={AVATAR_SIZE}
            variant={MEDIA_VARIANT_AVATAR}
            verified={resolved.verified}
            placeholderColor={getUserPlaceholderColor(resolved)}
          />
          {render(
            UserName({
              name: nameLabel,
              handle: handle || undefined,
              verified: resolved.verified,
              isFederated: resolved.isFederated,
              kind: resolved.kind,
              isAgent: resolved.isAgent,
              isAutomated: resolved.isAutomated,
              align: 'center',
              look: IDENTITY_COLUMN,
              nameLook: IDENTITY_NAME,
              handleLook: IDENTITY_HANDLE,
            }),
          )}
          {render(
            // BIO_LINES lines of BIO_LINE_HEIGHT (18px), the box held at both (36) when shorter.
            Text(bio ?? '')
              .foreground('muted')
              .textAlign('center')
              .font('sm')
              .leading('18px')
              .alignSelf('stretch')
              .frame({ minHeight: '36' })
              .lines(BIO_LINES),
          )}
        </PressableScale>
      )),
      Embed(
        <FollowButton
          userId={resolved.id}
          username={handle || undefined}
          size="sm"
          style={styles.followButton}
          onFollowChange={onFollowChange}
        />,
      ),
      Embed(accessory),
    )
      .padding('all', 'md')
      .background('card')
      .border('border', 'thin')
      .corner('md')
      .flex('1')
      .spacing('md'),
  );
}

/**
 * The loading placeholder for {@link SuggestedProfileCard}, with the same
 * geometry, so the row never shifts when the real tiles land.
 */
export function SuggestedProfileCardSkeleton() {
  return toElement(
    VStack(
      VStack(
        Embed(<Skeleton.Circle size={AVATAR_SIZE} />),
        Embed(<Skeleton.Text style={[SKELETON_LINES.name, { width: 110 }]} />),
        Embed(<Skeleton.Text style={[SKELETON_LINES.handle, { width: 80 }]} />),
        Embed(
          <Skeleton.Col
            style={{ gap: 0, alignItems: 'center', minHeight: BIO_LINES * BIO_LINE_HEIGHT }}
          >
            <Skeleton.Text style={{ width: 130, fontSize: 13, lineHeight: BIO_LINE_HEIGHT }} />
            <Skeleton.Text style={{ width: 90, fontSize: 13, lineHeight: BIO_LINE_HEIGHT }} />
          </Skeleton.Col>,
        ),
      )
        .align('center')
        .spacing('sm'),
      Embed(<Skeleton.Pill size={32} style={{ alignSelf: 'stretch' }} />),
    )
      .padding('all', 'md')
      .background('card')
      .border('border', 'thin')
      .corner('md')
      .spacing('md'),
  );
}
