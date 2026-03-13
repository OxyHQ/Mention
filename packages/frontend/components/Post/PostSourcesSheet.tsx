import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
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
  const { t } = useTranslation();

  const hasSources = sources.length > 0;

  return (
    <View className="flex-1 pb-6 bg-background">
      <View className="flex-row items-center px-4 py-2 min-h-[48px] border-b border-border">
        <IconButton variant="icon" onPress={onClose} style={styles.closeButton}>
          <CloseIcon size={20} className="text-foreground" />
        </IconButton>
        <Text className="absolute left-0 right-0 text-center text-lg font-bold text-foreground" style={{ pointerEvents: 'none' }}>
          {t('post.sourcesSheet.title', { defaultValue: 'Sources' })}
        </Text>
        <View style={styles.headerRight} />
      </View>

      <View className="flex-1 px-4 pt-4">
        {hasSources ? (
          <PostSources sources={sources} />
        ) : (
          <EmptyState
            title={t('post.sourcesSheet.empty', { defaultValue: 'No sources available for this post.' })}
            icon={{
              name: 'link-outline',
              size: 48,
            }}
            containerStyle={{ flex: 1 }}
            className="bg-surface"
          />
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  closeButton: {
    marginRight: 6,
    zIndex: 1,
  },
  headerRight: {
    width: 36,
    height: 36,
    marginLeft: 'auto',
  },
});

export default PostSourcesSheet;
