import Feed from "@/components/Feed";
import { Header } from "@/components/Header";
import Post from "@/components/Post";
import { Post as IPost } from "@/interfaces/Post";
import { colors } from "@/styles/colors";
import { fetchData } from "@/utils/api";
import { useLocalSearchParams } from "expo-router";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";

export default function PostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [loading, setLoading] = useState(true);
  const [post, setPost] = useState<IPost | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchPost = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await fetchData<{ data: IPost }>(`feed/post/${id}`);
        setPost(response.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load post');
        console.error('Error fetching post:', err);
      } finally {
        setLoading(false);
      }
    };

    if (id) {
      fetchPost();
    }
  }, [id]);

  if (loading) {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color={colors.primaryColor} />
      </View>
    );
  }

  if (error || !post) {
    return (
      <>
        <Header options={{ title: "Post not found" }} />
        <View style={styles.container}>
          <Text style={styles.notFoundText}>
            {error || "Post not found"}
          </Text>
        </View>
      </>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <Header options={{
        title: `Post by ${post.author?.username}`
      }} />
      <Post postData={post} />
      <Feed
        type="replies"
        parentId={post.id}
        showCreatePost={false}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  notFoundText: {
    textAlign: 'center',
    fontSize: 16,
    color: colors.primaryDark,
    marginTop: 20,
  },
});
