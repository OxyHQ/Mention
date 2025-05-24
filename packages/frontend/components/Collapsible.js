"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Collapsible = Collapsible;
var react_1 = require("react");
var react_native_1 = require("react-native");
var ThemedText_1 = require("@/components/ThemedText");
var ThemedView_1 = require("@/components/ThemedView");
var IconSymbol_1 = require("@/components/ui/IconSymbol");
var Colors_1 = require("@/constants/Colors");
var useColorScheme_1 = require("@/hooks/useColorScheme");
function Collapsible(_a) {
    var _b;
    var children = _a.children, title = _a.title;
    var _c = (0, react_1.useState)(false), isOpen = _c[0], setIsOpen = _c[1];
    var theme = (_b = (0, useColorScheme_1.useColorScheme)()) !== null && _b !== void 0 ? _b : 'light';
    return (<ThemedView_1.ThemedView>
      <react_native_1.TouchableOpacity style={styles.heading} onPress={function () { return setIsOpen(function (value) { return !value; }); }} activeOpacity={0.8}>
        <IconSymbol_1.IconSymbol name="chevron.right" size={18} weight="medium" color={theme === 'light' ? Colors_1.Colors.light.icon : Colors_1.Colors.dark.icon} style={{ transform: [{ rotate: isOpen ? '90deg' : '0deg' }] }}/>

        <ThemedText_1.ThemedText type="defaultSemiBold">{title}</ThemedText_1.ThemedText>
      </react_native_1.TouchableOpacity>
      {isOpen && <ThemedView_1.ThemedView style={styles.content}>{children}</ThemedView_1.ThemedView>}
    </ThemedView_1.ThemedView>);
}
var styles = react_native_1.StyleSheet.create({
    heading: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    content: {
        marginTop: 6,
        marginLeft: 24,
    },
});
