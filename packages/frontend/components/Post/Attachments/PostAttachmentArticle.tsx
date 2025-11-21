import React from 'react';
import { TouchableOpacity, View, Text, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

interface PostAttachmentArticleProps {
  title?: string;
  body?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

const PostAttachmentArticle: React.FC<PostAttachmentArticleProps> = ({ title, body, onPress, style }) => {
  const theme = useTheme();
  const trimmedTitle = title?.trim();
  const trimmedBody = body?.trim();

  return (
    <TouchableOpacity
      style={[styles.container, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }, style]}
      activeOpacity={0.85}
      onPress={onPress}
      disabled={!onPress}
    >
      <Text style={[styles.title, { color: theme.colors.text }]} numberOfLines={2}>
        {trimmedTitle || 'Untitled article'}
      </Text>
      {trimmedBody ? (
        <Text style={[styles.body, { color: theme.colors.textSecondary }]} numberOfLines={3}>
          {trimmedBody}
        </Text>
      ) : null}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: {
    width: 200,
    minHeight: 140,
    borderWidth: 1,
    borderRadius: 14,
    padding: 16,
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  body: {
    fontSize: 13,
    lineHeight: 18,
  },
});

export default PostAttachmentArticle;

