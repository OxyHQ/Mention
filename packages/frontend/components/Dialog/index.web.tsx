import React, { createContext, useCallback, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { useTheme } from '@/hooks/useTheme';
import { Portal } from '@/components/Portal';
import { CloseIcon } from '@/assets/icons/close-icon';
import { IconButton } from '@/components/ui/Button';
import { Context } from './context';
import type { DialogControlProps, DialogInnerProps, DialogOuterProps } from './types';

export { useDialogContext, useDialogControl } from './context';
export type { DialogControlProps, DialogOuterProps, DialogInnerProps } from './types';

const FADE_OUT_DURATION = 150;

const stopPropagation = (e: { stopPropagation: () => void }) => e.stopPropagation();

const ClosingContext = createContext(false);

export function Outer({
  children,
  control,
  onClose,
  testID,
  webOptions,
}: React.PropsWithChildren<DialogOuterProps>) {
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const closeCallbackRef = useRef<(() => void) | undefined>(undefined);

  const open = useCallback(() => {
    setIsClosing(false);
    setIsOpen(true);
  }, []);

  const close = useCallback<DialogControlProps['close']>((cb) => {
    if (cb && typeof cb === 'function') {
      closeCallbackRef.current = cb;
    }
    setIsClosing(true);
  }, []);

  useEffect(() => {
    if (!isClosing) return;

    const timer = setTimeout(() => {
      setIsOpen(false);
      setIsClosing(false);
      try {
        closeCallbackRef.current?.();
      } catch (e) {
        console.error('Dialog close callback error:', e);
      }
      closeCallbackRef.current = undefined;
      onClose?.();
    }, FADE_OUT_DURATION);

    return () => clearTimeout(timer);
  }, [isClosing, onClose]);

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
        <ClosingContext.Provider value={isClosing}>
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
              paddingVertical: '10vh' as unknown as number,
              overflowY: 'auto',
            }}
          >
            <Backdrop isClosing={isClosing} />
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
        </ClosingContext.Provider>
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
  const isClosing = useContext(ClosingContext);

  return (
    <View
      role="dialog"
      aria-label={label}
      onStartShouldSetResponder={() => true}
      onResponderRelease={stopPropagation}
      {...({ onClick: stopPropagation } as Record<string, unknown>)}
      style={[
        {
          position: 'relative',
          borderRadius: 10,
          width: '100%',
          maxWidth: 600,
          backgroundColor: theme.colors.background,
          borderWidth: 1,
          borderColor: theme.isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)',
          shadowColor: '#000',
          shadowOpacity: theme.isDark ? 0.4 : 0.1,
          shadowRadius: 30,
          shadowOffset: { width: 0, height: 4 },
          overflow: 'hidden',
        },
        isClosing
          ? { animation: `dialogZoomFadeOut ease-in ${FADE_OUT_DURATION}ms forwards` } as ViewStyle
          : { animation: 'dialogZoomFadeIn cubic-bezier(0.16, 1, 0.3, 1) 0.3s' } as ViewStyle,
        style,
      ]}
    >
      {header}
      <View style={[{ padding: 20 }, contentContainerStyle]}>
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
  const theme = useTheme();

  return (
    <View
      style={{
        position: 'absolute',
        top: 10,
        right: 10,
        zIndex: 10,
      }}
    >
      <IconButton
        variant="icon"
        onPress={() => close()}
        style={{
          width: 34,
          height: 34,
          borderRadius: 17,
          backgroundColor: theme.isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <CloseIcon size={18} />
      </IconButton>
    </View>
  );
}

function Backdrop({ isClosing }: { isClosing: boolean }) {
  const style: ViewStyle[] = [
    {
      position: 'fixed' as 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.8)',
    },
    isClosing
      ? { animation: `dialogFadeOut ease-in ${FADE_OUT_DURATION}ms forwards` } as ViewStyle
      : { animation: 'dialogFadeIn ease-out 0.15s' } as ViewStyle,
  ];

  return <View style={style} />;
}
