import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { DialogControlProps } from "@oxy.so/bloom/dialog";
import { SettingsModal } from "@oxy.so/bloom/settings-modal";
import { useMentionSettingsPages } from "./settingsPages";

export interface MentionSettingsModalProps {
  control: DialogControlProps;
  /** Bumped by every `open()`; each new value opens the dialog. */
  openRequest: number;
  page: string;
  initialView: "navigation" | "page";
  onPageChange: (page: string) => void;
  onClose: () => void;
}

/**
 * The settings dialog and every page in it. `MentionSettingsProvider` loads this
 * module on the first open request, so none of it is in the startup bundle.
 *
 * The pages (`settingsPages`) are static imports on purpose: they are the only
 * other users of `@oxy.so/bloom/settings-modal`, and a separate `import()` per
 * page would make Metro share that module between chunks and hoist it into
 * `__common`, which every page load downloads.
 */
export default function MentionSettingsModal({
  control,
  openRequest,
  page,
  initialView,
  onPageChange,
  onClose,
}: MentionSettingsModalProps) {
  const { t } = useTranslation();
  const { pages, groups } = useMentionSettingsPages();
  // Runs after this module's first commit too, so the request that loaded it
  // opens it: the dialog's imperative handle is attached by then.
  useEffect(() => {
    if (openRequest) control.open();
  }, [openRequest, control]);
  return (
    <SettingsModal
      initialView={initialView}
      control={control}
      page={page}
      defaultPage={page}
      onPageChange={onPageChange}
      onClose={onClose}
      groups={groups}
      pages={pages}
      labels={{
        dialog: t("settings.title", { defaultValue: "Settings" }),
        close: t("common.close", { defaultValue: "Close settings" }),
        back: t("common.back", { defaultValue: "Back" }),
      }}
    />
  );
}
