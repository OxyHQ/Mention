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
exports.postData = exports.cleanupPendingRequests = exports.fetchData = exports.batchRequest = exports.getCacheEntry = exports.setCacheEntry = exports.getCacheKey = exports.clearCache = void 0;
var axios_1 = require("axios");
var async_storage_1 = require("@react-native-async-storage/async-storage");
var SecureStore = require("expo-secure-store");
var sonner_1 = require("sonner");
var config_1 = require("@/config");
var CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
var BATCH_DELAY = 50; // ms to wait before processing batch
var MAX_BATCH_SIZE = 10;
var cache = new Map();
var batchQueue = [];
var batchTimeout = null;
var clearCache = function (pattern) {
    if (pattern) {
        var regex = new RegExp(pattern);
        for (var _i = 0, _a = cache.keys(); _i < _a.length; _i++) {
            var key = _a[_i];
            if (regex.test(key)) {
                cache.delete(key);
            }
        }
    }
    else {
        cache.clear();
    }
};
exports.clearCache = clearCache;
var getCacheKey = function (endpoint, params) {
    return "".concat(endpoint).concat(params ? "-".concat(JSON.stringify(params)) : '');
};
exports.getCacheKey = getCacheKey;
var setCacheEntry = function (key, data, ttl) {
    if (ttl === void 0) { ttl = CACHE_DURATION; }
    cache.set(key, {
        data: data,
        timestamp: Date.now(),
        ttl: ttl
    });
};
exports.setCacheEntry = setCacheEntry;
var getCacheEntry = function (key) {
    var entry = cache.get(key);
    if (!entry)
        return null;
    if (Date.now() - entry.timestamp > entry.ttl) {
        cache.delete(key);
        return null;
    }
    return entry.data;
};
exports.getCacheEntry = getCacheEntry;
// Request batching implementation
var processBatch = function () { return __awaiter(void 0, void 0, void 0, function () {
    var batch, requestGroups, error_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                batch = batchQueue.splice(0, MAX_BATCH_SIZE);
                batchTimeout = null;
                if (batch.length === 0)
                    return [2 /*return*/];
                _a.label = 1;
            case 1:
                _a.trys.push([1, 3, , 4]);
                requestGroups = batch.reduce(function (groups, request) {
                    var key = "".concat(request.config.method, "-").concat(request.config.url);
                    if (!groups[key])
                        groups[key] = [];
                    groups[key].push(request);
                    return groups;
                }, {});
                // Process each group
                return [4 /*yield*/, Promise.all(Object.values(requestGroups).map(function (requests) { return __awaiter(void 0, void 0, void 0, function () {
                        var response, params, response_1, error_2;
                        return __generator(this, function (_a) {
                            switch (_a.label) {
                                case 0:
                                    _a.trys.push([0, 5, , 6]);
                                    if (!(requests.length === 1)) return [3 /*break*/, 2];
                                    return [4 /*yield*/, api(requests[0].config)];
                                case 1:
                                    response = _a.sent();
                                    requests[0].resolve(response.data);
                                    return [3 /*break*/, 4];
                                case 2:
                                    params = requests.map(function (r) { return r.config.params || {}; });
                                    return [4 /*yield*/, api(__assign(__assign({}, requests[0].config), { params: { batch: params } }))];
                                case 3:
                                    response_1 = _a.sent();
                                    // Distribute responses
                                    requests.forEach(function (request, index) {
                                        request.resolve(Array.isArray(response_1.data) ? response_1.data[index] : response_1.data);
                                    });
                                    _a.label = 4;
                                case 4: return [3 /*break*/, 6];
                                case 5:
                                    error_2 = _a.sent();
                                    requests.forEach(function (request) { return request.reject(error_2); });
                                    return [3 /*break*/, 6];
                                case 6: return [2 /*return*/];
                            }
                        });
                    }); }))];
            case 2:
                // Process each group
                _a.sent();
                return [3 /*break*/, 4];
            case 3:
                error_1 = _a.sent();
                batch.forEach(function (request) { return request.reject(error_1); });
                return [3 /*break*/, 4];
            case 4: return [2 /*return*/];
        }
    });
}); };
var batchRequest = function (config) {
    return new Promise(function (resolve, reject) {
        batchQueue.push({ config: config, resolve: resolve, reject: reject });
        if (batchTimeout)
            clearTimeout(batchTimeout);
        batchTimeout = setTimeout(processBatch, BATCH_DELAY);
    });
};
exports.batchRequest = batchRequest;
// Enhanced fetchData with caching and batching
var fetchData = function (endpoint_1) {
    var args_1 = [];
    for (var _i = 1; _i < arguments.length; _i++) {
        args_1[_i - 1] = arguments[_i];
    }
    return __awaiter(void 0, __spreadArray([endpoint_1], args_1, true), void 0, function (endpoint, options) {
        var params, _a, skipCache, _b, cacheTTL, _c, skipBatch, cacheKey, cachedData, config, response, _d, cacheKey, error_3;
        if (options === void 0) { options = {}; }
        return __generator(this, function (_e) {
            switch (_e.label) {
                case 0:
                    params = options.params, _a = options.skipCache, skipCache = _a === void 0 ? false : _a, _b = options.cacheTTL, cacheTTL = _b === void 0 ? CACHE_DURATION : _b, _c = options.skipBatch, skipBatch = _c === void 0 ? false : _c;
                    // Check cache first
                    if (!skipCache) {
                        cacheKey = (0, exports.getCacheKey)(endpoint, params);
                        cachedData = (0, exports.getCacheEntry)(cacheKey);
                        if (cachedData)
                            return [2 /*return*/, cachedData];
                    }
                    _e.label = 1;
                case 1:
                    _e.trys.push([1, 6, , 7]);
                    config = {
                        method: 'GET',
                        url: endpoint,
                        params: params
                    };
                    if (!skipBatch) return [3 /*break*/, 3];
                    return [4 /*yield*/, api(config)];
                case 2:
                    _d = _e.sent();
                    return [3 /*break*/, 5];
                case 3: return [4 /*yield*/, (0, exports.batchRequest)(config)];
                case 4:
                    _d = _e.sent();
                    _e.label = 5;
                case 5:
                    response = _d;
                    // Cache successful responses
                    if (!skipCache) {
                        cacheKey = (0, exports.getCacheKey)(endpoint, params);
                        (0, exports.setCacheEntry)(cacheKey, response, cacheTTL);
                    }
                    return [2 /*return*/, response];
                case 6:
                    error_3 = _e.sent();
                    console.error("Error fetching data from ".concat(endpoint, ":"), error_3);
                    throw error_3;
                case 7: return [2 /*return*/];
            }
        });
    });
};
exports.fetchData = fetchData;
// Create axios instance with default config
var api = axios_1.default.create({
    baseURL: config_1.API_URL,
    headers: {
        'Content-Type': 'application/json'
    }
});
// Attach Oxy auth token to every request if available
api.interceptors.request.use(function (config) { return __awaiter(void 0, void 0, void 0, function () {
    var token, e_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                token = null;
                _a.label = 1;
            case 1:
                _a.trys.push([1, 5, , 6]);
                return [4 /*yield*/, SecureStore.getItemAsync('oxy_example_token')];
            case 2:
                // OxyProvider uses storageKeyPrefix="oxy_example" by default
                token = _a.sent();
                if (!!token) return [3 /*break*/, 4];
                return [4 /*yield*/, async_storage_1.default.getItem('oxy_example_token')];
            case 3:
                token = _a.sent();
                _a.label = 4;
            case 4: return [3 /*break*/, 6];
            case 5:
                e_1 = _a.sent();
                return [3 /*break*/, 6];
            case 6:
                if (token) {
                    config.headers = config.headers || {};
                    config.headers['Authorization'] = "Bearer ".concat(token);
                }
                return [2 /*return*/, config];
        }
    });
}); });
var cleanupPendingRequests = function () {
    try {
        // Clear any pending requests
        if (batchTimeout) {
            clearTimeout(batchTimeout);
            batchQueue.length = 0;
        }
        // Clear cache
        (0, exports.clearCache)();
    }
    catch (error) {
        console.error('[API] Cleanup error:', error);
    }
};
exports.cleanupPendingRequests = cleanupPendingRequests;
var postData = function (endpoint, data) { return __awaiter(void 0, void 0, void 0, function () {
    var response, error_4, errorMessage;
    var _a, _b;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                _c.trys.push([0, 2, , 3]);
                return [4 /*yield*/, api.post(endpoint, data)];
            case 1:
                response = _c.sent();
                (0, exports.clearCache)(endpoint);
                return [2 /*return*/, response.data];
            case 2:
                error_4 = _c.sent();
                errorMessage = ((_b = (_a = error_4.response) === null || _a === void 0 ? void 0 : _a.data) === null || _b === void 0 ? void 0 : _b.message) || error_4.message;
                sonner_1.toast.error("Error posting data: ".concat(errorMessage));
                throw error_4;
            case 3: return [2 /*return*/];
        }
    });
}); };
exports.postData = postData;
exports.default = api;
