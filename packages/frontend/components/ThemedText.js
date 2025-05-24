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
exports.ThemedText = ThemedText;
var react_native_1 = require("react-native");
var useThemeColor_1 = require("@/hooks/useThemeColor");
function ThemedText(_a) {
    var style = _a.style, lightColor = _a.lightColor, darkColor = _a.darkColor, _b = _a.type, type = _b === void 0 ? 'default' : _b, rest = __rest(_a, ["style", "lightColor", "darkColor", "type"]);
    var color = (0, useThemeColor_1.useThemeColor)({ light: lightColor, dark: darkColor }, 'text');
    return (<react_native_1.Text style={[
            { color: color },
            type === 'default' ? styles.default : undefined,
            type === 'title' ? styles.title : undefined,
            type === 'defaultSemiBold' ? styles.defaultSemiBold : undefined,
            type === 'subtitle' ? styles.subtitle : undefined,
            type === 'link' ? styles.link : undefined,
            style,
        ]} {...rest}/>);
}
var styles = react_native_1.StyleSheet.create({
    default: {
        fontSize: 16,
        lineHeight: 24,
    },
    defaultSemiBold: {
        fontSize: 16,
        lineHeight: 24,
        fontWeight: '600',
    },
    title: {
        fontSize: 32,
        fontWeight: 'bold',
        lineHeight: 32,
    },
    subtitle: {
        fontSize: 20,
        fontWeight: 'bold',
    },
    link: {
        lineHeight: 30,
        fontSize: 16,
        color: '#0a7ea4',
    },
});
