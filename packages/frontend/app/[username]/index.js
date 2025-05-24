"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var react_1 = require("react");
var expo_router_1 = require("expo-router");
var NotFoundScreen_1 = require("@/components/NotFoundScreen");
var ProfileScreen_1 = require("@/components/ProfileScreen");
var UsernamePage = function () {
    var router = (0, expo_router_1.useRouter)();
    var username = (0, expo_router_1.useLocalSearchParams)().username;
    if (typeof username === 'string' && username.startsWith('@')) {
        return <ProfileScreen_1.default />;
    }
    return <NotFoundScreen_1.default />;
};
exports.default = UsernamePage;
