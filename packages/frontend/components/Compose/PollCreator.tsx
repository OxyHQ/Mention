import React, { useRef } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from "react-native";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { PollIcon } from "@/assets/icons/poll-icon";
import { CloseIcon } from "@/assets/icons/close-icon";
import { Plus } from "@/assets/icons/plus-icon";

interface PollCreatorProps {
    pollTitle: string;
    pollOptions: string[];
    onTitleChange: (title: string) => void;
    onOptionChange: (index: number, value: string) => void;
    onAddOption: () => void;
    onRemoveOption: (index: number) => void;
    onRemove: () => void;
    style?: any;
    autoFocus?: boolean;
}

export const PollCreator: React.FC<PollCreatorProps> = ({
    pollTitle,
    pollOptions,
    onTitleChange,
    onOptionChange,
    onAddOption,
    onRemoveOption,
    onRemove,
    style,
    autoFocus = false,
}) => {
    const theme = useTheme();
    const { t } = useTranslation();
    const pollTitleInputRef = useRef<TextInput | null>(null);

    React.useEffect(() => {
        if (autoFocus) {
            setTimeout(() => {
                pollTitleInputRef.current?.focus();
            }, 50);
        }
    }, [autoFocus]);

    return (
        <View
            style={[
                styles.pollCreator,
                {
                    backgroundColor: theme.colors.card,
                    borderColor: theme.colors.border,
                },
                style,
            ]}
        >
            <View className="flex-row justify-between items-center mb-2.5">
                <View className="flex-row items-center gap-1.5">
                    <PollIcon size={18} color={theme.colors.primary} />
                    <Text className="text-[15px] font-bold text-foreground">
                        {t("Create a poll")}
                    </Text>
                </View>
                <TouchableOpacity
                    onPress={onRemove}
                    className="p-1"
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                    <CloseIcon size={18} color={theme.colors.textSecondary} />
                </TouchableOpacity>
            </View>

            <View className="mb-2.5">
                <TextInput
                    className="border-[1.5px] rounded-[10px] px-3 py-2.5 text-sm min-h-[44px] text-foreground bg-secondary"
                    style={{
                        textAlignVertical: "top",
                        borderColor: pollTitle.length > 0 ? theme.colors.primary : theme.colors.border,
                    }}
                    ref={pollTitleInputRef}
                    placeholder={t("Poll question")}
                    placeholderTextColor={theme.colors.textTertiary}
                    value={pollTitle}
                    onChangeText={onTitleChange}
                    maxLength={200}
                    multiline
                />
                <Text style={{ fontSize: 10, marginTop: 4, marginLeft: 2, fontWeight: "500", color: theme.colors.textTertiary }}>
                    {pollTitle.length}/200
                </Text>
            </View>

            <View className="mb-2 gap-2">
                {pollOptions.map((option, index) => (
                    <View key={index} className="flex-row items-center gap-2">
                        <View className="w-6 h-6 rounded-full items-center justify-center shrink-0 bg-secondary">
                            <Text className="text-xs font-bold text-muted-foreground">
                                {index + 1}
                            </Text>
                        </View>
                        <TextInput
                            className="flex-1 border-[1.5px] rounded-[10px] px-3 py-2.5 text-sm min-h-[44px] text-foreground bg-secondary"
                            style={{
                                borderColor: option.length > 0 ? theme.colors.primary : theme.colors.border,
                            }}
                            placeholder={t(`Option ${index + 1}`)}
                            placeholderTextColor={theme.colors.textTertiary}
                            value={option}
                            onChangeText={(value) => onOptionChange(index, value)}
                            maxLength={50}
                        />
                        {pollOptions.length > 2 && (
                            <TouchableOpacity
                                onPress={() => onRemoveOption(index)}
                                className="p-1 shrink-0"
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            >
                                <CloseIcon size={16} color={theme.colors.textSecondary} />
                            </TouchableOpacity>
                        )}
                    </View>
                ))}
            </View>

            {pollOptions.length < 4 && (
                <TouchableOpacity
                    className="flex-row items-center gap-2 py-2.5 px-3 rounded-[10px] border-[1.5px] border-dashed border-border mb-1.5"
                    onPress={onAddOption}
                    activeOpacity={0.7}
                >
                    <View className="w-6 h-6 rounded-full items-center justify-center bg-secondary">
                        <Plus size={16} color={theme.colors.primary} />
                    </View>
                    <Text className="text-sm font-semibold text-primary">
                        {t("Add option")}
                    </Text>
                </TouchableOpacity>
            )}

            <Text style={{ fontSize: 11, marginTop: 2, marginLeft: 2, color: theme.colors.textTertiary }}>
                {pollOptions.length === 2
                    ? t("Add up to 2 more options")
                    : t("Minimum 2 options required")}
            </Text>
        </View>
    );
};

const styles = StyleSheet.create({
    pollCreator: {
        borderRadius: 12,
        padding: 12,
        marginTop: 12,
        borderWidth: 1,
        boxShadow: '0px 2px 8px 0px rgba(0, 0, 0, 0.05)',
        elevation: 2,
        marginRight: 12,
    },
});
