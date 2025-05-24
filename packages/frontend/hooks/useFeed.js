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
exports.useFeed = useFeed;
var react_1 = require("react");
var api_1 = require("@/utils/api");
function useFeed(_a) {
    var _this = this;
    var _b = _a.type, type = _b === void 0 ? 'all' : _b, parentId = _a.parentId, _c = _a.limit, limit = _c === void 0 ? 20 : _c;
    var _d = (0, react_1.useState)([]), posts = _d[0], setPosts = _d[1];
    var _e = (0, react_1.useState)(false), loading = _e[0], setLoading = _e[1];
    var _f = (0, react_1.useState)(false), refreshing = _f[0], setRefreshing = _f[1];
    var _g = (0, react_1.useState)(null), nextCursor = _g[0], setNextCursor = _g[1];
    var _h = (0, react_1.useState)(true), hasMore = _h[0], setHasMore = _h[1];
    var _j = (0, react_1.useState)(null), error = _j[0], setError = _j[1];
    var endpoint = (function () {
        if (type === 'replies' && parentId)
            return "feed/replies/".concat(parentId);
        if (type === 'media')
            return 'feed/media';
        if (type === 'quotes')
            return 'feed/quotes';
        if (type === 'reposts')
            return 'feed/reposts';
        if (type === 'posts')
            return 'feed/posts';
        if (type === 'following')
            return 'feed/following';
        if (type === 'home')
            return 'feed/home';
        if (type === 'all')
            return 'feed/explore';
        return 'feed/explore';
    })();
    var fetchFeed = (0, react_1.useCallback)(function () {
        var args_1 = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            args_1[_i] = arguments[_i];
        }
        return __awaiter(_this, __spreadArray([], args_1, true), void 0, function (reset) {
            var params, res, _a, newPosts_1, newCursor, more, e_1;
            if (reset === void 0) { reset = false; }
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        setLoading(true);
                        setError(null);
                        _b.label = 1;
                    case 1:
                        _b.trys.push([1, 3, 4, 5]);
                        params = { limit: limit };
                        if (!reset && nextCursor)
                            params.cursor = nextCursor;
                        return [4 /*yield*/, (0, api_1.fetchData)(endpoint, { params: params })];
                    case 2:
                        res = _b.sent();
                        _a = res.data, newPosts_1 = _a.posts, newCursor = _a.nextCursor, more = _a.hasMore;
                        setPosts(function (prev) { return reset ? newPosts_1 : __spreadArray(__spreadArray([], prev, true), newPosts_1, true); });
                        setNextCursor(newCursor);
                        setHasMore(more);
                        return [3 /*break*/, 5];
                    case 3:
                        e_1 = _b.sent();
                        setError(e_1.message || 'Failed to load feed');
                        return [3 /*break*/, 5];
                    case 4:
                        setLoading(false);
                        setRefreshing(false);
                        return [7 /*endfinally*/];
                    case 5: return [2 /*return*/];
                }
            });
        });
    }, [endpoint, limit, nextCursor]);
    (0, react_1.useEffect)(function () {
        fetchFeed(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [type, parentId]);
    var refresh = function () {
        setRefreshing(true);
        setNextCursor(null);
        fetchFeed(true);
    };
    var fetchMore = function () {
        if (!loading && hasMore) {
            fetchFeed();
        }
    };
    return {
        posts: posts,
        loading: loading,
        refreshing: refreshing,
        error: error,
        hasMore: hasMore,
        fetchMore: fetchMore,
        refresh: refresh,
    };
}
