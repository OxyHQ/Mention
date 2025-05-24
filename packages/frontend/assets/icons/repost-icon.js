"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RepostIconActive = exports.RepostIcon = void 0;
var react_1 = require("react");
var react_native_svg_1 = require("react-native-svg");
var RepostIcon = function (_a) {
    var _b = _a.size, size = _b === void 0 ? 24 : _b, _c = _a.color, color = _c === void 0 ? '#000000' : _c;
    return (<react_native_svg_1.default width={size} height={size} viewBox="0 0 24 24" fill="none">
    <react_native_svg_1.Path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z" fill={color}/>
  </react_native_svg_1.default>);
};
exports.RepostIcon = RepostIcon;
var RepostIconActive = function (_a) {
    var _b = _a.size, size = _b === void 0 ? 24 : _b, _c = _a.color, color = _c === void 0 ? '#00BA7C' : _c;
    return (<react_native_svg_1.default width={size} height={size} viewBox="0 0 24 24" fill="none">
    <react_native_svg_1.Path d="M4.5 3.88l4.432 4.14-1.364 1.46L5.5 7.55V16c0 1.1.896 2 2 2H13v2H7.5c-2.209 0-4-1.79-4-4V7.55L1.432 9.48.068 8.02 4.5 3.88zM16.5 6H11V4h5.5c2.209 0 4 1.79 4 4v8.45l2.068-1.93 1.364 1.46-4.432 4.14-4.432-4.14 1.364-1.46 2.068 1.93V8c0-1.1-.896-2-2-2z" fill={color}/>
  </react_native_svg_1.default>);
};
exports.RepostIconActive = RepostIconActive;
