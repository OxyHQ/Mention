import { Stack, useLocalSearchParams } from "expo-router";
import React, { useState, useEffect } from "react";
import { View, StyleSheet } from "react-native";
import Post from "@/components/Post";
import { ThemedView } from "@/components/ThemedView";
import { fetchData } from "@/utils/api";
import { Post as PostType } from "@/interfaces/Post";

export default function PostDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [post, setPost] = useState<PostType | null>(null);

  useEffect(() => {
    const fetchPost = async () => {
      try {
        const response = await fetchData(`posts/${id}`);
        const post = {
          id: response.id,
          user: {
            name: response.author?.name || "Unknown",
            avatar: response.author?.image || "https://via.placeholder.com/50",
            username: response.author?.username || "unknown",
          },
          content: decodeURIComponent(response.text),
          timestamp: new Date(response.created_at).toLocaleTimeString(),
          likes: 0, // Assuming default value
          reposts: 0, // Assuming default value
          replies: 0, // Assuming default value
        };
        setPost(post);
      } catch (error) {
        console.error("Error fetching post:", error);
      }
    };

    if (id) {
      fetchPost();
    }
  }, [id]);

  return (
    <>
      <Stack.Screen options={{ title: "Post" }} />
      <ThemedView style={styles.container}>
        {post && (
          <Post
            id={post.id}
            avatar={post.user.avatar}
            name={post.user.name}
            username={post.user.username}
            content={post.content}
            time={post.timestamp}
            likes={post.likes}
            reposts={post.reposts}
            replies={post.replies}
            showActions={false}
          />
        )}
      </ThemedView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
});
