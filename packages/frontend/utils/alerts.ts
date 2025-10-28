import { Platform } from "react-native";

type ButtonStyle = "default" | "cancel" | "destructive";

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

export async function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  const { title, message = "", okText = "OK", cancelText = "Cancel", destructive = false } = options;

  if (Platform.OS === "web") {
    // Use native browser confirm for simplicity and reliability
    const text = message ? `${title}\n\n${message}` : title;
    return Promise.resolve(window.confirm(text));
  }

  // Native platforms: wrap Alert in a Promise
  return new Promise<boolean>((resolve) => {
    const { Alert } = require("react-native");
    const buttons: Array<{ text: string; style?: ButtonStyle; onPress?: () => void }> = [
      { text: cancelText, style: "cancel", onPress: () => resolve(false) },
      { text: okText, style: destructive ? "destructive" : "default", onPress: () => resolve(true) },
    ];
    Alert.alert(title, message, buttons, { cancelable: true, onDismiss: () => resolve(false) });
  });
}

export async function alertDialog(options: AlertOptions): Promise<void> {
  const { title, message = "", okText = "OK" } = options;
  if (Platform.OS === "web") {
    window.alert(message ? `${title}\n\n${message}` : title);
    return;
  }
  return new Promise<void>((resolve) => {
    const { Alert } = require("react-native");
    Alert.alert(title, message, [{ text: okText, onPress: () => resolve() }], {
      cancelable: true,
      onDismiss: () => resolve(),
    });
  });
}

// Convenience specialized confirm for destructive actions
export function confirmDestructive(title: string, message?: string, okText = "Delete", cancelText = "Cancel") {
  return confirmDialog({ title, message, okText, cancelText, destructive: true });
}
