import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { colors } from '../../styles/colors';
import LinkifiedText from '../common/LinkifiedText';
import { useRouter, usePathname } from 'expo-router';

interface Props {
  content?: string;
  postId?: string;
  previewChars?: number;
}

const PostContentText: React.FC<Props> = ({ content, postId, previewChars = 280 }) => {
  const router = useRouter();
  const pathname = usePathname();
  if (!content) return null;

  const isDetailPage = pathname?.startsWith('/p');
  const shouldTruncate = !isDetailPage && content.length > previewChars;
  const displayed = shouldTruncate ? `${content.slice(0, previewChars).trimEnd()}…` : content;

  const suffix = shouldTruncate && postId ? (
    <Text style={styles.link} onPress={() => router.push(`/p/${postId}`)}>
      {' Read more'}
    </Text>
  ) : null;

  return (
    <LinkifiedText text={displayed} style={styles.postText} linkStyle={styles.link} suffix={suffix} />
  );
};

export default PostContentText;

const styles = StyleSheet.create({
  postText: {
    fontSize: 15,
    color: colors.COLOR_BLACK_LIGHT_1,
    lineHeight: 20,
  },
  link: {
    color: colors.linkColor,
  },
});
