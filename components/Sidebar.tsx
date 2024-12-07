import React from "react";
import { View, StyleSheet } from "react-native";
import { Logo } from "./logo";
import { Navbar } from "./Navbar";
import { PostButton } from "./PostButton";

export function Sidebar() {
  const session = true;
  return (
    <View style={styles.container}>
      <View style={styles.logo}>
        <Logo />
      </View>
      <Navbar />
      {session && (
        <View style={styles.postButton}>
          <PostButton />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute", // 'sticky' is not supported in React Native
    top: 0,
    height: "100%",
    padding: 16,
  },
  logo: {
    justifyContent: "center",
  },
  postButton: {
    justifyContent: "center",
  },
  user: {
    justifyContent: "center",
    marginTop: "auto",
  },
  // Add media query styles here
  small: {
    // Media queries need to be handled with Dimensions API or similar
    padding: 4,
  },
  medium: {
    padding: 8,
  },
  xxLarge: {
    // Nested styles are not supported in React Native
  },
});
