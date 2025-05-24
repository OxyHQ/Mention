"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var react_1 = require("react");
var react_native_1 = require("react-native");
var colors_1 = require("@/styles/colors");
var AnimatedSkeleton_1 = require("./AnimatedSkeleton");
var LoadingSkeleton = function (_a) {
    var _b = _a.count, count = _b === void 0 ? 3 : _b;
    var windowWidth = (0, react_native_1.useWindowDimensions)().width;
    var isTabletOrDesktop = windowWidth >= 768;
    var skeletons = [];
    for (var i = 0; i < count; i++) {
        skeletons.push(<react_native_1.View key={"skeleton-".concat(i)} style={[
                styles.postContainer,
                isTabletOrDesktop && styles.postContainerTablet
            ]}>
                <react_native_1.View style={styles.headerContainer}>
                    <AnimatedSkeleton_1.default width={40} height={40} borderRadius={20} marginBottom={0}/>
                    <react_native_1.View style={styles.headerTextContainer}>
                        <AnimatedSkeleton_1.default width={120} height={16}/>
                        <AnimatedSkeleton_1.default width={100} height={14}/>
                    </react_native_1.View>
                    <AnimatedSkeleton_1.default width={24} height={24} borderRadius={12} marginBottom={0}/>
                </react_native_1.View>
                <react_native_1.View style={styles.contentContainer}>
                    <AnimatedSkeleton_1.default width="95%" height={16}/>
                    <AnimatedSkeleton_1.default width="80%" height={16}/>
                    <AnimatedSkeleton_1.default width="60%" height={16}/>
                </react_native_1.View>
                {i % 2 === 0 && (<react_native_1.View style={styles.mediaPlaceholder}>
                        <AnimatedSkeleton_1.default width="100%" height={isTabletOrDesktop ? 300 : 200} borderRadius={12}/>
                    </react_native_1.View>)}
                <react_native_1.View style={styles.actionsContainer}>
                    <AnimatedSkeleton_1.default width={70} height={24} borderRadius={12}/>
                    <AnimatedSkeleton_1.default width={70} height={24} borderRadius={12}/>
                    <AnimatedSkeleton_1.default width={70} height={24} borderRadius={12}/>
                    <AnimatedSkeleton_1.default width={70} height={24} borderRadius={12}/>
                </react_native_1.View>
            </react_native_1.View>);
        if (i < count - 1) {
            skeletons.push(<react_native_1.View key={"separator-".concat(i)} style={styles.separator}/>);
        }
    }
    return <>{skeletons}</>;
};
var styles = react_native_1.StyleSheet.create({
    postContainer: {
        backgroundColor: 'white',
        padding: 16,
        borderRadius: 8,
        shadowColor: colors_1.colors.shadow,
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
        elevation: 1,
    },
    postContainerTablet: {
        padding: 24,
        borderRadius: 12,
        marginHorizontal: react_native_1.Platform.OS === 'web' ? 0 : 16,
        shadowOpacity: 0.15,
        shadowRadius: 4,
        elevation: 3,
    },
    headerContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 16,
    },
    headerTextContainer: {
        marginLeft: 12,
        flex: 1,
    },
    contentContainer: {
        marginBottom: 16,
    },
    mediaPlaceholder: {
        marginBottom: 16,
        borderRadius: 12,
        overflow: 'hidden',
    },
    actionsContainer: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingTop: 8,
    },
    separator: {
        height: 6,
        backgroundColor: colors_1.colors.COLOR_BLACK_LIGHT_8,
    },
});
exports.default = LoadingSkeleton;
exports.default = LoadingSkeleton;
