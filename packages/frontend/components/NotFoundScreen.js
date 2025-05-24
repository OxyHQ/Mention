"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = NotFoundScreen;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var vector_icons_1 = require("@expo/vector-icons");
var colors_1 = require("@/styles/colors");
function NotFoundScreen() {
    var router = (0, expo_router_1.useRouter)();
    return (<react_native_1.View style={styles.container}>
            <vector_icons_1.Ionicons name="alert-circle-outline" size={80} color={colors_1.colors.primaryColor}/>
            <react_native_1.Text style={styles.title}>Page Not Found</react_native_1.Text>
            <react_native_1.Text style={styles.message}>The page you are looking for does not exist.</react_native_1.Text>
            <react_native_1.TouchableOpacity style={styles.button} onPress={function () { return router.back(); }}>
                <react_native_1.Text style={styles.buttonText}>Go Back</react_native_1.Text>
            </react_native_1.TouchableOpacity>
        </react_native_1.View>);
}
var styles = react_native_1.StyleSheet.create({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 16,
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        marginVertical: 16,
    },
    message: {
        fontSize: 16,
        color: '#666666',
        textAlign: 'center',
        marginBottom: 24,
    },
    button: {
        backgroundColor: colors_1.colors.primaryColor,
        paddingVertical: 12,
        paddingHorizontal: 24,
        borderRadius: 24,
    },
    buttonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: 'bold',
    },
});
