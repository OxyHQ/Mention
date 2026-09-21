import { createContext, useCallback, useContext } from "react";

export interface MentionSettingsActions {
  open: (page?: string) => void;
  close: () => void;
  page: string;
  navigate: (route: string) => void;
  afterClose: (action: () => void) => void;
}
export const MentionSettingsContext =
  createContext<MentionSettingsActions | null>(null);
export function useMentionSettings() {
  const value = useContext(MentionSettingsContext);
  if (!value) throw new Error("MentionSettingsProvider is missing");
  return value;
}
export function useSettingsRouter() {
  const { navigate, close } = useMentionSettings();
  return {
    push: navigate,
    replace: navigate,
    navigate,
    back: close,
    canGoBack: () => true,
  };
}
export function useSettingsBack() {
  const { open, page } = useMentionSettings();
  return useCallback(
    () =>
      open(
        page.includes("/") ? page.slice(0, page.lastIndexOf("/")) : "account",
      ),
    [open, page],
  );
}
