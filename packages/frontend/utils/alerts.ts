import { confirm } from "@oxy.so/bloom/surfaces";

export interface ConfirmOptions {
  title: string;
  message?: string;
  okText?: string;
  cancelText?: string;
  destructive?: boolean;
}

export interface AlertOptions {
  title: string;
  message?: string;
  okText?: string;
}

/**
 * Ask a yes/no question through Bloom's imperative surface stack (the one
 * `<SurfaceHost />` mounted in AppProviders). Resolves `false` when the reader
 * cancels or dismisses it.
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const { title, message, okText, cancelText, destructive } = options;
  return confirm({
    title,
    description: message || undefined,
    confirmLabel: okText,
    cancelLabel: cancelText,
    destructive,
  });
}

/**
 * Show a one-button notice. A single-action `confirm` rather than Bloom's
 * `alert()`: `confirm` resolves on a backdrop/Escape/back dismissal too, so the
 * caller's `await` never hangs.
 */
export async function alertDialog(options: AlertOptions): Promise<void> {
  const { title, message, okText = "OK" } = options;
  await confirm({
    title,
    description: message || undefined,
    confirmLabel: okText,
    hideCancel: true,
  });
}

// Convenience specialized confirm for destructive actions
export function confirmDestructive(title: string, message?: string, okText = "Delete", cancelText = "Cancel") {
  return confirmDialog({ title, message, okText, cancelText, destructive: true });
}
