import React from 'react';
import { StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';
import { Card } from '@oxy.so/bloom/card';

import { Embed, RawText, VStack, toElement } from '@oxy.so/bloom-language';

interface PostAttachmentEventProps {
  name: string;
  date: string; // ISO date string or Date object
  location?: string;
  onPress?: () => void;
  /** The cell's size from the row (its full width when the event is alone). */
  style?: StyleProp<ViewStyle>;
}

// The card lays its date block and details out in a row, which the language's
// Card (a container with no stack layout) does not take: it keeps Bloom's Card.
const styles = StyleSheet.create({
  card: { width: 200, minHeight: 140, flexDirection: 'row' },
  // A 28pt day: no type step or numeric font token has that size.
  day: { fontSize: 28, fontWeight: '700', color: '#fff', lineHeight: 32 },
});

const PostAttachmentEvent: React.FC<PostAttachmentEventProps> = ({
  name,
  date,
  location,
  onPress,
  style,
}) => {
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

  return (
    // Bloom's `Card` owns the surface (border, card fill, corner, clip) and,
    // given `onPress`, the press dip; without one it is a plain, inert view.
    <Card radius="radius-16" style={[styles.card, style]} onPress={onPress} appearance="outline">
      {toElement(
        VStack(
          Embed(
            day !== null && (
              <>
                <Text style={styles.day}>{day}</Text>
                {month &&
                  toElement(
                    RawText(month)
                      .font('11')
                      .weight('semibold')
                      .foreground('white')
                      .textCase('uppercase')
                      .margin('top', '2xs'),
                  )}
                {year &&
                  toElement(
                    RawText(year)
                      .opacity('90')
                      .font('2xs')
                      .weight('medium')
                      .foreground('white')
                      .margin('top', '2xs'),
                  )}
              </>
            ),
          ),
        )
          .padding('vertical', 'md')
          .padding('horizontal', 'sm')
          .frame({ width: '5xl' })
          .background('primary')
          .align('center')
          .justify('center'),
      )}
      {toElement(
        VStack(
          RawText(name)
            .foreground('foreground')
            .font('md')
            .weight('semibold')
            .margin('bottom', 'xs')
            .leading('20px')
            .lines(2),
          Embed(
            time &&
              toElement(
                RawText(time).foreground('muted').font('xs').leading('16px').margin('bottom', 'xs'),
              ),
          ),
          Embed(
            location &&
              toElement(
                RawText(RawText('📍', ' '), RawText(location))
                  .foreground('muted')
                  .font('11')
                  .margin('top', '2xs')
                  .lines(1),
              ),
          ),
        )
          .padding('all', 'md')
          .flex('1')
          .justify('center'),
      )}
    </Card>
  );
};

export default PostAttachmentEvent;
