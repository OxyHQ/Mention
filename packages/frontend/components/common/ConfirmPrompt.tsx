import React, { useCallback, useEffect, useRef, useState } from 'react';
import { type GestureResponderEvent } from 'react-native';

import { useDialogControl } from '@/components/Dialog';
import * as Prompt from '@/components/Prompt';
import type { ConfirmOptions } from '@/utils/alerts';

type ConfirmRequest = ConfirmOptions & {
  resolve: (value: boolean) => void;
};

let globalShowConfirm: ((request: ConfirmRequest) => void) | null = null;

/**
 * Show a confirm dialog using the Dialog system.
 * Returns a Promise<boolean> just like the old confirmDialog.
 * Falls back to resolving false if the provider isn't mounted yet.
 */
export function showConfirmPrompt(options: ConfirmOptions): Promise<boolean> {
  if (globalShowConfirm) {
    return new Promise<boolean>((resolve) => {
      globalShowConfirm!({ ...options, resolve });
    });
  }

  return Promise.resolve(false);
}

/**
 * Mount this provider once near the root of the app (inside BottomSheetModalProvider).
 * It renders a Prompt dialog when confirmDialog is called.
 */
export function ConfirmPromptProvider() {
  const control = useDialogControl();
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const requestRef = useRef<ConfirmRequest | null>(null);

  useEffect(() => {
    globalShowConfirm = (req) => {
      requestRef.current = req;
      setRequest(req);
      // Open on next tick so the Prompt component has time to mount with the new request
      setTimeout(() => control.open(), 0);
    };

    return () => {
      globalShowConfirm = null;
    };
  }, [control]);

  const handleConfirm = useCallback((_e: GestureResponderEvent) => {
    requestRef.current?.resolve(true);
    requestRef.current = null;
  }, []);

  const handleClose = useCallback(() => {
    // If dismissed without explicit confirm, treat as cancel
    if (requestRef.current) {
      requestRef.current.resolve(false);
      requestRef.current = null;
    }
    setRequest(null);
  }, []);

  return (
    <Prompt.Outer control={control} testID="confirmModal" onClose={handleClose}>
      {request && (
        <>
          <Prompt.Content>
            <Prompt.TitleText>{request.title}</Prompt.TitleText>
            {request.message && (
              <Prompt.DescriptionText>{request.message}</Prompt.DescriptionText>
            )}
          </Prompt.Content>
          <Prompt.Actions>
            <Prompt.Action
              cta={request.okText}
              onPress={handleConfirm}
              color={request.destructive ? 'negative' : 'primary'}
              testID="confirmBtn"
            />
            <Prompt.Cancel cta={request.cancelText} />
          </Prompt.Actions>
        </>
      )}
    </Prompt.Outer>
  );
}
