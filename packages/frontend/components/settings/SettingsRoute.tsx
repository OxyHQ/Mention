import { useMentionSettings } from "@/context/MentionSettingsContext";
import { useRouter } from "expo-router";
import { useEffect,useRef } from "react";

/**
 * The web address of a settings page. Settings content belongs to the shared
 * modal; on native a settings link never reaches this screen — it is
 * intercepted in `app/+native-intent.tsx` (see `settingsRoutes.ts`).
 */
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
