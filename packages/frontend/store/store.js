"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.store = void 0;
var toolkit_1 = require("@reduxjs/toolkit");
var analyticsReducer_1 = require("./reducers/analyticsReducer");
var trendsReducer_1 = require("./reducers/trendsReducer");
var rootReducer = (0, toolkit_1.combineReducers)({
    trends: trendsReducer_1.default,
    analytics: analyticsReducer_1.default,
});
exports.store = (0, toolkit_1.configureStore)({
    reducer: rootReducer,
});
exports.default = exports.store;
