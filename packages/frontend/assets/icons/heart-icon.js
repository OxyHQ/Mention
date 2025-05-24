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
exports.HeartIconActive = exports.HeartIcon = void 0;
var react_1 = require("react");
var react_native_svg_1 = require("react-native-svg");
var colors_1 = require("@/styles/colors");
var HeartIcon = function (_a) {
    var _b = _a.color, color = _b === void 0 ? colors_1.colors.primaryColor : _b, _c = _a.size, size = _c === void 0 ? 26 : _c, style = _a.style;
    return (<react_native_svg_1.default viewBox="0 0 18 18" width={size} height={size} style={__assign({}, style)}>
      <react_native_svg_1.Path stroke={color} fill="transparent" d="M1.34375 7.53125L1.34375 7.54043C1.34374 8.04211 1.34372 8.76295 1.6611 9.65585C1.9795 10.5516 2.60026 11.5779 3.77681 12.7544C5.59273 14.5704 7.58105 16.0215 8.33387 16.5497C8.73525 16.8313 9.26573 16.8313 9.66705 16.5496C10.4197 16.0213 12.4074 14.5703 14.2232 12.7544C15.3997 11.5779 16.0205 10.5516 16.3389 9.65585C16.6563 8.76296 16.6563 8.04211 16.6562 7.54043V7.53125C16.6562 5.23466 15.0849 3.25 12.6562 3.25C11.5214 3.25 10.6433 3.78244 9.99228 4.45476C9.59009 4.87012 9.26356 5.3491 9 5.81533C8.73645 5.3491 8.40991 4.87012 8.00772 4.45476C7.35672 3.78244 6.47861 3.25 5.34375 3.25C2.9151 3.25 1.34375 5.23466 1.34375 7.53125Z" strokeWidth="1.8"></react_native_svg_1.Path>
    </react_native_svg_1.default>);
};
exports.HeartIcon = HeartIcon;
var HeartIconActive = function (_a) {
    var _b = _a.color, color = _b === void 0 ? colors_1.colors.primaryColor : _b, _c = _a.size, size = _c === void 0 ? 26 : _c, style = _a.style;
    return (<react_native_svg_1.default viewBox="0 0 18 18" width={size} height={size} style={__assign({}, style)}>
      <react_native_svg_1.Path fill={color} d="M1.34375 7.03125L1.34375 7.04043C1.34374 7.54211 1.34372 8.26295 1.6611 9.15585C1.9795 10.0516 2.60026 11.0779 3.77681 12.2544C5.59273 14.0704 7.58105 15.5215 8.33387 16.0497C8.73525 16.3313 9.26573 16.3313 9.66705 16.0496C10.4197 15.5213 12.4074 14.0703 14.2232 12.2544C15.3997 11.0779 16.0205 10.0516 16.3389 9.15585C16.6563 8.26296 16.6563 7.54211 16.6562 7.04043V7.03125C16.6562 4.73466 15.0849 2.75 12.6562 2.75C11.5214 2.75 10.6433 3.28244 9.99228 3.95476C9.59009 4.37012 9.26356 4.8491 9 5.31533C8.73645 4.8491 8.40991 4.37012 8.00772 3.95476C7.35672 3.28244 6.47861 2.75 5.34375 2.75C2.9151 2.75 1.34375 4.73466 1.34375 7.03125Z"></react_native_svg_1.Path>
    </react_native_svg_1.default>);
};
exports.HeartIconActive = HeartIconActive;
