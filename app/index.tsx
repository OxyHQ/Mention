import React from 'react'
import { View, StyleSheet, FlatList } from 'react-native'
import { CreatePost } from '@/components/CreatePost'
import { Header } from '@/components/Header'
import Post from '@/components/Post'
import { IPost, usePostsStore } from '@/store/stores/postStore'
import { colors } from '@/styles/colors'

const useSortedPosts = () => {
  const posts = usePostsStore((state) => state.posts);
  return React.useMemo(() => {
    return [...posts].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  }, [posts]);
};

const PostList = () => {
  const sortedPosts = useSortedPosts();
  const renderItem = React.useCallback(({ item }: { item: IPost }) => <Post {...item} />, []);
  return <FlatList<IPost> data={sortedPosts} renderItem={renderItem} style={styles.flatListStyle} />;
};

export default function HomeScreen() {
  return (
    <View style={styles.container}>
      <Header options={{ title: "Home" }} />
      <CreatePost style={styles.createPost} />
      <PostList />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
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
