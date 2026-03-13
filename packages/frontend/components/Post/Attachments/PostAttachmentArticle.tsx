import React from 'react';
import { TouchableOpacity, Text, StyleProp, ViewStyle } from 'react-native';
import { cn } from '@/lib/utils';

interface PostAttachmentArticleProps {
  title?: string;
  body?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  className?: string;
}

const PostAttachmentArticle: React.FC<PostAttachmentArticleProps> = ({ title, body, onPress, style, className }) => {
  const trimmedTitle = title?.trim();
  const trimmedBody = body?.trim();

  return (
    <TouchableOpacity
      className={cn('w-[200px] min-h-[140px] border border-border bg-card rounded-[14px] p-4 justify-between', className)}
      style={style}
      activeOpacity={0.85}
      onPress={onPress}
      disabled={!onPress}
    >
      <Text className="text-foreground text-lg font-bold mb-3" numberOfLines={2}>
        {trimmedTitle || 'Untitled article'}
      </Text>
      {trimmedBody ? (
        <Text className="text-muted-foreground text-[13px] leading-[18px]" numberOfLines={3}>
          {trimmedBody}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
};

export default PostAttachmentArticle;
