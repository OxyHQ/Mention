import React, { useState } from "react";
import { View, Text, StyleSheet, Button } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import Tweet from "@/components/Tweet";
import { useColorScheme } from "@/hooks/useColorScheme";
import { Colors } from "@/constants/Colors";

const languages = ["English", "Spanish", "French", "German"];
const colors = ["#1DA1F2", "#FF5733", "#33FF57", "#3357FF"];

export default function SettingsScreen() {
  const colorScheme = useColorScheme();
  const [selectedLanguage, setSelectedLanguage] = useState(languages[0]);
  const [selectedColor, setSelectedColor] = useState(colors[0]);

  const applySettings = () => {
    // Apply the selected language and color throughout the app
    console.log("Selected Language:", selectedLanguage);
    console.log("Selected Color:", selectedColor);
  };

  const tweet = {
    id: "16",
    avatar: "/assets/images/favicon.png",
    name: "Mention",
    username: "@mention",
    content:
      "At the heart of Mention are short messages called Posts — just like this one — which can include photos, videos, links, text, hashtags, and mentions like @Oxy.",
    time: "16m",
    likes: 7,
    retweets: 3,
    replies: 2,
    isReply: false,
    hasMedia: false,
    isLiked: true,
  };

  return (
    <ThemedView style={styles.container}>
      <View style={styles.setting}>
        <h1>Customize your view</h1>
        <h2>These settings affect all the Mention accounts on this device.</h2>
        <ThemedView style={styles.container}>
          {tweet && <Tweet {...tweet} showActions={false} />}
        </ThemedView>
        <ThemedText style={styles.label}>Language</ThemedText>
      </View>
      <View style={styles.setting}>
        <ThemedText style={styles.label}>Primary Color</ThemedText>
      </View>
      <Button title="Apply Settings" onPress={applySettings} />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
  },
  header: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 16,
  },
  setting: {
    marginBottom: 16,
  },
  label: {
    fontSize: 18,
    marginBottom: 8,
  },
  picker: {
    height: 50,
    width: "100%",
  },
});
