import React, { createContext, useState, ReactNode, useRef, useCallback, useMemo } from "react";
import { StyleSheet, ScrollView, View } from "react-native";
import { BottomSheetModal, BottomSheetView, BottomSheetBackdrop, BottomSheetBackdropProps } from "@gorhom/bottom-sheet";
import { useTheme } from "@/hooks/useTheme";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface BottomSheetContextProps {
    openBottomSheet: (isOpen: boolean) => void;
    setBottomSheetContent: (content: ReactNode) => void;
    bottomSheetRef: React.RefObject<BottomSheetModal | null>;
}

export const BottomSheetContext = createContext<BottomSheetContextProps>({
    openBottomSheet: () => { },
    setBottomSheetContent: () => { },
    bottomSheetRef: { current: null },
});

export const BottomSheetProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [bottomSheetContent, setBottomSheetContent] = useState<ReactNode>(null);
    const bottomSheetModalRef = useRef<BottomSheetModal | null>(null);
    const theme = useTheme();
    const insets = useSafeAreaInsets();

    // Calculate snap points that allow the sheet to reach the top but respect safe area
    // The sheet can be dragged to 50% or 100% of screen height, but will stop at safe area top
    // The topInset prop ensures the sheet respects the safe area (camera notch/status bar)
    const snapPoints = useMemo(() => {
        // Return snap points as percentages - 100% will be limited by topInset to respect safe area
        return ['50%', '100%'];
    }, []);

    const renderBackdrop = useCallback(
        (props: BottomSheetBackdropProps) => (
            <BottomSheetBackdrop
                {...props}
                appearsOnIndex={0}
                disappearsOnIndex={-1}
                pressBehavior="close"
                opacity={0.5}
            />
        ),
        []
    );

    const openBottomSheet = (isOpen: boolean) => {
        if (isOpen) {
            bottomSheetModalRef.current?.present();
        } else {
            bottomSheetModalRef.current?.dismiss();
        }
    };

    return (
        <BottomSheetContext.Provider value={{ openBottomSheet, setBottomSheetContent, bottomSheetRef: bottomSheetModalRef }}>
            {children}
            <BottomSheetModal
                ref={bottomSheetModalRef}
                snapPoints={snapPoints}
                topInset={insets.top}
                enablePanDownToClose={true}
                enableDismissOnClose={true}
                android_keyboardInputMode="adjustResize"
                keyboardBehavior="extend"
                style={styles.contentContainer}
                backgroundStyle={{ backgroundColor: theme.colors.background }}
                handleIndicatorStyle={{ backgroundColor: theme.colors.text, width: 40 }}
                backdropComponent={renderBackdrop}
                enableContentPanningGesture={true}
                enableHandlePanningGesture={true}
                index={0}
            >
                <BottomSheetView style={[styles.contentView, { backgroundColor: theme.colors.background }]}>
                    {bottomSheetContent}
                </BottomSheetView>
            </BottomSheetModal>
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
    }
});