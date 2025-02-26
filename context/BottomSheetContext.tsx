import React, { createContext, useState, ReactNode, useRef, useCallback } from 'react';
import { StyleSheet, ScrollView, View } from 'react-native';
import { BottomSheetModal, BottomSheetView, BottomSheetBackdrop, BottomSheetBackdropProps } from '@gorhom/bottom-sheet';

interface BottomSheetContextProps {
    openBottomSheet: (isOpen: boolean) => void;
    setBottomSheetContent: (content: ReactNode) => void;
}

export const BottomSheetContext = createContext<BottomSheetContextProps>({
    openBottomSheet: () => { },
    setBottomSheetContent: () => { },
});

export const BottomSheetProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [bottomSheetContent, setBottomSheetContent] = useState<ReactNode>(null);
    const bottomSheetModalRef = useRef<BottomSheetModal>(null);

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
        <BottomSheetContext.Provider value={{ openBottomSheet, setBottomSheetContent }}>
            {children}
            <BottomSheetModal
                ref={bottomSheetModalRef}
                snapPoints={['90%']}
                enablePanDownToClose={true}
                enableDismissOnClose={true}
                android_keyboardInputMode="adjustResize"
                keyboardBehavior="extend"
                style={styles.contentContainer}
                handleIndicatorStyle={{ backgroundColor: '#000', width: 40 }}
                backgroundStyle={{ backgroundColor: 'white' }}
                backdropComponent={renderBackdrop}
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