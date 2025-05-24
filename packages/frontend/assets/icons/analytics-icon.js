"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AnalyticsIconActive = exports.AnalyticsIcon = void 0;
var react_1 = require("react");
var react_native_svg_1 = require("react-native-svg");
var colors_1 = require("@/styles/colors");
var AnalyticsIcon = function (_a) {
    var _b = _a.color, color = _b === void 0 ? colors_1.colors.primaryColor : _b, _c = _a.size, size = _c === void 0 ? 26 : _c, style = _a.style;
    return (<react_native_svg_1.default viewBox="0 0 24 24" width={size} height={size} style={__assign({}, style)}>
      <react_native_svg_1.Rect fill="none" height="20" rx="5" stroke={color} strokeWidth="2" width="20" x="2" y="2"></react_native_svg_1.Rect>
      <react_native_svg_1.Rect height="12" rx="1" width="2" x="11" y="6" fill={color}></react_native_svg_1.Rect>
      <react_native_svg_1.Rect height="9" rx="1" width="2" x="15" y="9" fill={color}></react_native_svg_1.Rect>
      <react_native_svg_1.Rect height="5" rx="1" width="2" x="7" y="13" fill={color}></react_native_svg_1.Rect>
    </react_native_svg_1.default>);
};
exports.AnalyticsIcon = AnalyticsIcon;
var AnalyticsIconActive = function (_a) {
    var _b = _a.color, color = _b === void 0 ? colors_1.colors.primaryColor : _b, _c = _a.size, size = _c === void 0 ? 26 : _c, style = _a.style;
    return (<react_native_svg_1.default viewBox="0 0 24 24" width={size} height={size} style={__assign({}, style)}>
    <react_native_svg_1.Rect fill="none" height="20" rx="5" stroke={color} strokeWidth="2" width="20" x="2" y="2"></react_native_svg_1.Rect>
      <react_native_svg_1.Rect height="12" rx="1" width="2.5" x="11" y="6" fill={color}></react_native_svg_1.Rect>
      <react_native_svg_1.Rect height="9" rx="1" width="2.5" x="15" y="9" fill={color}></react_native_svg_1.Rect>
      <react_native_svg_1.Rect height="5" rx="1" width="2.5" x="7" y="13" fill={color}></react_native_svg_1.Rect>
    </react_native_svg_1.default>);
};
exports.AnalyticsIconActive = AnalyticsIconActive;
