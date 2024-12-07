import React, { useState } from "react";
import { View, Text, StyleSheet, Button, Picker } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import Post from "@/components/Post";
import { useColorScheme } from "@/hooks/useColorScheme";
import { Colors } from "@/constants/Colors";
import { useTranslation } from "react-i18next";
import i18n from "i18next";

const languages = ["en", "es", "it"];
const colors = ["#1DA1F2", "#FF5733", "#33FF57", "#3357FF"];

export default function SettingsScreen() {
  const colorScheme = useColorScheme();
  const { t } = useTranslation();
  const [selectedLanguage, setSelectedLanguage] = useState(languages[0]);
  const [selectedColor, setSelectedColor] = useState(colors[0]);

  const applySettings = () => {
    i18n.changeLanguage(selectedLanguage);
    console.log("Selected Language:", selectedLanguage);
    console.log("Selected Color:", selectedColor);
  };

  const post = {
    id: "16",
    avatar: "/assets/images/favicon.png",
    name: "Mention",
    username: "@mention",
    content:
      "At the heart of Mention are short messages called Posts — just like this one — which can include photos, videos, links, text, hashtags, and mentions like @Oxy.",
    time: "16m",
    likes: 7,
    reposts: 3,
    replies: 2,
    isReply: false,
    hasMedia: false,
    isLiked: true,
  };

  return (
    <ThemedView style={styles.container}>
      <View style={styles.setting}>
        <h1>{t("Customize your view")}</h1>
        <h2>
          {t("These settings affect all the Mention accounts on this device.")}
        </h2>
        <ThemedView style={styles.container}>
          {post && <Post {...post} showActions={false} />}
        </ThemedView>
        <ThemedText style={styles.label}>{t("Language")}</ThemedText>
        <Picker
          selectedValue={selectedLanguage}
          style={styles.picker}
          onValueChange={(itemValue) => setSelectedLanguage(itemValue)}
        >
          {languages.map((lang) => (
            <Picker.Item key={lang} label={t(lang)} value={lang} />
          ))}
        </Picker>
      </View>
      <View style={styles.setting}>
        <ThemedText style={styles.label}>{t("Primary Color")}</ThemedText>
        <Picker
          selectedValue={selectedColor}
          style={styles.picker}
          onValueChange={(itemValue) => setSelectedColor(itemValue)}
        >
          {colors.map((color) => (
            <Picker.Item key={color} label={color} value={color} />
          ))}
        </Picker>
      </View>
      <Button title={t("Apply Settings")} onPress={applySettings} />
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
