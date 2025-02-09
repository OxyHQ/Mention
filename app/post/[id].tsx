import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, ActivityIndicator, ScrollView } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useSelector, useDispatch } from "react-redux";
import { fetchPosts, fetchPostById } from "@/store/reducers/postsReducer";
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
    dispatch(fetchPostById(id));
    dispatch(fetchPosts());
  }, [dispatch, id]);

  useEffect(() => {
    if (posts.length > 0) {
      setLoading(false);
    }
  }, [posts]);

  const post = posts.find((post) => post.id === id);
  const replies = posts.filter(p => p.in_reply_to_status_id === id);

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
    <ScrollView style={styles.container}>
      <Header options={{
        title: `Post by ${post?.author?.username}`
      }} />
      <Post postData={post} />
      <CreatePost style={styles.createPost} replyToPostId={id} />
      {replies.map((reply) => (
        <Post key={reply.id} postData={reply} />
      ))}
    </ScrollView>
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
    borderTopWidth: 1,
    borderTopColor: colors.COLOR_BLACK_LIGHT_3,
    borderBottomWidth: 1,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_3,
    paddingVertical: 10,
  },
});
