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
exports.BottomBar = void 0;
var vector_icons_1 = require("@expo/vector-icons");
var services_1 = require("@oxyhq/services");
var expo_router_1 = require("expo-router");
var react_1 = require("react");
var react_native_1 = require("react-native");
var Avatar_1 = require("./Avatar");
var BottomBar = function () {
    var router = (0, expo_router_1.useRouter)();
    var _a = react_1.default.useState('/'), activeRoute = _a[0], setActiveRoute = _a[1];
    var pathname = (0, expo_router_1.usePathname)();
    var _b = (0, services_1.useOxy)(), showBottomSheet = _b.showBottomSheet, hideBottomSheet = _b.hideBottomSheet;
    var handlePress = function (route) {
        setActiveRoute(route);
        router.push(route);
    };
    var styles = react_native_1.StyleSheet.create({
        bottomBar: __assign({ width: '100%', height: 60, backgroundColor: '#ffffff', flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', borderTopWidth: 1, borderTopColor: '#eeeeee', elevation: 8 }, react_native_1.Platform.select({
            web: {
                position: 'sticky',
                bottom: 0,
                left: 0,
            },
        })),
        tab: {
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            paddingVertical: 10,
        },
        active: {
            borderRadius: 30,
        },
    });
    return (<react_native_1.View style={styles.bottomBar}>
            <react_native_1.Pressable onPress={function () { return handlePress('/'); }} style={[styles.tab, activeRoute === '/' && styles.active]}>
                <vector_icons_1.Ionicons name={activeRoute === '/' ? "home" : "home-outline"} size={28} color={activeRoute === '/' ? "#4E67EB" : "#000"}/>
            </react_native_1.Pressable>
            <react_native_1.Pressable onPress={function () { return handlePress('/properties'); }} style={[styles.tab, activeRoute === '/properties' && styles.active]}>
                <vector_icons_1.Ionicons name={activeRoute === '/properties' ? "search" : "search-outline"} size={28} color={activeRoute === '/properties' ? "#4E67EB" : "#000"}/>
            </react_native_1.Pressable>
            <react_native_1.Pressable onPress={function () { return handlePress('/saved'); }} style={[styles.tab, activeRoute === '/saved' && styles.active]}>
                <vector_icons_1.Ionicons name={activeRoute === '/saved' ? "bookmark" : "bookmark-outline"} size={28} color={activeRoute === '/saved' ? "#4E67EB" : "#000"}/>
            </react_native_1.Pressable>
            <react_native_1.Pressable onPress={function () { return handlePress('/contracts'); }} style={[styles.tab, activeRoute === '/contracts' && styles.active]}>
                <vector_icons_1.Ionicons name={activeRoute === '/contracts' ? "document-text" : "document-text-outline"} size={28} color={activeRoute === '/contracts' ? "#4E67EB" : "#000"}/>
            </react_native_1.Pressable>
            <react_native_1.View style={styles.tab}>
                <Avatar_1.default onPress={function () { return showBottomSheet === null || showBottomSheet === void 0 ? void 0 : showBottomSheet('SignIn'); }}/>
            </react_native_1.View>
        </react_native_1.View>);
};
exports.BottomBar = BottomBar;
