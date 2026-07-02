import React, { createContext, useState, ReactNode, useRef, useCallback, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import BottomSheet, { type BottomSheetRef } from "@oxyhq/bloom/bottom-sheet";

export interface BottomSheetContextProps {
    openBottomSheet: (isOpen: boolean) => void;
    setBottomSheetContent: (content: ReactNode, options?: { scrollable?: boolean }) => void;
    bottomSheetRef: React.RefObject<BottomSheetRef | null>;
}

export const BottomSheetContext = createContext<BottomSheetContextProps>({
    openBottomSheet: () => { },
    setBottomSheetContent: () => { },
    bottomSheetRef: { current: null },
});

export const BottomSheetProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [bottomSheetContent, setBottomSheetContentState] = useState<ReactNode>(null);
    const [scrollable, setScrollable] = useState(true);
    const bottomSheetRef = useRef<BottomSheetRef | null>(null);

    const openBottomSheet = useCallback((isOpen: boolean) => {
        if (isOpen) {
            bottomSheetRef.current?.present();
        } else {
            bottomSheetRef.current?.dismiss();
        }
    }, []);

    const setBottomSheetContent = useCallback((content: ReactNode, options?: { scrollable?: boolean }) => {
        setBottomSheetContentState(content);
        setScrollable(options?.scrollable ?? true);
    }, []);

    const contextValue = useMemo(() => ({
        openBottomSheet,
        setBottomSheetContent,
        bottomSheetRef,
    }), [openBottomSheet, setBottomSheetContent]);

    return (
        <BottomSheetContext.Provider value={contextValue}>
            {children}
            <BottomSheet
                ref={bottomSheetRef}
                enablePanDownToClose={true}
                style={styles.contentContainer}
                scrollable={scrollable}
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
