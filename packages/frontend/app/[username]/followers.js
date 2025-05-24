"use strict";
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
exports.default = FollowersScreen;
var Header_1 = require("@/components/Header");
var ThemedText_1 = require("@/components/ThemedText");
var colors_1 = require("@/styles/colors");
var services_1 = require("@oxyhq/services");
var expo_router_1 = require("expo-router");
var react_1 = require("react");
var react_i18next_1 = require("react-i18next");
var react_native_1 = require("react-native");
function FollowersScreen() {
    var _this = this;
    var _a;
    var username = (0, expo_router_1.useLocalSearchParams)().username;
    var cleanUsername = username.startsWith('@') ? username.slice(1) : username;
    var _b = (0, services_1.useOxy)(), user = _b.user, oxyServices = _b.oxyServices;
    var _c = (0, react_1.useState)(true), loading = _c[0], setLoading = _c[1];
    var _d = (0, react_1.useState)([]), followers = _d[0], setFollowers = _d[1];
    var _e = (0, react_1.useState)(null), profile = _e[0], setProfile = _e[1];
    var t = (0, react_i18next_1.useTranslation)().t;
    (0, react_1.useEffect)(function () {
        var loadFollowers = function () { return __awaiter(_this, void 0, void 0, function () {
            var userProfile, followersList, error_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 4, 5, 6]);
                        return [4 /*yield*/, oxyServices.getProfileByUsername(cleanUsername)];
                    case 1:
                        userProfile = _a.sent();
                        if (!userProfile) {
                            throw new Error('User profile is null');
                        }
                        if (!(userProfile === null || userProfile === void 0 ? void 0 : userProfile._id)) return [3 /*break*/, 3];
                        setProfile(userProfile);
                        return [4 /*yield*/, oxyServices.getUserFollowers(userProfile._id)];
                    case 2:
                        followersList = _a.sent();
                        console.log('Followers:', followersList);
                        setFollowers(followersList || []);
                        _a.label = 3;
                    case 3: return [3 /*break*/, 6];
                    case 4:
                        error_1 = _a.sent();
                        console.error('Error loading followers:', error_1);
                        return [3 /*break*/, 6];
                    case 5:
                        setLoading(false);
                        return [7 /*endfinally*/];
                    case 6: return [2 /*return*/];
                }
            });
        }); };
        loadFollowers();
    }, [cleanUsername, oxyServices]);
    var renderUser = function (_a) {
        var _b, _c;
        var item = _a.item;
        return (<react_native_1.View style={{
                flexDirection: 'row',
                alignItems: 'center',
                padding: 16,
                borderBottomWidth: 0.5,
                borderBottomColor: colors_1.colors.COLOR_BLACK_LIGHT_6
            }}>
      <expo_router_1.Link href={"/@".concat(item.username)} asChild>
        <react_native_1.View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
          <services_1.Avatar uri={(_b = item.avatar) === null || _b === void 0 ? void 0 : _b.url} size={40}/>
          <react_native_1.View style={{ marginLeft: 12, flex: 1 }}>
            <ThemedText_1.ThemedText style={{ fontWeight: '600' }}>
              {((_c = item.name) === null || _c === void 0 ? void 0 : _c.first) ? "".concat(item.name.first, " ").concat(item.name.last || '').trim() : item.username}
            </ThemedText_1.ThemedText>
            <ThemedText_1.ThemedText style={{ color: colors_1.colors.COLOR_BLACK_LIGHT_4 }}>@{item.username}</ThemedText_1.ThemedText>
          </react_native_1.View>
        </react_native_1.View>
      </expo_router_1.Link>
      <services_1.FollowButton userId={item._id || item.userID}/>
    </react_native_1.View>);
    };
    if (loading) {
        return (<react_native_1.View style={{ flex: 1 }}>
        <Header_1.Header options={{ title: t("Followers"), showBackButton: true }}/>
        <react_native_1.ActivityIndicator style={{ marginTop: 20 }}/>
      </react_native_1.View>);
    }
    return (<react_native_1.View style={{ flex: 1 }}>
      <Header_1.Header options={{ title: "".concat(((_a = profile === null || profile === void 0 ? void 0 : profile.name) === null || _a === void 0 ? void 0 : _a.first) ? "".concat(profile.name.first, " ").concat(profile.name.last || '').trim() : username, " ").concat(t("Followers")), showBackButton: true }}/>
      <react_native_1.FlatList data={followers} renderItem={renderUser} keyExtractor={function (item) { return item._id || item.userID; }} ListEmptyComponent={<react_native_1.View style={{ padding: 16, alignItems: 'center' }}>
            <ThemedText_1.ThemedText>{t("No followers yet")}</ThemedText_1.ThemedText>
          </react_native_1.View>}/>
    </react_native_1.View>);
}
