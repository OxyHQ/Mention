import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '@/assets/icons/close-icon';
import PostSources from './PostSources';
import { PostSourceLink } from '@mention/shared-types';
import { IconButton } from '@/components/ui/Button';
import { EmptyState } from '@/components/common/EmptyState';

interface PostSourcesSheetProps {
  sources: PostSourceLink[];
  onClose: () => void;
}

const PostSourcesSheet: React.FC<PostSourcesSheetProps> = ({ sources, onClose }) => {
  const theme = useTheme();
  const { t } = useTranslation();

  const hasSources = sources.length > 0;

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}> 
        <IconButton variant="icon" onPress={onClose} style={styles.closeButton}>
          <CloseIcon size={20} color={theme.colors.text} />
        </IconButton>
        <Text style={[styles.title, { color: theme.colors.text }]}>
          {t('post.sourcesSheet.title', { defaultValue: 'Sources' })}
        </Text>
        <View style={styles.headerRight} />
      </View>

      <View style={styles.body}>
        {hasSources ? (
          <PostSources sources={sources} />
        ) : (
          <EmptyState
            title={t('post.sourcesSheet.empty', { defaultValue: 'No sources available for this post.' })}
            icon={{
              name: 'link-outline',
              size: 48,
            }}
            containerStyle={[styles.emptyState, { backgroundColor: theme.colors.backgroundSecondary }]}
          />
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingBottom: 24,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    minHeight: 48,
    borderBottomWidth: 1,
  },
  title: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '700',
    pointerEvents: 'none',
  },
  closeButton: {
    marginRight: 6,
    zIndex: 1,
  },
  headerRight: {
    width: 36,
    height: 36,
    marginLeft: 'auto',
  },
  body: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  emptyState: {
    flex: 1,
  },
});

export default PostSourcesSheet;

