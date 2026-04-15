import React from 'react';
import { View, Text, ViewStyle, Platform } from 'react-native';
import PollCard from '../PollCard';
import { MEDIA_CARD_WIDTH } from '@/utils/composeUtils';

const webGrabCursorStyle: ViewStyle | null = Platform.OS === 'web'
  ? ({ cursor: 'grab' } as unknown as ViewStyle)
  : null;

interface PostAttachmentPollProps {
  pollId?: string;
  pollData?: {
    question: string;
    options: string[];
  };
  style?: ViewStyle;
}

const PostAttachmentPoll: React.FC<PostAttachmentPollProps> = ({ pollId, pollData, style }) => {
  return (
    <View
      className="border border-border rounded-[15px] overflow-hidden w-[280px]"
      style={[webGrabCursorStyle, style]}
    >
      {pollId ? (
        // Use interactive PollCard when we have a pollId
        <PollCard pollId={pollId} width={MEDIA_CARD_WIDTH} />
      ) : pollData ? (
        // Fallback to simple display if we only have poll data without ID
        <View className="bg-secondary p-4 rounded-[15px]">
          <Text className="text-foreground text-base font-bold mb-3">{pollData.question}</Text>
          {pollData.options?.map((option: string, optIdx: number) => (
            <View key={optIdx} className="bg-background border border-border p-3 rounded-lg mb-2">
              <Text className="text-foreground text-sm">{option}</Text>
            </View>
          ))}
        </View>
      ) : (
        // Debug: Show what we received
        <View className="bg-secondary p-4 rounded-[15px]">
          <Text className="text-destructive text-base font-bold mb-3">
            {process.env.NODE_ENV === 'development' ? 'Poll data missing' : 'Poll unavailable'}
          </Text>
        </View>
      )}
    </View>
  );
};

export default PostAttachmentPoll;
