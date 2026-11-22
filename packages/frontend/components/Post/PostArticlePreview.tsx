import type React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Card } from '@oxy.so/bloom/card';
import { cn } from '@/lib/utils';

import { RawText, toElement } from '@oxy.so/bloom-language';

interface PostArticlePreviewProps {
  title?: string;
  body?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  className?: string;
}

const PostArticlePreview: React.FC<PostArticlePreviewProps> = ({
  title,
  body,
  onPress,
  style,
  className,
}) => {
  const trimmedTitle = title?.trim();
  const trimmedBody = body?.trim();

  return (
    // Bloom's outlined card owns the chrome (card fill, 1px border, corner); a
    // card with no `onPress` renders as a plain view, as the disabled touchable did.
    <Card
      radius="radius-16"
      className={cn('w-[200px] min-h-[140px] p-4 justify-between', className)}
      style={style}
      onPress={onPress}
      appearance="outline"
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
    </Card>
  );
};

export default PostArticlePreview;
