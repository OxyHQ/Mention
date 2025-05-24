"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var react_1 = require("react");
var react_native_1 = require("react-native");
var Post_1 = require("../Post");
var CreatePost_1 = require("../Post/CreatePost");
var useFeed_1 = require("@/hooks/useFeed");
var ErrorBoundary_1 = require("../ErrorBoundary");
var react_i18next_1 = require("react-i18next");
var colors_1 = require("@/styles/colors");
var LoadingSkeleton_1 = require("./LoadingSkeleton");
var services_1 = require("@oxyhq/services");
var Feed = function (_a) {
    var _b = _a.type, type = _b === void 0 ? 'all' : _b, parentId = _a.parentId, _c = _a.showCreatePost, showCreatePost = _c === void 0 ? false : _c, onCreatePostPress = _a.onCreatePostPress;
    var _d = (0, useFeed_1.useFeed)({ type: type, parentId: parentId }), posts = _d.posts, loading = _d.loading, refreshing = _d.refreshing, error = _d.error, hasMore = _d.hasMore, fetchMore = _d.fetchMore, refresh = _d.refresh;
    var t = (0, react_i18next_1.useTranslation)().t;
    var windowWidth = (0, react_native_1.useWindowDimensions)().width;
    var isAuthenticated = (0, services_1.useOxy)().isAuthenticated;
    // Calculate responsive values
    var isTabletOrDesktop = windowWidth >= 768;
    // Refresh feed when component mounts
    (0, react_1.useEffect)(function () {
        refresh();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [type, parentId]);
    // Render each post item
    var renderItem = function (_a) {
        var item = _a.item, index = _a.index;
        return (<react_native_1.View style={[
                styles.postItemContainer,
                isTabletOrDesktop && styles.postItemContainerTablet
            ]}>
                <Post_1.default postData={item}/>
            </react_native_1.View>);
    };
    // Handle create post press
    var handleCreatePostPress = function () {
        if (onCreatePostPress) {
            onCreatePostPress();
        }
    };
    // Render error state
    if (error) {
        return (<react_native_1.View style={styles.errorContainer}>
                <react_native_1.Text style={styles.errorText}>{error}</react_native_1.Text>
                <react_native_1.Text style={styles.retryText} onPress={refresh}>{t('Tap to retry')}</react_native_1.Text>
            </react_native_1.View>);
    }
    // Render initial loading state
    if (loading && posts.length === 0 && !refreshing) {
        return (<react_native_1.View style={styles.loadingContainer}>
                <LoadingSkeleton_1.default count={3}/>
            </react_native_1.View>);
    }
    return (<ErrorBoundary_1.default>
            <react_native_1.FlatList data={posts} keyExtractor={function (item) { return item.id; }} renderItem={renderItem} onEndReached={fetchMore} onEndReachedThreshold={0.5} refreshControl={<react_native_1.RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[colors_1.colors.primaryColor]} tintColor={colors_1.colors.primaryColor}/>} contentContainerStyle={[
            styles.container,
            isTabletOrDesktop && styles.containerTablet,
            posts.length === 0 && styles.emptyListContainer
        ]} ListHeaderComponent={isAuthenticated && showCreatePost ? (<CreatePost_1.default onPress={handleCreatePostPress} placeholder={t("What's happening?")}/>) : null} ListEmptyComponent={!loading ? (<react_native_1.View style={styles.emptyContainer}>
                            <react_native_1.Text style={styles.emptyText}>
                                {type === 'following'
                ? t('No posts from people you follow yet')
                : t('No posts available')}
                            </react_native_1.Text>
                        </react_native_1.View>) : null} ListFooterComponent={loading && posts.length > 0 ? (<react_native_1.View style={styles.footerLoaderContainer}>
                            <react_native_1.ActivityIndicator color={colors_1.colors.primaryColor} size="small"/>
                        </react_native_1.View>) : null} ItemSeparatorComponent={function () { return (<react_native_1.View style={styles.separator}/>); }} showsVerticalScrollIndicator={false}/>
        </ErrorBoundary_1.default>);
};
var styles = react_native_1.StyleSheet.create({
    container: {
        paddingBottom: 20,
        backgroundColor: colors_1.colors.COLOR_BLACK_LIGHT_8,
        minHeight: '100%'
    },
    containerTablet: {
        paddingHorizontal: react_native_1.Platform.OS === 'web' ? '10%' : 16,
    },
    errorContainer: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        backgroundColor: colors_1.colors.COLOR_BLACK_LIGHT_8,
    },
    errorText: {
        fontSize: 16,
        marginBottom: 10,
        textAlign: 'center',
        color: colors_1.colors.COLOR_BLACK_LIGHT_3,
    },
    retryText: {
        color: colors_1.colors.primaryColor,
        fontSize: 16,
        fontWeight: '600',
    },
    emptyContainer: {
        padding: 20,
        alignItems: 'center',
        backgroundColor: 'white',
        borderRadius: 8,
        margin: 16,
        shadowColor: colors_1.colors.shadow,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
        elevation: 1,
    },
    emptyText: {
        fontSize: 16,
        color: colors_1.colors.COLOR_BLACK_LIGHT_3,
        textAlign: 'center'
    },
    loadingContainer: {
        flex: 1,
        backgroundColor: colors_1.colors.COLOR_BLACK_LIGHT_8,
        padding: 16
    },
    separator: {
        height: 6,
        backgroundColor: colors_1.colors.COLOR_BLACK_LIGHT_8,
    },
    footerLoaderContainer: {
        padding: 20,
        alignItems: 'center',
    },
    postItemContainer: {
        backgroundColor: 'white',
        borderRadius: 8,
        overflow: 'hidden',
        shadowColor: colors_1.colors.shadow,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.2,
        shadowRadius: 3,
        elevation: 2,
    },
    postItemContainerTablet: {
        borderRadius: 12,
        shadowRadius: 4,
        elevation: 3,
    },
    emptyListContainer: {
        paddingVertical: 16
    }
});
exports.default = Feed;
