import React, { createContext, useState, ReactNode, useRef, useCallback, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import BottomSheet, { type BottomSheetRef } from "@oxyhq/bloom/bottom-sheet";

interface BottomSheetContextProps {
    openBottomSheet: (isOpen: boolean) => void;
    setBottomSheetContent: (content: ReactNode) => void;
    bottomSheetRef: React.RefObject<BottomSheetRef | null>;
}

export const BottomSheetContext = createContext<BottomSheetContextProps>({
    openBottomSheet: () => { },
    setBottomSheetContent: () => { },
    bottomSheetRef: { current: null },
});

export const BottomSheetProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [bottomSheetContent, setBottomSheetContent] = useState<ReactNode>(null);
    const bottomSheetRef = useRef<BottomSheetRef | null>(null);

    const openBottomSheet = useCallback((isOpen: boolean) => {
        if (isOpen) {
            bottomSheetRef.current?.present();
        } else {
            bottomSheetRef.current?.dismiss();
        }
    }, []);

    const contextValue = useMemo(() => ({
        openBottomSheet,
        setBottomSheetContent,
        bottomSheetRef,
    }), [openBottomSheet]);

    return (
        <BottomSheetContext.Provider value={contextValue}>
            {children}
            <BottomSheet
                ref={bottomSheetRef}
                enablePanDownToClose={true}
                style={styles.contentContainer}
            >
                <View style={styles.contentView}>
                    {bottomSheetContent}
                </View>
            </BottomSheet>
        </BottomSheetContext.Provider>
    );
};

const styles = StyleSheet.create({
    contentContainer: {
        maxWidth: 500,
        margin: 'auto',
    },
    contentView: {
        flex: 1,
    },
});
