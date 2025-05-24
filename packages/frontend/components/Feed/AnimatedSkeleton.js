"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var react_1 = require("react");
var react_native_1 = require("react-native");
var AnimatedSkeleton = function (_a) {
    var _b = _a.width, width = _b === void 0 ? '100%' : _b, _c = _a.height, height = _c === void 0 ? 20 : _c, _d = _a.borderRadius, borderRadius = _d === void 0 ? 4 : _d, _e = _a.marginBottom, marginBottom = _e === void 0 ? 10 : _e;
    var animatedValue = (0, react_1.useRef)(new react_native_1.Animated.Value(0)).current;
    (0, react_1.useEffect)(function () {
        react_native_1.Animated.loop(react_native_1.Animated.timing(animatedValue, {
            toValue: 1,
            duration: 1500,
            easing: react_native_1.Easing.ease,
            useNativeDriver: false
        })).start();
    }, [animatedValue]);
    var interpolatedColor = animatedValue.interpolate({
        inputRange: [0, 0.5, 1],
        outputRange: ['#EEEEEE', '#DDDDDD', '#EEEEEE']
    });
    return (<react_native_1.Animated.View style={{
            width: width,
            height: height,
            borderRadius: borderRadius,
            backgroundColor: interpolatedColor,
            marginBottom: marginBottom,
        }}/>);
};
exports.default = AnimatedSkeleton;
