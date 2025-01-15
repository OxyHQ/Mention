import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator } from 'react-native';
import { CreatePost } from '../components/CreatePost';
import { Header } from '../components/Header';
import Post from '../components/Post';
import { Post as IPost } from "@/interfaces/Post";
import { colors } from '../styles/colors';
import { useSelector, useDispatch } from 'react-redux';
import { fetchPosts } from '@/store/reducers/postsReducer';
import { Hashtag } from '@/assets/icons/hashtag-icon';
import { Link } from 'expo-router';

export default function HomeScreen() {
  const posts = useSelector((state) => state.posts.posts);
  const dispatch = useDispatch();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    dispatch(fetchPosts());
  }, [dispatch]);

  useEffect(() => {
    if (Array.isArray(posts) && posts.length > 0) {
      setLoading(false);
    }
  }, [posts]);

  const sortedPosts = React.useMemo(() => {
    return Array.isArray(posts) ? [...posts].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()) : [];
  }, [posts]);

  const renderItem = React.useCallback(({ item, index }: { item: IPost, index: number }) => {
    const isLastItem = index === sortedPosts.length - 1;
    return <Post postData={item} style={isLastItem ? styles.lastItem : undefined} />;
  }, [sortedPosts.length]);

  return (
    <>
      <Header options={{ title: "Home", rightComponents: [<Hashtag />] }} />
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
    </>
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
