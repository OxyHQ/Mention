import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator } from 'react-native';
import { CreatePost } from '../components/CreatePost';
import { Header } from '../components/Header';
import Post from '../components/Post';
import { Post as IPost } from "@/interfaces/Post";
import { colors } from '../styles/colors';
import { useFetchPosts } from '@/hooks/useFetchPosts';
import { usePostsStore } from '../store/stores/postStore'; // Add this import

export default function HomeScreen() {
  const posts = useFetchPosts();
  const [loading, setLoading] = useState(true);
  const storePosts = usePostsStore((state) => state.posts); // Fetch posts from the store

  useEffect(() => {
    if (storePosts.length > 0) {
      setLoading(false);
    }
  }, [storePosts]);

  const sortedPosts = React.useMemo(() => {
    return [...storePosts].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [storePosts]);

  const renderItem = React.useCallback(({ item, index }: { item: IPost, index: number }) => {
    const isLastItem = index === sortedPosts.length - 1;
    return <Post postData={item} style={isLastItem ? styles.lastItem : undefined} />;
  }, [sortedPosts.length]);

  return (
    <View style={styles.container}>
      <Header options={{ title: "Home" }} />
      <CreatePost style={styles.createPost} />
      {loading ? (
        <ActivityIndicator size="large" color="#1DA1F2" />
      ) : (
        <FlatList<IPost>
          data={sortedPosts}
          renderItem={renderItem}
          style={styles.flatListStyle}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {},
  createPost: {
  },
  flatListStyle: {
    borderTopWidth: 1,
    borderColor: colors.COLOR_BACKGROUND,
  },
  lastItem: {
    borderBottomRightRadius: 35,
    borderBottomLeftRadius: 35,
  },
});
