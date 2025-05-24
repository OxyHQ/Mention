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
var react_hooks_1 = require("@testing-library/react-hooks");
var useFeed_1 = require("../useFeed");
var api_1 = require("@/utils/api");
// Mock the api fetch function
jest.mock('@/utils/api', function () { return ({
    fetchData: jest.fn()
}); });
describe('useFeed', function () {
    beforeEach(function () {
        jest.clearAllMocks();
    });
    it('fetches explore feed correctly', function () { return __awaiter(void 0, void 0, void 0, function () {
        var mockResponse, _a, result, waitForNextUpdate;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    mockResponse = {
                        data: {
                            posts: [{ id: '1', text: 'Test post' }],
                            nextCursor: 'next-123',
                            hasMore: true
                        }
                    };
                    api_1.fetchData.mockResolvedValueOnce(mockResponse);
                    _a = (0, react_hooks_1.renderHook)(function () { return (0, useFeed_1.useFeed)({ type: 'all' }); }), result = _a.result, waitForNextUpdate = _a.waitForNextUpdate;
                    expect(result.current.loading).toBe(true);
                    return [4 /*yield*/, waitForNextUpdate()];
                case 1:
                    _b.sent();
                    expect(api_1.fetchData).toHaveBeenCalledWith('feed/explore', { params: { limit: 20 } });
                    expect(result.current.posts).toEqual(mockResponse.data.posts);
                    expect(result.current.hasMore).toBe(true);
                    expect(result.current.loading).toBe(false);
                    return [2 /*return*/];
            }
        });
    }); });
    it('fetches following feed correctly', function () { return __awaiter(void 0, void 0, void 0, function () {
        var mockResponse, _a, result, waitForNextUpdate;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    mockResponse = {
                        data: {
                            posts: [{ id: '2', text: 'Following post' }],
                            nextCursor: 'next-456',
                            hasMore: true
                        }
                    };
                    api_1.fetchData.mockResolvedValueOnce(mockResponse);
                    _a = (0, react_hooks_1.renderHook)(function () { return (0, useFeed_1.useFeed)({ type: 'following' }); }), result = _a.result, waitForNextUpdate = _a.waitForNextUpdate;
                    expect(result.current.loading).toBe(true);
                    return [4 /*yield*/, waitForNextUpdate()];
                case 1:
                    _b.sent();
                    expect(api_1.fetchData).toHaveBeenCalledWith('feed/following', { params: { limit: 20 } });
                    expect(result.current.posts).toEqual(mockResponse.data.posts);
                    expect(result.current.hasMore).toBe(true);
                    expect(result.current.loading).toBe(false);
                    return [2 /*return*/];
            }
        });
    }); });
    it('handles refresh correctly', function () { return __awaiter(void 0, void 0, void 0, function () {
        var mockResponse1, mockResponse2, _a, result, waitForNextUpdate;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    mockResponse1 = {
                        data: {
                            posts: [{ id: '1', text: 'Initial post' }],
                            nextCursor: 'next-123',
                            hasMore: true
                        }
                    };
                    mockResponse2 = {
                        data: {
                            posts: [{ id: '2', text: 'New post' }],
                            nextCursor: 'next-456',
                            hasMore: true
                        }
                    };
                    api_1.fetchData.mockResolvedValueOnce(mockResponse1);
                    _a = (0, react_hooks_1.renderHook)(function () { return (0, useFeed_1.useFeed)({ type: 'following' }); }), result = _a.result, waitForNextUpdate = _a.waitForNextUpdate;
                    return [4 /*yield*/, waitForNextUpdate()];
                case 1:
                    _b.sent();
                    expect(result.current.posts).toEqual(mockResponse1.data.posts);
                    // Setup mock for refresh call
                    api_1.fetchData.mockResolvedValueOnce(mockResponse2);
                    // Trigger refresh
                    (0, react_hooks_1.act)(function () {
                        result.current.refresh();
                    });
                    expect(result.current.refreshing).toBe(true);
                    return [4 /*yield*/, waitForNextUpdate()];
                case 2:
                    _b.sent();
                    expect(api_1.fetchData).toHaveBeenCalledWith('feed/following', { params: { limit: 20 } });
                    expect(result.current.posts).toEqual(mockResponse2.data.posts);
                    expect(result.current.refreshing).toBe(false);
                    return [2 /*return*/];
            }
        });
    }); });
    it('handles fetchMore correctly', function () { return __awaiter(void 0, void 0, void 0, function () {
        var mockResponse1, mockResponse2, _a, result, waitForNextUpdate;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    mockResponse1 = {
                        data: {
                            posts: [{ id: '1', text: 'First post' }],
                            nextCursor: 'next-cursor',
                            hasMore: true
                        }
                    };
                    mockResponse2 = {
                        data: {
                            posts: [{ id: '2', text: 'Second post' }],
                            nextCursor: null,
                            hasMore: false
                        }
                    };
                    api_1.fetchData.mockResolvedValueOnce(mockResponse1);
                    _a = (0, react_hooks_1.renderHook)(function () { return (0, useFeed_1.useFeed)({ type: 'following' }); }), result = _a.result, waitForNextUpdate = _a.waitForNextUpdate;
                    return [4 /*yield*/, waitForNextUpdate()];
                case 1:
                    _b.sent();
                    expect(result.current.posts).toEqual(mockResponse1.data.posts);
                    expect(result.current.hasMore).toBe(true);
                    // Setup mock for fetchMore call
                    api_1.fetchData.mockResolvedValueOnce(mockResponse2);
                    // Trigger fetchMore
                    (0, react_hooks_1.act)(function () {
                        result.current.fetchMore();
                    });
                    return [4 /*yield*/, waitForNextUpdate()];
                case 2:
                    _b.sent();
                    expect(api_1.fetchData).toHaveBeenCalledWith('feed/following', {
                        params: { limit: 20, cursor: 'next-cursor' }
                    });
                    // Should append new posts to existing ones
                    expect(result.current.posts).toEqual(__spreadArray(__spreadArray([], mockResponse1.data.posts, true), mockResponse2.data.posts, true));
                    expect(result.current.hasMore).toBe(false);
                    return [2 /*return*/];
            }
        });
    }); });
    it('handles errors correctly', function () { return __awaiter(void 0, void 0, void 0, function () {
        var error, _a, result, waitForNextUpdate;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    error = new Error('Network error');
                    api_1.fetchData.mockRejectedValueOnce(error);
                    _a = (0, react_hooks_1.renderHook)(function () { return (0, useFeed_1.useFeed)({ type: 'following' }); }), result = _a.result, waitForNextUpdate = _a.waitForNextUpdate;
                    return [4 /*yield*/, waitForNextUpdate()];
                case 1:
                    _b.sent();
                    expect(result.current.error).toBe('Network error');
                    expect(result.current.loading).toBe(false);
                    return [2 /*return*/];
            }
        });
    }); });
});
