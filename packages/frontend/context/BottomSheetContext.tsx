import React, { createContext, useState, ReactNode, useRef, useCallback, useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { BottomSheet, type BottomSheetRef } from "@oxyhq/bloom/bottom-sheet";

export interface BottomSheetContextProps {
    openBottomSheet: (isOpen: boolean) => void;
    setBottomSheetContent: (content: ReactNode, options?: { scrollable?: boolean; presentation?: 'default' | 'videoReplies' }) => void;
    bottomSheetRef: React.RefObject<BottomSheetRef | null>;
    isBottomSheetOpen?: boolean;
    bottomSheetPresentation?: 'default' | 'videoReplies';
}

export const BottomSheetContext = createContext<BottomSheetContextProps>({
    openBottomSheet: () => { },
    setBottomSheetContent: () => { },
    bottomSheetRef: { current: null },
});

export const BottomSheetProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const [bottomSheetContent, setBottomSheetContentState] = useState<ReactNode>(null);
    const [scrollable, setScrollable] = useState(true);
    const [isBottomSheetOpen, setIsBottomSheetOpen] = useState(false);
    const [bottomSheetPresentation, setBottomSheetPresentation] = useState<'default' | 'videoReplies'>('default');
    const bottomSheetRef = useRef<BottomSheetRef | null>(null);

    const openBottomSheet = useCallback((isOpen: boolean) => {
        setIsBottomSheetOpen(isOpen);
        if (isOpen) {
            bottomSheetRef.current?.present();
        } else {
            bottomSheetRef.current?.dismiss();
        }
    }, []);

    const setBottomSheetContent = useCallback((content: ReactNode, options?: { scrollable?: boolean; presentation?: 'default' | 'videoReplies' }) => {
        setBottomSheetContentState(content);
        setScrollable(options?.scrollable ?? true);
        setBottomSheetPresentation(options?.presentation ?? 'default');
    }, []);

    const handleDismiss = useCallback(() => {
        setIsBottomSheetOpen(false);
        setBottomSheetPresentation('default');
    }, []);

    const contextValue = useMemo(() => ({
        openBottomSheet,
        setBottomSheetContent,
        bottomSheetRef,
        isBottomSheetOpen,
        bottomSheetPresentation,
    }), [openBottomSheet, setBottomSheetContent, isBottomSheetOpen, bottomSheetPresentation]);

    return (
        <BottomSheetContext.Provider value={contextValue}>
            {children}
            <BottomSheet
                ref={bottomSheetRef}
                enablePanDownToClose={true}
                style={[
                    styles.contentContainer,
                    bottomSheetPresentation === 'videoReplies' ? styles.videoRepliesContainer : null,
                ]}
                scrollable={scrollable}
                onDismiss={handleDismiss}
                backdropComponent={bottomSheetPresentation === 'videoReplies'
                    ? ({ onPress }) => <Pressable style={StyleSheet.absoluteFill} onPress={onPress} />
                    : undefined}
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
    videoRepliesContainer: {
        height: '62%',
    },
    contentView: {
        flex: 1,
    },
});
