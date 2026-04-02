import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { ChevronUpIcon } from '@/assets/icons/chevron-up-icon';
import { ChevronDownIcon } from '@/assets/icons/chevron-down-icon';
import { useTheme } from '@oxyhq/bloom/theme';
import { useHaptics } from '@/hooks/useHaptics';
import { formatCompactNumber } from '@/utils/formatNumber';
import { PressableScale } from '@/lib/animations/PressableScale';

const ARROW_SIZE = 18;

interface VotePillProps {
  likeCount: number;
  downvoteCount: number;
  isLiked: boolean;
  isDownvoted: boolean;
  onUpvote: () => void;
  onDownvote: () => void;
}

const VotePill: React.FC<VotePillProps> = ({
  likeCount,
  downvoteCount,
  isLiked,
  isDownvoted,
  onUpvote,
  onDownvote,
}) => {
  const theme = useTheme();
  const haptic = useHaptics();

  const netScore = likeCount - downvoteCount;

  const upColor = isLiked ? theme.colors.primary : theme.colors.textSecondary;
  const downColor = isDownvoted ? theme.colors.error : theme.colors.textSecondary;

  return (
    <View
      className="border-border bg-secondary"
      style={styles.pill}
    >
      <PressableScale
        style={styles.arrowButton}
        onPress={() => {
          haptic('Light');
          onUpvote();
        }}
        hitSlop={{ top: 5, bottom: 5, left: 5, right: 0 }}
        accessibilityLabel={isLiked ? 'Remove upvote' : 'Upvote'}
      >
        <ChevronUpIcon size={ARROW_SIZE} color={upColor} />
      </PressableScale>

      {netScore !== 0 && (
        <Text
          className={
            isLiked
              ? "text-primary"
              : isDownvoted
                ? "text-destructive"
                : "text-muted-foreground"
          }
          style={[
            styles.score,
            { fontWeight: isLiked || isDownvoted ? '600' : '400' },
          ]}
        >
          {formatCompactNumber(netScore)}
        </Text>
      )}

      <PressableScale
        style={styles.arrowButton}
        onPress={() => {
          haptic('Light');
          onDownvote();
        }}
        hitSlop={{ top: 5, bottom: 5, left: 0, right: 5 }}
        accessibilityLabel={isDownvoted ? 'Remove downvote' : 'Downvote'}
      >
        <ChevronDownIcon size={ARROW_SIZE} color={downColor} />
      </PressableScale>
    </View>
  );
};

export default VotePill;

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 2,
  },
  arrowButton: {
    paddingHorizontal: 4,
    paddingVertical: 4,
  },
  score: {
    fontSize: 13,
    minWidth: 16,
    textAlign: 'center',
  },
});
