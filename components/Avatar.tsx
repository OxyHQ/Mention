import React from "react";
import { Image, StyleSheet } from "react-native";
import { colors } from "../styles/colors";

interface AvatarProps {
  userImage: string;
}

const Avatar: React.FC<AvatarProps> = ({ userImage }) => {
  return <Image source={{ uri: userImage }} style={styles.avatar} />;
};

const styles = StyleSheet.create({
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primaryColor,
  },
});

export default Avatar;
