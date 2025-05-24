"use strict";
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
var PREFIX = '[Session]';
var createLogger = function () {
    return {
        info: function (message) {
            var args = [];
            for (var _i = 1; _i < arguments.length; _i++) {
                args[_i - 1] = arguments[_i];
            }
            if (process.env.NODE_ENV !== 'production') {
                console.log.apply(console, __spreadArray(["".concat(PREFIX, " [INFO] ").concat(message)], args, false));
            }
        },
        warn: function (message) {
            var args = [];
            for (var _i = 1; _i < arguments.length; _i++) {
                args[_i - 1] = arguments[_i];
            }
            console.warn.apply(console, __spreadArray(["".concat(PREFIX, " [WARN] ").concat(message)], args, false));
        },
        error: function (message) {
            var args = [];
            for (var _i = 1; _i < arguments.length; _i++) {
                args[_i - 1] = arguments[_i];
            }
            console.error.apply(console, __spreadArray(["".concat(PREFIX, " [ERROR] ").concat(message)], args, false));
        },
        debug: function (message) {
            var args = [];
            for (var _i = 1; _i < arguments.length; _i++) {
                args[_i - 1] = arguments[_i];
            }
            if (process.env.NODE_ENV !== 'production') {
                console.debug.apply(console, __spreadArray(["".concat(PREFIX, " [DEBUG] ").concat(message)], args, false));
            }
        }
    };
};
exports.logger = createLogger();
