"use strict";
// Fallback for using MaterialIcons on Android and web.
Object.defineProperty(exports, "__esModule", { value: true });
exports.IconSymbol = IconSymbol;
var MaterialIcons_1 = require("@expo/vector-icons/MaterialIcons");
/**
 * Add your SF Symbols to Material Icons mappings here.
 * - see Material Icons in the [Icons Directory](https://icons.expo.fyi).
 * - see SF Symbols in the [SF Symbols](https://developer.apple.com/sf-symbols/) app.
 */
var MAPPING = {
    'house.fill': 'home',
    'paperplane.fill': 'send',
    'chevron.left.forwardslash.chevron.right': 'code',
    'chevron.right': 'chevron-right',
};
/**
 * An icon component that uses native SF Symbols on iOS, and Material Icons on Android and web.
 * This ensures a consistent look across platforms, and optimal resource usage.
 * Icon `name`s are based on SF Symbols and require manual mapping to Material Icons.
 */
function IconSymbol(_a) {
    var name = _a.name, _b = _a.size, size = _b === void 0 ? 24 : _b, color = _a.color, style = _a.style;
    return <MaterialIcons_1.default color={color} size={size} name={MAPPING[name]} style={style}/>;
}
