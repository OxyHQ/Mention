import { showFediverseInfo } from "@/components/Fediverse/FediverseInfoDialog";
import { SettingsSelect } from "@/components/settings/SettingsSelect";
import { WEB_BASE_URL } from "@/config";
import {
  CONTENT_LANGUAGES,
  describeContentLanguage,
} from "@/constants/contentLanguages";
import { useSettingsRouter as useRouter } from "@/context/MentionSettingsContext";
import { useFediversePreferredLanguage } from "@/hooks/useFediversePreferredLanguage";
import { confirmDialog } from "@/utils/alerts";
import { api } from "@/utils/api";
import { Button } from "@oxy.so/bloom/button";
import { Loading } from "@oxy.so/bloom/loading";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@oxy.so/bloom/settings-modal";
import { Switch } from "@oxy.so/bloom/switch";
import { toast } from "@oxy.so/bloom/toast";
import { createLogger } from "@oxy.so/core/logger";
import { OxyAuthPrompt, useAuth } from "@oxy.so/services/ui/client";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";

const logger = createLogger("FediverseSettings");

/**
 * The one door to everything fediverse in settings: sharing, the language your
 * posts are published under, your node, and how to read the moderation policy.
 * Anything federation-related that grows a screen of its own belongs under
 * `settings/fediverse/`, not beside this row in the settings index.
 *
 * Mounted only once auth is resolved and a private bearer is available, so it
 * reads the current sharing flag straight off the resolved user (no fetch, no
 * effect). Turning sharing off requires a confirm; both directions
 * optimistically update and revert if the Oxy write fails.
 */
