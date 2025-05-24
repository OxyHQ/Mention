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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostProvider = exports.PostContext = void 0;
var react_1 = require("react");
exports.PostContext = (0, react_1.createContext)({
    posts: {},
    likePost: function () { },
    replyToPost: function () { },
    repost: function () { },
});
var PostProvider = function (_a) {
    var children = _a.children;
    var _b = (0, react_1.useState)(__assign({}, Array.from({ length: 35 }, function (_, i) {
        var postId = "".concat(i + 1);
        // Make every 5th post a reply to post #1
        var isReply = i % 5 === 0 && i > 0;
        // Make every 7th post a quote of post #2
        var isQuote = i % 7 === 0 && i > 0;
        // Make every 11th post a repost of post #3
        var isRepost = i % 11 === 0 && i > 0;
        return {
            id: postId,
            author: {
                id: "user".concat(i + 1),
                username: "user".concat(i + 1),
                avatar: "https://example.com/avatar".concat(i + 1, ".png"),
            },
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            text: "This is ".concat(isReply ? 'a reply' : isQuote ? 'a quoted post' : isRepost ? 'a repost' : 'a regular post', " by user").concat(i + 1, "."),
            media: i % 2 === 0 ? ["https://quickframe.com/wp-content/uploads/2023/08/QF-Blog_Best-Time-to-Post-on-Threads.jpg"] : [],
            in_reply_to_status_id: isReply ? '1' : null,
            quoted_post_id: isQuote ? '2' : null,
            repost_of: isRepost ? { id: '3', text: 'Original post', media: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() } : null,
            _count: {
                likes: Math.floor(Math.random() * 100),
                replies: Math.floor(Math.random() * 50),
                reposts: Math.floor(Math.random() * 20),
                quotes: Math.floor(Math.random() * 10),
                bookmarks: Math.floor(Math.random() * 15),
            },
            source: 'web',
            possibly_sensitive: false,
            lang: 'en',
            userID: "user".concat(i + 1),
            quoted_post: null,
            mentions: [],
            hashtags: [],
            replies: [],
            likes: [],
            reposts: [],
            bookmarks: [],
            isDraft: false,
            scheduledFor: null,
            status: 'published',
            isLiked: false,
            isReposted: false,
            isBookmarked: false,
        };
    }).reduce(function (acc, post) {
        var _a;
        return (__assign(__assign({}, acc), (_a = {}, _a[post.id] = post, _a)));
    }, {}))), posts = _b[0], setPosts = _b[1];
    var likePost = function (id) {
        setPosts(function (prev) {
            var _a;
            return (__assign(__assign({}, prev), (_a = {}, _a[id] = __assign(__assign({}, prev[id]), { likes: __spreadArray(__spreadArray([], prev[id].likes, true), ['new_like_id'], false) }), _a)));
        });
    };
    var replyToPost = function (id) {
        // Handle reply logic
    };
    var repost = function (id) {
        setPosts(function (prev) {
            var _a;
            return (__assign(__assign({}, prev), (_a = {}, _a[id] = __assign(__assign({}, prev[id]), { reposts: __spreadArray(__spreadArray([], prev[id].reposts, true), ['new_repost_id'], false) }), _a)));
        });
    };
    return (<exports.PostContext.Provider value={{ posts: posts, likePost: likePost, replyToPost: replyToPost, repost: repost }}>
            {children}
        </exports.PostContext.Provider>);
};
exports.PostProvider = PostProvider;
