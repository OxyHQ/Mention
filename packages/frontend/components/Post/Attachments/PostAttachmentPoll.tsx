import React from 'react';
import { View, Text, StyleSheet, ViewStyle, Platform } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import PollCard from '../PollCard';

const webGrabCursorStyle: ViewStyle | null = Platform.OS === 'web'
  ? ({ cursor: 'grab' } as unknown as ViewStyle)
  : null;

const CARD_WIDTH = 280;

interface PostAttachmentPollProps {
  pollId?: string;
  pollData?: {
    question: string;
    options: string[];
  };
  style?: ViewStyle;
}

const PostAttachmentPoll: React.FC<PostAttachmentPollProps> = ({ pollId, pollData, style }) => {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.itemContainer,
        webGrabCursorStyle,
        styles.pollWrapper,
        { borderColor: theme.colors.border },
        style,
      ]}
    >
      {pollId ? (
        // Use interactive PollCard when we have a pollId
        <PollCard pollId={pollId} width={CARD_WIDTH} />
      ) : pollData ? (
        // Fallback to simple display if we only have poll data without ID
        <View style={[styles.pollContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
          <Text style={[styles.pollQuestion, { color: theme.colors.text }]}>{pollData.question}</Text>
          {pollData.options?.map((option: string, optIdx: number) => (
            <View key={optIdx} style={[styles.pollOption, { backgroundColor: theme.colors.background, borderColor: theme.colors.border }]}>
              <Text style={[styles.pollOptionText, { color: theme.colors.text }]}>{option}</Text>
            </View>
          ))}
        </View>
      ) : (
        // Debug: Show what we received
        <View style={[styles.pollContainer, { backgroundColor: theme.colors.backgroundSecondary }]}>
          <Text style={[styles.pollQuestion, { color: theme.colors.error }]}>
            {process.env.NODE_ENV === 'development' ? 'Poll data missing' : 'Poll unavailable'}
          </Text>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  itemContainer: {
    borderWidth: 1,
    borderRadius: 15,
    overflow: 'hidden',
  },
  pollWrapper: {
    width: CARD_WIDTH,
  },
  pollContainer: {
    padding: 16,
    borderRadius: 15,
  },
  pollQuestion: {
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  pollOption: {
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
  },
  pollOptionText: {
    fontSize: 14,
  },
});

export default PostAttachmentPoll;

