"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Loading = void 0;
var react_1 = require("react");
var react_native_svg_1 = require("react-native-svg");
var colors_1 = require("@/styles/colors");
var react_native_1 = require("react-native");
var Loading = function (_a) {
    var _b = _a.color, color = _b === void 0 ? colors_1.colors.primaryColor : _b, _c = _a.size, size = _c === void 0 ? 26 : _c, style = _a.style;
    var rotateAnim = react_1.default.useRef(new react_native_1.Animated.Value(0)).current;
    react_1.default.useEffect(function () {
        var animation = react_native_1.Animated.loop(react_native_1.Animated.timing(rotateAnim, {
            toValue: 1,
            duration: 500,
            easing: react_native_1.Easing.linear,
            useNativeDriver: true, // Enable native driver for rotation
        }));
        animation.start();
        return function () { return animation.stop(); };
    }, [rotateAnim]);
    var rotate = rotateAnim.interpolate({
        inputRange: [0, 1],
        outputRange: ['0deg', '360deg'],
    });
    return (<react_native_1.Animated.View style={__assign({ transform: [{ rotate: rotate }], width: size, height: size, alignItems: 'center', margin: 'auto', justifyContent: 'center' }, style)}>
            <react_native_svg_1.default viewBox="0 0 100 100" width={size} height={size}>
                <react_native_svg_1.Rect fill={color} height="10" opacity="0" rx="5" ry="5" transform="rotate(-90 50 50)" width="28" x="67" y="45"></react_native_svg_1.Rect>
                <react_native_svg_1.Rect fill={color} height="10" opacity="0.125" rx="5" ry="5" transform="rotate(-45 50 50)" width="28" x="67" y="45"></react_native_svg_1.Rect>
                <react_native_svg_1.Rect fill={color} height="10" opacity="0.25" rx="5" ry="5" transform="rotate(0 50 50)" width="28" x="67" y="45"></react_native_svg_1.Rect>
                <react_native_svg_1.Rect fill={color} height="10" opacity="0.375" rx="5" ry="5" transform="rotate(45 50 50)" width="28" x="67" y="45"></react_native_svg_1.Rect>
                <react_native_svg_1.Rect fill={color} height="10" opacity="0.5" rx="5" ry="5" transform="rotate(90 50 50)" width="28" x="67" y="45"></react_native_svg_1.Rect>
                <react_native_svg_1.Rect fill={color} height="10" opacity="0.625" rx="5" ry="5" transform="rotate(135 50 50)" width="28" x="67" y="45"></react_native_svg_1.Rect>
                <react_native_svg_1.Rect fill={color} height="10" opacity="0.75" rx="5" ry="5" transform="rotate(180 50 50)" width="28" x="67" y="45"></react_native_svg_1.Rect>
                <react_native_svg_1.Rect fill={color} height="10" opacity="0.875" rx="5" ry="5" transform="rotate(225 50 50)" width="28" x="67" y="45"></react_native_svg_1.Rect>
            </react_native_svg_1.default>
        </react_native_1.Animated.View>);
};
exports.Loading = Loading;
