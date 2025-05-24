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
exports.Header = void 0;
var react_1 = require("react");
var react_native_1 = require("react-native");
var react_native_2 = require("react-native");
var vector_icons_1 = require("@expo/vector-icons");
var colors_1 = require("@/styles/colors");
var expo_router_1 = require("expo-router");
var Header = function (_a) {
    var _b, _c;
    var options = _a.options;
    var router = (0, expo_router_1.useRouter)();
    var _d = (0, react_1.useState)(false), isSticky = _d[0], setIsSticky = _d[1];
    var titlePosition = (options === null || options === void 0 ? void 0 : options.titlePosition) || 'left';
    (0, react_1.useEffect)(function () {
        if (react_native_1.Platform.OS === 'web') {
            var handleScroll_1 = function () {
                if (window.scrollY > 20) {
                    setIsSticky(true);
                }
                else {
                    setIsSticky(false);
                }
            };
            window.addEventListener('scroll', handleScroll_1);
            return function () {
                window.removeEventListener('scroll', handleScroll_1);
            };
        }
    }, []);
    return (<react_native_1.View style={[styles.topRow, isSticky && styles.stickyHeader]}>
            <react_native_1.View style={styles.leftContainer}>
                {(options === null || options === void 0 ? void 0 : options.showBackButton) && (<react_native_2.Pressable onPress={function () { return router.back(); }} style={styles.backButton}>
                        <vector_icons_1.Ionicons name="arrow-back" size={24} color={colors_1.colors.COLOR_BLACK}/>
                    </react_native_2.Pressable>)}
                {(_b = options === null || options === void 0 ? void 0 : options.leftComponents) === null || _b === void 0 ? void 0 : _b.map(function (component, index) { return (<react_1.default.Fragment key={index}>{component}</react_1.default.Fragment>); })}
                {titlePosition === 'left' && (<react_native_1.View>
                        {(options === null || options === void 0 ? void 0 : options.title) && (<react_native_1.Text style={[styles.topRowText, (options === null || options === void 0 ? void 0 : options.subtitle) && { fontSize: 14 }]}>
                                {options.title}
                            </react_native_1.Text>)}
                        {(options === null || options === void 0 ? void 0 : options.subtitle) && <react_native_1.Text>{options.subtitle}</react_native_1.Text>}
                    </react_native_1.View>)}

            </react_native_1.View>
            {titlePosition === 'center' && (<react_native_1.View style={styles.centerContainer}>
                    {(options === null || options === void 0 ? void 0 : options.title) && (<react_native_1.Text style={[styles.topRowText, (options === null || options === void 0 ? void 0 : options.subtitle) && { fontSize: 14 }]}>
                            {options.title}
                        </react_native_1.Text>)}
                    {(options === null || options === void 0 ? void 0 : options.subtitle) && <react_native_1.Text>{options.subtitle}</react_native_1.Text>}
                </react_native_1.View>)}
            <react_native_1.View style={styles.rightContainer}>
                {(_c = options === null || options === void 0 ? void 0 : options.rightComponents) === null || _c === void 0 ? void 0 : _c.map(function (component, index) { return (<react_1.default.Fragment key={index}>{component}</react_1.default.Fragment>); })}
            </react_native_1.View>
        </react_native_1.View>);
};
exports.Header = Header;
var styles = react_native_1.StyleSheet.create({
    container: {
        width: '100%',
        paddingBottom: 10,
    },
    topRow: __assign(__assign({ minHeight: 60, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderBottomWidth: 0.01, paddingHorizontal: 15, borderBottomColor: colors_1.colors.COLOR_BLACK_LIGHT_6, paddingVertical: 5, position: 'relative' }, react_native_1.Platform.select({
        web: {
            position: 'sticky',
        },
    })), { top: 0, backgroundColor: colors_1.colors.primaryLight, zIndex: 100, borderTopEndRadius: 35, borderTopStartRadius: 35 }),
    topRowText: {
        fontSize: 20,
        color: colors_1.colors.COLOR_BLACK,
        fontWeight: '800',
        paddingStart: 1,
    },
    startContainer: {
        borderRadius: 100,
        padding: 10,
    },
    backButton: {
        marginRight: 10,
    },
    leftContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        gap: 10,
    },
    centerContainer: {
        flex: 1,
        alignItems: 'center',
    },
    rightContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        flex: 1,
        justifyContent: 'flex-end',
        gap: 10,
    },
    stickyHeader: {
        borderTopEndRadius: 0,
        borderTopStartRadius: 0,
    },
});
