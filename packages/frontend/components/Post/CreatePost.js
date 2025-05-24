"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var services_1 = require("@oxyhq/services");
var expo_router_1 = require("expo-router");
var react_1 = require("react");
var react_i18next_1 = require("react-i18next");
var react_native_1 = require("react-native");
var Avatar_1 = require("../Avatar");
var CreatePost = function (_a) {
    var onPress = _a.onPress, placeholder = _a.placeholder;
    var t = (0, react_i18next_1.useTranslation)().t;
    var _b = (0, services_1.useOxy)(), user = _b.user, isAuthenticated = _b.isAuthenticated;
    var handlePress = function () {
        if (onPress) {
            onPress();
        }
        else {
            expo_router_1.router.push('/compose');
        }
    };
    if (!isAuthenticated) {
        return null;
    }
    return (<react_native_1.View style={styles.mainContainer}>
            <react_native_1.TouchableOpacity onPress={handlePress} style={styles.container} activeOpacity={0.7}>
                <Avatar_1.default size={40} imageUrl={user === null || user === void 0 ? void 0 : user.avatar}/>
                <react_native_1.View style={styles.inputContainer}>
                    <react_native_1.TextInput style={styles.input} placeholder={placeholder || t('What\'s happening?')} placeholderTextColor="#657786" editable={false} pointerEvents="none"/>
                </react_native_1.View>
            </react_native_1.TouchableOpacity>
            <react_native_1.TouchableOpacity style={styles.postButton} onPress={handlePress}>
                <react_native_1.Text style={styles.postButtonText}>{t('Create')}</react_native_1.Text>
            </react_native_1.TouchableOpacity>
        </react_native_1.View>);
};
var styles = react_native_1.StyleSheet.create({
    mainContainer: {
        backgroundColor: 'white',
        borderRadius: 8,
        paddingVertical: 12,
        marginHorizontal: 16,
        marginTop: 16,
        marginBottom: 8,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
        elevation: 1,
    },
    container: {
        flexDirection: 'row',
        padding: 12,
        paddingBottom: 16,
        borderBottomWidth: 1,
        borderBottomColor: '#F5F8FA',
    },
    inputContainer: {
        flex: 1,
        marginLeft: 12,
        justifyContent: 'center',
        backgroundColor: '#F5F8FA',
        borderRadius: react_native_1.Platform.OS === 'ios' ? 20 : 24,
        paddingHorizontal: 16,
        height: 40,
    },
    input: {
        fontSize: 16,
        color: '#14171A',
    },
    postButton: {
        marginTop: 8,
        backgroundColor: '#1DA1F2',
        borderRadius: 24,
        paddingVertical: 8,
        paddingHorizontal: 16,
        alignSelf: 'flex-end',
        marginRight: 16,
    },
    postButtonText: {
        color: 'white',
        fontWeight: 'bold',
        fontSize: 14,
    },
});
exports.default = CreatePost;
