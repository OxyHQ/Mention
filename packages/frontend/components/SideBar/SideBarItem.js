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
exports.SideBarItem = SideBarItem;
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_responsive_1 = require("react-responsive");
var expo_router_1 = require("expo-router");
var colors_1 = require("@/styles/colors");
function SideBarItem(_a) {
    var isActive = _a.isActive, icon = _a.icon, text = _a.text, href = _a.href;
    var router = (0, expo_router_1.useRouter)();
    var isFullSideBar = (0, react_responsive_1.useMediaQuery)({ minWidth: 1266 });
    return (<react_native_1.Pressable onPress={function () { return router.push(href); }} style={function (_a) {
            var pressed = _a.pressed, hovered = _a.hovered;
            return [
                pressed ? { backgroundColor: "".concat(colors_1.colors.primaryColor, "33"), } : {},
                hovered ? { backgroundColor: "".concat(colors_1.colors.primaryColor, "22"), } : {},
                __assign({ flexDirection: 'row', alignItems: 'center', width: 'auto', marginBottom: 10, marginEnd: isFullSideBar ? 70 : 0, borderRadius: 100, padding: 12, paddingEnd: isFullSideBar ? 30 : 15 }, react_native_1.Platform.select({
                    web: {
                        cursor: 'pointer',
                    },
                })),
            ];
        }}>
            <react_native_1.View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {icon}
                {isFullSideBar ? (<react_native_1.Text style={{ marginStart: 15, fontSize: 20, color: isActive ? colors_1.colors.primaryColor : colors_1.colors.COLOR_BLACK }}>
                        {text}
                    </react_native_1.Text>) : null}
            </react_native_1.View>
        </react_native_1.Pressable>);
}
