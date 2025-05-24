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
exports.Trends = void 0;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var react_i18next_1 = require("react-i18next");
var react_redux_1 = require("react-redux");
var vector_icons_1 = require("@expo/vector-icons");
var colors_1 = require("@/styles/colors");
var TrendItem_1 = require("@/features/trends/TrendItem");
var trendsReducer_1 = require("@/store/reducers/trendsReducer");
var loading_icon_1 = require("@/assets/icons/loading-icon");
var Trends = function (_a) {
    var hideTrends = _a.hideTrends;
    var router = (0, expo_router_1.useRouter)();
    var pathname = (0, expo_router_1.usePathname)();
    var isExplorePage = pathname === '/explore';
    var t = (0, react_i18next_1.useTranslation)().t;
    var trendsData = (0, react_redux_1.useSelector)(function (state) { return state.trends.trends; });
    var isLoading = (0, react_redux_1.useSelector)(function (state) { return state.trends.isLoading; });
    var dispatch = (0, react_redux_1.useDispatch)();
    (0, react_1.useEffect)(function () {
        dispatch((0, trendsReducer_1.fetchTrends)());
    }, [dispatch]);
    if (hideTrends)
        return null;
    if (isLoading) {
        return (<react_native_1.View style={{
                backgroundColor: colors_1.colors.primaryLight,
                borderRadius: 15,
                alignContent: 'center',
                alignItems: 'center',
                flexDirection: 'column',
                height: 400,
            }}>
                <loading_icon_1.Loading size={40}/>
            </react_native_1.View>);
    }
    return (<react_native_1.View style={{
            backgroundColor: isExplorePage ? "" : colors_1.colors.primaryLight,
            borderRadius: isExplorePage ? 0 : 15,
            overflow: 'hidden',
        }}>
            <react_native_1.View style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: 14,
            paddingVertical: 14,
            borderBottomWidth: 0.01,
            borderBottomColor: colors_1.colors.COLOR_BLACK_LIGHT_6,
        }}>
                <react_native_1.Text style={{ fontSize: 18, fontWeight: 'bold' }}>
                    {t("Trends for you")}
                </react_native_1.Text>
                <react_native_1.TouchableOpacity onPress={function () { return router.push('/settings'); }}>
                    <vector_icons_1.Ionicons style={{ fontSize: 20 }} name="settings"/>
                </react_native_1.TouchableOpacity>
            </react_native_1.View>
            <react_native_1.View>
                <react_native_1.FlatList data={trendsData} renderItem={function (_a) {
            var item = _a.item;
            return (<TrendItem_1.TrendItem topHeader="Hashtag · Trending" mainTitle={item.text} numberOfPosts={item.score}/>);
        }} keyExtractor={function (item) { return item.id; }}/>
            </react_native_1.View>
            {!isExplorePage && (<react_native_1.View>
                    <react_native_1.TouchableOpacity onPress={function () { return router.push('/explore'); }} style={styles.showMoreButton}>
                        <react_native_1.Text style={{ fontSize: 15, color: colors_1.colors.primaryColor }}>
                            {t("Show more")}
                        </react_native_1.Text>
                    </react_native_1.TouchableOpacity>
                </react_native_1.View>)}
        </react_native_1.View>);
};
exports.Trends = Trends;
var styles = react_native_1.StyleSheet.create({
    showMoreButton: __assign(__assign({ padding: 14 }, react_native_1.Platform.select({
        web: {
            cursor: 'pointer',
        },
    })), { backgroundColor: 'transparent' })
});
