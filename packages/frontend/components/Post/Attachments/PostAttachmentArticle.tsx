import type React from 'react';
import { TouchableOpacity, type StyleProp, type ViewStyle } from 'react-native';
import { cn } from '@/lib/utils';

import { RawText, toElement } from '@oxy.so/bloom-language';

interface PostAttachmentArticleProps {
  title?: string;
  body?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  className?: string;
}

const PostAttachmentArticle: React.FC<PostAttachmentArticleProps> = ({
  title,
  body,
  onPress,
  style,
  className,
}) => {
  const trimmedTitle = title?.trim();
  const trimmedBody = body?.trim();

  return (
    <TouchableOpacity
      className={cn(
        'w-[200px] min-h-[140px] border border-border bg-card rounded-[14px] p-4 justify-between',
        className,
      )}
      style={style}
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
