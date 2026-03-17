import React from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from "react-i18next";
import { PollIcon } from "@/assets/icons/poll-icon";
import { CloseIcon } from "@/assets/icons/close-icon";
import { BackArrowIcon } from "@/assets/icons/back-arrow-icon";
import { ChevronRightIcon } from "@/assets/icons/chevron-right-icon";
import { MEDIA_CARD_WIDTH } from "@/utils/composeUtils";
import { cn } from "@/lib/utils";

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
        <View className="relative self-start">
            {showReorderControls && (
                <View className="absolute left-2 right-2 bottom-2 flex-row justify-between items-center z-[2]" style={{ pointerEvents: 'box-none' }}>
                    <TouchableOpacity
                        onPress={onMoveLeft}
                        disabled={!canMoveLeft}
                        className={cn(
                            "rounded-full p-1.5 bg-background",
                            !canMoveLeft && "opacity-40"
                        )}
                    >
                        <BackArrowIcon
                            size={14}
                            color={!canMoveLeft ? theme.colors.textTertiary : theme.colors.textSecondary}
                        />
                    </TouchableOpacity>
                    <TouchableOpacity
                        onPress={onMoveRight}
                        disabled={!canMoveRight}
                        className={cn(
                            "rounded-full p-1.5 bg-background",
                            !canMoveRight && "opacity-40"
                        )}
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
                <View className="flex-row items-center justify-between gap-3">
                    <View className="flex-row items-center gap-1.5 px-2.5 py-1 rounded-full bg-background">
                        <PollIcon size={16} className="text-primary" />
                        <Text className="text-xs font-semibold uppercase tracking-wide text-primary">
                            {t("compose.poll.title", { defaultValue: "Poll" })}
                        </Text>
                    </View>
                    <Text className="text-xs font-medium text-muted-foreground">
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

                <Text className="text-base font-bold text-foreground" numberOfLines={2}>
                    {pollTitle.trim() ||
                        t("compose.poll.placeholderQuestion", { defaultValue: "Ask a question..." })}
                </Text>

                <View className="gap-2">
                    {(pollOptions.length > 0 ? pollOptions : ["", ""]).slice(0, 2).map((option, index) => {
                        const trimmed = option?.trim?.() || "";
                        return (
                            <View
                                key={`poll-opt-${index}`}
                                className="border border-border bg-background rounded-[10px] px-3 py-2.5"
                            >
                                <Text className="text-[13px] font-medium text-muted-foreground" numberOfLines={1}>
                                    {trimmed ||
                                        t("compose.poll.optionPlaceholder", {
                                            defaultValue: `Option ${index + 1}`,
                                        })}
                                </Text>
                            </View>
                        );
                    })}
                    {pollOptions.length > 2 && (
                        <Text style={{ fontSize: 12, fontWeight: "500", color: theme.colors.textTertiary }}>
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
                className="absolute top-2 right-2 rounded-full p-1.5 bg-background"
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
                <CloseIcon size={16} className="text-foreground" />
            </TouchableOpacity>
        </View>
    );
};

const styles = StyleSheet.create({
    card: {
        width: MEDIA_CARD_WIDTH,
        minHeight: 150,
        borderRadius: 15,
        borderWidth: 1,
        padding: 16,
        gap: 12,
    },
});
