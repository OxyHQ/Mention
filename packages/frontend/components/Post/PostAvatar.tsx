import React from 'react';
import { Image, ImageStyle, StyleProp } from 'react-native';

interface PostAvatarProps {
  uri: string;
  size?: number;
  style?: StyleProp<ImageStyle>;
}

const PostAvatar: React.FC<PostAvatarProps> = ({ uri, size = 40, style }) => {
  return (
    <Image
      source={{ uri }}
      style={[{ width: size, height: size, borderRadius: size / 2, marginRight: 12 }, style]}
    />
  );
};

export default PostAvatar;

