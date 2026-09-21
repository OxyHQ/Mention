import { EmptyState } from "@/components/common/EmptyState";
import { viewerQueryKeys } from "@/lib/viewerQueryKeys";
import {
  isHashtagMuteWord,
  muteWordDisplayValue,
  muteWordsService,
  type SerializedMuteWord,
} from "@/services/muteWordsService";
import { invalidateSafetyFilters } from "@/stores/safetyInvalidation";
import { getErrorMessage } from "@/utils/apiError";
import { Admonition } from "@oxy.so/bloom/admonition";
import { Button } from "@oxy.so/bloom/button";
import { RiAddCircleLine } from '@oxy.so/bloom/icons/RiAddCircleLine';
import { RiEyeOffLine } from '@oxy.so/bloom/icons/RiEyeOffLine';
import { Loading } from "@oxy.so/bloom/loading";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
} from "@oxy.so/bloom/settings-modal";
import { confirm as confirmSettingsAction } from "@oxy.so/bloom/surfaces";
import { TextFieldInput } from "@oxy.so/bloom/text-field";
import { useTheme } from "@oxy.so/bloom/theme";
import { toast } from "@oxy.so/bloom/toast";
import { createLogger } from "@oxy.so/core/logger";
import { OxyAuthPrompt, useAuth } from "@oxy.so/services/ui/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";

const hiddenWordsLogger = createLogger("HiddenWords");

