"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Button = void 0;
var react_1 = require("react");
var react_native_web_hover_1 = require("react-native-web-hover");
var react_responsive_1 = require("react-responsive");
var expo_router_1 = require("expo-router"); // added Link import
var Button = function (_a) {
    var href = _a.href, renderText = _a.renderText, renderIcon = _a.renderIcon, containerStyle = _a.containerStyle;
    var isDesktop = (0, react_responsive_1.useMediaQuery)({ minWidth: 1266 });
    var state = isDesktop ? 'desktop' : 'tablet';
    var style = containerStyle === null || containerStyle === void 0 ? void 0 : containerStyle({ state: state });
    if (href) {
        return (<expo_router_1.Link href={href} style={style}>
                {renderIcon ? renderIcon({ state: state }) : null}
                {renderText ? renderText({ state: state }) : null}
            </expo_router_1.Link>);
    }
    return (<react_native_web_hover_1.Pressable style={style}>
            {renderIcon ? renderIcon({ state: state }) : null}
            {renderText ? renderText({ state: state }) : null}
        </react_native_web_hover_1.Pressable>);
};
exports.Button = Button;
