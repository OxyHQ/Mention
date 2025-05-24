"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HelloWave = HelloWave;
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_reanimated_1 = require("react-native-reanimated");
var ThemedText_1 = require("@/components/ThemedText");
function HelloWave() {
    var rotationAnimation = (0, react_native_reanimated_1.useSharedValue)(0);
    (0, react_1.useEffect)(function () {
        rotationAnimation.value = (0, react_native_reanimated_1.withRepeat)((0, react_native_reanimated_1.withSequence)((0, react_native_reanimated_1.withTiming)(25, { duration: 150 }), (0, react_native_reanimated_1.withTiming)(0, { duration: 150 })), 4 // Run the animation 4 times
        );
    }, [rotationAnimation]);
    var animatedStyle = (0, react_native_reanimated_1.useAnimatedStyle)(function () { return ({
        transform: [{ rotate: "".concat(rotationAnimation.value, "deg") }],
    }); });
    return (<react_native_reanimated_1.default.View style={animatedStyle}>
      <ThemedText_1.ThemedText style={styles.text}>👋</ThemedText_1.ThemedText>
    </react_native_reanimated_1.default.View>);
}
var styles = react_native_1.StyleSheet.create({
    text: {
        fontSize: 28,
        lineHeight: 32,
        marginTop: -6,
    },
});
