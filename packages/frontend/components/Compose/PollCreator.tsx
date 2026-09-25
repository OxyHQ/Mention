import React, { useRef } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from '@oxy.so/bloom/theme';
import { Card } from '@oxy.so/bloom/card';
import { InputGroup, InputGroupAddon } from '@oxy.so/bloom/input-group';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useTranslation } from "react-i18next";
import { PollIcon } from "@/assets/icons/poll-icon";
import { CloseIcon } from "@/assets/icons/close-icon";
import { Plus } from "@/assets/icons/plus-icon";
import { HIT_SLOP_MD } from '@/styles/hitSlop';

interface PollCreatorProps {
    pollTitle: string;
    pollOptions: string[];
    onTitleChange: (title: string) => void;
    onOptionChange: (index: number, value: string) => void;
    onAddOption: () => void;
    onRemoveOption: (index: number) => void;
    onRemove: () => void;
    style?: StyleProp<ViewStyle>;
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
        <Card border="thin" radius="radius-12" style={[styles.pollCreator, style]}>
            <View className="flex-row justify-between items-center mb-2.5">
                <View className="flex-row items-center gap-1.5">
                    <PollIcon size={18} className="text-primary" />
                    <Text className="text-[15px] font-bold text-foreground">
                        {t("Create a poll")}
                    </Text>
                </View>
                <TouchableOpacity
                    onPress={onRemove}
                    className="p-1"
                    hitSlop={HIT_SLOP_MD}
                >
                    <CloseIcon size={18} className="text-muted-foreground" />
                </TouchableOpacity>
            </View>

            <Textarea
                inputRef={pollTitleInputRef}
                accessibilityLabel={t("Poll question")}
                placeholder={t("Poll question")}
                value={pollTitle}
                onChangeText={onTitleChange}
                maxLength={200}
                showCount
                rows={1}
                autoResize
                maxRows={4}
                style={{ marginBottom: 10 }}
            />

            <View className="mb-2 gap-2">
                {pollOptions.map((option, index) => (
                    <InputGroup key={index}>
                        <InputGroupAddon>
                            <View className="w-6 h-6 rounded-full items-center justify-center bg-muted">
                                <Text className="text-xs font-bold text-muted-foreground">
                                    {index + 1}
                                </Text>
                            </View>
                        </InputGroupAddon>
                        <TextFieldInput
                            label={t(`Option ${index + 1}`)}
                            value={option}
                            onChangeText={(value) => onOptionChange(index, value)}
                            maxLength={50}
                        />
                        {pollOptions.length > 2 && (
                            <InputGroupAddon>
                                <TouchableOpacity
                                    onPress={() => onRemoveOption(index)}
                                    className="p-1"
                                    hitSlop={HIT_SLOP_MD}
                                    accessibilityRole="button"
                                    accessibilityLabel={t("common.remove", { defaultValue: "Remove" })}
                                >
                                    <CloseIcon size={16} className="text-muted-foreground" />
                                </TouchableOpacity>
                            </InputGroupAddon>
                        )}
                    </InputGroup>
                ))}
            </View>

            {pollOptions.length < 4 && (
                <TouchableOpacity
                    className="flex-row items-center gap-2 py-2.5 px-3 rounded-[10px] border-[1.5px] border-dashed border-border mb-1.5"
                    onPress={onAddOption}
                    activeOpacity={0.7}
                >
                    <View className="w-6 h-6 rounded-full items-center justify-center bg-muted">
                        <Plus size={16} className="text-primary" />
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
        </Card>
    );
};

const styles = StyleSheet.create({
    pollCreator: {
        padding: 12,
        marginTop: 12,
        marginRight: 12,
    },
});
