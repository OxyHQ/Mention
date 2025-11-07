import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { PollIcon } from "@/assets/icons/poll-icon";
import { CloseIcon } from "@/assets/icons/close-icon";
import { BackArrowIcon } from "@/assets/icons/back-arrow-icon";
import { ChevronRightIcon } from "@/assets/icons/chevron-right-icon";
import { MEDIA_CARD_WIDTH } from "@/utils/composeUtils";

interface PollAttachmentCardProps {
  pollTitle: string;
  pollOptions: string[];
  onPress: () => void;
  onRemove: () => void;
  onMoveLeft?: () => void;
  onMoveRight?: () => void;
  canMoveLeft?: boolean;
  canMoveRight?: boolean;
  showReorderControls?: boolean;
}

export const PollAttachmentCard: React.FC<PollAttachmentCardProps> = ({
  pollTitle,
  pollOptions,
  onPress,
  onRemove,
  onMoveLeft,
  onMoveRight,
  canMoveLeft = false,
  canMoveRight = false,
  showReorderControls = false,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();

  return (
    <View style={styles.wrapper}>
      {showReorderControls && (
        <View style={styles.reorderControls} pointerEvents="box-none">
          <TouchableOpacity
            onPress={onMoveLeft}
            disabled={!canMoveLeft}
            style={[
              styles.reorderButton,
              { backgroundColor: theme.colors.background },
              !canMoveLeft && styles.reorderButtonDisabled,
            ]}
          >
            <BackArrowIcon
              size={14}
              color={!canMoveLeft ? theme.colors.textTertiary : theme.colors.textSecondary}
            />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={onMoveRight}
            disabled={!canMoveRight}
            style={[
              styles.reorderButton,
              { backgroundColor: theme.colors.background },
              !canMoveRight && styles.reorderButtonDisabled,
            ]}
          >
            <ChevronRightIcon
              size={14}
              color={!canMoveRight ? theme.colors.textTertiary : theme.colors.textSecondary}
            />
          </TouchableOpacity>
        </View>
      )}

      <TouchableOpacity
        style={[
          styles.card,
          {
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.backgroundSecondary,
          },
        ]}
        activeOpacity={0.85}
        onPress={onPress}
      >
        <View style={styles.header}>
          <View style={[styles.badge, { backgroundColor: theme.colors.background }]}>
            <PollIcon size={16} color={theme.colors.primary} />
            <Text style={[styles.badgeText, { color: theme.colors.primary }]}>
              {t("compose.poll.title", { defaultValue: "Poll" })}
            </Text>
          </View>
          <Text style={[styles.meta, { color: theme.colors.textSecondary }]}>
            {t("compose.poll.optionCount", {
              count: pollOptions.length,
              defaultValue:
                pollOptions.length === 0
                  ? "No options yet"
                  : pollOptions.length === 1
                    ? "1 option"
                    : `${pollOptions.length} options`,
            })}
          </Text>
        </View>

        <Text style={[styles.question, { color: theme.colors.text }]} numberOfLines={2}>
          {pollTitle.trim() ||
            t("compose.poll.placeholderQuestion", { defaultValue: "Ask a question..." })}
        </Text>

        <View style={styles.options}>
          {(pollOptions.length > 0 ? pollOptions : ["", ""]).slice(0, 2).map((option, index) => {
            const trimmed = option?.trim?.() || "";
            return (
              <View
                key={`poll-opt-${index}`}
                style={[
                  styles.option,
                  {
                    borderColor: theme.colors.border,
                    backgroundColor: theme.colors.background,
                  },
                ]}
              >
                <Text style={[styles.optionText, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                  {trimmed ||
                    t("compose.poll.optionPlaceholder", {
                      defaultValue: `Option ${index + 1}`,
                    })}
                </Text>
              </View>
            );
          })}
          {pollOptions.length > 2 && (
            <Text style={[styles.more, { color: theme.colors.textTertiary }]}>
              {t("compose.poll.moreOptions", {
                count: pollOptions.length - 2,
                defaultValue: `+${pollOptions.length - 2} more`,
              })}
            </Text>
          )}
        </View>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={onRemove}
        style={[styles.removeButton, { backgroundColor: theme.colors.background }]}
        hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      >
        <CloseIcon size={16} color={theme.colors.text} />
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  wrapper: {
    position: "relative",
    alignSelf: "flex-start",
  },
  card: {
    width: MEDIA_CARD_WIDTH,
    minHeight: 150,
    borderRadius: 15,
    borderWidth: 1,
    padding: 16,
    gap: 12,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  meta: {
    fontSize: 12,
    fontWeight: "500",
  },
  question: {
    fontSize: 16,
    fontWeight: "700",
  },
  options: {
    gap: 8,
  },
  option: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  optionText: {
    fontSize: 13,
    fontWeight: "500",
  },
  more: {
    fontSize: 12,
    fontWeight: "500",
  },
  removeButton: {
    position: "absolute",
    top: 8,
    right: 8,
    borderRadius: 999,
    padding: 6,
  },
  reorderControls: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    zIndex: 2,
  },
  reorderButton: {
    borderRadius: 999,
    padding: 6,
  },
  reorderButtonDisabled: {
    opacity: 0.4,
  },
});
