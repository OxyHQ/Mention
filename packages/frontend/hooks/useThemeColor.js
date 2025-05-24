"use strict";
/**
 * Learn more about light and dark modes:
 * https://docs.expo.dev/guides/color-schemes/
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.useThemeColor = useThemeColor;
var Colors_1 = require("@/constants/Colors");
var useColorScheme_1 = require("@/hooks/useColorScheme");
function useThemeColor(props, colorName) {
    var _a;
    var theme = (_a = (0, useColorScheme_1.useColorScheme)()) !== null && _a !== void 0 ? _a : 'light';
    var colorFromProps = props[theme];
    if (colorFromProps) {
        return colorFromProps;
    }
    else {
        return Colors_1.Colors[theme][colorName];
    }
}
