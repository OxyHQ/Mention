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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SideBar = SideBar;
var analytics_icon_1 = require("@/assets/icons/analytics-icon");
var bell_icon_1 = require("@/assets/icons/bell-icon");
var bookmark_icon_1 = require("@/assets/icons/bookmark-icon");
var chat_icon_1 = require("@/assets/icons/chat-icon");
var compose_icon_1 = require("@/assets/icons/compose-icon");
var gear_icon_1 = require("@/assets/icons/gear-icon");
var hashtag_icon_1 = require("@/assets/icons/hashtag-icon");
var home_icon_1 = require("@/assets/icons/home-icon");
var list_icon_1 = require("@/assets/icons/list-icon");
var search_icon_1 = require("@/assets/icons/search-icon");
var video_icon_1 = require("@/assets/icons/video-icon");
var Logo_1 = require("@/components/Logo");
var Button_1 = require("@/components/SideBar/Button");
var colors_1 = require("@/styles/colors");
var services_1 = require("@oxyhq/services");
var expo_router_1 = require("expo-router");
var react_1 = require("react");
var react_i18next_1 = require("react-i18next");
var react_native_1 = require("react-native");
var Ionicons_1 = require("react-native-vector-icons/Ionicons");
var react_responsive_1 = require("react-responsive");
var SideBarItem_1 = require("./SideBarItem");
var WindowHeight = react_native_1.Dimensions.get('window').height;
function SideBar() {
    var _this = this;
    var t = (0, react_i18next_1.useTranslation)().t;
    var _a = (0, services_1.useOxy)(), logout = _a.logout, isLoading = _a.isLoading, user = _a.user, isAuthenticated = _a.isAuthenticated, showBottomSheet = _a.showBottomSheet;
    var handleLogout = function () { return __awaiter(_this, void 0, void 0, function () {
        var error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, logout()];
                case 1:
                    _a.sent();
                    expo_router_1.router.push('/');
                    return [3 /*break*/, 3];
                case 2:
                    error_1 = _a.sent();
                    console.error('Logout failed:', error_1);
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    }); };
    var sideBarData = [
        {
            title: 'Home',
            icon: <home_icon_1.Home color={colors_1.colors.COLOR_BLACK}/>,
            iconActive: <home_icon_1.HomeActive />,
            route: '/',
        },
        {
            title: t("Explore"),
            icon: <search_icon_1.Search color={colors_1.colors.COLOR_BLACK}/>,
            iconActive: <search_icon_1.SearchActive />,
            route: '/explore',
        },
        {
            title: t("Notifications"),
            icon: <bell_icon_1.Bell color={colors_1.colors.COLOR_BLACK}/>,
            iconActive: <bell_icon_1.BellActive />,
            route: '/notifications',
        },
        {
            title: 'Chat',
            icon: <chat_icon_1.Chat color={colors_1.colors.COLOR_BLACK}/>,
            iconActive: <chat_icon_1.ChatActive />,
            route: '/chat',
        },
        {
            title: t("Analytics"),
            icon: <analytics_icon_1.AnalyticsIcon color={colors_1.colors.COLOR_BLACK}/>,
            iconActive: <analytics_icon_1.AnalyticsIconActive />,
            route: '/analytics',
        },
        {
            title: t("Bookmarks"),
            icon: <bookmark_icon_1.Bookmark color={colors_1.colors.COLOR_BLACK}/>,
            iconActive: <bookmark_icon_1.BookmarkActive />,
            route: '/bookmarks',
        },
        {
            title: t("Feeds"),
            icon: <hashtag_icon_1.Hashtag color={colors_1.colors.COLOR_BLACK}/>,
            iconActive: <hashtag_icon_1.HashtagActive />,
            route: '/feeds',
        },
        {
            title: t("Lists"),
            icon: <list_icon_1.List color={colors_1.colors.COLOR_BLACK}/>,
            iconActive: <list_icon_1.ListActive />,
            route: '/lists',
        },
        {
            title: t("Videos"),
            icon: <video_icon_1.Video color={colors_1.colors.COLOR_BLACK}/>,
            iconActive: <video_icon_1.VideoActive />,
            route: '/videos',
        },
        {
            title: t("Settings"),
            icon: <gear_icon_1.Gear color={colors_1.colors.COLOR_BLACK}/>,
            iconActive: <gear_icon_1.GearActive />,
            route: '/settings',
        },
    ];
    var pathname = (0, expo_router_1.usePathname)();
    var isSideBarVisible = (0, react_responsive_1.useMediaQuery)({ minWidth: 500 });
    var isFullSideBar = (0, react_responsive_1.useMediaQuery)({ minWidth: 1266 });
    var isRightBarVisible = (0, react_responsive_1.useMediaQuery)({ minWidth: 990 });
    if (!isSideBarVisible)
        return null;
    if (isSideBarVisible) {
        return (<react_native_1.View style={__assign(__assign({ paddingVertical: 20, height: WindowHeight, 
                // width: '30%',
                paddingHorizontal: isFullSideBar ? 20 : 0, alignItems: isFullSideBar ? 'flex-end' : 'center', paddingEnd: !isFullSideBar ? 10 : 0, width: isFullSideBar ? 360 : 60 }, react_native_1.Platform.select({
                web: {
                    position: 'sticky',
                },
            })), { top: 0 })}>
                <react_native_1.View style={{
                justifyContent: 'center',
                alignItems: 'flex-start',
            }}>
                    <Logo_1.Logo />
                    {!isAuthenticated && (<react_native_1.View>
                            <react_native_1.Text style={{
                    color: colors_1.colors.COLOR_BLACK,
                    fontSize: 25,
                    fontWeight: 'bold',
                    flexWrap: 'wrap',
                    textAlign: 'left',
                    maxWidth: 200,
                    lineHeight: 30,
                }}>{t("Join the conversation")}</react_native_1.Text>
                            {!isAuthenticated && (<react_native_1.View style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        marginVertical: 20,
                        gap: 10,
                    }}>
                                    <react_native_1.TouchableOpacity style={{
                        justifyContent: 'center',
                        alignItems: 'center',
                        backgroundColor: colors_1.colors.COLOR_BLACK,
                        borderRadius: 25,
                        paddingHorizontal: 15,
                        paddingVertical: 8,
                    }} onPress={function () { return showBottomSheet === null || showBottomSheet === void 0 ? void 0 : showBottomSheet('SignUp'); }}>
                                        <react_native_1.Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold' }}>{t("Sign Up")}</react_native_1.Text>
                                    </react_native_1.TouchableOpacity>
                                    <react_native_1.TouchableOpacity style={{
                        justifyContent: 'center',
                        alignItems: 'center',
                        backgroundColor: colors_1.colors.primaryColor,
                        borderRadius: 25,
                        paddingHorizontal: 15,
                        paddingVertical: 8,
                    }} onPress={function () { return showBottomSheet === null || showBottomSheet === void 0 ? void 0 : showBottomSheet('SignIn'); }}>
                                        <react_native_1.Text style={{ color: '#fff', fontSize: 14, fontWeight: 'bold' }}>{t("Sign In")}</react_native_1.Text>
                                    </react_native_1.TouchableOpacity>
                                </react_native_1.View>)}
                        </react_native_1.View>)}
                    {isAuthenticated && (<react_native_1.View style={{
                    justifyContent: 'center',
                    alignItems: 'flex-start',
                }}>
                            {sideBarData.map(function (_a) {
                    var title = _a.title, icon = _a.icon, iconActive = _a.iconActive, route = _a.route;
                    return <SideBarItem_1.SideBarItem href={route} key={title} icon={pathname === route ? iconActive : icon} text={title} isActive={pathname === route}/>;
                })}
                            <Button_1.Button renderText={function (_a) {
                    var state = _a.state;
                    return state === 'desktop' ? (<react_native_1.Text className="text-white text-[17px] font-bold">
                                            New Post
                                        </react_native_1.Text>) : null;
                }} renderIcon={function (_a) {
                    var state = _a.state;
                    return state === 'tablet' ? (<compose_icon_1.Compose size={24} color={colors_1.colors.primaryLight}/>) : null;
                }} containerStyle={function (_a) {
                    var state = _a.state;
                    return (__assign({ justifyContent: 'center', alignItems: 'center', backgroundColor: colors_1.colors.primaryColor, borderRadius: 100, height: state === 'desktop' ? 47 : 50, width: state === 'desktop' ? 220 : 50 }, (state === 'desktop'
                        ? {}
                        : {
                            alignSelf: 'center',
                        })));
                }}/>
                        </react_native_1.View>)}
                </react_native_1.View>
                <react_native_1.View style={{ flex: 1, }}></react_native_1.View>
                <react_native_1.View style={{ width: '100%', paddingHorizontal: 20, }}>
                    {isAuthenticated && (<react_native_1.View style={styles.logoutContainer}>
                                            <react_native_1.TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
                                                <Ionicons_1.default name="log-out-outline" size={20} color="#fff"/>
                                                <react_native_1.Text style={styles.logoutButtonText}>Logout</react_native_1.Text>
                                            </react_native_1.TouchableOpacity>
                                        </react_native_1.View>)}
                </react_native_1.View>
            </react_native_1.View>);
    }
    else {
        return null;
    }
}
var styles = react_native_1.StyleSheet.create({
    // Logout
    logoutContainer: {
        padding: 16,
        marginBottom: 20,
    },
    logoutButton: {
        backgroundColor: '#E0245E',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 12,
        borderRadius: 50,
    },
    logoutButtonText: {
        color: '#fff',
        fontSize: 16,
        fontWeight: 'bold',
        marginLeft: 8,
    },
});
