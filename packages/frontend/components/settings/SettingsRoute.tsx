import { useMentionSettings } from "@/context/MentionSettingsContext";
import { useRouter } from "expo-router";
import { useEffect,useRef } from "react";

/** Compatibility deep link only. Settings content belongs to the shared modal. */
export function createSettingsRoute(page: string) {
  return function SettingsRoute() {
    const { open } = useMentionSettings();
    const router = useRouter();
    const handled = useRef(false);
    useEffect(() => {
      if (handled.current) return;
      handled.current = true;
      open(page === "account" ? undefined : page);
      if (router.canGoBack()) router.back();
      else router.replace("/");
    }, [open, router]);
    return null;
  };
}
