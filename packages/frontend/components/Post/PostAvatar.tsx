import React from 'react';
import { Image, ImageStyle, StyleProp, View, ViewStyle } from 'react-native';
import { colors } from '../../styles/colors';

interface PostAvatarProps {
  uri?: string;
  size?: number;
  style?: StyleProp<ImageStyle | ViewStyle>;
  bgColor?: string; // default background when no image or load fails
}

const PostAvatar: React.FC<PostAvatarProps> = ({ uri, size = 40, style, bgColor }) => {
  const [errored, setErrored] = React.useState(false);

  const baseStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    marginRight: 12,
    backgroundColor: bgColor || colors.COLOR_BLACK_LIGHT_6,
  } as const;

  if (!uri || errored) {
    return <View style={[baseStyle, style]} />;
  }

  return (
    <Image
      source={{ uri }}
      onError={() => setErrored(true)}
      style={[baseStyle, style]}
    />
  );
};

export default PostAvatar;
