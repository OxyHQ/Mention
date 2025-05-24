"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectHashtags = void 0;
var react_1 = require("react");
var react_native_1 = require("react-native");
var expo_router_1 = require("expo-router");
var colors_1 = require("@/styles/colors");
var detectHashtags = function (text) {
    if (!text)
        return null;
    var parts = text.split(/(#[a-zA-Z0-9_]+)/g);
    return parts.map(function (part, index) {
        return part.startsWith("#") ? (<expo_router_1.Link key={index} href={"/hashtag/".concat(part.slice(1))}>
        <react_native_1.Text style={styles.hashtag}>{part}</react_native_1.Text>
      </expo_router_1.Link>) : (part);
    });
};
exports.detectHashtags = detectHashtags;
var styles = react_native_1.StyleSheet.create({
    hashtag: {
        color: colors_1.colors.primaryColor,
        fontWeight: 'bold',
    },
});
