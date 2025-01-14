import React from "react";
import { Image, StyleSheet, ImageStyle } from "react-native";
import { colors } from "../styles/colors";

interface AvatarProps {
  source: string;
  size?: number; // Add size prop
  style?: ImageStyle; // Add style prop
}

const Avatar: React.FC<AvatarProps> = ({ source, size = 40, style }) => {
  return <Image source={{ uri: source }} style={[styles.avatar, { width: size, height: size, borderRadius: size }, style]} />;
};

const styles = StyleSheet.create({
  avatar: {
    backgroundColor: colors.COLOR_BLACK_LIGHT_6,
  },
});

export default Avatar;