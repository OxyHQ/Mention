import React, { useState } from "react";
import { View, Text, StyleSheet, Picker, Button } from "react-native";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
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

  return (
    <ThemedView style={styles.container}>
      <ThemedText style={styles.header}>Settings</ThemedText>
      <View style={styles.setting}>
        <ThemedText style={styles.label}>Language</ThemedText>
        <Picker
          selectedValue={selectedLanguage}
          style={styles.picker}
          onValueChange={(itemValue) => setSelectedLanguage(itemValue)}
        >
          {languages.map((language) => (
            <Picker.Item key={language} label={language} value={language} />
          ))}
        </Picker>
      </View>
      <View style={styles.setting}>
        <ThemedText style={styles.label}>Primary Color</ThemedText>
        <Picker
          selectedValue={selectedColor}
          style={styles.picker}
          onValueChange={(itemValue) => setSelectedColor(itemValue)}
        >
          {colors.map((color) => (
            <Picker.Item
              key={color}
              label={color}
              value={color}
              color={color}
            />
          ))}
        </Picker>
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
