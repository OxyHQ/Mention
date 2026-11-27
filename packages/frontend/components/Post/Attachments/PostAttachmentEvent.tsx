import React from 'react';

import {
  Card,
  Group,
  RawText,
  VStack,
  type ViewModifier,
  defineModifier,
  defineTokens,
  view,
} from '@oxy.so/bloom-language';

const eventColors = defineTokens({ color: { hexfff: '#fff' } });

/** The card's own frame: 200pt wide, at least 140 tall. */
const eventFrame = defineModifier((v) => v.frame({ width: '200', minHeight: '140' }));

interface PostAttachmentEventProps {
  name: string;
  date: string; // ISO date string or Date object
  location?: string;
  onPress?: () => void;
  /** The caller's frame (the row's cell, its full width when the event is alone) in place of the card's own. */
  look?: ViewModifier;
  /** Spread the date block and the details from end to end (a card filling its caller's cell). */
  spread?: boolean;
}

const PostAttachmentEvent = view(function PostAttachmentEvent({
  name,
  date,
  location,
  onPress,
  look,
  spread = false,
}: PostAttachmentEventProps) {
  // Parse date and format
  const eventDate = React.useMemo(() => {
    try {
      const d = typeof date === 'string' ? new Date(date) : date;
      if (isNaN(d.getTime())) return null;
      return d;
    } catch {
      return null;
    }
  }, [date]);

  const day = eventDate ? eventDate.getDate() : null;
  const month = eventDate ? eventDate.toLocaleString('default', { month: 'short' }) : null;
  const year = eventDate ? eventDate.getFullYear() : null;
  const time = eventDate
    ? eventDate.toLocaleTimeString('default', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      })
    : null;

  // Bloom's `Card` owns the surface (border, card fill, corner, clip) and,
  // given `onPress`, the press dip; without one it is a plain, inert view. It
  // lays the date block and the details out in a row.
  const card = Card(
    VStack(
      day !== null
        ? Group(
            RawText(day)
              .font('28')
              .leading('32px')
              .weight('bold')
              .foreground(eventColors.color.hexfff),
            month
              ? RawText(month)
                  .font('11')
                  .weight('semibold')
                  .foreground('white')
                  .textCase('uppercase')
                  .margin('top', '2xs')
              : null,
            year
              ? RawText(year)
                  .opacity('90')
                  .font('2xs')
                  .weight('medium')
                  .foreground('white')
                  .margin('top', '2xs')
              : null,
          )
        : null,
    )
      .padding('vertical', 'md')
      .padding('horizontal', 'sm')
      .frame({ width: '5xl' })
      .background('primary')
      .align('center')
      .justify('center'),
    VStack(
      RawText(name)
        .foreground('foreground')
        .font('md')
        .weight('semibold')
        .margin('bottom', 'xs')
        .leading('20px')
        .lines(2),
      time
        ? RawText(time).foreground('muted').font('xs').leading('16px').margin('bottom', 'xs')
        : null,
      location
        ? RawText(RawText('📍', ' '), RawText(location))
            .foreground('muted')
            .font('11')
            .margin('top', '2xs')
            .lines(1)
        : null,
    )
      .padding('all', 'md')
      .flex('1')
      .justify('center'),
  )
    .style('outline')
    .radius('lg')
    .axis('horizontal')
    .modifier(look ?? eventFrame);
  return (spread ? card.justify('between') : card).onPress(onPress);
});

export default PostAttachmentEvent;
