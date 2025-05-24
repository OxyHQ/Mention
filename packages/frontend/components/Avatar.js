"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var default_avatar_jpg_1 = require("@/assets/images/default-avatar.jpg");
var colors_1 = require("@/styles/colors");
var react_1 = require("react");
var react_native_1 = require("react-native");
var Avatar = function (_a) {
    var id = _a.id, _b = _a.size, size = _b === void 0 ? 40 : _b, style = _a.style, onPress = _a.onPress;
    // Handle different avatar formats
    var source;
    if (!id) {
        // Use default avatar if no ID provided
        source = default_avatar_jpg_1.default;
    }
    else if (id.startsWith('http')) {
        // If it's already a full URL, use it directly
        source = { uri: id };
    }
    else {
        // Otherwise, construct the URL using the cloud URL
        source = { uri: "".concat(id) };
    }
    return (<react_native_1.Pressable onPress={onPress} disabled={!onPress}>
      <react_native_1.Image source={source} style={[styles.avatar, { width: size, height: size, borderRadius: size }, style]} defaultSource={default_avatar_jpg_1.default} onError={function (e) { return console.warn('Avatar image failed to load:', id); }}/>
    </react_native_1.Pressable>);
};
var styles = react_native_1.StyleSheet.create({
    avatar: {
        backgroundColor: colors_1.colors.COLOR_BLACK_LIGHT_6,
    },
});
exports.default = Avatar;
