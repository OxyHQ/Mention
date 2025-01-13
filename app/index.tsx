import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator } from 'react-native';
import { CreatePost } from '../components/CreatePost';
import { Header } from '../components/Header';
import Post from '../components/Post';
import { IPost, useStore } from '@/store/stores/postStore';
import { colors } from '../styles/colors';
import { useFetchPosts } from '@/hooks/useFetchPosts';

export default function HomeScreen() {
  const posts = useFetchPosts();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (posts.length > 0) {
      setLoading(false);
    }
  }, [posts]);

  const sortedPosts = React.useMemo(() => {
    return [...posts].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  }, [posts]);

  const renderItem = React.useCallback(({ item }: { item: IPost }) => <Post id={''} avatar={''} username={''} time={''} likes={0} reposts={0} replies={0} {...item} />, []);

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
    marginBottom: 15,
    borderBottomWidth: 0.01,
    borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
  },
  flatListStyle: {
    borderBottomWidth: 0.01,
    borderTopWidth: 0.01,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
  },
});
