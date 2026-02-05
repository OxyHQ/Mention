import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from '@/assets/icons/close-icon';
import { IconButton } from '@/components/ui/Button';
import { articleService } from '@/services/articleService';

interface PostArticleSheetProps {
  articleId?: string;
  title?: string;
  body?: string;
  onClose: () => void;
}

const PostArticleSheet: React.FC<PostArticleSheetProps> = ({ articleId, title, body, onClose }) => {
  const theme = useTheme();
  const { t } = useTranslation();

  const [articleTitle, setArticleTitle] = useState<string | undefined>(title);
  const [articleBody, setArticleBody] = useState<string | undefined>(body);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(articleId && !body));
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;
    if (articleId && !body) {
      setIsLoading(true);
      setLoadError(null);
      articleService.getArticle(articleId)
        .then((article) => {
          if (!isMounted) return;
          setArticleTitle(article.title || title);
          setArticleBody(article.body || body);
        })
        .catch((error) => {
          console.error('Failed to load article content:', error);
          if (isMounted) {
            setLoadError(t('post.articleSheet.loadError', { defaultValue: 'Failed to load article.' }));
          }
        })
        .finally(() => {
          if (isMounted) {
            setIsLoading(false);
          }
        });
    } else {
      setArticleTitle(title);
      setArticleBody(body);
    }

    return () => {
      isMounted = false;
    };
  }, [articleId, body, title, t]);

  const trimmedTitle = useMemo(() => articleTitle?.trim(), [articleTitle]);
  const trimmedBody = useMemo(() => articleBody?.trim(), [articleBody]);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}
    >
      <View style={[styles.header, { borderBottomColor: theme.colors.border }]}>
        <IconButton variant="icon" onPress={onClose} style={styles.closeButton}>
          <CloseIcon size={20} color={theme.colors.text} />
        </IconButton>
        <Text style={[styles.headerTitle, { color: theme.colors.text }, { pointerEvents: 'none' }]}>
          {t('post.articleSheet.title', { defaultValue: 'Article' })}
        </Text>
        <View style={styles.headerRight} />
      </View>

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <Loading size="small" />
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <Text style={[styles.articleTitle, { color: theme.colors.text }]}>
            {trimmedTitle || t('post.articleSheet.untitled', { defaultValue: 'Untitled article' })}
          </Text>
          {trimmedBody ? (
            <Text style={[styles.articleBody, { color: theme.colors.textSecondary }]}>
              {trimmedBody}
            </Text>
          ) : loadError ? (
            <Text style={[styles.articleBodyPlaceholder, { color: theme.colors.error }]}>
              {loadError}
            </Text>
          ) : (
            <Text style={[styles.articleBodyPlaceholder, { color: theme.colors.textSecondary }]}>
              {t('post.articleSheet.emptyBody', { defaultValue: 'No content provided.' })}
            </Text>
          )}
        </ScrollView>
      )}
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
  closeButton: {
    marginRight: 6,
    zIndex: 1,
  },
  headerTitle: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    fontSize: 18,
    fontWeight: '700',
    pointerEvents: 'none',
  },
  headerRight: {
    width: 36,
    height: 36,
    marginLeft: 'auto',
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 20,
    paddingBottom: 40,
    gap: 16,
  },
  articleTitle: {
    fontSize: 24,
    fontWeight: '700',
    lineHeight: 30,
  },
  articleBody: {
    fontSize: 15,
    lineHeight: 22,
  },
  articleBodyPlaceholder: {
    fontSize: 14,
    fontStyle: 'italic',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
});

export default PostArticleSheet;

