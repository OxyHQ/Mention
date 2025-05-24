"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var react_1 = require("react");
var react_native_1 = require("react-native");
var loading_icon_1 = require("@/assets/icons/loading-icon");
var LoadingTopSpinner = function (_a) {
    var _b = _a.size, size = _b === void 0 ? 40 : _b, _c = _a.iconSize, iconSize = _c === void 0 ? 25 : _c, style = _a.style, showLoading = _a.showLoading;
    var translateYAnim = (0, react_1.useRef)(new react_native_1.Animated.Value(0)).current;
    var opacityAnim = (0, react_1.useRef)(new react_native_1.Animated.Value(0)).current;
    var containerHeight = iconSize + size;
    (0, react_1.useEffect)(function () {
        react_native_1.Animated.parallel([
            react_native_1.Animated.timing(opacityAnim, {
                toValue: showLoading ? 1 : 0,
                duration: 300,
                useNativeDriver: true,
            }),
            react_native_1.Animated.timing(translateYAnim, {
                toValue: showLoading ? 0 : -containerHeight,
                duration: 300,
                useNativeDriver: true,
            })
        ]).start();
    }, [showLoading, size, iconSize, containerHeight]);
    // If not showing loading, don't render anything at all
    if (showLoading === false) {
        return null;
    }
    var styles = react_native_1.StyleSheet.create({
        container: {
            width: '100%',
            height: containerHeight,
            position: 'relative',
            overflow: 'hidden',
        },
        loadingView: {
            width: '100%',
            height: containerHeight,
            alignItems: 'center',
            justifyContent: 'center',
            position: 'absolute',
            top: 0,
            left: 0,
        },
    });
    return (<react_native_1.View style={styles.container}>
            <react_native_1.Animated.View style={[
            styles.loadingView,
            {
                opacity: opacityAnim,
                transform: [{ translateY: translateYAnim }]
            },
            style
        ]}>
                <loading_icon_1.Loading size={iconSize}/>
            </react_native_1.Animated.View>
        </react_native_1.View>);
};
exports.default = LoadingTopSpinner;
