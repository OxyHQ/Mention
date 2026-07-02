import React from 'react';
import { StyleSheet, Text } from 'react-native';
import LinkifiedText from '../common/LinkifiedText';
import { useRouter, usePathname } from 'expo-router';
import { PostContent } from '@mention/shared-types';
import { useAppearanceStore } from '@/store/appearanceStore';
import { useExpandableText } from '@/hooks/useExpandableText';
import { useTranslation } from 'react-i18next';

interface Props {
  content?: string | PostContent;
  postId?: string;
  previewChars?: number;
  translatedText?: string | null;
  linkPreviewUrl?: string | null;
}

const TRAILING_URL_RE = /\s*(https?:\/\/[^\s]+|www\.[^\s]+)\s*$/;

/** In-feed truncation thresholds (chars) per the `postTextExpand` preference. */
const PREVIEW_CHARS = { default: 280, more: 600, muchMore: 1200, all: Infinity } as const;

const PostContentText: React.FC<Props> = ({ content, postId, previewChars, translatedText, linkPreviewUrl }) => {
  const router = useRouter();
  const pathname = usePathname();
  const { t } = useTranslation();
  const postTextExpand = useAppearanceStore((s) => s.mySettings?.appearance?.postTextExpand) ?? 'default';
  const postReadMoreAction = useAppearanceStore((s) => s.mySettings?.appearance?.postReadMoreAction) ?? 'openPost';
  const effectivePreviewChars = previewChars ?? PREVIEW_CHARS[postTextExpand];
  const originalText = typeof content === 'string' ? content : content?.text || '';
  const rawText = translatedText || originalText;

  const textContent = linkPreviewUrl
    ? rawText.replace(TRAILING_URL_RE, (match, url) => url === linkPreviewUrl ? '' : match)
    : rawText;

  const isDetailPage = pathname?.startsWith('/p');
  // On the detail page, never truncate — feed it Infinity so the hook is a no-op.
  // `postReadMoreAction` is passed as the reset key so toggling it in Settings
  // (or reusing this component for different content) collapses back to false.
  const { displayText, isTruncated, isExpanded, toggle } = useExpandableText(
    textContent,
    isDetailPage ? Infinity : effectivePreviewChars,
    postReadMoreAction
  );

  if (!textContent) return null;

  const suffix = isTruncated && postId ? (
    postReadMoreAction === 'expandInline' ? (
      <Text className="text-primary" onPress={toggle}>
        {isExpanded ? ` ${t('common.showLess', 'Show less')}` : ' Read more'}
      </Text>
    ) : (
      <Text className="text-primary" onPress={() => router.push(`/p/${postId}`)}>
        {' Read more'}
      </Text>
    )
  ) : null;

  return (
    <LinkifiedText
      text={displayText}
      style={styles.postText}
      className="text-foreground"
      suffix={suffix}
    />
  );
};

export default PostContentText;

const styles = StyleSheet.create({
  postText: {
    fontSize: 15,
    lineHeight: 20,
  },
});
