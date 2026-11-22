import type React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { Card } from '@oxy.so/bloom/card';

import { RawText, toElement } from '@oxy.so/bloom-language';

interface PostArticlePreviewProps {
  title?: string;
  body?: string;
  onPress?: () => void;
  /** The caller's size over the card's own 200pt width. */
  style?: StyleProp<ViewStyle>;
}

const styles = StyleSheet.create({
  card: { width: 200, minHeight: 140, padding: 16, justifyContent: 'space-between' },
});

const PostArticlePreview: React.FC<PostArticlePreviewProps> = ({ title, body, onPress, style }) => {
  const trimmedTitle = title?.trim();
  const trimmedBody = body?.trim();

  return (
    // Bloom's outlined card owns the chrome (card fill, 1px border, corner); a
    // card with no `onPress` renders as a plain view, as the disabled touchable did.
    <Card radius="radius-16" style={[styles.card, style]} onPress={onPress} appearance="outline">
      {toElement(
        RawText(trimmedTitle || 'Untitled article')
          .foreground('foreground')
          .font('18')
          .leading('28px')
          .weight('bold')
          .margin('bottom', 'md')
          .lines(2),
      )}
      {trimmedBody
        ? toElement(RawText(trimmedBody).foreground('muted').font('sm').leading('18px').lines(3))
        : null}
    </Card>
  );
};

export default PostArticlePreview;
