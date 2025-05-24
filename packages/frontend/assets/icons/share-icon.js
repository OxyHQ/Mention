"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ShareIcon = void 0;
var react_1 = require("react");
var react_native_svg_1 = require("react-native-svg");
var ShareIcon = function (_a) {
    var _b = _a.size, size = _b === void 0 ? 24 : _b, _c = _a.color, color = _c === void 0 ? '#000000' : _c;
    return (<react_native_svg_1.default width={size} height={size} viewBox="0 0 24 24" fill="none">
        <react_native_svg_1.Path d="M12 2.59l5.7 5.7-1.41 1.42L13 6.41V16h-2V6.41l-3.3 3.3-1.41-1.42L12 2.59zM21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z" fill={color}/>
    </react_native_svg_1.default>);
};
exports.ShareIcon = ShareIcon;
