"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var react_1 = require("react");
var react_native_1 = require("react-native");
var Feed_1 = require("@/components/Feed");
var PostContext_1 = require("@/context/PostContext");
var react_i18next_1 = require("react-i18next");
var colors_1 = require("@/styles/colors");
var expo_status_bar_1 = require("expo-status-bar");
var ExploreScreen = function () {
    var t = (0, react_i18next_1.useTranslation)().t;
    return (<PostContext_1.PostProvider>
      <react_native_1.SafeAreaView style={styles.container}>
        <expo_status_bar_1.StatusBar style="dark"/>
        <react_native_1.View style={styles.header}>
          <react_native_1.Text style={styles.headerTitle}>{t('Explore')}</react_native_1.Text>
        </react_native_1.View>
        <Feed_1.default showCreatePost type="all"/>
      </react_native_1.SafeAreaView>
    </PostContext_1.PostProvider>);
};
var styles = react_native_1.StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors_1.colors.COLOR_BLACK_LIGHT_8,
    },
    header: {
        paddingVertical: 12,
        paddingHorizontal: 16,
        backgroundColor: '#fff',
        borderBottomWidth: 0.5,
        borderBottomColor: colors_1.colors.COLOR_BLACK_LIGHT_6,
    },
    headerTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        color: colors_1.colors.COLOR_BLACK_LIGHT_1,
    },
});
exports.default = ExploreScreen;
