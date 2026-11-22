import type React from 'react';
import { View, type ViewStyle, Platform } from 'react-native';
import { cn } from '@/lib/utils';
import PollCard from '../PollCard';
import { IS_DEVELOPMENT } from '@/config';

import { Embed, RawText, VStack, toElement } from '@oxy.so/bloom-language';

const webGrabCursorStyle: ViewStyle | null =
  Platform.OS === 'web' ? ({ cursor: 'grab' } as unknown as ViewStyle) : null;

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

const PostAttachmentPoll: React.FC<PostAttachmentPollProps> = ({
  pollId,
  pollData,
  className = 'w-[280px]',
  style,
}) => {
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
        toElement(
          VStack(
            RawText(pollData.question)
              .foreground('foreground')
              .font('16')
              .leading('normal')
              .weight('bold')
              .margin('bottom', 'md'),
            Embed(
              pollData.options?.map((option: string, optIdx: number) => (
                <View key={optIdx} className="bg-card border border-border p-3 rounded-lg mb-2">
                  {toElement(RawText(option).foreground('foreground').font('14').leading('20px'))}
                </View>
              )),
            ),
          )
            .padding('all', 'lg')
            .background('mutedFill')
            .flex('1'),
        )
      ) : (
        // Debug: Show what we received
        <View className="bg-muted p-4 rounded-[15px]">
          {toElement(
            RawText(IS_DEVELOPMENT ? 'Poll data missing' : 'Poll unavailable')
              .foreground('destructive')
              .font('16')
              .leading('normal')
              .weight('bold')
              .margin('bottom', 'md'),
          )}
        </View>
      )}
    </View>
  );
};

export default PostAttachmentPoll;