function FediverseSharingBody() {
  const { t } = useTranslation();
  const router = useRouter();
  const { user, oxyServices } = useAuth();
  const { preferredLanguage, updatePreferredLanguage } =
    useFediversePreferredLanguage();

  const [sharing, setSharing] = useState<boolean>(
    user?.fediverseSharing !== false,
  );
  const [pending, setPending] = useState(false);

  const preferredLabel = preferredLanguage
    ? describeContentLanguage(preferredLanguage).nativeName
    : t("fediverse.settings.preferredLanguage.automatic", {
        defaultValue: "Automatic",
      });

  const applyPreferred = useCallback(
    async (tag: string | null) => {
      try {
        await updatePreferredLanguage(tag);
      } catch (error) {
        logger.error("Failed to update fediverse preferred language", error);
        toast(
          t("fediverse.settings.updateFailed", {
            defaultValue:
              "Couldn't update fediverse sharing. Please try again.",
          }),
          { type: "error" },
        );
      }
    },
    [updatePreferredLanguage, t],
  );

  const federatedHandle = user?.username
    ? `@${user.username}@${new URL(WEB_BASE_URL).host}`
    : undefined;

  const applyChange = useCallback(
    async (value: boolean) => {
      setSharing(value);
      setPending(true);
      try {
        await oxyServices.updatePrivacySettings({ fediverseSharing: value });
      } catch (error) {
        logger.error("Failed to update fediverse sharing preference", error);
        setSharing(!value);
        setPending(false);
        toast(
          t("fediverse.settings.updateFailed", {
            defaultValue:
              "Couldn't update fediverse sharing. Please try again.",
          }),
          { type: "error" },
        );
        return;
      }
      // Best-effort backend notify: queues remote cleanup when turning off and
      // re-reads the flag from Oxy itself, so it takes no body. One retry.
      try {
        await api.post("/federation/sharing-changed");
      } catch {
        try {
          await api.post("/federation/sharing-changed");
        } catch (retryError) {
          logger.warn("sharing-changed notify failed after retry", {
            error: retryError,
          });
        }
      }
      setPending(false);
    },
    [oxyServices, t],
  );

  const onToggle = useCallback(
    async (value: boolean) => {
      if (!value) {
        const confirmed = await confirmDialog({
          title: t("fediverse.settings.disableConfirm.title"),
          message: t("fediverse.settings.disableConfirm.message"),
          okText: t("fediverse.settings.disableConfirm.confirm"),
          cancelText: t("common.cancel"),
          destructive: true,
        });
        if (!confirmed) return;
      }
      await applyChange(value);
    },
    [applyChange, t],
  );

  const openInfoSheet = useCallback(() => {
    showFediverseInfo({
      showEnableCta: !sharing,
      onEnable: () => {
        void applyChange(true);
      },
    });
  }, [applyChange, sharing]);

  return (
    <View className="gap-4">
      <SettingsSection description={t("fediverse.settings.description")}>
        <SettingsCard>
          <SettingsRow
            label={t("fediverse.settings.share")}
            description={federatedHandle}
          >
            {
              <Switch
                value={sharing}
                onValueChange={onToggle}
                disabled={pending}
              />
            }
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        description={t("fediverse.settings.preferredLanguage.description", {
          defaultValue:
            "The main language your posts are written in. It becomes the primary version shown across the fediverse; leave it automatic to let it be detected per post.",
        })}
      >
        <SettingsCard>
          <SettingsRow
            label={t("fediverse.settings.preferredLanguage.title", {
              defaultValue: "Preferred language",
            })}
            description={preferredLabel}
          >
            <SettingsSelect
              label={t("fediverse.settings.preferredLanguage.title", {
                defaultValue: "Preferred language",
              })}
              value={preferredLanguage ?? "automatic"}
              items={[
                {
                  value: "automatic",
                  label: t("fediverse.settings.preferredLanguage.automatic", {
                    defaultValue: "Automatic",
                  }),
                },
                ...CONTENT_LANGUAGES.map((language) => ({
                  value: language.tag,
                  label: language.nativeName,
                })),
                ...(preferredLanguage &&
                !CONTENT_LANGUAGES.some(
                  (language) => language.tag === preferredLanguage,
                )
                  ? [{ value: preferredLanguage, label: preferredLabel }]
                  : []),
              ]}
              onChange={(value) => {
                void applyPreferred(value === "automatic" ? null : value);
              }}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection>
        <SettingsCard>
          <SettingsRow
            label={t("settings.node.title", {
              defaultValue: "Your Mention node",
            })}
            description={t("settings.node.description", {
              defaultValue: "Your own copy of your signed posts",
            })}
          >
            <Button
              size="small"
              appearance="subtle"
              tone="neutral"
              onPress={() => router.push("/settings/fediverse/node")}
              accessibilityLabel={t("settings.node.title", {
                defaultValue: "Your Mention node",
              })}
            >
              {t("common.open", { defaultValue: "Open" })}
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection>
        <SettingsCard>
          <SettingsRow label={t("fediverse.settings.whatIs")}>
            <Button
              size="small"
              appearance="subtle"
              tone="neutral"
              onPress={openInfoSheet}
              accessibilityLabel={t("fediverse.settings.whatIs")}
            >
              {t("common.open", { defaultValue: "Open" })}
            </Button>
          </SettingsRow>
          <SettingsRow
            label={t("transparency.title")}
            description={t("transparency.list.title")}
          >
            <Button
              size="small"
              appearance="subtle"
              tone="neutral"
              onPress={() => router.push("/transparency")}
              accessibilityLabel={t("transparency.title")}
            >
              {t("common.open", { defaultValue: "Open" })}
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

export default function FediverseSettingsScreen() {
  const { t } = useTranslation();

  const { isAuthResolved, canUsePrivateApi, isPrivateApiPending } = useAuth();

  return (
    <View className="gap-4">
      {!isAuthResolved || isPrivateApiPending ? (
        <View className="flex-1 items-center justify-center">
          <Loading />
        </View>
      ) : !canUsePrivateApi ? (
        <OxyAuthPrompt
          label={t("fediverse.settings.signInRequired", {
            defaultValue: "Sign in to manage fediverse sharing",
          })}
          description={t("fediverse.settings.signInRequiredDesc", {
            defaultValue:
              "Control whether your profile and posts are shared across the fediverse.",
          })}
        />
      ) : (
        <FediverseSharingBody />
      )}
    </View>
  );
}
