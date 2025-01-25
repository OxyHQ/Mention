import React, { createContext, useState, ReactNode, useRef } from 'react';
import { StyleSheet } from 'react-native';
import BottomSheet, { BottomSheetModalProvider, BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { autoBatchEnhancer } from '@reduxjs/toolkit';

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

    const openBottomSheet = (isOpen: boolean) => {
        if (isOpen) {
            bottomSheetModalRef.current?.present();
        } else {
            bottomSheetModalRef.current?.dismiss();
        }
    };

    return (
        <BottomSheetContext.Provider value={{ openBottomSheet, setBottomSheetContent }}>
            <BottomSheetModalProvider>
                {children}
                <BottomSheetModal ref={bottomSheetModalRef} style={styles.contentContainer}>
                    <BottomSheetView>
                        {bottomSheetContent}
                    </BottomSheetView>
                </BottomSheetModal>
            </BottomSheetModalProvider>
        </BottomSheetContext.Provider>
    );
};


const styles = StyleSheet.create({
    contentContainer: {
        maxWidth: 500,
        margin: 'auto',
    },
});