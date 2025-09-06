import React from 'react';
import Avatar from '../Avatar';
import { ViewStyle, ImageStyle, StyleProp } from 'react-native';

interface PostAvatarProps {
  uri?: string;
  size?: number;
  style?: StyleProp<ImageStyle | ViewStyle>;
  bgColor?: string; // default background when no image or load fails
}

const PostAvatar: React.FC<PostAvatarProps> = ({ uri, size = 40, style, bgColor }) => {
  const initials = undefined;

  return (
    <Avatar
      source={uri}
      size={size}
      style={[{ marginRight: 12, backgroundColor: bgColor }, (style as any)]}
      imageStyle={{ borderRadius: size / 2 }}
      label={initials}
    />
  );
};

export default PostAvatar;
