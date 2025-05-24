"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LogoIcon = void 0;
var react_1 = require("react");
var react_native_svg_1 = require("react-native-svg");
var colors_1 = require("@/styles/colors");
var LogoIcon = function (_a) {
    var _b = _a.color, color = _b === void 0 ? colors_1.colors.primaryColor : _b, _c = _a.size, size = _c === void 0 ? 26 : _c, style = _a.style;
    return (<react_native_svg_1.default viewBox="0 0 388.03 512" width={size} height={size} style={style}>
      <polygon fill={color} points="388.03 512 170.88 512 168.64 509.76 168.64 364.25 85.07 364.25 85.07 509.76 82.83 512 0 512 0 105.31 276.91 0 281.41 1.51 388.03 109.79 388.03 512"/>
    </react_native_svg_1.default>);
};
exports.LogoIcon = LogoIcon;
