import {
  useFollowedTopics,
  useTopicFollowTargetId,
  type FollowedTopic,
} from "@/hooks/useTopicFollows";
import { publicQueryKeys } from "@/lib/viewerQueryKeys";
import { topicFollowUri } from "@/services/followGraph";
import { topicService } from "@/services/topicService";
import { Button } from "@oxy.so/bloom/button";
import { Loading } from "@oxy.so/bloom/loading";
import { Search } from "@oxy.so/bloom/search";
import { SettingsCard, SettingsSection } from "@oxy.so/bloom/settings-modal";
import type { TopicData } from "@oxy.so/core";
import { resolveFollowPrimaryAction, useFollowTarget } from "@oxy.so/services";
import { OxyAuthPrompt, useAuth } from "@oxy.so/services/ui/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";

/**
 * Your interests — a searchable grid of topics, where selecting one FOLLOWS it.
 *
 * This screen used to write a list of slugs to `interests.tags` on the profile
 * settings. Nothing read that field: the feed learns topics from behaviour, not
 * from it. A chip now creates a real edge in the user-owned follow graph
 * instead, which every Oxy application shares — so a topic picked here is picked
 * everywhere, and giving it up here gives it up everywhere.
 *
 * `interests.tags` is deliberately left alone rather than migrated or
 * dual-written. Writing both would make two sources of truth for one intention,
 * and whichever one a future reader picked would be a coin flip.
 *
 * The topics are Oxy's (`GET /topics` proxies to the Oxy API) and so is the kind
 * — `oxy.topic` is seeded as a platform kind — so Mention registers nothing at
 * all here. See `services/followGraph.ts`.
 */
export default function InterestsSettingsScreen() {
  const { t } = useTranslation();

  const { canUsePrivateApi, isPrivateApiPending } = useAuth();

  const [query, setQuery] = useState("");
  const trimmedQuery = query.trim();

  /*
   * An empty box shows the curated categories; a query searches the catalogue.
   * ONE query key covers both, because they answer the same question — what
   * should the grid show — and a second key would let the two disagree about
   * which is on screen.
   *
   * Not gated on the viewer: `/topics` is mounted on the public API and the
   * catalogue is the same for everyone. Only the FOLLOW state below is
   * viewer-scoped. Both service calls resolve to an empty list rather than
   * throwing, so the grid always settles.
   */
  const catalogue = useQuery({
    queryKey: publicQueryKeys.topicCatalogue(trimmedQuery),
    queryFn: () =>
      trimmedQuery.length > 0
        ? topicService.search(trimmedQuery, 40)
        : topicService.getCategories(),
    staleTime: 5 * 60 * 1000,
  });

  const followed = useFollowedTopics();
  const topics = useMemo(() => catalogue.data ?? [], [catalogue.data]);

  if (isPrivateApiPending) {
    return (
      <View className="gap-4">
        <View className="flex-1 justify-center items-center">
          <Loading className="text-primary" size="large" />
        </View>
      </View>
    );
  }

  if (!canUsePrivateApi) {
    return (
      <View className="gap-4">
        <OxyAuthPrompt
          label={t("settings.interests.signInRequired", {
            defaultValue: "Sign in to choose your interests",
          })}
          description={t("settings.interests.signInRequiredDesc", {
            defaultValue: "Pick topics so we can tailor your feed.",
          })}
        />
      </View>
    );
  }

  return (
    <View className="gap-4">
      <View className="gap-4">
        <View className="pb-2">
          <Search
            value={query}
            onValueChange={setQuery}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t("settings.interests.searchPlaceholder", {
              defaultValue: "Search topics",
            })}
            accessibilityLabel={t("settings.interests.searchLabel", {
              defaultValue: "Search topics",
            })}
            label={t("settings.interests.searchLabel", {
              defaultValue: "Search topics",
            })}
            onClearText={() => setQuery("")}
          />
        </View>

        <SettingsSection
          label={t("settings.interests.title", {
            defaultValue: "Your interests",
          })}
          description={t("settings.interests.description", {
            defaultValue:
              "Topics you follow shape your feed, and come with you to every Oxy app.",
          })}
        >
          <SettingsCard>
            {catalogue.isLoading ? (
              <View className="py-8 items-center">
                <Loading className="text-primary" size="large" />
              </View>
            ) : topics.length === 0 ? (
              <View className="px-4 py-6">
                <Text className="text-[13px] text-muted-foreground">
                  {trimmedQuery.length > 0
                    ? t("settings.interests.noMatches", {
                        query: trimmedQuery,
                        defaultValue: "No topics match “{{query}}”.",
                      })
                    : t("settings.interests.noTopics", {
                        defaultValue: "No topics are available yet.",
                      })}
                </Text>
              </View>
            ) : (
              <View className="flex-row flex-wrap gap-2 px-4 py-4">
                {topics.map((topic) => (
                  <TopicChip
                    key={topic.slug}
                    topic={topic}
                    seeded={followed.byUri.get(topicFollowUri(topic.slug))}
                    // Until the sweep lands, a chip cannot tell
                    // "not followed" from "not asked yet", and
                    // offering to follow something already
                    // followed is the one mistake this screen
                    // must not make.
                    followsReady={followed.isReady}
                  />
                ))}
              </View>
            )}
          </SettingsCard>
        </SettingsSection>
      </View>
    </View>
  );
}

