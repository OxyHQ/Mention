"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HapticTab = HapticTab;
var elements_1 = require("@react-navigation/elements");
var Haptics = require("expo-haptics");
function HapticTab(props) {
    return (<elements_1.PlatformPressable {...props} onPressIn={function (ev) {
            var _a;
            if (process.env.EXPO_OS === 'ios') {
                // Add a soft haptic feedback when pressing down on the tabs.
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }
            (_a = props.onPressIn) === null || _a === void 0 ? void 0 : _a.call(props, ev);
        }}/>);
}
