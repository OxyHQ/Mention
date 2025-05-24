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
exports.TrendItem = void 0;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_native_web_hover_1 = require("react-native-web-hover");
var vector_icons_1 = require("@expo/vector-icons");
var colors_1 = require("@/styles/colors");
var react_i18next_1 = require("react-i18next");
var TrendItem = function (_a) {
    var topHeader = _a.topHeader, mainTitle = _a.mainTitle, numberOfPosts = _a.numberOfPosts;
    var t = (0, react_i18next_1.useTranslation)().t;
    return (<expo_router_1.Link href={"/search/%23".concat(mainTitle)} style={styles.trendItem}>
            <react_native_1.View style={{
            flex: 1,
            justifyContent: 'space-between',
        }}>
                <react_native_1.Text style={{ fontSize: 13, color: colors_1.colors.COLOR_BLACK_LIGHT_4 }}>
                    {topHeader}
                </react_native_1.Text>
                <react_native_1.Text style={{ fontSize: 15, fontWeight: 'bold', paddingVertical: 3 }}>
                    {"#".concat(mainTitle)}
                </react_native_1.Text>
                <react_native_1.Text style={{ fontSize: 14, color: colors_1.colors.COLOR_BLACK_LIGHT_4 }}>
                    {numberOfPosts} {t("posts")}
                </react_native_1.Text>
            </react_native_1.View>
            <react_native_web_hover_1.Pressable style={function (_a) {
            var hovered = _a.hovered;
            return [
                hovered
                    ? {
                        backgroundColor: colors_1.colors.COLOR_BLACK_LIGHT_6,
                    }
                    : {},
                {
                    borderRadius: 100,
                    width: 40,
                    height: 40,
                    justifyContent: 'center',
                    alignItems: 'center',
                    marginTop: -20,
                },
            ];
        }}>
                <vector_icons_1.Ionicons name="ellipsis-horizontal" style={{
            fontSize: 20,
            color: colors_1.colors.COLOR_BLACK_LIGHT_5,
        }}/>
            </react_native_web_hover_1.Pressable>
        </expo_router_1.Link>);
};
exports.TrendItem = TrendItem;
var styles = react_native_1.StyleSheet.create({
    trendItem: __assign({ display: 'flex', flex: 1, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 12, borderBottomWidth: 0.01, borderBottomColor: colors_1.colors.COLOR_BLACK_LIGHT_6 }, react_native_1.Platform.select({
        web: {
            cursor: 'pointer',
        },
    })),
});
