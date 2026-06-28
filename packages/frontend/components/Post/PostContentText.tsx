import React from 'react';
import { StyleSheet, Text } from 'react-native';
import LinkifiedText from '../common/LinkifiedText';
import { useRouter, usePathname } from 'expo-router';
import { PostContent } from '@mention/shared-types';
import { useAppearanceStore } from '@/store/appearanceStore';

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
  const postTextExpand = useAppearanceStore((s) => s.mySettings?.appearance?.postTextExpand) ?? 'default';
  // An explicit `previewChars` prop from a caller always wins; otherwise the
  // viewer's display preference picks the threshold.
  const effectivePreviewChars = previewChars ?? PREVIEW_CHARS[postTextExpand];
  // Extract text from content (handle both string and PostContent object)
  const originalText = typeof content === 'string' ? content : content?.text || '';
  const rawText = translatedText || originalText;

  // Strip trailing URL when a link attachment card already shows it
  const textContent = linkPreviewUrl
    ? rawText.replace(TRAILING_URL_RE, (match, url) => url === linkPreviewUrl ? '' : match)
    : rawText;

  if (!textContent) return null;

  const isDetailPage = pathname?.startsWith('/p');
  // `all` maps to Infinity, so `length > Infinity` is always false \u2014 never truncates.
  const shouldTruncate = !isDetailPage && textContent.length > effectivePreviewChars;
  const displayed = shouldTruncate ? `${textContent.slice(0, effectivePreviewChars).trimEnd()}\u2026` : textContent;

  const suffix = shouldTruncate && postId ? (
    <Text className="text-primary" onPress={() => router.push(`/p/${postId}`)}>
      {' Read more'}
    </Text>
  ) : null;

  return (
    <LinkifiedText
      text={displayed}
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
