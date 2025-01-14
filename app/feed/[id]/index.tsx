import React from 'react'
import {
    Animated,
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    StatusBar,
    FlatList,
    Platform,
} from 'react-native';
import { TabView, SceneMap } from 'react-native-tab-view';
import { Header } from '@/components/Header'
import Post from '@/components/Post'
import { colors } from '@/styles/colors'


const PostList = () => {
    return <Text>PostList</Text>;
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
});
