import React, { createContext, useState, ReactNode, useRef, useCallback } from "react";
import { StyleSheet, ScrollView, View } from "react-native";
import { BottomSheetModal, BottomSheetView, BottomSheetBackdrop, BottomSheetBackdropProps } from "@gorhom/bottom-sheet";
import { useTheme } from "@/hooks/useTheme";

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

    const renderBackdrop = useCallback(
        (props: BottomSheetBackdropProps) => (
            <BottomSheetBackdrop
                {...props}
                appearsOnIndex={0}
                disappearsOnIndex={-1}
                pressBehavior="close"
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
                enableDynamicSizing
                enablePanDownToClose={true}
                enableDismissOnClose={true}
                android_keyboardInputMode="adjustResize"
                keyboardBehavior="extend"
                style={styles.contentContainer}
                handleIndicatorStyle={{ backgroundColor: theme.colors.text, width: 40 }}
                backdropComponent={renderBackdrop}
                enableContentPanningGesture={true}
                enableHandlePanningGesture={true}
                index={0}
            >
                <BottomSheetView style={styles.contentView}>
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