interface TopicChipProps {
  topic: TopicData;
  seeded: FollowedTopic | undefined;
  followsReady: boolean;
}

/** Binds the shared follow state machine to a Bloom selection control. */
function TopicChip({ topic, seeded, followsReady }: TopicChipProps) {
  const { t } = useTranslation();

  const targetId = useTopicFollowTargetId({
    slug: topic.slug,
    displayName: topic.displayName,
    ...(topic.icon ? { icon: topic.icon } : {}),
    ...(seeded ? { seededTargetId: seeded.targetId } : {}),
  });

  const follow = useFollowTarget(
    targetId,
    seeded ? { initialStatus: seeded.status } : undefined,
  );

  const isOffHere =
    follow.isFollowing && follow.status.applicationMode === "disabled";

  /*
   * The SDK decides WHAT a press means; this only routes its answer to the
   * matching mutation. The middle case is the one worth naming: a follow the
   * viewer switched OFF in Mention still reads as followed globally, so a
   * press turns it back on HERE rather than unfollowing it everywhere and
   * throwing away a relationship they still hold in every other Oxy app.
   *
   * The `never` arm is what keeps this honest as that rule grows: a new action
   * upstream becomes a type error here instead of a press that silently does
   * nothing.
   */
  const onPress = useCallback(() => {
    const action = resolveFollowPrimaryAction({
      isFollowing: follow.isFollowing,
      applicationMode: follow.status.applicationMode,
    });
    switch (action) {
      case "follow":
        void follow.follow();
        return;
      case "enable-here":
        void follow.enableHere();
        return;
      case "unfollow":
        void follow.unfollow();
        return;
      default: {
        const unhandled: never = action;
        throw new Error(`Unhandled follow action: ${String(unhandled)}`);
      }
    }
  }, [follow]);

  /*
   * Inert until BOTH the sweep has settled and a target exists. Pressing
   * earlier would either act on a relationship whose state is not yet known or
   * address a row that does not exist yet.
   */
  const disabled = !followsReady || !targetId || follow.isPending;

  const label = topic.displayName || topic.slug;

  return (
    <Button
      size="small"
      appearance={follow.isFollowing && !isOffHere ? "solid" : "subtle"}
      tone="neutral"
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={
        isOffHere
          ? t("settings.interests.chipOffHere", {
              topic: label,
              defaultValue: "Show {{topic}} in Mention again",
            })
          : follow.isFollowing
            ? t("settings.interests.chipUnfollow", {
                topic: label,
                defaultValue: "Unfollow {{topic}}",
              })
            : t("settings.interests.chipFollow", {
                topic: label,
                defaultValue: "Follow {{topic}}",
              })
      }
      aria-pressed={follow.isFollowing && !isOffHere}
    >
      {label}
    </Button>
  );
}
