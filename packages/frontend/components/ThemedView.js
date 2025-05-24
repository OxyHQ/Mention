"use strict";
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ThemedView = ThemedView;
var react_native_1 = require("react-native");
var useThemeColor_1 = require("@/hooks/useThemeColor");
function ThemedView(_a) {
    var style = _a.style, lightColor = _a.lightColor, darkColor = _a.darkColor, otherProps = __rest(_a, ["style", "lightColor", "darkColor"]);
    var backgroundColor = (0, useThemeColor_1.useThemeColor)({ light: lightColor, dark: darkColor }, 'background');
    return <react_native_1.View style={[{ backgroundColor: backgroundColor }, style]} {...otherProps}/>;
}
