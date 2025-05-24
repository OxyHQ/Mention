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
exports.Logo = void 0;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var logo_1 = require("@/assets/logo");
var colors_1 = require("@/styles/colors");
var Logo = function () {
    var router = (0, expo_router_1.useRouter)();
    return (<react_native_1.Pressable onPress={function () { return router.push("/"); }} style={function (_a) {
            var pressed = _a.pressed;
            return [
                pressed ? { backgroundColor: "".concat(colors_1.colors.primaryColor, "33"), } : {},
                styles.container,
            ];
        }}>
      <react_native_1.View style={styles.logo}>
        <logo_1.LogoIcon style={styles.logoSvg} size={27} color={colors_1.colors.primaryColor}/>
      </react_native_1.View>
    </react_native_1.Pressable>);
};
exports.Logo = Logo;
var styles = react_native_1.StyleSheet.create({
    container: __assign({ justifyContent: "center", alignItems: "center", width: 'auto', marginBottom: 10, borderRadius: 1000 }, react_native_1.Platform.select({
        web: {
            cursor: 'pointer',
        },
    })),
    logo: {
        padding: 10,
    },
    logoSvg: {},
});
