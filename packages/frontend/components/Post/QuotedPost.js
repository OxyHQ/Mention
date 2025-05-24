"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = QuotedPost;
var react_1 = require("react");
var react_native_1 = require("react-native");
var _1 = require(".");
function QuotedPost(_a) {
    var id = _a.id;
    // Minimal implementation; expand as needed.
    if (!id)
        return null;
    return (<_1.default id={id}/>);
}
var styles = react_native_1.StyleSheet.create({
    container: {
        padding: 8,
        borderColor: "#ccc",
        borderWidth: 1,
        borderRadius: 6,
        marginVertical: 8,
    },
    text: {
        fontSize: 14,
        color: "#333",
    },
});
