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
var react_1 = require("react");
var react_native_1 = require("react-native");
var services_1 = require("@oxyhq/services");
var api_1 = require("@/utils/api");
var expo_status_bar_1 = require("expo-status-bar");
var react_native_safe_area_context_1 = require("react-native-safe-area-context");
var api_2 = require("@/utils/api");
var expo_router_1 = require("expo-router");
var colors_1 = require("@/styles/colors");
var Avatar_1 = require("@/components/Avatar");
var react_i18next_1 = require("react-i18next");
var sonner_1 = require("sonner");
var ComposeScreen = function () {
    var _a = (0, react_1.useState)(''), postContent = _a[0], setPostContent = _a[1];
    var _b = (0, react_1.useState)(false), isPosting = _b[0], setIsPosting = _b[1];
    var user = (0, services_1.useOxy)().user;
    var t = (0, react_i18next_1.useTranslation)().t;
    var handlePost = function () { return __awaiter(void 0, void 0, void 0, function () {
        var error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!postContent.trim() || isPosting)
                        return [2 /*return*/];
                    setIsPosting(true);
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, 4, 5]);
                    // Call API to create post
                    return [4 /*yield*/, (0, api_1.postData)('/posts', { text: postContent.trim() })];
                case 2:
                    // Call API to create post
                    _a.sent();
                    // Clear cache to ensure feed is refreshed with the new post
                    (0, api_2.clearCache)('feed/');
                    // Show success toast
                    sonner_1.toast.success(t('Post published successfully'));
                    // Navigate back after posting
                    expo_router_1.router.back();
                    return [3 /*break*/, 5];
                case 3:
                    error_1 = _a.sent();
                    console.error('Error creating post:', error_1);
                    sonner_1.toast.error(t('Failed to publish post'));
                    return [3 /*break*/, 5];
                case 4:
                    setIsPosting(false);
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    }); };
    var handleCancel = function () {
        expo_router_1.router.back();
    };
    var isPostButtonEnabled = postContent.trim().length > 0 && !isPosting;
    return (<react_native_safe_area_context_1.SafeAreaView style={styles.container} edges={['top']}>
      <expo_status_bar_1.StatusBar style="dark"/>
      
      {/* Header */}
      <react_native_1.View style={styles.header}>
        <react_native_1.TouchableOpacity onPress={handleCancel} style={styles.cancelButton}>
          <react_native_1.Text style={styles.cancelButtonText}>{t('Cancel')}</react_native_1.Text>
        </react_native_1.TouchableOpacity>
        
        <react_native_1.TouchableOpacity onPress={handlePost} style={[
            styles.postButton,
            !isPostButtonEnabled && styles.postButtonDisabled
        ]} disabled={!isPostButtonEnabled}>
          {isPosting ? (<react_native_1.ActivityIndicator size="small" color="#fff"/>) : (<react_native_1.Text style={styles.postButtonText}>{t('Post')}</react_native_1.Text>)}
        </react_native_1.TouchableOpacity>
      </react_native_1.View>
      
      <react_native_1.KeyboardAvoidingView style={styles.composeArea} behavior={react_native_1.Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={react_native_1.Platform.OS === 'ios' ? 64 : 0}>
        <react_native_1.View style={styles.userInfoContainer}>
          <Avatar_1.default size={40}/>
          
          <react_native_1.View style={styles.userInfo}>
            <react_native_1.Text style={styles.userName}>{(user === null || user === void 0 ? void 0 : user.fullName) || (user === null || user === void 0 ? void 0 : user.username)}</react_native_1.Text>
            {(user === null || user === void 0 ? void 0 : user.username) && <react_native_1.Text style={styles.userHandle}>@{user.username}</react_native_1.Text>}
          </react_native_1.View>
        </react_native_1.View>
        
        <react_native_1.View style={styles.inputContainer}>
          <react_native_1.TextInput style={styles.input} placeholder={t("What's happening?")} placeholderTextColor="#657786" multiline autoFocus value={postContent} onChangeText={setPostContent} maxLength={280}/>
        </react_native_1.View>
        
        <react_native_1.View style={styles.charCountContainer}>
          <react_native_1.Text style={[
            styles.charCount,
            postContent.length > 260 && styles.charCountWarning,
            postContent.length >= 280 && styles.charCountLimit
        ]}>
            {280 - postContent.length}
          </react_native_1.Text>
        </react_native_1.View>
      </react_native_1.KeyboardAvoidingView>
    </react_native_safe_area_context_1.SafeAreaView>);
};
var styles = react_native_1.StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#fff',
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
        borderBottomWidth: 0.5,
        borderBottomColor: '#E1E8ED',
    },
    cancelButton: {
        padding: 8,
    },
    cancelButtonText: {
        color: '#1DA1F2',
        fontSize: 16,
    },
    postButton: {
        backgroundColor: colors_1.colors.primaryColor,
        paddingHorizontal: 20,
        paddingVertical: 8,
        borderRadius: 50,
    },
    postButtonDisabled: {
        backgroundColor: '#9BD1F9',
    },
    postButtonText: {
        color: '#fff',
        fontWeight: 'bold',
        fontSize: 16,
    },
    composeArea: {
        flex: 1,
        padding: 16,
    },
    userInfoContainer: {
        flexDirection: 'row',
        marginBottom: 16,
    },
    userInfo: {
        marginLeft: 12,
        justifyContent: 'center',
    },
    userName: {
        fontSize: 16,
        fontWeight: 'bold',
        color: '#14171A',
    },
    userHandle: {
        fontSize: 14,
        color: '#657786',
    },
    inputContainer: {
        flex: 1,
    },
    input: {
        fontSize: 18,
        lineHeight: 24,
        color: '#14171A',
        textAlignVertical: 'top',
    },
    charCountContainer: {
        alignItems: 'flex-end',
        paddingVertical: 8,
    },
    charCount: {
        fontSize: 14,
        color: '#657786',
    },
    charCountWarning: {
        color: '#FFAD1F',
    },
    charCountLimit: {
        color: '#E0245E',
    },
});
exports.default = ComposeScreen;
