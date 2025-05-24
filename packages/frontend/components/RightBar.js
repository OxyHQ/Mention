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
exports.RightBar = RightBar;
var Avatar_1 = require("@/components/Avatar");
var Trends_1 = require("@/features/trends/Trends");
var services_1 = require("@oxyhq/services");
var expo_router_1 = require("expo-router");
var react_1 = require("react");
var react_i18next_1 = require("react-i18next");
var react_native_1 = require("react-native");
var react_responsive_1 = require("react-responsive");
var colors_1 = require("../styles/colors");
var SearchBar_1 = require("./SearchBar");
function RightBar() {
    var _this = this;
    var oxyServices = (0, services_1.useOxy)().oxyServices;
    var isRightBarVisible = (0, react_responsive_1.useMediaQuery)({ minWidth: 990 });
    var pathname = (0, expo_router_1.usePathname)();
    var isExplorePage = pathname === '/explore';
    var _a = (0, react_1.useState)(false), loading = _a[0], setLoading = _a[1];
    var _b = (0, react_1.useState)(null), error = _b[0], setError = _b[1];
    var _c = (0, react_1.useState)(null), recommendations = _c[0], setRecommendations = _c[1];
    (0, react_1.useEffect)(function () {
        var fetchRecommendations = function () { return __awaiter(_this, void 0, void 0, function () {
            var response, err_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, 3, 4]);
                        setLoading(true);
                        setError(null);
                        return [4 /*yield*/, oxyServices.getProfileRecommendations()];
                    case 1:
                        response = _a.sent();
                        console.log('Recommendations:', response);
                        setRecommendations(response);
                        return [3 /*break*/, 4];
                    case 2:
                        err_1 = _a.sent();
                        setError(err_1 instanceof Error ? err_1.message : 'Failed to fetch recommendations');
                        console.error('Error fetching recommendations:', err_1);
                        return [3 /*break*/, 4];
                    case 3:
                        setLoading(false);
                        return [7 /*endfinally*/];
                    case 4: return [2 /*return*/];
                }
            });
        }); };
        fetchRecommendations();
    }, [oxyServices]);
    if (!isRightBarVisible)
        return null;
    return (<react_native_1.View style={styles.container}>
            <SearchBar_1.SearchBar />
            {!isExplorePage && (<Trends_1.Trends />)}
            {loading ? (<react_native_1.View style={styles.loadingContainer}>
                    <react_native_1.ActivityIndicator size="small" color={colors_1.colors.primaryColor}/>
                    <react_native_1.Text style={styles.loadingText}>Loading recommendations...</react_native_1.Text>
                </react_native_1.View>) : error ? (<react_native_1.View style={styles.errorContainer}>
                    <react_native_1.Text style={styles.errorText}>Error: {error}</react_native_1.Text>
                </react_native_1.View>) : (recommendations === null || recommendations === void 0 ? void 0 : recommendations.length) === 0 ? (<react_native_1.View style={styles.emptyContainer}>
                    <react_native_1.Text>No recommendations available</react_native_1.Text>
                </react_native_1.View>) : (<SuggestedFriends followRecData={recommendations !== null && recommendations !== void 0 ? recommendations : []}/>)}
        </react_native_1.View>);
}
function SuggestedFriends(_a) {
    var followRecData = _a.followRecData;
    var t = (0, react_i18next_1.useTranslation)().t;
    var router = (0, expo_router_1.useRouter)();
    return (<react_native_1.View style={{
            backgroundColor: colors_1.colors.primaryLight,
            borderRadius: 15,
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
                    {t("Who to follow")}
                </react_native_1.Text>
            </react_native_1.View>
            <react_native_1.View>
                {followRecData === null || followRecData === void 0 ? void 0 : followRecData.map(function (data, index) { return (<FollowRowComponent key={data.id || index} profileData={data}/>); })}
            </react_native_1.View>
            <react_native_1.TouchableOpacity onPress={function () { return router.push('/explore'); }} style={__assign({ padding: 14, backgroundColor: 'transparent' }, react_native_1.Platform.select({
            web: {
                cursor: 'pointer',
            },
        }))} activeOpacity={0.7}>
                <react_native_1.Text style={{ fontSize: 15, color: colors_1.colors.primaryColor }}>
                    {t("Show more")}
                </react_native_1.Text>
            </react_native_1.TouchableOpacity>
        </react_native_1.View>);
}
var FollowRowComponent = function (_a) {
    var _b;
    var profileData = _a.profileData;
    // Skip rendering if no id
    if (!profileData.id)
        return null;
    var displayName = ((_b = profileData.name) === null || _b === void 0 ? void 0 : _b.first)
        ? "".concat(profileData.name.first, " ").concat(profileData.name.last || '').trim()
        : profileData.username || 'Unknown User';
    var username = profileData.username || profileData.id;
    return (<expo_router_1.Link href={"/@".concat(username)} asChild>
            <react_native_1.View style={__assign({ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: 0.01, borderBottomColor: colors_1.colors.COLOR_BLACK_LIGHT_6, padding: 12, flex: 1 }, react_native_1.Platform.select({
            web: {
                cursor: 'pointer',
            },
        }))}>
                <react_native_1.View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                    <Avatar_1.default id={profileData.id}/>
                    <react_native_1.View style={{ marginRight: 'auto', marginLeft: 13 }}>
                        <react_native_1.Text style={{ fontWeight: 'bold', fontSize: 15 }}>
                            {displayName}
                        </react_native_1.Text>
                        <react_native_1.Text style={{ color: colors_1.colors.COLOR_BLACK_LIGHT_4, paddingTop: 4 }}>
                            @{username}
                        </react_native_1.Text>
                        {profileData.bio && (<react_native_1.Text style={{
                color: colors_1.colors.COLOR_BLACK_LIGHT_4,
                paddingTop: 4,
                fontSize: 13
            }} numberOfLines={2}>
                                {profileData.bio}
                            </react_native_1.Text>)}
                    </react_native_1.View>
                </react_native_1.View>
                <services_1.FollowButton userId={profileData.id} size="small"/>
            </react_native_1.View>
        </expo_router_1.Link>);
};
var styles = react_native_1.StyleSheet.create({
    container: __assign({ width: 350, paddingStart: 20, flexDirection: 'column', gap: 20 }, react_native_1.Platform.select({
        web: {
            position: 'sticky',
            top: 50,
            bottom: 20,
        },
    })),
    loadingContainer: {
        padding: 20,
        alignItems: 'center',
        backgroundColor: colors_1.colors.primaryLight,
        borderRadius: 15,
        gap: 10,
    },
    loadingText: {
        color: colors_1.colors.COLOR_BLACK_LIGHT_4,
    },
    errorContainer: {
        padding: 20,
        backgroundColor: colors_1.colors.primaryLight,
        borderRadius: 15,
    },
    errorText: {
        color: 'red',
    },
    emptyContainer: {
        padding: 20,
        alignItems: 'center',
        backgroundColor: colors_1.colors.primaryLight,
        borderRadius: 15,
    },
    followButton: {
        backgroundColor: colors_1.colors.primaryColor,
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    followButtonText: {
        color: 'white',
        fontWeight: 'bold',
        fontSize: 14,
    },
});
