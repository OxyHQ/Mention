import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useSelector, useDispatch } from "react-redux";
import { fetchPosts } from "@/store/reducers/postsReducer";
import { Header } from "@/components/Header";
import Post from "@/components/Post";
import { colors } from "@/styles/colors";
import { CreatePost } from "@/components/CreatePost";

export default function PostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const dispatch = useDispatch();
  const posts = useSelector((state) => state.posts.posts);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    dispatch(fetchPosts());
  }, [dispatch]);

  useEffect(() => {
    if (posts.length > 0) {
      setLoading(false);
    }
  }, [posts]);

  const post = posts.find((post) => post.id === id);

  if (loading) {
    return <ActivityIndicator size="large" color="#1DA1F2" />;
  }

  if (!post) {
    return (
      <>
        <Header options={{ title: "Post not found" }} />
        <View style={styles.container}>
          <Text style={styles.notFoundText}>Post not found</Text>
        </View>
      </>
    );
  }

  return (
    <>
      <View style={styles.container}>
        <Header options={{
          title: `Post by ${post?.author?.username}`
        }} />
        <Post postData={post} />
        <CreatePost style={styles.createPost} />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  notFoundText: {
    fontSize: 18,
    color: colors.COLOR_BLACK_LIGHT_3,
    textAlign: "center",
    marginTop: 20,
  },
  createPost: {
  },
});
