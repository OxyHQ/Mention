import React, { useState, useEffect, useContext } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator } from 'react-native';
import { CreatePost } from '@/components/CreatePost';
import { Header } from '@/components/Header';
import Post from '@/components/Post';
import { Post as IPost } from "@/interfaces/Post";
import { colors } from '../styles/colors';
import { useSelector, useDispatch } from 'react-redux';
import { fetchPosts } from '@/store/reducers/postsReducer';
import { fetchTrends } from '@/store/reducers/trendsReducer';
import { Hashtag } from '@/assets/icons/hashtag-icon';
import { Link } from 'expo-router';
import { Stories } from '@/components/Stories';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ScrollView } from 'react-native-gesture-handler';

export default function HomeScreen() {
  const posts = useSelector((state) => state.posts.posts);
  const dispatch = useDispatch();
  const [loading, setLoading] = useState(true);
  const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);

  useEffect(() => {
    dispatch(fetchPosts());
    dispatch(fetchTrends());
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

  const handleOpenCreatePostModal = () => {
    setBottomSheetContent(<CreatePost />);
    openBottomSheet(true);
  };

  return (
    <ScrollView>
      <SafeAreaView>
        <Header options={{ title: "Home", rightComponents: [<Hashtag />] }} />
        <Stories />
        <CreatePost style={styles.createPost} onPress={handleOpenCreatePostModal} />
        {loading ? (
          <ActivityIndicator size="large" color={colors.primaryColor} />
        ) : (
          <FlatList<IPost>
            data={sortedPosts}
            renderItem={renderItem}
            style={styles.flatListStyle}
          />
        )}
      </SafeAreaView>
    </ScrollView>
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
