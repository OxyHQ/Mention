import React, { useCallback } from 'react';
import { GestureResponderEvent, Pressable, Text } from 'react-native';
import { useRouter } from 'expo-router';
import type { LaneSummary } from '@mention/shared-types';
import { HIT_SLOP_MD } from '@/styles/hitSlop';

/**
 * The widest the chip may grow before it starts truncating. A lane name can be
 * 40 characters (`MAX_LANE_NAME_LENGTH`); at the identity line's 15px that is far
 * wider than the row can spare, and an uncapped chip pushes the `@handle` out
 * before the flex shrink ever gets a say.
 */
const MAX_CHIP_WIDTH = 140;

/**
 * How hard the chip yields when the identity line runs out of room.
 *
 * The row's shrink ranks are: display name `0`, `@handle` `10`, the time slot
 * `0`. The chip is the LEAST important thing on that line — it names a
 * carriageway, not a person or a moment — so it shrinks harder than the handle
 * and gives up its space first. `minWidth: 0` is what lets it shrink below its
 * intrinsic width at all.
 */
const CHIP_SHRINK = 20;

interface Props {
  /** The lane this post is on, straight off `post.lane`. */
  lane: LaneSummary;
  /** Normalized handle of the post's author — the first segment of the lane tab's URL. */
  authorHandle: string;
  /**
   * The descriptor of the feed this row is rendered in, when it is in one. A row
   * inside the lane's OWN tab suppresses the chip: every row there is on that
   * lane, so the label would be one repeated line of noise.
   */
  feedDescriptor?: string;
}

/**
 * `› Lane name` — the author's own carriageway for this post, in the identity
 * line right after the time.
 *
 * It is a LENS, not a destination: the post is an ordinary post and the chip
 * changes nothing about it. So the chip is quiet (muted, one line, truncating)
 * and it only becomes tappable when there is somewhere to go — `displayMode:
 * 'tab'` is the one mode with a tab of its own. A `mixed` lane's posts already
 * sit on the main profile tab and a `hidden` lane has no profile surface at all,
 * so both render as plain text rather than a link that would 404 or, worse, open
 * a tab the owner deliberately took away.
 *
 * Two suppressions live elsewhere, with the data that decides them: `PostItem`
 * does not render this at all on a boost row or a collaborative-authorship
 * header, where the identity line is already saying something more important
 * about who published the post.
 */
const PostLaneChip: React.FC<Props> = ({ lane, authorHandle, feedDescriptor }) => {
  const router = useRouter();

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      // The chip lives inside the post's own press target: opening the lane tab
      // must never open the post detail underneath it.
      event.stopPropagation?.();
      router.push(`/@${authorHandle}/lane/${lane.id}`);
    },
    [router, authorHandle, lane.id],
  );

  if (feedDescriptor === `lane|${lane.id}`) return null;

  const label = `› ${lane.name}`;
  const canOpenTab = lane.displayMode === 'tab' && authorHandle.length > 0;

  if (!canOpenTab) {
    return (
      <Text
        className="text-muted-foreground text-[15px] leading-tight"
        style={{ flexShrink: CHIP_SHRINK, minWidth: 0, maxWidth: MAX_CHIP_WIDTH }}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {label}
      </Text>
    );
  }

  return (
    <Pressable
      onPress={handlePress}
      hitSlop={HIT_SLOP_MD}
      accessibilityRole="link"
      accessibilityLabel={lane.name}
      style={{ flexShrink: CHIP_SHRINK, minWidth: 0, maxWidth: MAX_CHIP_WIDTH }}
    >
      <Text
        className="text-muted-foreground text-[15px] leading-tight"
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {label}
      </Text>
    </Pressable>
  );
};

export default React.memo(PostLaneChip);
