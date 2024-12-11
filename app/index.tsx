import {
  FlatList,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
} from "react-native";
import React, { useState, useEffect } from "react";
import { Stack, useLocalSearchParams, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Post from "@/components/Post";
import { ThemedView } from "@/components/ThemedView";
import { ThemedText } from "@/components/ThemedText";
import { useColorScheme } from "@/hooks/useColorScheme";
import { fetchData } from "@/utils/api";
import { storeData, getData } from "@/utils/storage";
import { useTranslation } from "react-i18next";
import { Post as PostType } from "@/constants/sampleData";

export default function HomeScreen() {
  const [refreshing, setRefreshing] = useState(false);
  const [posts, setPosts] = useState<PostType[]>([]);
  const colorScheme = useColorScheme();
  const { t } = useTranslation();

  const onRefresh = React.useCallback(() => {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 2000);
  }, []);

  type PostAPIResponse = {
    id: string;
    text: string;
    created_at: string;
    author: {
      name: string;
      image: string;
    };
  };

  const retrievePostsFromAPI = async () => {
    try {
      const response = await fetchData("posts");
      const posts = response.posts.map((post: PostAPIResponse) => ({
        id: post.id,
        user: {
          name: post.author?.name || "Unknown",
          avatar: post.author?.image || "https://via.placeholder.com/50",
        },
        content: decodeURIComponent(post.text),
        timestamp: new Date(post.created_at).toLocaleTimeString(),
      }));
      await storeData("posts", posts);
      setPosts(posts);
    } catch (error) {
      console.error("Error retrieving posts from API:", error);
    }
  };

  useEffect(() => {
    const fetchPosts = async () => {
      const storedPosts = await getData("posts");
      if (storedPosts) {
        setPosts(storedPosts);
      } else {
        retrievePostsFromAPI();
      }
    };

    fetchPosts();
  }, []);

  return (
    <>
      <Stack.Screen options={{ title: t("Home"), headerBackVisible: false }} />
      <ThemedView style={styles.container}>
        <FlatList
          data={posts}
          renderItem={({ item }) => (
            <Post
              id={item.id}
              avatar={item.avatar}
              name={item.name}
              username={item.username}
              content={item.content}
              time={item.time}
              likes={item.likes}
              reposts={item.reposts}
              replies={item.replies}
              images={item.images}
              poll={item.poll}
              location={item.location}
            />
          )}
          keyExtractor={(item) => item.id.toString()}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        />
        <TouchableOpacity
          style={styles.fab}
          onPress={() => router.push("/compose")}
        >
          <Ionicons name="create-outline" size={24} color="#FFFFFF" />
        </TouchableOpacity>
      </ThemedView>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#e1e8ed",
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: "bold",
  },
  composeButton: {
    backgroundColor: "#1DA1F2",
    padding: 8,
    borderRadius: 9999,
  },
  fab: {
    position: "fixed",
    bottom: 65,
    right: 16,
    backgroundColor: "#1DA1F2",
    padding: 16,
    borderRadius: 9999,
    elevation: 4,
  },
});
