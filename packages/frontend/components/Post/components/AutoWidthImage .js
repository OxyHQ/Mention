"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var colors_1 = require("@/styles/colors");
var react_1 = require("react");
var react_native_1 = require("react-native");
var AutoWidthImage = function (_a) {
    var uri = _a.uri, style = _a.style;
    var _b = (0, react_1.useState)(0), width = _b[0], setWidth = _b[1];
    (0, react_1.useEffect)(function () {
        react_native_1.Image.getSize(uri, function (imgWidth, imgHeight) {
            var calculatedWidth = (250 * imgWidth) / imgHeight;
            setWidth(calculatedWidth);
        });
    }, [uri]);
    return (<react_native_1.Image source={{ uri: uri }} style={[
            {
                height: 250,
                width: width || "auto",
                resizeMode: "contain",
                borderRadius: 35,
                borderWidth: 1,
                borderColor: colors_1.colors.COLOR_BLACK_LIGHT_6,
            },
            style,
        ]}/>);
};
exports.default = AutoWidthImage;
