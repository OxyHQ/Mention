"use strict";
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WidgetManager = WidgetManager;
var react_1 = require("react");
var react_native_1 = require("react-native");
/**
 * Widget Manager Component
 *
 * This component controls which widgets should appear on which screens.
 * It provides a centralized way to manage widget visibility based on screen context.
 */
function WidgetManager(_a) {
    var screenId = _a.screenId, _b = _a.customWidgets, customWidgets = _b === void 0 ? [] : _b;
    // Define which widgets should appear on which screens
    var getWidgetsForScreen = function (screen) {
        switch (screen) {
            case 'home':
                return [
                    <react_native_1.View key="trending-topics">
                        <react_native_1.Text>Trending Topics Widget</react_native_1.Text>
                    </react_native_1.View>,
                    <react_native_1.View key="suggested-users">
                        <react_native_1.Text>Suggested Users Widget</react_native_1.Text>
                    </react_native_1.View>,
                    <react_native_1.View key="activity-feed">
                        <react_native_1.Text>Activity Feed Widget</react_native_1.Text>
                    </react_native_1.View>
                ];
            case 'explore':
                return [
                    <react_native_1.View key="popular-posts">
                        <react_native_1.Text>Popular Posts Widget</react_native_1.Text>
                    </react_native_1.View>,
                    <react_native_1.View key="trending-topics">
                        <react_native_1.Text>Trending Topics Widget</react_native_1.Text>
                    </react_native_1.View>
                ];
            case 'notifications':
                return [
                    <react_native_1.View key="notifications">
                        <react_native_1.Text>Notifications Widget</react_native_1.Text>
                    </react_native_1.View>
                ];
            case 'messages':
                return [
                    <react_native_1.View key="messages-preview">
                        <react_native_1.Text>Messages Preview Widget</react_native_1.Text>
                    </react_native_1.View>
                ];
            case 'bookmarks':
                return [
                    <react_native_1.View key="bookmarks">
                        <react_native_1.Text>Bookmarks Widget</react_native_1.Text>
                    </react_native_1.View>
                ];
            case 'profile':
                return [
                    <react_native_1.View key="profile-stats">
                        <react_native_1.Text>Profile Stats Widget</react_native_1.Text>
                    </react_native_1.View>,
                    <react_native_1.View key="engagement-stats">
                        <react_native_1.Text>Engagement Stats Widget</react_native_1.Text>
                    </react_native_1.View>
                ];
            case 'post-detail':
                return [
                    <react_native_1.View key="related-posts">
                        <react_native_1.Text>Related Posts Widget</react_native_1.Text>
                    </react_native_1.View>,
                    <react_native_1.View key="recently-viewed">
                        <react_native_1.Text>Recently Viewed Widget</react_native_1.Text>
                    </react_native_1.View>
                ];
            case 'search':
                return [
                    <react_native_1.View key="trending-topics">
                        <react_native_1.Text>Trending Topics Widget</react_native_1.Text>
                    </react_native_1.View>
                ];
            default:
                return [];
        }
    };
    var screenWidgets = getWidgetsForScreen(screenId);
    // Combine screen-specific widgets with any custom widgets passed as props
    var allWidgets = __spreadArray(__spreadArray([], screenWidgets, true), customWidgets, true);
    if (allWidgets.length === 0) {
        return null;
    }
    return (<react_native_1.View style={styles.container}>
            {allWidgets.map(function (widget, index) { return (<react_native_1.View key={index} style={styles.widgetWrapper}>
                    {widget}
                </react_native_1.View>); })}
        </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    container: {
        padding: 10,
    },
    widgetWrapper: {
        marginBottom: 16,
    },
});
var styles = react_native_1.StyleSheet.create({
    container: {
        padding: 10,
    },
    widgetWrapper: {
        marginBottom: 16,
    },
});
var screenWidgets = getWidgetsForScreen(screenId);
// Combine screen-specific widgets with any custom widgets passed as props
var allWidgets = __spreadArray(__spreadArray([], screenWidgets, true), customWidgets, true);
if (allWidgets.length === 0) {
    return null;
}
return (<react_native_1.View style={styles.container}>
            {allWidgets.map(function (widget, index) { return (<react_native_1.View key={"widget-".concat(index)} style={styles.widgetWrapper}>
                    {widget}
                </react_native_1.View>); })}
        </react_native_1.View>);
var styles = react_native_1.StyleSheet.create({
    container: {
        flexDirection: 'column',
        gap: 10,
    },
    widgetWrapper: {
        marginBottom: 10,
    }
});
