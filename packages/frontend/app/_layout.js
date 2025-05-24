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
exports.default = RootLayout;
var BottomBar_1 = require("@/components/BottomBar");
var ErrorBoundary_1 = require("@/components/ErrorBoundary");
var LoadingTopSpinner_1 = require("@/components/LoadingTopSpinner");
var RightBar_1 = require("@/components/RightBar");
var SideBar_1 = require("@/components/SideBar");
var WebSplashScreen_1 = require("@/components/WebSplashScreen");
var useColorScheme_1 = require("@/hooks/useColorScheme");
var reactQuery_1 = require("@/lib/reactQuery");
var sonner_1 = require("@/lib/sonner");
var en_json_1 = require("@/locales/en.json");
var es_json_1 = require("@/locales/es.json");
var it_json_1 = require("@/locales/it.json");
var store_1 = require("@/store/store");
var colors_1 = require("@/styles/colors");
var notifications_1 = require("@/utils/notifications");
var services_1 = require("@oxyhq/services");
var react_query_1 = require("@tanstack/react-query");
var expo_font_1 = require("expo-font");
var expo_router_1 = require("expo-router");
var SplashScreen = require("expo-splash-screen");
var expo_status_bar_1 = require("expo-status-bar");
var i18next_1 = require("i18next");
var react_1 = require("react");
var react_i18next_1 = require("react-i18next");
var react_native_1 = require("react-native");
var react_native_gesture_handler_1 = require("react-native-gesture-handler");
var react_native_popup_menu_1 = require("react-native-popup-menu");
require("react-native-reanimated");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var react_redux_1 = require("react-redux");
var react_responsive_1 = require("react-responsive");
require("../styles/global.css");
// Keep the splash screen visible while we fetch resources
SplashScreen.preventAutoHideAsync();
i18next_1.default.use(react_i18next_1.initReactI18next).init({
    resources: {
        en: { translation: en_json_1.default },
        es: { translation: es_json_1.default },
        it: { translation: it_json_1.default },
    },
    lng: "en",
    fallbackLng: "en",
    interpolation: {
        escapeValue: false,
    },
}).catch(function (error) {
    console.error("Failed to initialize i18n:", error);
});
function RootLayout() {
    var _this = this;
    var _a = (0, react_1.useState)(false), appIsReady = _a[0], setAppIsReady = _a[1];
    var i18n = (0, react_i18next_1.useTranslation)().i18n;
    var colorScheme = (0, useColorScheme_1.useColorScheme)();
    // Initialize OxyServices
    var oxyServices = new services_1.OxyServices({
        baseURL: 'https://api.oxy.so',
    });
    // Handle user authentication - no hooks here
    var handleAuthenticated = function (user) {
        console.log('User authenticated:', user);
        // We'll just log the authentication event here
        // The bottom sheet will be closed by the OxyProvider internally
    };
    var loaded = (0, expo_font_1.useFonts)({
        "Inter-Black": require("@/assets/fonts/inter/Inter-Black.otf"),
        "Inter-Bold": require("@/assets/fonts/inter/Inter-Bold.otf"),
        "Inter-ExtraBold": require("@/assets/fonts/inter/Inter-ExtraBold.otf"),
        "Inter-ExtraLight": require("@/assets/fonts/inter/Inter-ExtraLight.otf"),
        "Inter-Light": require("@/assets/fonts/inter/Inter-Light.otf"),
        "Inter-Medium": require("@/assets/fonts/inter/Inter-Medium.otf"),
        "Inter-Regular": require("@/assets/fonts/inter/Inter-Regular.otf"),
        "Inter-SemiBold": require("@/assets/fonts/inter/Inter-SemiBold.otf"),
        "Inter-Thin": require("@/assets/fonts/inter/Inter-Thin.otf"),
        "Phudu": require("@/assets/fonts/Phudu-VariableFont_wght.ttf"),
    })[0];
    var _b = (0, react_1.useState)(false), keyboardVisible = _b[0], setKeyboardVisible = _b[1];
    (0, react_1.useEffect)(function () {
        var show = react_native_1.Keyboard.addListener("keyboardDidShow", function () { return setKeyboardVisible(true); });
        var hide = react_native_1.Keyboard.addListener("keyboardDidHide", function () { return setKeyboardVisible(false); });
        return function () {
            show.remove();
            hide.remove();
        };
    }, []);
    var initializeApp = function () { return __awaiter(_this, void 0, void 0, function () {
        var hasPermission, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 7, , 8]);
                    if (!loaded) return [3 /*break*/, 6];
                    return [4 /*yield*/, (0, notifications_1.setupNotifications)()];
                case 1:
                    _a.sent();
                    return [4 /*yield*/, (0, notifications_1.requestNotificationPermissions)()];
                case 2:
                    hasPermission = _a.sent();
                    if (!hasPermission) return [3 /*break*/, 4];
                    return [4 /*yield*/, (0, notifications_1.scheduleDemoNotification)()];
                case 3:
                    _a.sent();
                    _a.label = 4;
                case 4:
                    setAppIsReady(true);
                    return [4 /*yield*/, SplashScreen.hideAsync()];
                case 5:
                    _a.sent();
                    _a.label = 6;
                case 6: return [3 /*break*/, 8];
                case 7:
                    error_1 = _a.sent();
                    console.warn("Failed to set up notifications:", error_1);
                    return [3 /*break*/, 8];
                case 8: return [2 /*return*/];
            }
        });
    }); };
    (0, react_1.useEffect)(function () {
        initializeApp();
        // Change overflow style to visible only on web
        if (typeof document !== 'undefined') {
            document.body.style.overflow = 'visible';
            document.body.style.backgroundColor = colors_1.colors.COLOR_BACKGROUND;
        }
    }, [loaded]);
    var isScreenNotMobile = (0, react_responsive_1.useMediaQuery)({ minWidth: 500 });
    if (!loaded) {
        return null;
    }
    if (!appIsReady) {
        // check if we are in web
        if (react_native_1.Platform.OS === 'web') {
            return <WebSplashScreen_1.default />;
        }
        else {
            return null;
        }
    }
    var styles = react_native_1.StyleSheet.create({
        container: __assign({ maxWidth: 1300, width: '100%', paddingHorizontal: isScreenNotMobile ? 10 : 0, marginHorizontal: 'auto', justifyContent: 'space-between', flexDirection: isScreenNotMobile ? 'row' : 'column' }, (!isScreenNotMobile && {
            flex: 1,
        })),
        mainContentWrapper: {
            marginVertical: isScreenNotMobile ? 20 : 0,
            flex: isScreenNotMobile ? 2.2 : 1,
            backgroundColor: colors_1.colors.primaryLight,
            borderRadius: isScreenNotMobile ? 35 : 0,
        },
        contentContainer: {
            flex: 1,
            alignItems: 'center',
        },
    });
    return (<react_native_safe_area_context_1.SafeAreaProvider initialMetrics={react_native_safe_area_context_1.initialWindowMetrics}>
      <react_native_gesture_handler_1.GestureHandlerRootView style={{ flex: 1 }}>
        <services_1.OxyProvider oxyServices={oxyServices} initialScreen="SignIn" autoPresent={false} // Don't auto-present, we'll control it with the button
     onClose={function () { return console.log('Sheet closed'); }} onAuthenticated={handleAuthenticated} onAuthStateChange={function (user) { return console.log('Auth state changed:', (user === null || user === void 0 ? void 0 : user.username) || 'logged out'); }} storageKeyPrefix="oxy_example" // Prefix for stored auth tokens
     theme="light"><react_native_1.ScrollView>
            <react_query_1.QueryClientProvider client={reactQuery_1.queryClient}>
              <react_redux_1.Provider store={store_1.default}>
                <react_i18next_1.I18nextProvider i18n={i18n}>
                  <react_native_popup_menu_1.MenuProvider>
                    <ErrorBoundary_1.default>
                      <react_native_1.View style={styles.container}>
                        <SideBar_1.SideBar />
                        <react_native_1.View style={styles.mainContentWrapper}>
                          <LoadingTopSpinner_1.default showLoading={false} size={20} style={{ paddingBottom: 0 }}/>
                          <expo_router_1.Slot />
                        </react_native_1.View>
                        <RightBar_1.RightBar />
                      </react_native_1.View>
                      <expo_status_bar_1.StatusBar style="auto"/>
                      <sonner_1.Toaster position="bottom-center" swipeToDismissDirection="left" offset={15}/>
                      {!isScreenNotMobile && !keyboardVisible && <BottomBar_1.BottomBar />}
                    </ErrorBoundary_1.default>
                  </react_native_popup_menu_1.MenuProvider>
                </react_i18next_1.I18nextProvider>
              </react_redux_1.Provider>
            </react_query_1.QueryClientProvider>
          </react_native_1.ScrollView>
        </services_1.OxyProvider>
      </react_native_gesture_handler_1.GestureHandlerRootView>
    </react_native_safe_area_context_1.SafeAreaProvider>);
}
