import { AliaChatScreen } from "@alia.onl/sdk";
import { useAuth } from "@oxyhq/services";
import React from "react";
import { useTranslation } from "react-i18next";

export default function AiScreen() {
  const { user } = useAuth();
  const { t } = useTranslation();

  return (
    <AliaChatScreen
      welcomeGreeting={`${t("Hello")}, ${user?.username || "there"}.`}
      welcomeSubtitle={t("How can I help you today?")}
      welcomeSuggestions={[
        { label: t("Latest news"), prompt: t("What are the latest news?") },
        { label: t("Edit image"), prompt: t("Help me edit an image") },
      ]}
    />
  );
}
