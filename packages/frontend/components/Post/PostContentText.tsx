import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { colors } from '../../styles/colors';

interface Props {
  content?: string;
}

const PostContentText: React.FC<Props> = ({ content }) => {
  if (!content) return null;
  return <Text style={styles.postText}>{content}</Text>;
};

export default PostContentText;

const styles = StyleSheet.create({
  postText: {
    fontSize: 15,
    color: colors.COLOR_BLACK_LIGHT_1,
    lineHeight: 20,
    marginBottom: 12,
  },
});
