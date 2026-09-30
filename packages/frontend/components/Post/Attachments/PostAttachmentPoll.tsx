import React from 'react';
import { View, Text, ViewStyle, Platform } from 'react-native';
import { cn } from '@/lib/utils';
import PollCard from '../PollCard';
import { IS_DEVELOPMENT } from '@/config';

const webGrabCursorStyle: ViewStyle | null = Platform.OS === 'web'
  ? ({ cursor: 'grab' } as unknown as ViewStyle)
  : null;

interface PostAttachmentPollProps {
  pollId?: string;
  pollData?: {
    question: string;
    options: string[];
  };
  /** Layout classes: `w-full` alone in the row, the card width and row height beside others. */
  className?: string;
  style?: ViewStyle;
}

const PostAttachmentPoll: React.FC<PostAttachmentPollProps> = ({ pollId, pollData, className = 'w-[280px]', style }) => {
  // A live poll draws its own surface (`PollCard` is a Bloom `Card`); only the
  // static fallbacks below keep a hand-drawn frame. They are what the feed's
  // row-cost harness mounts for a poll row, and a `Card` there would add hook
  // slots to every poll row against a budget with no headroom.
  if (pollId) {
    return (
      <View className={className} style={[webGrabCursorStyle, style]}>
        <PollCard pollId={pollId} />
      </View>
    );
  }

  return (
    <View
      className={cn('border border-border rounded-[15px] overflow-hidden', className)}
      style={[webGrabCursorStyle, style]}
    >
      {pollData ? (
        // Fallback to simple display if we only have poll data without ID
        <View className="flex-1 bg-muted p-4">
          <Text className="text-foreground text-base font-bold mb-3">{pollData.question}</Text>
          {pollData.options?.map((option: string, optIdx: number) => (
            <View key={optIdx} className="bg-card border border-border p-3 rounded-lg mb-2">
              <Text className="text-foreground text-sm">{option}</Text>
            </View>
          ))}
        </View>
      ) : (
        // Debug: Show what we received
        <View className="bg-muted p-4 rounded-[15px]">
          <Text className="text-destructive text-base font-bold mb-3">
            {IS_DEVELOPMENT ? 'Poll data missing' : 'Poll unavailable'}
          </Text>
        </View>
      )}
    </View>
  );
};

export default PostAttachmentPoll;
