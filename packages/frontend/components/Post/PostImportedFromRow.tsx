import React from 'react';
import { type GestureResponderEvent, View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import { RiHistoryLine } from '@oxy.so/bloom/icons/RiHistoryLine';
import { openExternalLink } from '@/utils/openExternalLink';
import { POST_CONTEXT_ROW_HEIGHT } from './postContextRowLayout';

/**
 * "Originally posted on Mastodon" — the context row of a post its author
 * IMPORTED from another platform (Oxy Move).
 *
 * The post itself is an ordinary Mention post with its own replies and likes;
 * this only says where it was first published, and the label opens the original
 * permalink (through `openExternalLink`, the one safe way out of the app).
 *
 * Hook-free on purpose: it renders inside every feed row that carries
 * `post.importedFrom`, so the caller resolves the translated label and the row
 * adds no hook slots of its own.
 */

interface Props {
  /** The translated sentence, platform name included. */
  label: string;
  /** Straight off `post.importedFrom.sourceUrl` — the DTO, never a render prop. */
  sourceUrl: string;
  /** Colour for the leading glyph, from the active theme. */
  iconColor: string;
}

const PostImportedFromRow: React.FC<Props> = ({ label, sourceUrl, iconColor }) => {
  const openOriginal = (event: GestureResponderEvent) => {
    // The row lives inside the post's own press target: opening the original
    // must never also open the post detail underneath it.
    event.stopPropagation?.();
    void openExternalLink(sourceUrl);
  };

  return (
    <View className="flex-row items-center" style={{ height: POST_CONTEXT_ROW_HEIGHT }}>
      <View className="-ml-4 mr-[3px]">
        <RiHistoryLine width={13} height={13} fill={iconColor} />
      </View>
      <Text
        className="text-muted-foreground text-[13px] font-semibold"
        numberOfLines={1}
        ellipsizeMode="tail"
        accessibilityRole="link"
        accessibilityLabel={label}
        onPress={openOriginal}
      >
        {label}
      </Text>
    </View>
  );
};

export default React.memo(PostImportedFromRow);
