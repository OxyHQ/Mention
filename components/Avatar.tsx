import React from "react";
import { Image, ImageSourcePropType } from 'react-native';
import { StyleSheet, ImageStyle } from "react-native";
import { colors } from "../styles/colors";
import defaultAvatar from "@/assets/images/default-avatar.jpg";

interface AvatarProps {
  id?: string; // Add id prop
  size?: number; // Add size prop
  style?: ImageStyle; // Add style prop
}

const Avatar: React.FC<AvatarProps> = ({ id, size = 40, style }) => {
  const source = id ? { uri: `http://localhost:3000/api/files/${id}` } : defaultAvatar;
  return <Image source={source} style={[styles.avatar, { width: size, height: size, borderRadius: size }, style]} />;
};

const styles = StyleSheet.create({
  avatar: {
    backgroundColor: colors.COLOR_BLACK_LIGHT_6,
  },
});

export default Avatar;