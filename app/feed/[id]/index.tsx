import React from 'react'
import {
    Animated,
    View,
    TouchableOpacity,
    StyleSheet,
    StatusBar,
    FlatList,
    Platform,
} from 'react-native';
import { TabView, SceneMap } from 'react-native-tab-view';
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
    return <FlatList<IPost> data={sortedPosts} renderItem={renderItem} />;
};

const TopRoute = () => (
    <View style={styles.container}>
        <PostList />
    </View>
);

const LatestRoute = () => (
    <View style={styles.container}>
        <PostList />
    </View>
);

export default class TabViewExample extends React.Component {
    state = {
        index: 0,
        routes: [
            { key: 'top', title: 'Top' },
            { key: 'latest', title: 'Latest' },
        ],
    };

    _handleIndexChange = (index) => this.setState({ index });

    _renderTabBar = (props) => {
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
                            onPress={() => this.setState({ index: i })}>
                            <Animated.Text style={{ opacity }}>{route.title}</Animated.Text>
                        </TouchableOpacity>
                    );
                })}
            </View>
        );
    };

    _renderScene = SceneMap({
        top: TopRoute,
        latest: LatestRoute,
    });

    render() {
        return (
            <>
                <Header options={{ title: "Feed" }} />
                <TabView
                    navigationState={this.state}
                    renderScene={this._renderScene}
                    renderTabBar={this._renderTabBar}
                    onIndexChange={this._handleIndexChange}
                />
            </>
        );
    }
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        ...Platform.select({
            web: {
                position: 'sticky',
            },
        }),
        top: 0,
    },
    tabBar: {
        flexDirection: 'row',
        paddingTop: StatusBar.currentHeight,
    },
    tabItem: {
        flex: 1,
        alignItems: 'center',
        padding: 16,
    },
}) as ViewStyle;
