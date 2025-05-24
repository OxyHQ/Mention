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
exports.HashtagActive = exports.Hashtag = void 0;
var react_1 = require("react");
var react_native_svg_1 = require("react-native-svg");
var colors_1 = require("@/styles/colors");
var Hashtag = function (_a) {
    var _b = _a.color, color = _b === void 0 ? colors_1.colors.primaryColor : _b, _c = _a.size, size = _c === void 0 ? 26 : _c, style = _a.style;
    return (<react_native_svg_1.default viewBox="0 0 24 24" width={size} height={size} style={__assign({}, style)}>
      <react_native_svg_1.Path fill={color} d="M10.09 3.098L9.72 7h5.99l.39-4.089 1.99.187L17.72 7h3.78v2h-3.97l-.56 6h3.53v2h-3.72l-.38 4.089-1.99-.187.36-3.902H8.78l-.38 4.089-1.99-.187L6.77 17H2.5v-2h4.46l.56-6H3.5V7h4.21l.39-4.089 1.99.187zM14.96 15l.56-6H9.53l-.56 6h5.99z"></react_native_svg_1.Path>
    </react_native_svg_1.default>);
};
exports.Hashtag = Hashtag;
var HashtagActive = function (_a) {
    var _b = _a.color, color = _b === void 0 ? colors_1.colors.primaryColor : _b, _c = _a.size, size = _c === void 0 ? 26 : _c, style = _a.style;
    return (<react_native_svg_1.default viewBox="0 0 24 24" width={size} height={size} style={__assign({}, style)}>
      <react_native_svg_1.Path fill={color} d="M10.64 3.157l-.36 3.593h4.99l.38-3.892 2.99.299-.36 3.593h2.97v2.5h-3.22l-.55 5.5h2.77v2.5h-3.02l-.39 3.892-2.98-.299.36-3.593H9.23l-.39 3.892-2.98-.299.36-3.593H2.75v-2.5h3.72l.55-5.5H3.75v-2.5h3.52l.38-3.892 2.99.299zm3.83 11.593l.55-5.5h-4.99l-.55 5.5h4.99z"></react_native_svg_1.Path>
    </react_native_svg_1.default>);
};
exports.HashtagActive = HashtagActive;
