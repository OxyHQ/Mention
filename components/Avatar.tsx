import React from "react";
import { Image, ImageSourcePropType } from 'react-native';
import { StyleSheet, ImageStyle } from "react-native";
import { colors } from "@/styles/colors";
import defaultAvatar from "@/assets/images/default-avatar.jpg";
import { OXY_CLOUD_URL } from "@/modules/oxyhqservices/config";

interface AvatarProps {
  id?: string; // Avatar ID or full URL
  size?: number;
  style?: ImageStyle;
}

const Avatar: React.FC<AvatarProps> = ({ id, size = 40, style }) => {
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
    source = { uri: `${OXY_CLOUD_URL}${id}` };
  }

  return (
    <Image
      source={source}
      style={[styles.avatar, { width: size, height: size, borderRadius: size }, style]}
      defaultSource={defaultAvatar}
      onError={(e) => console.warn('Avatar image failed to load:', id)}
    />
  );
};

const styles = StyleSheet.create({
  avatar: {
    backgroundColor: colors.COLOR_BLACK_LIGHT_6,
  },
});

export default Avatar;