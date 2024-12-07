import React, { useState } from "react";
import { View, Text, Image, StyleSheet, TouchableOpacity } from "react-native";
import { Link } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Post as PostType } from "@/constants/sampleData";

interface PostComponentProps extends PostType {
  showActions?: boolean;
}

export default function Post({
  id,
  avatar,
  name,
  username,
  content,
  time,
  likes = 0,
  reposts = 0,
  replies = 0,
}: PostComponentProps) {
  const [isLiked, setIsLiked] = useState(false);
  const [likesCount, setLikesCount] = useState(likes);

  const handleLike = (event: any) => {
    event.stopPropagation();
    setIsLiked(!isLiked);
    setLikesCount((prev) => (isLiked ? prev - 1 : prev + 1));
  };

  return (
    <Link href={`/post/${id}` as any} asChild>
      <TouchableOpacity>
        <View style={styles.container}>
          <Image source={{ uri: avatar }} style={styles.avatar} />
          <View style={styles.contentContainer}>
            <View style={styles.header}>
              <Text style={styles.name}>{name}</Text>
              <Text style={styles.username}>{username}</Text>
              <Text style={styles.time}>· {time}</Text>
            </View>
            <Text style={styles.content}>{content}</Text>
            <View style={styles.actions}>
              <View style={styles.actionItem}>
                <Ionicons name="chatbubble-outline" size={20} color="#536471" />
                <Text style={styles.actionText}>{replies}</Text>
              </View>
              <View style={styles.actionItem}>
                <Ionicons name="repeat-outline" size={20} color="#536471" />
                <Text style={styles.actionText}>{reposts}</Text>
              </View>
              <TouchableOpacity style={styles.actionItem} onPress={handleLike}>
                <Ionicons
                  name={isLiked ? "heart" : "heart-outline"}
                  size={20}
                  color={isLiked ? "#F91880" : "#536471"}
                />
                <Text style={[styles.actionText, isLiked && styles.likedText]}>
                  {likesCount}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    </Link>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    padding: 12,
    borderBottomColor: "#e1e8ed",
    borderBottomWidth: 1,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
  contentContainer: {
    flex: 1,
    marginLeft: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
  },
  name: {
    fontWeight: "bold",
    marginRight: 4,
  },
  username: {
    color: "#536471",
  },
  time: {
    color: "#536471",
    marginLeft: 4,
  },
  content: {
    marginTop: 4,
    lineHeight: 20,
  },
  actions: {
    flexDirection: "row",
    marginTop: 12,
    justifyContent: "space-between",
    maxWidth: 300,
  },
  actionItem: {
    flexDirection: "row",
    alignItems: "center",
  },
  actionText: {
    color: "#536471",
    fontSize: 13,
    marginLeft: 4,
  },
  likedText: {
    color: "#F91880",
  },
});
