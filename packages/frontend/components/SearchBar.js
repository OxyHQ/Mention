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
exports.SearchBar = void 0;
var vector_icons_1 = require("@expo/vector-icons");
var expo_router_1 = require("expo-router");
var react_1 = require("react");
var react_i18next_1 = require("react-i18next");
var react_native_1 = require("react-native");
var colors_1 = require("../styles/colors");
var debounce = function (func, wait) {
    var timeout;
    return function executedFunction() {
        var args = [];
        for (var _i = 0; _i < arguments.length; _i++) {
            args[_i] = arguments[_i];
        }
        var later = function () {
            clearTimeout(timeout);
            func.apply(void 0, args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
};
var SearchBar = function () {
    var _a = (0, react_1.useState)(''), searchQuery = _a[0], setSearchQuery = _a[1];
    var _b = (0, react_1.useState)(false), isLoading = _b[0], setIsLoading = _b[1];
    var _c = (0, react_1.useState)(false), showFilters = _c[0], setShowFilters = _c[1];
    var router = (0, expo_router_1.useRouter)();
    var t = (0, react_i18next_1.useTranslation)().t;
    var handleSearch = (0, react_1.useCallback)(debounce(function (query) { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!query.trim())
                        return [2 /*return*/];
                    setIsLoading(true);
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, , 3, 4]);
                    return [4 /*yield*/, router.push("/search/".concat(encodeURIComponent(query)))];
                case 2:
                    _a.sent();
                    return [3 /*break*/, 4];
                case 3:
                    setIsLoading(false);
                    return [7 /*endfinally*/];
                case 4: return [2 /*return*/];
            }
        });
    }); }, 300), []);
    var handleSearchChange = function (query) {
        setSearchQuery(query);
        handleSearch(query);
    };
    return (<react_native_1.View style={__assign(__assign({ backgroundColor: colors_1.colors.COLOR_BACKGROUND, flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }, react_native_1.Platform.select({
            web: { position: 'sticky' },
        })), { marginTop: 20, top: 0, zIndex: 1000, paddingVertical: 4, width: '100%', gap: 10 })}>
            <react_native_1.View style={{
            backgroundColor: colors_1.colors.primaryLight,
            borderRadius: 100,
            height: 45,
            flexDirection: 'row',
            justifyContent: 'flex-start',
            alignItems: 'center',
            paddingStart: 15,
            flex: 1,
            width: '100%',
        }}>
                {isLoading ? (<react_native_1.ActivityIndicator size="small" color={colors_1.colors.COLOR_BLACK_LIGHT_4}/>) : (<vector_icons_1.Ionicons name="search" size={20} color={colors_1.colors.COLOR_BLACK_LIGHT_4}/>)}
                <react_native_1.TextInput style={{
            fontSize: 16,
            color: colors_1.colors.COLOR_BLACK_LIGHT_4,
            marginHorizontal: 17,
            flex: 1,
        }} placeholder={t("Search Mention")} value={searchQuery} onChangeText={handleSearchChange} returnKeyType="search" onSubmitEditing={function () { return handleSearch(searchQuery); }}/>
                <react_native_1.TouchableOpacity onPress={function () { return setShowFilters(!showFilters); }} style={{
            padding: 10,
            marginRight: 5,
        }}>
                    <vector_icons_1.Ionicons name="options-outline" size={20} color={colors_1.colors.COLOR_BLACK_LIGHT_4}/>
                </react_native_1.TouchableOpacity>
            </react_native_1.View>

            {showFilters && (<react_native_1.View style={{
                backgroundColor: colors_1.colors.primaryLight,
                width: '100%',
                padding: 15,
                borderRadius: 15,
                marginTop: 5,
            }}>
                    <react_native_1.Text style={{ fontWeight: 'bold', marginBottom: 10 }}>
                        {t("Filter by")}
                    </react_native_1.Text>

                    <react_native_1.View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                        <FilterPill label="People"/>
                        <FilterPill label="Hashtags"/>
                        <FilterPill label="Latest"/>
                        <FilterPill label="Photos"/>
                        <FilterPill label="Videos"/>
                        <FilterPill label="Verified"/>
                    </react_native_1.View>

                    <react_native_1.TouchableOpacity style={{
                backgroundColor: colors_1.colors.primaryColor,
                padding: 10,
                borderRadius: 20,
                alignItems: 'center',
                marginTop: 15,
            }} onPress={function () {
                setShowFilters(false);
                router.push('/search/advanced');
            }}>
                        <react_native_1.Text style={{ color: 'white', fontWeight: '600' }}>
                            {t("Advanced Search")}
                        </react_native_1.Text>
                    </react_native_1.TouchableOpacity>
                </react_native_1.View>)}
        </react_native_1.View>);
};
exports.SearchBar = SearchBar;
var FilterPill = function (_a) {
    var label = _a.label;
    var _b = (0, react_1.useState)(false), isSelected = _b[0], setIsSelected = _b[1];
    return (<react_native_1.TouchableOpacity style={{
            paddingVertical: 6,
            paddingHorizontal: 12,
            borderRadius: 20,
            backgroundColor: isSelected ? colors_1.colors.primaryColor : '#f0f0f0',
            borderWidth: isSelected ? 0 : 1,
            borderColor: '#e0e0e0',
        }} onPress={function () { return setIsSelected(!isSelected); }}>
            <react_native_1.Text style={{
            color: isSelected ? 'white' : colors_1.colors.COLOR_BLACK_LIGHT_4,
            fontSize: 14,
            fontWeight: isSelected ? '600' : 'normal',
        }}>
                {label}
            </react_native_1.Text>
        </react_native_1.TouchableOpacity>);
};
