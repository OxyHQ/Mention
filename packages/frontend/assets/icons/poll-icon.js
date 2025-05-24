"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PollIcon = void 0;
var react_1 = require("react");
var react_native_svg_1 = require("react-native-svg");
var colors_1 = require("@/styles/colors");
var PollIcon = function (_a) {
    var _b = _a.size, size = _b === void 0 ? 20 : _b, _c = _a.color, color = _c === void 0 ? colors_1.colors.primaryColor : _c;
    return (<react_native_svg_1.default width={size} height={size} viewBox="0 0 24 24" fill="none">
            <react_native_svg_1.Path d="M3 4h18v2H3V4zm0 7h12v2H3v-2zm0 7h18v2H3v-2z" fill={color}/>
            <react_native_svg_1.Path d="M17 10h4v4h-4v-4z" fill={color}/>
        </react_native_svg_1.default>);
};
exports.PollIcon = PollIcon;
exports.default = exports.PollIcon;
