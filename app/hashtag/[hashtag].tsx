import React, { useEffect, useState } from 'react';
import {
    Animated,
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    StatusBar,
    FlatList,
    Platform,
    ActivityIndicator,
} from 'react-native';
import { TabView, SceneMap } from 'react-native-tab-view';
import { Header } from '@/components/Header'
import Post from '@/components/Post'
import { colors } from '@/styles/colors'
import { fetchPostsByHashtag } from '@/store/reducers/postsReducer';
import { useDispatch, useSelector } from 'react-redux';
import { useLocalSearchParams } from 'expo-router';
import { fetchData } from '@/utils/api';

const PostList = ({ hashtag }) => {
    const dispatch = useDispatch();
    const posts = useSelector((state) => state.posts.posts);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        dispatch(fetchPostsByHashtag(hashtag));
    }, [dispatch, hashtag]);

    useEffect(() => {
        if (posts.length > 0) {
            setLoading(false);
        }
    }, [posts]);

    if (loading) {
        return <ActivityIndicator size="large" color={colors.primaryColor} />;
    }

    return (
        <FlatList
            data={posts}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => <Post postData={item} />}
        />
    );
};

const PostsRoute = ({ hashtag }) => (
    <View style={styles.container}>
        <PostList hashtag={hashtag} />
    </View>
);

const StatsRoute = ({ hashtag }) => {
    interface HashtagStats {
        totalPosts: number;
        likes: number;
        reposts: number;
        quotes: number;
        bookmarks: number;
        replies: number;
    }

    const [hashtagStats, setHashtagStats] = useState<HashtagStats | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchHashtagStats = async () => {
            const response = await fetchData(`posts/hashtag/${hashtag}`);
            setHashtagStats(response._count);
            setLoading(false);
        };

        fetchHashtagStats();
    }, [hashtag]);

    if (loading) {
        return <ActivityIndicator size="large" color="#1DA1F2" />;
    }

    return (
        <View style={styles.container}>
            <View style={styles.statsGrid}>
                {hashtagStats && (
                    <>
                        <View style={styles.statItem}>
                            <Text style={styles.statValue}>{hashtagStats.totalPosts}</Text>
                            <Text style={styles.statLabel}>Total Posts</Text>
                        </View>
                        <View style={styles.statItem}>
                            <Text style={styles.statValue}>{hashtagStats.likes}</Text>
                            <Text style={styles.statLabel}>Total Likes</Text>
                        </View>
                        <View style={styles.statItem}>
                            <Text style={styles.statValue}>{hashtagStats.reposts}</Text>
                            <Text style={styles.statLabel}>Total Reposts</Text>
                        </View>
                        <View style={styles.statItem}>
                            <Text style={styles.statValue}>{hashtagStats.quotes}</Text>
                            <Text style={styles.statLabel}>Total Quotes</Text>
                        </View>
                        <View style={styles.statItem}>
                            <Text style={styles.statValue}>{hashtagStats.bookmarks}</Text>
                            <Text style={styles.statLabel}>Total Bookmarks</Text>
                        </View>
                        <View style={styles.statItem}>
                            <Text style={styles.statValue}>{hashtagStats.replies}</Text>
                            <Text style={styles.statLabel}>Total Replies</Text>
                        </View>
                    </>
                )}
            </View>
        </View>
    );
};

const TabViewExample = () => {
    const { hashtag } = useLocalSearchParams<{ hashtag: string }>();
    const [index, setIndex] = useState(0);
    const routes = [
        { key: 'posts', title: 'Posts' },
        { key: 'stats', title: 'Stats' },
    ];

    const handleIndexChange = (index) => setIndex(index);

    const renderTabBar = (props) => {
        const inputRange = props.navigationState.routes.map((x, i) => i);

        return (
            <View style={styles.tabBar}>
                {props.navigationState.routes.map((route, i) => {
                    const opacity = props.position.interpolate({
                        inputRange,
                        outputRange: inputRange.map((inputIndex) =>
                            inputIndex === i ? 1 : 0.5
                        ),
                    });

                    return (
                        <TouchableOpacity
                            key={route.key}
                            style={styles.tabItem}
                            onPress={() => setIndex(i)}>
                            <Animated.Text style={{ opacity }}>{route.title}</Animated.Text>
                        </TouchableOpacity>
                    );
                })}
            </View>
        );
    };

    const renderScene = ({ route }) => {
        switch (route.key) {
            case 'posts':
                return <PostsRoute hashtag={hashtag} />;
            case 'stats':
                return <StatsRoute hashtag={hashtag} />;
            default:
                return null;
        }
    };

    return (
        <>
            <Header options={{ title: `#${hashtag}` }} />
            <TabView
                navigationState={{ index, routes }}
                renderScene={renderScene}
                renderTabBar={renderTabBar}
                onIndexChange={handleIndexChange}
            />
        </>
    );
};

export default TabViewExample;

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    tabBar: {
        flexDirection: 'row',
        paddingTop: StatusBar.currentHeight,
        borderBottomWidth: 1,
        borderBottomColor: colors.COLOR_BLACK_LIGHT_6,
    },
    tabItem: {
        flex: 1,
        alignItems: 'center',
        padding: 16,
    },
    statsText: {
        fontSize: 18,
        margin: 10,
    },
    hashtagTitle: {
        fontSize: 24,
        fontWeight: 'bold',
        textAlign: 'center',
        marginVertical: 20,
    },
    statsGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'space-around',
        padding: 10,
    },
    statItem: {
        alignItems: 'center',
        margin: 10,
        backgroundColor: colors.COLOR_BLACK_LIGHT_6,
        borderRadius: 35,
        paddingHorizontal: 20,
        paddingVertical: 10,
        width: '45%',
    },
    statValue: {
        fontSize: 20,
        fontWeight: 'bold',
        color: colors.COLOR_BLACK,
    },
    statLabel: {
        fontSize: 14,
        color: colors.COLOR_BLACK,
    },
});
