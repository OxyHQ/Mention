import React, { useCallback, useImperativeHandle, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/Portal';
import { CloseIcon } from '@/assets/icons/close-icon';
import { IconButton } from '@/components/ui/Button';
import { Context } from './context';
import type { DialogControlProps, DialogInnerProps, DialogOuterProps } from './types';

export { useDialogContext, useDialogControl } from './context';
export type { DialogControlProps, DialogOuterProps, DialogInnerProps } from './types';

const stopPropagation = (e: { stopPropagation: () => void }) => e.stopPropagation();

export function Outer({
  children,
  control,
  onClose,
  testID,
  webOptions,
}: React.PropsWithChildren<DialogOuterProps>) {
  const [isOpen, setIsOpen] = useState(false);

  const open = useCallback(() => {
    setIsOpen(true);
  }, []);

  const close = useCallback<DialogControlProps['close']>((cb) => {
    setIsOpen(false);
    try {
      if (cb && typeof cb === 'function') {
        setTimeout(cb);
      }
    } catch (e) {
      console.error('Dialog close callback error:', e);
    }
    onClose?.();
  }, [onClose]);

  useImperativeHandle(
    control.ref,
    () => ({ open, close }),
    [open, close],
  );

  const context = useMemo(
    () => ({ close, isWithinDialog: true }),
    [close],
  );

  const handleBackdropPress = useCallback(() => {
    close();
  }, [close]);

  if (!isOpen) return null;

  return (
    <Portal>
      <Context.Provider value={context}>
        <Pressable
          onPress={handleBackdropPress}
          style={{
            position: 'fixed' as 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 50,
            alignItems: 'center',
            justifyContent: webOptions?.alignCenter ? 'center' : undefined,
            paddingHorizontal: 20,
            paddingVertical: '10%',
            overflowY: 'auto',
          }}
        >
          <Backdrop />
          <View
            testID={testID}
            style={{
              width: '100%',
              zIndex: 60,
              alignItems: 'center',
              minHeight: webOptions?.alignCenter ? undefined : '60%',
            }}
          >
            {children}
          </View>
        </Pressable>
      </Context.Provider>
    </Portal>
  );
}

export function Inner({
  children,
  style,
  label,
  header,
  contentContainerStyle,
}: DialogInnerProps) {
  const theme = useTheme();

  return (
    <View
      role="dialog"
      aria-label={label}
      onStartShouldSetResponder={() => true}
      onResponderRelease={stopPropagation}
      // @ts-expect-error web-only onClick
      onClick={stopPropagation}
      style={[
        {
          position: 'relative',
          borderRadius: 16,
          width: '100%',
          maxWidth: 600,
          backgroundColor: theme.colors.background,
          borderWidth: 1,
          borderColor: theme.colors.border,
          shadowColor: theme.colors.shadow,
          shadowOpacity: theme.isDark ? 0.4 : 0.1,
          shadowRadius: 30,
          shadowOffset: { width: 0, height: 4 },
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {header}
      <View style={[{ padding: 24 }, contentContainerStyle]}>
        {children}
      </View>
    </View>
  );
}

export function ScrollableInner(props: DialogInnerProps) {
  return <Inner {...props} />;
}

export function Handle() {
  return null;
}

export function Close() {
  const { close } = React.useContext(Context);

  return (
    <View
      style={{
        position: 'absolute',
        top: 12,
        right: 12,
        zIndex: 10,
      }}
    >
      <IconButton variant="icon" onPress={() => close()}>
        <CloseIcon size={20} />
      </IconButton>
    </View>
  );
}

export function Backdrop() {
  const theme = useTheme();

  return (
    <View
      style={{
        position: 'fixed' as 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: theme.colors.overlay,
      }}
    />
  );
}
