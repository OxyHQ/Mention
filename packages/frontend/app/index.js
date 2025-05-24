"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var react_1 = require("react");
var react_native_1 = require("react-native");
var Feed_1 = require("../components/Feed");
var PostContext_1 = require("../context/PostContext");
var react_i18next_1 = require("react-i18next");
var colors_1 = require("@/styles/colors");
var services_1 = require("@oxyhq/services");
var expo_router_1 = require("expo-router");
var HomeScreen = function () {
    var _a = (0, react_1.useState)('all'), feedType = _a[0], setFeedType = _a[1];
    var t = (0, react_i18next_1.useTranslation)().t;
    var isAuthenticated = (0, services_1.useOxy)().isAuthenticated;
    // Whether the current tab is the "For You" tab
    var isForYouTab = feedType === 'all' || feedType === 'home';
    (0, react_1.useEffect)(function () {
        // Set default feed type based on authentication
        if (isAuthenticated) {
            setFeedType('home');
        }
        else {
            setFeedType('all');
        }
    }, [isAuthenticated]);
    var handleCreatePostPress = function () {
        expo_router_1.router.push('/compose');
    };
    return (<PostContext_1.PostProvider>
            <react_native_1.SafeAreaView style={styles.container}>
                <react_native_1.View style={styles.feedToggle}>
                    <react_native_1.TouchableOpacity style={[styles.toggleButton, isForYouTab && styles.activeToggle]} onPress={function () { return setFeedType(isAuthenticated ? 'home' : 'all'); }}>
                        <react_native_1.Text style={[styles.toggleText, isForYouTab && styles.activeToggleText]}>
                            {t('For You')}
                        </react_native_1.Text>
                    </react_native_1.TouchableOpacity>
                    <react_native_1.TouchableOpacity style={[styles.toggleButton, feedType === 'following' && styles.activeToggle]} onPress={function () { return setFeedType('following'); }}>
                        <react_native_1.Text style={[styles.toggleText, feedType === 'following' && styles.activeToggleText]}>
                            {t('Following')}
                        </react_native_1.Text>
                    </react_native_1.TouchableOpacity>
                </react_native_1.View>
                <Feed_1.default showCreatePost type={feedType} onCreatePostPress={handleCreatePostPress}/>
            </react_native_1.SafeAreaView>
        </PostContext_1.PostProvider>);
};
var styles = react_native_1.StyleSheet.create({
    container: {
        flex: 1,
    },
    feedToggle: {
        flexDirection: 'row',
        borderBottomWidth: 0.5,
        borderBottomColor: colors_1.colors.COLOR_BLACK_LIGHT_6,
        backgroundColor: 'white',
        shadowColor: colors_1.colors.shadow,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
        elevation: react_native_1.Platform.OS === 'android' ? 2 : 0,
    },
    toggleButton: {
        flex: 1,
        alignItems: 'center',
        paddingVertical: 15,
    },
    activeToggle: {
        borderBottomWidth: 2,
        borderBottomColor: colors_1.colors.primaryColor,
    },
    toggleText: {
        fontSize: 16,
        fontWeight: '500',
        color: colors_1.colors.COLOR_BLACK_LIGHT_3,
    },
    activeToggleText: {
        fontWeight: 'bold',
        color: colors_1.colors.primaryColor,
    },
});
exports.default = HomeScreen;
