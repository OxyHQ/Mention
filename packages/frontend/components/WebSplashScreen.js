"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var logo_1 = require("@/assets/logo");
var colors_1 = require("@/styles/colors");
var react_1 = require("react");
var react_native_1 = require("react-native");
var WebSplashScreen = function () {
    return (<react_native_1.View className="flex-1 items-center justify-center bg-primary-light dark:bg-primary-dark">
            <logo_1.LogoIcon size={100} color={colors_1.colors.primaryColor}/>
        </react_native_1.View>);
};
exports.default = WebSplashScreen;
