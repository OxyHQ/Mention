import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { colors } from '../../styles/colors';
import LinkifiedText from '../common/LinkifiedText';
import { useRouter, usePathname } from 'expo-router';
import { PostContent } from '@mention/shared-types';
import { useTheme } from '@/hooks/useTheme';

interface Props {
  content?: string | PostContent; // Support both legacy string and new PostContent object
  postId?: string;
  previewChars?: number;
}

const PostContentText: React.FC<Props> = ({ content, postId, previewChars = 280 }) => {
  const router = useRouter();
  const pathname = usePathname();
  const theme = useTheme();

  // Extract text from content (handle both string and PostContent object)
  const textContent = typeof content === 'string' ? content : content?.text || '';

  if (!textContent) return null;

  const isDetailPage = pathname?.startsWith('/p');
  const shouldTruncate = !isDetailPage && textContent.length > previewChars;
  const displayed = shouldTruncate ? `${textContent.slice(0, previewChars).trimEnd()}…` : textContent;

  const suffix = shouldTruncate && postId ? (
    <Text style={[styles.link, { color: theme.colors.primary }]} onPress={() => router.push(`/p/${postId}`)}>
      {' Read more'}
    </Text>
  ) : null;

  return (
    <LinkifiedText text={displayed} style={[styles.postText, { color: theme.colors.text }]} linkStyle={[styles.link, { color: theme.colors.primary }]} suffix={suffix} />
  );
};

export default PostContentText;

const styles = StyleSheet.create({
  postText: {
    fontSize: 15,
    color: "#E7E9EA",
    lineHeight: 20,
  },
  link: {
    color: "#d169e5",
  },
});
