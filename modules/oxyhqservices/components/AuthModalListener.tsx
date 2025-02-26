import React, { useContext, useEffect } from 'react';
import { addAuthEventListener, removeAuthEventListener } from '../utils/api';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { AuthBottomSheet } from './AuthBottomSheet';

export function AuthModalListener() {
    const { openBottomSheet, setBottomSheetContent } = useContext(BottomSheetContext);

    useEffect(() => {
        const showAuthModal = () => {
            setBottomSheetContent(<AuthBottomSheet />);
            openBottomSheet(true);
        };

        // Add listener when component mounts
        addAuthEventListener(showAuthModal);

        // Remove listener when component unmounts
        return () => {
            removeAuthEventListener(showAuthModal);
        };
    }, [openBottomSheet, setBottomSheetContent]);

    return null; // This component doesn't render anything
} 