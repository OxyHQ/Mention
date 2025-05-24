"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = NotFoundScreen;
var expo_router_1 = require("expo-router");
var react_native_1 = require("react-native");
var ThemedText_1 = require("@/components/ThemedText");
var ThemedView_1 = require("@/components/ThemedView");
function NotFoundScreen() {
    return (<>
      <expo_router_1.Stack.Screen options={{ title: 'Oops!' }}/>
      <ThemedView_1.ThemedView style={styles.container}>
        <ThemedText_1.ThemedText type="title">This screen does not exist.</ThemedText_1.ThemedText>
        <expo_router_1.Link href="/" style={styles.link}>
          <ThemedText_1.ThemedText type="link">Go to home screen!</ThemedText_1.ThemedText>
        </expo_router_1.Link>
      </ThemedView_1.ThemedView>
    </>);
}
var styles = react_native_1.StyleSheet.create({
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
    },
    link: {
        marginTop: 15,
        paddingVertical: 15,
    },
});
