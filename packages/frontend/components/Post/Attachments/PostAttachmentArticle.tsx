import type React from 'react';
import { TouchableOpacity, type StyleProp, type ViewStyle } from 'react-native';
import { createTokenStyles } from '@oxy.so/bloom/theme';

import { RawText, toElement } from '@oxy.so/bloom-language';

interface PostAttachmentArticleProps {
  title?: string;
  body?: string;
  onPress?: () => void;
  /** The cell's size from the row; a 200pt-wide card by default. */
  style?: StyleProp<ViewStyle>;
}

// A touchable card (its press dims it): the language's press variant has no
// timed opacity, so the touchable keeps its own style.
const useStyles = createTokenStyles((t) => ({
  card: {
    width: 200,
    minHeight: 140,
    borderWidth: 1,
    borderColor: t.border,
    backgroundColor: t.card,
    borderRadius: 14,
    padding: 16,
    justifyContent: 'space-between',
  },
}));

const PostAttachmentArticle: React.FC<PostAttachmentArticleProps> = ({
  title,
  body,
  onPress,
  style,
}) => {
  const styles = useStyles();
  const trimmedTitle = title?.trim();
  const trimmedBody = body?.trim();

  return (
    <TouchableOpacity
      style={[styles.card, style]}
      activeOpacity={0.85}
      onPress={onPress}
      disabled={!onPress}
    >
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
    </TouchableOpacity>
  );
};

export default PostAttachmentArticle;
