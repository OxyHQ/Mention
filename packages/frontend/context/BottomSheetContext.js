"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BottomSheetProvider = exports.BottomSheetContext = void 0;
var react_1 = require("react");
var react_native_1 = require("react-native");
var bottom_sheet_1 = require("@gorhom/bottom-sheet");
exports.BottomSheetContext = (0, react_1.createContext)({
    openBottomSheet: function () { },
    setBottomSheetContent: function () { },
    bottomSheetRef: { current: null },
});
var BottomSheetProvider = function (_a) {
    var children = _a.children;
    var _b = (0, react_1.useState)(null), bottomSheetContent = _b[0], setBottomSheetContent = _b[1];
    var bottomSheetModalRef = (0, react_1.useRef)(null);
    var renderBackdrop = (0, react_1.useCallback)(function (props) { return (<bottom_sheet_1.BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close"/>); }, []);
    var openBottomSheet = function (isOpen) {
        var _a, _b;
        if (isOpen) {
            (_a = bottomSheetModalRef.current) === null || _a === void 0 ? void 0 : _a.present();
        }
        else {
            (_b = bottomSheetModalRef.current) === null || _b === void 0 ? void 0 : _b.dismiss();
        }
    };
    return (<exports.BottomSheetContext.Provider value={{ openBottomSheet: openBottomSheet, setBottomSheetContent: setBottomSheetContent, bottomSheetRef: bottomSheetModalRef }}>
            {children}
            <bottom_sheet_1.BottomSheetModal ref={bottomSheetModalRef} enableDynamicSizing enablePanDownToClose={true} enableDismissOnClose={true} android_keyboardInputMode="adjustResize" keyboardBehavior="extend" style={styles.contentContainer} handleIndicatorStyle={{ backgroundColor: '#000', width: 40 }} backdropComponent={renderBackdrop} enableContentPanningGesture={true} enableHandlePanningGesture={true} index={0}>
                <bottom_sheet_1.BottomSheetView style={styles.contentView}>
                    {bottomSheetContent}
                </bottom_sheet_1.BottomSheetView>
            </bottom_sheet_1.BottomSheetModal>
        </exports.BottomSheetContext.Provider>);
};
exports.BottomSheetProvider = BottomSheetProvider;
var styles = react_native_1.StyleSheet.create({
    contentContainer: {
        maxWidth: 500,
        margin: 'auto',
    },
    contentView: {
        flex: 1,
    }
});
