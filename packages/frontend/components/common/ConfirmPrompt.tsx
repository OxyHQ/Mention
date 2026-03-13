import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BottomSheetModal, BottomSheetView, BottomSheetBackdrop, BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useTheme } from '@/hooks/useTheme';
import { ConfirmBottomSheet } from './ConfirmBottomSheet';
import type { ConfirmOptions } from '@/utils/alerts';

type ConfirmRequest = ConfirmOptions & {
  resolve: (value: boolean) => void;
};

let globalShowConfirm: ((request: ConfirmRequest) => void) | null = null;

/**
 * Show a confirm dialog using the in-app bottom sheet instead of window.confirm/Alert.alert.
 * Returns a Promise<boolean> just like the old confirmDialog.
 * Falls back to native Alert if the provider isn't mounted yet.
 */
export function showConfirmPrompt(options: ConfirmOptions): Promise<boolean> {
  if (globalShowConfirm) {
    return new Promise<boolean>((resolve) => {
      globalShowConfirm!({ ...options, resolve });
    });
  }

  // Fallback if provider not mounted (shouldn't happen in normal app flow)
  return Promise.resolve(false);
}

/**
 * Mount this provider once near the root of the app (inside BottomSheetModalProvider).
 * It renders the ConfirmBottomSheet when confirmDialog is called.
 */
export function ConfirmPromptProvider() {
  const theme = useTheme();
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const requestRef = useRef<ConfirmRequest | null>(null);

  useEffect(() => {
    globalShowConfirm = (req) => {
      requestRef.current = req;
      setRequest(req);
      bottomSheetRef.current?.present();
    };

    return () => {
      globalShowConfirm = null;
    };
  }, []);

  const handleConfirm = useCallback(() => {
    requestRef.current?.resolve(true);
    requestRef.current = null;
    bottomSheetRef.current?.dismiss();
  }, []);

  const handleCancel = useCallback(() => {
    requestRef.current?.resolve(false);
    requestRef.current = null;
    bottomSheetRef.current?.dismiss();
  }, []);

  const handleDismiss = useCallback(() => {
    // If dismissed without explicit confirm/cancel, treat as cancel
    if (requestRef.current) {
      requestRef.current.resolve(false);
      requestRef.current = null;
    }
    setRequest(null);
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
    [],
  );

  return (
    <BottomSheetModal
      ref={bottomSheetRef}
      enablePanDownToClose
      enableDismissOnClose
      enableDynamicSizing
      backgroundStyle={{ backgroundColor: theme.colors.background }}
      handleIndicatorStyle={{ backgroundColor: theme.colors.text, width: 40 }}
      backdropComponent={renderBackdrop}
      onDismiss={handleDismiss}
      style={{ maxWidth: 500, margin: 'auto' }}
    >
      <BottomSheetView style={{ backgroundColor: theme.colors.background }}>
        {request && (
          <ConfirmBottomSheet
            title={request.title}
            message={request.message}
            confirmText={request.okText}
            cancelText={request.cancelText}
            destructive={request.destructive}
            onConfirm={handleConfirm}
            onCancel={handleCancel}
          />
        )}
      </BottomSheetView>
    </BottomSheetModal>
  );
}
