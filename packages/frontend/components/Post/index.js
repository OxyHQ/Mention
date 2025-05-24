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
exports.default = Post;
var bookmark_icon_1 = require("@/assets/icons/bookmark-icon");
var heart_icon_1 = require("@/assets/icons/heart-icon");
var repost_icon_1 = require("@/assets/icons/repost-icon");
var share_icon_1 = require("@/assets/icons/share-icon");
var sonner_1 = require("@/lib/sonner");
var colors_1 = require("@/styles/colors");
var api_1 = require("@/utils/api");
var vector_icons_1 = require("@expo/vector-icons");
var services_1 = require("@oxyhq/services");
var react_query_1 = require("@tanstack/react-query");
var date_fns_1 = require("date-fns");
var expo_router_1 = require("expo-router");
var react_1 = require("react");
var react_i18next_1 = require("react-i18next");
var react_native_1 = require("react-native");
var Avatar_1 = require("../Avatar");
if (!global.profileCacheMap) {
    global.profileCacheMap = new Map();
}
function Post(_a) {
    var _this = this;
    var _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    var postData = _a.postData, quotedPost = _a.quotedPost, className = _a.className, style = _a.style, _o = _a.showActions, showActions = _o === void 0 ? true : _o;
    var t = (0, react_i18next_1.useTranslation)().t;
    var queryClient = (0, react_query_1.useQueryClient)();
    var _p = (0, react_1.useState)(postData.isLiked || false), isLiked = _p[0], setIsLiked = _p[1];
    var _q = (0, react_1.useState)(((_b = postData._count) === null || _b === void 0 ? void 0 : _b.likes) || 0), likesCount = _q[0], setLikesCount = _q[1];
    var _r = (0, react_1.useState)(postData.isReposted || false), isReposted = _r[0], setIsReposted = _r[1];
    var _s = (0, react_1.useState)(((_c = postData._count) === null || _c === void 0 ? void 0 : _c.reposts) || 0), repostsCount = _s[0], setRepostsCount = _s[1];
    var _t = (0, react_1.useState)(postData.isBookmarked || false), isBookmarked = _t[0], setIsBookmarked = _t[1];
    var _u = (0, react_1.useState)(((_d = postData._count) === null || _d === void 0 ? void 0 : _d.bookmarks) || 0), bookmarksCount = _u[0], setBookmarksCount = _u[1];
    var _v = (0, react_1.useState)(null), poll = _v[0], setPoll = _v[1];
    var _w = (0, react_1.useState)(null), selectedOption = _w[0], setSelectedOption = _w[1];
    var _x = (0, react_1.useState)(false), isFollowing = _x[0], setIsFollowing = _x[1];
    var _y = (0, services_1.useOxy)(), user = _y.user, isAuthenticated = _y.isAuthenticated;
    var animatedScale = (0, react_1.useRef)(new react_native_1.Animated.Value(1)).current;
    var authorId = (_e = postData.author) === null || _e === void 0 ? void 0 : _e.id;
    // Reset states when post data changes
    (0, react_1.useEffect)(function () {
        var _a, _b, _c;
        setIsLiked(postData.isLiked || false);
        setLikesCount(((_a = postData._count) === null || _a === void 0 ? void 0 : _a.likes) || 0);
        setIsReposted(postData.isReposted || false);
        setRepostsCount(((_b = postData._count) === null || _b === void 0 ? void 0 : _b.reposts) || 0);
        setIsBookmarked(postData.isBookmarked || false);
        setBookmarksCount(((_c = postData._count) === null || _c === void 0 ? void 0 : _c.bookmarks) || 0);
    }, [postData]);
    // Check following status if we're authenticated and not looking at our own post
    (0, react_1.useEffect)(function () {
        var checkFollowingStatus = function () { return __awaiter(_this, void 0, void 0, function () {
            return __generator(this, function (_a) {
                if (isAuthenticated && authorId && (user === null || user === void 0 ? void 0 : user.id) !== authorId) {
                    try {
                        // Check if the user is already following the author
                    }
                    catch (error) {
                        console.error('Error checking following status:', error);
                    }
                }
                return [2 /*return*/];
            });
        }); };
        checkFollowingStatus();
    }, [authorId, user, isAuthenticated]);
    // Animation for interactions
    var animateInteraction = function () {
        react_native_1.Animated.sequence([
            react_native_1.Animated.spring(animatedScale, {
                toValue: 1.2,
                useNativeDriver: true,
            }),
            react_native_1.Animated.spring(animatedScale, {
                toValue: 1,
                useNativeDriver: true,
            }),
        ]).start();
    };
    var handleLike = function () { return __awaiter(_this, void 0, void 0, function () {
        var newIsLiked_1, feedQueries, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!isAuthenticated) {
                        sonner_1.toast.error(t('Please sign in to like posts'));
                        return [2 /*return*/];
                    }
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 6, , 7]);
                    newIsLiked_1 = !isLiked;
                    // Optimistic update
                    setIsLiked(newIsLiked_1);
                    setLikesCount(function (prev) { return prev + (newIsLiked_1 ? 1 : -1); });
                    animateInteraction();
                    feedQueries = queryClient.getQueriesData({
                        queryKey: ['feed']
                    });
                    // Update all feed queries that might have this post
                    feedQueries.forEach(function (_a) {
                        var queryKey = _a[0];
                        queryClient.setQueryData(queryKey, function (oldData) {
                            if (!(oldData === null || oldData === void 0 ? void 0 : oldData.pages))
                                return oldData;
                            return __assign(__assign({}, oldData), { pages: oldData.pages.map(function (page) { return (__assign(__assign({}, page), { posts: page.posts.map(function (post) {
                                        var _a;
                                        if (post.id === postData.id) {
                                            var likesCount_1 = (((_a = post._count) === null || _a === void 0 ? void 0 : _a.likes) || 0) + (newIsLiked_1 ? 1 : -1);
                                            return __assign(__assign({}, post), { isLiked: newIsLiked_1, _count: __assign(__assign({}, post._count), { likes: likesCount_1 >= 0 ? likesCount_1 : 0 }) });
                                        }
                                        return post;
                                    }) })); }) });
                        });
                    });
                    if (!newIsLiked_1) return [3 /*break*/, 3];
                    return [4 /*yield*/, api_1.default.post("posts/".concat(postData.id, "/like"))];
                case 2:
                    _a.sent();
                    return [3 /*break*/, 5];
                case 3: return [4 /*yield*/, api_1.default.delete("posts/".concat(postData.id, "/like"))];
                case 4:
                    _a.sent();
                    _a.label = 5;
                case 5: return [3 /*break*/, 7];
                case 6:
                    error_1 = _a.sent();
                    // Revert optimistic update on error
                    console.error('Error liking post:', error_1);
                    setIsLiked(function (prev) { return !prev; });
                    setLikesCount(function (prev) { return prev + (isLiked ? 1 : -1); });
                    sonner_1.toast.error(t('Failed to update like status'));
                    return [3 /*break*/, 7];
                case 7: return [2 /*return*/];
            }
        });
    }); };
    var handleReply = function () {
        expo_router_1.router.push("/post/".concat(postData.id, "/reply"));
    };
    var handleRepost = function () { return __awaiter(_this, void 0, void 0, function () {
        var newIsReposted_1, feedQueries, error_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!isAuthenticated) {
                        sonner_1.toast.error(t('Please sign in to repost'));
                        return [2 /*return*/];
                    }
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 6, , 7]);
                    newIsReposted_1 = !isReposted;
                    // Optimistic update
                    setIsReposted(newIsReposted_1);
                    setRepostsCount(function (prev) { return prev + (newIsReposted_1 ? 1 : -1); });
                    animateInteraction();
                    feedQueries = queryClient.getQueriesData({
                        queryKey: ['feed']
                    });
                    // Update all feed queries that might have this post
                    feedQueries.forEach(function (_a) {
                        var queryKey = _a[0];
                        queryClient.setQueryData(queryKey, function (oldData) {
                            if (!(oldData === null || oldData === void 0 ? void 0 : oldData.pages))
                                return oldData;
                            return __assign(__assign({}, oldData), { pages: oldData.pages.map(function (page) { return (__assign(__assign({}, page), { posts: page.posts.map(function (post) {
                                        var _a;
                                        if (post.id === postData.id) {
                                            var repostsCount_1 = (((_a = post._count) === null || _a === void 0 ? void 0 : _a.reposts) || 0) + (newIsReposted_1 ? 1 : -1);
                                            return __assign(__assign({}, post), { isReposted: newIsReposted_1, _count: __assign(__assign({}, post._count), { reposts: repostsCount_1 >= 0 ? repostsCount_1 : 0 }) });
                                        }
                                        return post;
                                    }) })); }) });
                        });
                    });
                    if (!newIsReposted_1) return [3 /*break*/, 3];
                    return [4 /*yield*/, api_1.default.post("posts/".concat(postData.id, "/repost"))];
                case 2:
                    _a.sent();
                    return [3 /*break*/, 5];
                case 3: return [4 /*yield*/, api_1.default.delete("posts/".concat(postData.id, "/repost"))];
                case 4:
                    _a.sent();
                    _a.label = 5;
                case 5: return [3 /*break*/, 7];
                case 6:
                    error_2 = _a.sent();
                    // Revert optimistic update on error
                    console.error('Error reposting:', error_2);
                    setIsReposted(function (prev) { return !prev; });
                    setRepostsCount(function (prev) { return prev + (isReposted ? 1 : -1); });
                    sonner_1.toast.error(t('Failed to update repost status'));
                    return [3 /*break*/, 7];
                case 7: return [2 /*return*/];
            }
        });
    }); };
    var handleBookmark = function () { return __awaiter(_this, void 0, void 0, function () {
        var newIsBookmarked_1, feedQueries, error_3;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!isAuthenticated) {
                        sonner_1.toast.error(t('Please sign in to bookmark posts'));
                        return [2 /*return*/];
                    }
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 6, , 7]);
                    newIsBookmarked_1 = !isBookmarked;
                    // Optimistic update
                    setIsBookmarked(newIsBookmarked_1);
                    setBookmarksCount(function (prev) { return prev + (newIsBookmarked_1 ? 1 : -1); });
                    feedQueries = queryClient.getQueriesData({
                        queryKey: ['feed']
                    });
                    // Update all feed queries that might have this post
                    feedQueries.forEach(function (_a) {
                        var queryKey = _a[0];
                        queryClient.setQueryData(queryKey, function (oldData) {
                            if (!(oldData === null || oldData === void 0 ? void 0 : oldData.pages))
                                return oldData;
                            return __assign(__assign({}, oldData), { pages: oldData.pages.map(function (page) { return (__assign(__assign({}, page), { posts: page.posts.map(function (post) {
                                        var _a;
                                        if (post.id === postData.id) {
                                            var bookmarksCount_1 = (((_a = post._count) === null || _a === void 0 ? void 0 : _a.bookmarks) || 0) + (newIsBookmarked_1 ? 1 : -1);
                                            return __assign(__assign({}, post), { isBookmarked: newIsBookmarked_1, _count: __assign(__assign({}, post._count), { bookmarks: bookmarksCount_1 >= 0 ? bookmarksCount_1 : 0 }) });
                                        }
                                        return post;
                                    }) })); }) });
                        });
                    });
                    if (!newIsBookmarked_1) return [3 /*break*/, 3];
                    return [4 /*yield*/, api_1.default.post("posts/".concat(postData.id, "/bookmark"))];
                case 2:
                    _a.sent();
                    return [3 /*break*/, 5];
                case 3: return [4 /*yield*/, api_1.default.delete("posts/".concat(postData.id, "/bookmark"))];
                case 4:
                    _a.sent();
                    _a.label = 5;
                case 5: return [3 /*break*/, 7];
                case 6:
                    error_3 = _a.sent();
                    // Revert optimistic update on error
                    console.error('Error bookmarking:', error_3);
                    setIsBookmarked(function (prev) { return !prev; });
                    setBookmarksCount(function (prev) { return prev + (isBookmarked ? 1 : -1); });
                    sonner_1.toast.error(t('Failed to update bookmark status'));
                    return [3 /*break*/, 7];
                case 7: return [2 /*return*/];
            }
        });
    }); };
    var handlePollOptionPress = function (optionIndex) { return __awaiter(_this, void 0, void 0, function () {
        var error_4;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!poll || selectedOption !== null)
                        return [2 /*return*/];
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, api_1.default.post("polls/".concat(poll.id, "/vote"), { option: optionIndex })];
                case 2:
                    _a.sent();
                    setPoll(function (prev) {
                        if (!prev)
                            return null;
                        var updatedOptions = prev.options.map(function (opt, idx) { return (__assign(__assign({}, opt), { votes: idx === optionIndex ? opt.votes + 1 : opt.votes })); });
                        return __assign(__assign({}, prev), { options: updatedOptions });
                    });
                    setSelectedOption(optionIndex);
                    return [3 /*break*/, 4];
                case 3:
                    error_4 = _a.sent();
                    console.error('Error voting in poll:', error_4);
                    sonner_1.toast.error('Failed to vote in poll');
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    }); };
    var handleShare = function () { return __awaiter(_this, void 0, void 0, function () {
        var error_5;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, react_native_1.Share.share({
                            message: "".concat(postData.text, "\n\nShared from Mention"),
                            url: "https://mention.earth/post/".concat(postData.id)
                        })];
                case 1:
                    _a.sent();
                    return [3 /*break*/, 3];
                case 2:
                    error_5 = _a.sent();
                    console.error('Error sharing post:', error_5);
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    }); };
    var formatTimeAgo = function (date) {
        var now = new Date();
        var postDate = new Date(date);
        var diffInMinutes = Math.floor((now.getTime() - postDate.getTime()) / (1000 * 60));
        if (diffInMinutes < 1)
            return 'just now';
        if (diffInMinutes < 60)
            return "".concat(diffInMinutes, "m");
        if (diffInMinutes < 1440)
            return "".concat(Math.floor(diffInMinutes / 60), "h");
        return (0, date_fns_1.format)(postDate, 'MMM d');
    };
    // Format the author's full name using profile data from post object
    var getAuthorDisplayName = function () {
        if (!postData.author)
            return t('Unknown');
        if (postData.author.name) {
            if (typeof postData.author.name === 'object') {
                var _a = postData.author.name, first = _a.first, last = _a.last;
                return "".concat(first, " ").concat(last || '').trim();
            }
            else {
                return postData.author.name;
            }
        }
        return postData.author.username || t('Unknown');
    };
    // Get author's username for profile links from post object
    var getAuthorUsername = function () {
        var _a;
        return ((_a = postData.author) === null || _a === void 0 ? void 0 : _a.username) || 'unknown';
    };
    // Check if user has premium status from post object
    var isPremiumUser = function () {
        var _a, _b;
        return ((_b = (_a = postData.author) === null || _a === void 0 ? void 0 : _a.premium) === null || _b === void 0 ? void 0 : _b.isPremium) || false;
    };
    // Get premium tier if available from post object
    var getPremiumTier = function () {
        var _a, _b;
        return ((_b = (_a = postData.author) === null || _a === void 0 ? void 0 : _a.premium) === null || _b === void 0 ? void 0 : _b.subscriptionTier) || null;
    };
    // Handle follow/unfollow
    var handleFollowToggle = function () { return __awaiter(_this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            if (!isAuthenticated) {
                sonner_1.toast.error(t('Please sign in to follow users'));
                return [2 /*return*/];
            }
            if (!authorId)
                return [2 /*return*/];
            try {
            }
            catch (error) {
                console.error('Error toggling follow status:', error);
                // Revert the optimistic update
                setIsFollowing(function (prevState) { return !prevState; });
                sonner_1.toast.error(t('Failed to update follow status'));
            }
            return [2 /*return*/];
        });
    }); };
    return (<react_native_1.View className={"border-b border-gray-100 ".concat(className)} style={style}>
            {postData.repost_of && (<react_native_1.View className="flex-row items-center px-3 mb-2">
                    <repost_icon_1.RepostIcon size={16} color="#536471"/>
                    <react_native_1.Text className="text-gray-500 ml-2">{getAuthorDisplayName()} {t('Reposted')}</react_native_1.Text>
                </react_native_1.View>)}
            <react_native_1.View className="flex-row gap-2.5 px-3 items-start">
                <expo_router_1.Link href={"/@".concat(getAuthorUsername())} asChild>
                    <react_native_1.TouchableOpacity onPress={function (e) { return e.stopPropagation(); }}>
                        <Avatar_1.default id={(_f = postData.author) === null || _f === void 0 ? void 0 : _f.avatar} size={40}/>
                    </react_native_1.TouchableOpacity>
                </expo_router_1.Link>
                <react_native_1.View className="flex-1">
                    <expo_router_1.Link href={"/post/".concat(postData.id)} asChild>
                        <react_native_1.TouchableOpacity className="flex-1" activeOpacity={0.7}>
                            <react_native_1.View className="flex-row items-center">
                                <react_native_1.View className="flex-row items-center flex-1 gap-1">
                                    <expo_router_1.Link href={"/@".concat(getAuthorUsername())} asChild>
                                        <react_native_1.TouchableOpacity>
                                            <react_native_1.Text className="font-bold">
                                                {getAuthorDisplayName()}
                                            </react_native_1.Text>
                                        </react_native_1.TouchableOpacity>
                                    </expo_router_1.Link>
                                    {((_g = postData.author) === null || _g === void 0 ? void 0 : _g.labels) && postData.author.labels.includes('verified') && (<vector_icons_1.Ionicons name="checkmark-circle" size={16} color={colors_1.colors.primaryColor}/>)}
                                    {isPremiumUser() && (<vector_icons_1.Ionicons name="star" size={14} color="#FFD700"/>)}
                                    <react_native_1.Text className="text-gray-500">·</react_native_1.Text>
                                    <react_native_1.Text className="text-gray-500">{formatTimeAgo(postData.created_at)}</react_native_1.Text>
                                </react_native_1.View>
                                {isAuthenticated &&
            (user === null || user === void 0 ? void 0 : user.id) !== authorId && (<react_native_1.TouchableOpacity onPress={handleFollowToggle} style={{
                paddingHorizontal: 10,
                paddingVertical: 4,
                borderRadius: 16,
                backgroundColor: isFollowing ? 'transparent' : colors_1.colors.primaryColor,
                borderWidth: 1,
                borderColor: colors_1.colors.primaryColor
            }}>
                                            <react_native_1.Text style={{
                color: isFollowing ? colors_1.colors.primaryColor : 'white',
                fontWeight: '600',
                fontSize: 12
            }}>
                                                {isFollowing ? t('Following') : t('Follow')}
                                            </react_native_1.Text>
                                        </react_native_1.TouchableOpacity>)}
                            </react_native_1.View>
                            {((_h = postData.author) === null || _h === void 0 ? void 0 : _h.username) && (<react_native_1.View className="flex-row items-center">
                                    <react_native_1.Text className="text-gray-500 text-sm">@{postData.author.username}</react_native_1.Text>
                                    {postData.author.location && (<react_native_1.Text className="text-gray-500 text-sm ml-2">· {postData.author.location}</react_native_1.Text>)}
                                </react_native_1.View>)}
                            <react_native_1.Text className="text-black text-base mt-1">{postData.text}</react_native_1.Text>
                            {quotedPost && (<react_native_1.View className="mt-3 border border-gray-200 rounded-xl p-3">
                                    {quotedPost && <Post postData={quotedPost} showActions={false}/>}
                                </react_native_1.View>)}
                        </react_native_1.TouchableOpacity>
                    </expo_router_1.Link>
                    {showActions && (<react_native_1.View className="flex-row justify-between mt-3 mb-2 pr-16">
                            <react_native_1.TouchableOpacity onPress={handleReply} className="flex-row items-center">
                                <vector_icons_1.Ionicons name="chatbubble-outline" size={18} color="#536471"/>
                                {((_k = (_j = postData._count) === null || _j === void 0 ? void 0 : _j.replies) !== null && _k !== void 0 ? _k : 0) > 0 && (<react_native_1.Text className="text-gray-600 ml-2">{(_m = (_l = postData._count) === null || _l === void 0 ? void 0 : _l.replies) !== null && _m !== void 0 ? _m : 0}</react_native_1.Text>)}
                            </react_native_1.TouchableOpacity>
                            <react_native_1.TouchableOpacity onPress={handleRepost} className="flex-row items-center">
                                <react_native_1.Animated.View style={{ transform: [{ scale: animatedScale }] }}>
                                    {isReposted ? (<repost_icon_1.RepostIconActive size={18} color={colors_1.colors.primaryColor}/>) : (<repost_icon_1.RepostIcon size={18} color="#536471"/>)}
                                </react_native_1.Animated.View>
                                {repostsCount > 0 && (<react_native_1.Text className={"ml-2 ".concat(isReposted ? 'text-primary' : 'text-gray-600')}>
                                        {repostsCount}
                                    </react_native_1.Text>)}
                            </react_native_1.TouchableOpacity>
                            <react_native_1.TouchableOpacity onPress={handleLike} className="flex-row items-center">
                                <react_native_1.Animated.View style={{ transform: [{ scale: animatedScale }] }}>
                                    {isLiked ? (<heart_icon_1.HeartIconActive size={18} color={colors_1.colors.primaryColor}/>) : (<heart_icon_1.HeartIcon size={18} color="#536471"/>)}
                                </react_native_1.Animated.View>
                                {likesCount > 0 && (<react_native_1.Text className={"ml-2 ".concat(isLiked ? 'text-primary' : 'text-gray-600')}>
                                        {likesCount}
                                    </react_native_1.Text>)}
                            </react_native_1.TouchableOpacity>
                            <react_native_1.TouchableOpacity onPress={handleBookmark} className="flex-row items-center">
                                {isBookmarked ? (<bookmark_icon_1.BookmarkActive size={18} color={colors_1.colors.primaryColor}/>) : (<bookmark_icon_1.Bookmark size={18} color="#536471"/>)}
                                {bookmarksCount > 0 && (<react_native_1.Text className={"ml-2 ".concat(isBookmarked ? 'text-primary' : 'text-gray-600')}>
                                        {bookmarksCount}
                                    </react_native_1.Text>)}
                            </react_native_1.TouchableOpacity>
                            <react_native_1.TouchableOpacity className="flex-row items-center gap-1" onPress={function (e) {
                e.preventDefault();
                e.stopPropagation();
                handleShare();
            }}>
                                <share_icon_1.ShareIcon size={20} color="#536471"/>
                            </react_native_1.TouchableOpacity>
                        </react_native_1.View>)}
                </react_native_1.View>
            </react_native_1.View>
        </react_native_1.View>);
}
