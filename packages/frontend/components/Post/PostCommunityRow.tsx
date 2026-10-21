import React from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { RiGroupLine } from '@oxy.so/bloom/icons/RiGroupLine';
import { Text } from '@oxy.so/bloom/typography';
import { Link, type Href } from '@/lib/navigation/router';
import { ProfileHoverCard } from '../ProfileHoverCard';
import { POST_CONTEXT_ROW_HEIGHT } from './postContextRowLayout';

/**
 * "in !technology@lemmy.world" — the community a federated post was written in.
 *
 * The post is its writer's: the byline is theirs and this row only says where
 * they posted it, the way Lemmy names a community (`!name@instance`). It links
 * to the community's profile, which lists its posts.
 */

interface Props {
  /** The community's canonical handle (`post.community`, normalized). */
  handle: string;
  /** Its profile, or null when it has no route. */
  href: Href | null;
  /** Colour for the leading glyph, from the active theme. */
  iconColor: string;
}

const PostCommunityRow: React.FC<Props> = ({ handle, href, iconColor }) => {
  const { t } = useTranslation();

  const label = (
    <Text className="text-muted-foreground text-[13px] font-semibold" numberOfLines={1}>
      {t('post.inCommunity', { handle })}
    </Text>
  );

  return (
    <ProfileHoverCard username={handle}>
      <View className="flex-row items-center" style={{ height: POST_CONTEXT_ROW_HEIGHT }}>
        <View className="-ml-4 mr-[3px]">
          <RiGroupLine width={13} height={13} fill={iconColor} />
        </View>
        {href ? (
          // The row lives inside the post's own press target: opening the
          // community must not open the post underneath it as well.
          <Link href={href} push asChild onPress={(event) => event.stopPropagation()}>
            {label}
          </Link>
        ) : (
          label
        )}
      </View>
    </ProfileHoverCard>
  );
};

export default React.memo(PostCommunityRow);
