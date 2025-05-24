"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
var react_1 = require("react");
var react_native_1 = require("react-native");
var colors_1 = require("@/styles/colors");
var react_i18next_1 = require("react-i18next");
var ErrorBoundaryBase = /** @class */ (function (_super) {
    __extends(ErrorBoundaryBase, _super);
    function ErrorBoundaryBase() {
        var _this = _super !== null && _super.apply(this, arguments) || this;
        _this.state = {
            hasError: false,
            error: null,
        };
        _this.handleRetry = function () {
            _this.setState({ hasError: false, error: null });
        };
        return _this;
    }
    ErrorBoundaryBase.getDerivedStateFromError = function (error) {
        return { hasError: true, error: error };
    };
    ErrorBoundaryBase.prototype.componentDidCatch = function (error, errorInfo) {
        console.error('Error caught by boundary:', error, errorInfo);
    };
    ErrorBoundaryBase.prototype.render = function () {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }
            return (<react_native_1.View style={styles.container}>
                    <react_native_1.Text style={styles.title}>{this.props.t("error.boundary.title")}</react_native_1.Text>
                    <react_native_1.Text style={styles.message}>
                        {this.props.t("error.boundary.message")}
                    </react_native_1.Text>
                    <react_native_1.TouchableOpacity style={styles.retryButton} onPress={this.handleRetry}>
                        <react_native_1.Text style={styles.retryText}>{this.props.t("error.boundary.retry")}</react_native_1.Text>
                    </react_native_1.TouchableOpacity>
                </react_native_1.View>);
        }
        return this.props.children;
    };
    return ErrorBoundaryBase;
}(react_1.Component));
// Wrap the component with translation HOC
var ErrorBoundary = (0, react_i18next_1.withTranslation)()(ErrorBoundaryBase);
var styles = react_native_1.StyleSheet.create({
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
    },
    title: {
        fontSize: 20,
        fontWeight: 'bold',
        marginBottom: 10,
        color: colors_1.colors.primaryColor,
    },
    message: {
        fontSize: 16,
        textAlign: 'center',
        marginBottom: 20,
        color: colors_1.colors.COLOR_BLACK_LIGHT_3,
    },
    retryButton: {
        backgroundColor: colors_1.colors.primaryColor,
        paddingHorizontal: 20,
        paddingVertical: 10,
        borderRadius: 8,
    },
    retryText: {
        color: 'white',
        fontSize: 16,
        fontWeight: '600',
    },
});
exports.default = ErrorBoundary;
