import type React from 'react';
import { Text, type StyleProp, type ViewStyle } from 'react-native';
import { Card } from '@oxy.so/bloom/card';

const cardStyle: ViewStyle = {
  width: 200,
  minHeight: 140,
  padding: 16,
  justifyContent: 'space-between',
};

interface PostArticlePreviewProps {
  title?: string;
  body?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

const PostArticlePreview: React.FC<PostArticlePreviewProps> = ({ title, body, onPress, style }) => {
  const trimmedTitle = title?.trim();
  const trimmedBody = body?.trim();

  return (
    // Bloom's outlined card owns the chrome (card fill, 1px border, corner); a
    // card with no `onPress` renders as a plain view, as the disabled touchable did.
    <Card radius="radius-16" style={[cardStyle, style]} onPress={onPress} appearance="outline">
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
