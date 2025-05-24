"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EmojiIcon = void 0;
var react_1 = require("react");
var react_native_svg_1 = require("react-native-svg");
var colors_1 = require("@/styles/colors");
var EmojiIcon = function (_a) {
    var _b = _a.color, color = _b === void 0 ? colors_1.colors.primaryColor : _b, // Replace with your primary color
    _c = _a.size, // Replace with your primary color
    size = _c === void 0 ? 26 : _c, style = _a.style;
    return (<react_native_svg_1.default width={size} height={size} viewBox="0 0 24 24" style={style}>
      <react_native_svg_1.Path fill={color} fillRule="evenodd" clipRule="evenodd" d="M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM2 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10S2 17.523 2 12Zm8-5a1 1 0 0 1 1 1v3a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1Zm4 0a1 1 0 0 1 1 1v3a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1Zm-5.894 7.803a1 1 0 0 1 1.341-.447c1.719.859 3.387.859 5.106 0a1 1 0 1 1 .894 1.788c-2.281 1.141-4.613 1.141-6.894 0a1 1 0 0 1-.447-1.341Z"/>
    </react_native_svg_1.default>);
};
exports.EmojiIcon = EmojiIcon;
