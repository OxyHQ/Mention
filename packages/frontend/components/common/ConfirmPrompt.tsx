import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Dialog, useDialogControl, type DialogAction } from '@oxyhq/bloom/dialog';
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
      globalShowConfirm?.({ ...options, resolve });
    });
  }

  return Promise.resolve(false);
}

/**
 * Mount this provider once near the root of the app.
 * It renders a Dialog when confirmDialog is called.
 */
export function ConfirmPromptProvider() {
  const control = useDialogControl();
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const requestRef = useRef<ConfirmRequest | null>(null);
  const resolvedRef = useRef(false);

  useEffect(() => {
    globalShowConfirm = (req) => {
      requestRef.current = req;
      resolvedRef.current = false;
      setRequest(req);
      // Open on next tick so the Dialog component has time to mount with the new request
      setTimeout(() => control.open(), 0);
    };

    return () => {
      globalShowConfirm = null;
    };
  }, [control]);

  const handleConfirm = useCallback(() => {
    if (requestRef.current && !resolvedRef.current) {
      resolvedRef.current = true;
      requestRef.current.resolve(true);
      requestRef.current = null;
    }
  }, []);

  const handleClose = useCallback(() => {
    // If dismissed without explicit confirm, treat as cancel
    if (requestRef.current && !resolvedRef.current) {
      resolvedRef.current = true;
      requestRef.current.resolve(false);
      requestRef.current = null;
    }
    setRequest(null);
  }, []);

  const actions = useMemo<DialogAction[] | undefined>(() => {
    if (!request) return undefined;
    return [
      {
        label: request.okText ?? 'OK',
        onPress: handleConfirm,
        color: request.destructive ? 'destructive' : 'default',
        testID: 'confirmBtn',
      },
      {
        label: request.cancelText ?? 'Cancel',
        color: 'cancel',
      },
    ];
  }, [request, handleConfirm]);

  return (
    <Dialog
      control={control}
      testID="confirmModal"
      onClose={handleClose}
      title={request?.title}
      description={request?.message}
      actions={actions}
    />
  );
}
