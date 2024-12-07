import React, { useState } from "react";
import {
  View,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  Image,
} from "react-native";
import { Stack, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { ThemedText } from "@/components/ThemedText";
import { ThemedView } from "@/components/ThemedView";

export default function ComposeScreen() {
  const [content, setContent] = useState("");
  const maxLength = 280;

  const handlePost = () => {
    if (content.trim().length > 0) {
      // Here you would typically call an API to create the post
      console.log("Creating post:", content);
      router.back();
    }
  };

  const characterCount = content.length;
  const isOverLimit = characterCount > maxLength;

  return (
    <>
      <Stack.Screen
        options={{
          title: "New Post",
          headerRight: () => (
            <TouchableOpacity
              onPress={handlePost}
              disabled={content.trim().length === 0 || isOverLimit}
              style={[
                styles.postButton,
                (content.trim().length === 0 || isOverLimit) &&
                  styles.postButtonDisabled,
              ]}
            >
              <ThemedText style={styles.postButtonText}>Post</ThemedText>
            </TouchableOpacity>
          ),
        }}
      />
      <ThemedView style={styles.container}>
        <View style={styles.content}>
          <Image
            source={{ uri: "https://via.placeholder.com/40" }}
            style={styles.avatar}
          />
          <TextInput
            style={styles.input}
            placeholder="What's happening?"
            placeholderTextColor="#657786"
            multiline
            maxLength={maxLength}
            value={content}
            onChangeText={setContent}
            autoFocus
          />
        </View>
        <View style={styles.footer}>
          <TouchableOpacity style={styles.mediaButton}>
            <Ionicons name="image-outline" size={24} color="#1DA1F2" />
          </TouchableOpacity>
          <View style={styles.characterCount}>
            <ThemedText
              style={[
                styles.characterCountText,
                isOverLimit && styles.characterCountOverLimit,
              ]}
            >
              {characterCount}/{maxLength}
            </ThemedText>
          </View>
        </View>
      </ThemedView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 16,
  },
  content: {
    flexDirection: "row",
    alignItems: "flex-start",
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    marginRight: 12,
  },
  input: {
    flex: 1,
    fontSize: 16,
    lineHeight: 24,
    minHeight: 100,
  },
  footer: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: "#E1E8ED",
    paddingTop: 12,
    marginTop: 12,
  },
  mediaButton: {
    padding: 8,
  },
  characterCount: {
    padding: 8,
  },
  characterCountText: {
    fontSize: 14,
    color: "#657786",
  },
  characterCountOverLimit: {
    color: "#E0245E",
  },
  postButton: {
    backgroundColor: "#1DA1F2",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 8,
  },
  postButtonDisabled: {
    opacity: 0.5,
  },
  postButtonText: {
    color: "#FFFFFF",
    fontWeight: "bold",
  },
});
