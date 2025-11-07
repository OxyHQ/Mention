import React from 'react';
import { TouchableOpacity, View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';

interface PostArticlePreviewProps {
  title?: string;
  body?: string;
  onPress?: () => void;
}

const PostArticlePreview: React.FC<PostArticlePreviewProps> = ({ title, body, onPress }) => {
  const theme = useTheme();
  const trimmedTitle = title?.trim();
  const trimmedBody = body?.trim();

  return (
    <TouchableOpacity
      style={[styles.container, { borderColor: theme.colors.border, backgroundColor: theme.colors.card }]}
      activeOpacity={0.85}
      onPress={onPress}
      disabled={!onPress}
    >
      <View style={[styles.badge, { backgroundColor: theme.colors.backgroundSecondary }]}>
        <Text style={[styles.badgeText, { color: theme.colors.primary }]}>Article</Text>
      </View>
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
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.05)',
    marginBottom: 12,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
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

export default PostArticlePreview;

