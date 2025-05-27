import defaultAvatar from "@/assets/images/default-avatar.jpg";
import { colors } from "@/styles/colors";
import React from "react";
import { Image, ImageStyle, Pressable, StyleSheet } from 'react-native';

interface AvatarProps {
  id?: string; // Avatar ID or full URL
  size?: number;
  style?: ImageStyle;
  onPress?: () => void;
  onLongPress?: () => void;
}

const Avatar: React.FC<AvatarProps> = ({ id, size = 40, style, onPress, onLongPress }) => {
  // Handle different avatar formats
  let source;

  if (!id) {
    // Use default avatar if no ID provided
    source = defaultAvatar;
  } else if (id.startsWith('http')) {
    // If it's already a full URL, use it directly
    source = { uri: id };
  } else {
    // Otherwise, construct the URL using the cloud URL
    source = { uri: `${id}` };
  }

  return (
    <Pressable onPress={onPress} disabled={!onPress} onLongPress={onLongPress}>
      <Image
        source={source}
        style={[styles.avatar, { width: size, height: size, borderRadius: size }, style]}
        defaultSource={defaultAvatar}
        onError={(e) => console.warn('Avatar image failed to load:', id)}
      />
    </Pressable>
  );
};

const styles = StyleSheet.create({
  avatar: {
    backgroundColor: colors.COLOR_BLACK_LIGHT_6,
  },
});

export default Avatar;