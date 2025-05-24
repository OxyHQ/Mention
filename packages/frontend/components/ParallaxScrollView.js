"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = ParallaxScrollView;
var react_native_1 = require("react-native");
var react_native_reanimated_1 = require("react-native-reanimated");
var ThemedView_1 = require("@/components/ThemedView");
var TabBarBackground_1 = require("@/components/ui/TabBarBackground");
var useColorScheme_1 = require("@/hooks/useColorScheme");
var HEADER_HEIGHT = 250;
function ParallaxScrollView(_a) {
    var _b;
    var children = _a.children, headerImage = _a.headerImage, headerBackgroundColor = _a.headerBackgroundColor;
    var colorScheme = (_b = (0, useColorScheme_1.useColorScheme)()) !== null && _b !== void 0 ? _b : 'light';
    var scrollRef = (0, react_native_reanimated_1.useAnimatedRef)();
    var scrollOffset = (0, react_native_reanimated_1.useScrollViewOffset)(scrollRef);
    var bottom = (0, TabBarBackground_1.useBottomTabOverflow)();
    var headerAnimatedStyle = (0, react_native_reanimated_1.useAnimatedStyle)(function () {
        return {
            transform: [
                {
                    translateY: (0, react_native_reanimated_1.interpolate)(scrollOffset.value, [-HEADER_HEIGHT, 0, HEADER_HEIGHT], [-HEADER_HEIGHT / 2, 0, HEADER_HEIGHT * 0.75]),
                },
                {
                    scale: (0, react_native_reanimated_1.interpolate)(scrollOffset.value, [-HEADER_HEIGHT, 0, HEADER_HEIGHT], [2, 1, 1]),
                },
            ],
        };
    });
    return (<ThemedView_1.ThemedView style={styles.container}>
      <react_native_reanimated_1.default.ScrollView ref={scrollRef} scrollEventThrottle={16} scrollIndicatorInsets={{ bottom: bottom }} contentContainerStyle={{ paddingBottom: bottom }}>
        <react_native_reanimated_1.default.View style={[
            styles.header,
            { backgroundColor: headerBackgroundColor[colorScheme] },
            headerAnimatedStyle,
        ]}>
          {headerImage}
        </react_native_reanimated_1.default.View>
        <ThemedView_1.ThemedView style={styles.content}>{children}</ThemedView_1.ThemedView>
      </react_native_reanimated_1.default.ScrollView>
    </ThemedView_1.ThemedView>);
}
var styles = react_native_1.StyleSheet.create({
    container: {
        flex: 1,
    },
    header: {
        height: HEADER_HEIGHT,
        overflow: 'hidden',
    },
    content: {
        flex: 1,
        padding: 32,
        gap: 16,
        overflow: 'hidden',
    },
});
