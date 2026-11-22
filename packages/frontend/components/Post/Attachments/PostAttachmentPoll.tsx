import type React from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { createTokenStyles } from '@oxy.so/bloom/theme';
import PollCard from '../PollCard';
import { IS_DEVELOPMENT } from '@/config';

import { RawText, VStack, toElement } from '@oxy.so/bloom-language';

const webGrabCursorStyle: ViewStyle | null =
  Platform.OS === 'web' ? ({ cursor: 'grab' } as unknown as ViewStyle) : null;

interface PostAttachmentPollProps {
  pollId?: string;
  pollData?: {
    question: string;
    options: string[];
  };
  /** The cell's size: its full width alone in the row, the card width and row height beside others; 280pt wide by default. */
  style?: StyleProp<ViewStyle>;
}

const styles = StyleSheet.create({
  cell: { width: 280 },
});

// The static fallbacks' frame: a 15pt corner, which no corner token has.
const useFrameStyles = createTokenStyles((t) => ({
  frame: { borderWidth: 1, borderColor: t.border, borderRadius: 15, overflow: 'hidden' },
  missing: { backgroundColor: t.muted, padding: 16, borderRadius: 15 },
}));

const PostAttachmentPoll: React.FC<PostAttachmentPollProps> = ({
  pollId,
  pollData,
  style = styles.cell,
}) => {
  const frameStyles = useFrameStyles();
  // A live poll draws its own surface (`PollCard` is a Bloom `Card`); only the
  // static fallbacks below keep a hand-drawn frame. They are what the feed's
  // row-cost harness mounts for a poll row, and a `Card` there would add hook
  // slots to every poll row against a budget with no headroom.
  if (pollId) {
    return (
      <View style={[webGrabCursorStyle, style]}>
        <PollCard pollId={pollId} />
      </View>
    );
  }

  return (
    <View style={[frameStyles.frame, webGrabCursorStyle, style]}>
      {pollData ? (
        toElement(
          VStack(
            RawText(pollData.question)
              .foreground('foreground')
              .font('16')
              .leading('normal')
              .weight('bold')
              .margin('bottom', 'md'),
            pollData.options?.map((option: string, optIdx: number) =>
              VStack(RawText(option).foreground('foreground').font('14').leading('20px'))
                .padding('all', 'md')
                .background('card')
                .border('border', 'thin')
                .corner('lg')
                .margin('bottom', 'sm')
                .id(optIdx),
            ),
          )
            .padding('all', 'lg')
            .background('mutedFill')
            .flex('1'),
        )
      ) : (
        // Debug: Show what we received
        <View style={frameStyles.missing}>
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
