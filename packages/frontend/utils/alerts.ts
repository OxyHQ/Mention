import { Platform } from "react-native";
import { showConfirmPrompt } from "@/components/common/ConfirmPrompt";

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
  // Use the in-app bottom sheet prompt on all platforms
  return showConfirmPrompt(options);
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
