import React, { useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import { Pressable, View } from 'react-native';
import { BottomSheetModal, BottomSheetView, BottomSheetBackdrop, type BottomSheetBackdropProps } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '@/hooks/useTheme';
import { Context, useDialogContext } from './context';
import type { DialogControlProps, DialogInnerProps, DialogOuterProps } from './types';

export { useDialogContext, useDialogControl } from './context';
export type { DialogControlProps, DialogOuterProps, DialogInnerProps } from './types';

export function Outer({
  children,
  control,
  onClose,
  testID,
  preventExpansion,
}: React.PropsWithChildren<DialogOuterProps>) {
  const theme = useTheme();
  const ref = useRef<BottomSheetModal>(null);
  const closeCallbacks = useRef<(() => void)[]>([]);

  const callQueuedCallbacks = useCallback(() => {
    for (const cb of closeCallbacks.current) {
      try {
        cb();
      } catch (e) {
        console.error('Dialog close callback error:', e);
      }
    }
    closeCallbacks.current = [];
  }, []);

  const open = useCallback(() => {
    callQueuedCallbacks();
    ref.current?.present();
  }, [callQueuedCallbacks]);

  const close = useCallback<DialogControlProps['close']>((cb) => {
    if (typeof cb === 'function') {
      closeCallbacks.current.push(cb);
    }
    ref.current?.dismiss();
  }, []);

  const handleDismiss = useCallback(() => {
    callQueuedCallbacks();
    onClose?.();
  }, [callQueuedCallbacks, onClose]);

  useImperativeHandle(
    control.ref,
    () => ({ open, close }),
    [open, close],
  );

  const context = useMemo(
    () => ({ close, isWithinDialog: true }),
    [close],
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
        opacity={0.4}
      />
    ),
    [],
  );

  return (
    <BottomSheetModal
      ref={ref}
      enablePanDownToClose
      enableDismissOnClose
      enableDynamicSizing={!preventExpansion}
      snapPoints={preventExpansion ? ['40%'] : undefined}
      backgroundStyle={{
        backgroundColor: theme.colors.background,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
      }}
      handleIndicatorStyle={{
        backgroundColor: theme.colors.text,
        width: 35,
        height: 5,
        opacity: 0.5,
      }}
      backdropComponent={renderBackdrop}
      onDismiss={handleDismiss}
      style={{ maxWidth: 500, margin: 'auto' }}
    >
      <Context.Provider value={context}>
        <BottomSheetView
          testID={testID}
          style={{ backgroundColor: theme.colors.background }}
        >
          {children}
        </BottomSheetView>
      </Context.Provider>
    </BottomSheetModal>
  );
}

export function Inner({ children, style, header, contentContainerStyle }: DialogInnerProps) {
  const insets = useSafeAreaInsets();
  return (
    <>
      {header}
      <View
        style={[
          { paddingTop: 20, paddingHorizontal: 20, paddingBottom: insets.bottom + insets.top },
          contentContainerStyle,
          style,
        ]}
      >
        {children}
      </View>
    </>
  );
}

export function ScrollableInner(props: DialogInnerProps) {
  return <Inner {...props} />;
}

export function Handle() {
  const theme = useTheme();
  const { close } = useDialogContext();

  return (
    <View style={{ position: 'absolute', width: '100%', alignItems: 'center', zIndex: 10, height: 20 }}>
      <Pressable
        onPress={() => close()}
        accessibilityLabel="Dismiss"
        accessibilityHint="Tap to close the dialog"
        hitSlop={{ top: 10, bottom: 10, left: 40, right: 40 }}
      >
        <View
          style={{
            top: 8,
            width: 35,
            height: 5,
            borderRadius: 3,
            alignSelf: 'center',
            backgroundColor: theme.colors.text,
            opacity: 0.5,
          }}
        />
      </Pressable>
    </View>
  );
}

export function Close() {
  return null;
}

export function Backdrop() {
  return null;
}
