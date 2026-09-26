import React from 'react';
import { Text, StyleProp, ViewStyle } from 'react-native';
import { Card } from '@oxy.so/bloom/card';
import { cn } from '@/lib/utils';

interface PostArticlePreviewProps {
  title?: string;
  body?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  className?: string;
}

const PostArticlePreview: React.FC<PostArticlePreviewProps> = ({ title, body, onPress, style, className }) => {
  const trimmedTitle = title?.trim();
  const trimmedBody = body?.trim();

  return (
    // Bloom's outlined card owns the chrome (card fill, 1px border, corner); a
    // card with no `onPress` renders as a plain view, as the disabled touchable did.
    <Card
      variant="outlined"
      radius="radius-16"
      className={cn('w-[200px] min-h-[140px] p-4 justify-between', className)}
      style={style}
      onPress={onPress}
    >
      <Text className="text-foreground text-lg font-bold mb-3" numberOfLines={2}>
        {trimmedTitle || 'Untitled article'}
      </Text>
      {trimmedBody ? (
        <Text className="text-muted-foreground text-[13px] leading-[18px]" numberOfLines={3}>
          {trimmedBody}
        </Text>
      ) : null}
    </Card>
  );
};

export default PostArticlePreview;
