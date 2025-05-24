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
exports.SearchActive = exports.Search = void 0;
var react_1 = require("react");
var react_native_svg_1 = require("react-native-svg");
var colors_1 = require("@/styles/colors");
var Search = function (_a) {
    var _b = _a.color, color = _b === void 0 ? colors_1.colors.primaryColor : _b, _c = _a.size, size = _c === void 0 ? 26 : _c, style = _a.style;
    return (<react_native_svg_1.default viewBox="0 0 24 24" width={size} height={size} style={__assign({}, style)}>
      <react_native_svg_1.Path fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 10.5A8.5 8.5 0 1 1 10.5 2a8.5 8.5 0 0 1 8.5 8.5Z"></react_native_svg_1.Path>
      <react_native_svg_1.Line fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" x1="16.511" x2="22" y1="16.511" y2="22"></react_native_svg_1.Line>
    </react_native_svg_1.default>);
};
exports.Search = Search;
var SearchActive = function (_a) {
    var _b = _a.color, color = _b === void 0 ? colors_1.colors.primaryColor : _b, _c = _a.size, size = _c === void 0 ? 26 : _c, style = _a.style;
    return (<react_native_svg_1.default viewBox="0 0 24 24" width={size} height={size} style={__assign({}, style)}>
      <react_native_svg_1.Path fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M18.5 10.5a8 8 0 1 1-8-8 8 8 0 0 1 8 8Z"></react_native_svg_1.Path>
      <react_native_svg_1.Line fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" x1="16.511" x2="21.643" y1="16.511" y2="21.643"></react_native_svg_1.Line>
    </react_native_svg_1.default>);
};
exports.SearchActive = SearchActive;
