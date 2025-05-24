"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.colors = void 0;
function lightenColor(hex, percent) {
    var num = parseInt(hex.slice(1), 16);
    var amt = Math.round(2.55 * percent);
    var R = (num >> 16) + amt;
    var G = (num >> 8 & 0x00FF) + amt;
    var B = (num & 0x0000FF) + amt;
    return "#".concat((0x1000000 + (R < 255 ? R < 1 ? 0 : R : 255) * 0x10000 + (G < 255 ? G < 1 ? 0 : G : 255) * 0x100 + (B < 255 ? B < 1 ? 0 : B : 255)).toString(16).slice(1).toUpperCase());
}
// Updated primary color for better contrast and modern feel
var primaryColor = '#005c67';
exports.colors = {
    primaryColor: primaryColor,
    primaryLight: '#ffffff',
    primaryLight_1: '#DDF3F5',
    primaryLight_2: '#E5F0FF',
    primaryDark: '#1A1A1A',
    primaryDark_1: '#2D2D2D',
    primaryDark_2: '#404040',
    overlay: 'rgba(0, 0, 0, 0.5)',
    shadow: 'rgba(0, 0, 0, 0.1)',
    COLOR_BLACK: '#000',
    COLOR_BLACK_LIGHT_1: '#111111',
    COLOR_BLACK_LIGHT_2: '#1e1e1e',
    COLOR_BLACK_LIGHT_3: '#3c3c3c',
    COLOR_BLACK_LIGHT_4: '#5e5e5e',
    COLOR_BLACK_LIGHT_5: '#949494',
    COLOR_BLACK_LIGHT_6: '#ededed',
    COLOR_BLACK_LIGHT_7: '#F5F5F5',
    COLOR_BLACK_LIGHT_8: '#FAFAFA',
    COLOR_BLACK_LIGHT_9: '#FDFDFD',
    COLOR_BACKGROUND: lightenColor(primaryColor, 90),
    // New modern messaging colors
    messageBubbleSent: primaryColor,
    messageBubbleReceived: '#EDF2F7',
    messageTextSent: '#FFFFFF',
    messageTextReceived: '#1A202C',
    messageTimestamp: '#A0AEC0',
    messageSeparator: '#CBD5E0',
    // Chat UI specific colors
    chatInputBackground: '#F7FAFC',
    chatInputBorder: '#E2E8F0',
    chatInputText: '#2D3748',
    chatInputPlaceholder: '#A0AEC0',
    chatHeaderBorder: '#E2E8F0',
    chatUnreadBadge: '#FF3B30',
    chatTypingIndicator: '#00C853',
    // Interactive elements
    buttonPrimary: primaryColor,
    buttonSecondary: '#718096',
    buttonDisabled: '#CBD5E0',
    linkColor: primaryColor,
    // Status colors
    online: '#00C853',
    offline: '#718096',
    busy: '#FF3B30',
    away: '#FFCC00',
};