export default function HiddenWordsScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const { isAuthenticated, user, canUsePrivateApi } = useAuth();

  const queryClient = useQueryClient();
  const [input, setInput] = useState("");

  const {
    data: mutedWords = [],
    isLoading,
    isError,
    refetch,
  } = useQuery<SerializedMuteWord[]>({
    queryKey: viewerQueryKeys.muteWords(user?.id),
    queryFn: () => muteWordsService.list(),
    enabled: canUsePrivateApi,
  });

  const addMutation = useMutation<SerializedMuteWord, unknown, string>({
    mutationFn: (rawInput: string) => muteWordsService.create(rawInput),
    onSuccess: () => {
      setInput("");
      queryClient.invalidateQueries({
        queryKey: viewerQueryKeys.muteWords(user?.id),
      });
      // Muting decides what the SERVER sends, so every surface holding
      // content fetched under the old rules is now wrong. One authority
      // tells both read caches: `stores/safetyInvalidation`.
      invalidateSafetyFilters();
      toast(t("settings.privacy.wordMuted", { defaultValue: "Word muted" }), {
        type: "success",
      });
    },
    onError: (error) => {
      hiddenWordsLogger.error("Failed to add muted word", error);
      toast(
        getErrorMessage(
          error,
          t("settings.privacy.failedToMuteWord", {
            defaultValue: "Failed to mute word",
          }),
        ),
        {
          type: "error",
        },
      );
    },
  });

  const removeMutation = useMutation<void, unknown, string>({
    mutationFn: (id: string) => muteWordsService.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: viewerQueryKeys.muteWords(user?.id),
      });
      // Unmuting can only be honoured by asking again: the posts it lets
      // back in were never sent to this device.
      invalidateSafetyFilters();
      toast(
        t("settings.privacy.wordUnmuted", { defaultValue: "Word unmuted" }),
        { type: "success" },
      );
    },
    onError: (error) => {
      hiddenWordsLogger.error("Failed to remove muted word", error);
      toast(
        getErrorMessage(
          error,
          t("settings.privacy.failedToUnmuteWord", {
            defaultValue: "Failed to unmute word",
          }),
        ),
        { type: "error" },
      );
    },
  });

  const handleAdd = () => {
    const value = input.trim();
    if (!value || addMutation.isPending) return;
    addMutation.mutate(value);
  };

  const handleRemove = (word: SerializedMuteWord) => {
    void confirmSettingsAction({
      title: t("settings.privacy.removeMutedWord", {
        defaultValue: "Remove muted word",
      }),
      description: t("settings.privacy.removeMutedWordConfirm", {
        defaultValue: 'Stop hiding posts containing "{{value}}"?',
        value: muteWordDisplayValue(word),
      }),
      confirmLabel: t("common.remove", { defaultValue: "Remove" }),
      cancelLabel: t("common.cancel"),
      destructive: true,
    }).then((confirmed) => {
      if (confirmed) void (() => removeMutation.mutate(word.id))();
    });
  };

  if (!isAuthenticated) {
    return (
      <View className="gap-4">
        <OxyAuthPrompt
          label={t("settings.privacy.hiddenWordsSignInRequired", {
            defaultValue: "Sign in to manage muted words",
          })}
          description={t("settings.privacy.hiddenWordsSignInRequiredDesc", {
            defaultValue:
              "Muted words and hashtags hide matching posts from your feeds.",
          })}
        />
      </View>
    );
  }

  return (
    <View className="gap-4">
      <View className="gap-4">
        <View className="mb-4">
          <Admonition type="info">
            {t("settings.privacy.hiddenWordsDescription", {
              defaultValue:
                "Posts containing these words or hashtags are hidden from your feeds. Start an entry with # to mute a hashtag.",
            })}
          </Admonition>
        </View>

        <SettingsSection
          label={t("settings.privacy.addMutedWord", {
            defaultValue: "Add a word or hashtag",
          })}
        >
          <SettingsCard>
            <View className="px-4 py-3 flex-row items-center gap-3">
              <RiEyeOffLine size="md" fill={colors.textSecondary} />
              <TextFieldInput
                value={input}
                onValueChange={setInput}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={t("settings.privacy.addWordPlaceholder", {
                  defaultValue: "Word or #hashtag",
                })}
                editable={!addMutation.isPending}
                onSubmitEditing={handleAdd}
                returnKeyType="done"
                label={t("settings.privacy.addWordPlaceholder", {
                  defaultValue: "Word or #hashtag",
                })}
              />
              {addMutation.isPending ? (
                <Loading
                  className="text-primary"
                  variant="inline"
                  size="small"
                  style={{ flex: undefined }}
                />
              ) : (
                <Button
                  size="small"
                  appearance="subtle"
                  tone="neutral"
                  onPress={handleAdd}
                  disabled={input.trim().length === 0}
                  accessibilityLabel={t("settings.privacy.addMutedWord", {
                    defaultValue: "Add a word or hashtag",
                  })}
                >
                  <RiAddCircleLine
                    width={26}
                    height={26}
                    fill={
                      input.trim().length === 0
                        ? colors.textSecondary
                        : colors.primary
                    }
                  />
                </Button>
              )}
            </View>
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          label={t("settings.privacy.mutedWords", {
            defaultValue: "Muted words and hashtags",
          })}
        >
          <SettingsCard>
            {isLoading ? (
              <View className="py-10 items-center">
                <Loading
                  className="text-primary"
                  size="large"
                  style={{ flex: undefined }}
                />
              </View>
            ) : isError ? (
              <View className="py-4">
                <EmptyState
                  title={t("settings.privacy.failedToLoadMutedWords", {
                    defaultValue: "Failed to load muted words",
                  })}
                  icon={{ name: "alert-circle-outline", size: 48 }}
                  error={{
                    title: t("settings.privacy.failedToLoadMutedWords", {
                      defaultValue: "Failed to load muted words",
                    }),
                    message: t("common.tryAgain", {
                      defaultValue: "Try again",
                    }),
                    onRetry: async () => {
                      await refetch();
                    },
                  }}
                />
              </View>
            ) : mutedWords.length === 0 ? (
              <View className="py-4">
                <EmptyState
                  title={t("settings.privacy.mutedWordsEmpty", {
                    defaultValue: "No muted words yet",
                  })}
                  icon={{ name: "eye-off-outline", size: 48 }}
                />
              </View>
            ) : (
              mutedWords.map((word) => {
                const isHashtag = isHashtagMuteWord(word);
                return (
                  <SettingsRow
                    label={muteWordDisplayValue(word)}
                    description={
                      isHashtag
                        ? t("settings.privacy.mutedWordTypeHashtag", {
                            defaultValue: "Hashtag",
                          })
                        : t("settings.privacy.mutedWordTypeWord", {
                            defaultValue: "Word",
                          })
                    }
                    key={word.id}
                  >
                    {
                      <Button
                        size="small"
                        appearance="subtle"
                        tone="danger"
                        onPress={() => handleRemove(word)}
                        accessibilityLabel={t(
                          "settings.privacy.removeMutedWord",
                          {
                            defaultValue: "Remove muted word",
                          },
                        )}
                      >
                        {t("common.remove", { defaultValue: "Remove" })}
                      </Button>
                    }
                  </SettingsRow>
                );
              })
            )}
          </SettingsCard>
        </SettingsSection>
      </View>
    </View>
  );
}
