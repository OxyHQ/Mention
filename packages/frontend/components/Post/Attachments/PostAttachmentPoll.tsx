import PollCard from '../PollCard';
import { IS_DEVELOPMENT } from '@/config';

import { Embed, RawText, VStack, type ViewModifier, view } from '@oxy.so/bloom-language';

interface PostAttachmentPollProps {
  pollId?: string;
  pollData?: {
    question: string;
    options: string[];
  };
  /** The cell's frame from the row: its full width alone, the card width and row height beside others. */
  look: ViewModifier;
}

const PostAttachmentPoll = view(function PostAttachmentPoll({
  pollId,
  pollData,
  look,
}: PostAttachmentPollProps) {
  // A live poll draws its own surface (`PollCard` is a Bloom `Card`); only the
  // static fallbacks below keep a hand-drawn frame. They are what the feed's
  // row-cost harness mounts for a poll row, and a `Card` there would add hook
  // slots to every poll row against a budget with no headroom. On the web the
  // pointer is a hand that grabs, as the row scrolls by dragging.
  if (pollId) {
    return VStack(Embed(<PollCard pollId={pollId} />))
      .modifier(look)
      .cursor('grab');
  }

  return VStack(
    pollData
      ? VStack(
          RawText(pollData.question)
            .foreground('foreground')
            .font('16')
            .leading('normal')
            .weight('bold')
            .margin('bottom', 'md'),
          ...(pollData.options ?? []).map((option: string, optIdx: number) =>
            VStack(RawText(option).foreground('foreground').font('14').leading('20px'))
              .padding('all', 'md')
              .margin('bottom', 'sm')
              .background('card')
              .border('border', 'thin')
              .corner('lg')
              .id(optIdx),
          ),
        )
          .padding('all', 'lg')
          .background('mutedFill')
          .flex('1')
      : // Debug: Show what we received
        VStack(
          RawText(IS_DEVELOPMENT ? 'Poll data missing' : 'Poll unavailable')
            .foreground('destructive')
            .font('16')
            .leading('normal')
            .weight('bold')
            .margin('bottom', 'md'),
        )
          .padding('lg')
          .background('mutedFill')
          .corner('15'),
  )
    .modifier(look)
    .border('border', 'thin')
    .corner('15')
    .clipped()
    .cursor('grab');
});

export default PostAttachmentPoll;
