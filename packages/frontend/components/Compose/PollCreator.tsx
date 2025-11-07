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
      <View style={styles.pollHeader}>
        <View style={styles.pollHeaderLeft}>
          <PollIcon size={18} color={theme.colors.primary} />
          <Text style={[styles.pollTitle, { color: theme.colors.text }]}>
            {t("Create a poll")}
          </Text>
        </View>
        <TouchableOpacity
          onPress={onRemove}
          style={styles.pollCloseBtn}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <CloseIcon size={18} color={theme.colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <View style={styles.pollQuestionContainer}>
        <TextInput
          style={[
            styles.pollTitleInput,
            {
              color: theme.colors.text,
              borderColor: pollTitle.length > 0 ? theme.colors.primary : theme.colors.border,
              backgroundColor: theme.colors.backgroundSecondary,
            },
          ]}
          ref={pollTitleInputRef}
          placeholder={t("Poll question")}
          placeholderTextColor={theme.colors.textTertiary}
          value={pollTitle}
          onChangeText={onTitleChange}
          maxLength={200}
          multiline
        />
        <Text style={[styles.pollCharCount, { color: theme.colors.textTertiary }]}>
          {pollTitle.length}/200
        </Text>
      </View>

      <View style={styles.pollOptionsContainer}>
        {pollOptions.map((option, index) => (
          <View key={index} style={styles.pollOptionRow}>
            <View
              style={[
                styles.pollOptionNumber,
                { backgroundColor: theme.colors.backgroundSecondary },
              ]}
            >
              <Text style={[styles.pollOptionNumberText, { color: theme.colors.textSecondary }]}>
                {index + 1}
              </Text>
            </View>
            <TextInput
              style={[
                styles.pollOptionInput,
                {
                  color: theme.colors.text,
                  borderColor: option.length > 0 ? theme.colors.primary : theme.colors.border,
                  backgroundColor: theme.colors.backgroundSecondary,
                },
              ]}
              placeholder={t(`Option ${index + 1}`)}
              placeholderTextColor={theme.colors.textTertiary}
              value={option}
              onChangeText={(value) => onOptionChange(index, value)}
              maxLength={50}
            />
            {pollOptions.length > 2 && (
              <TouchableOpacity
                onPress={() => onRemoveOption(index)}
                style={styles.pollOptionRemoveBtn}
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
          style={[styles.addPollOptionBtn, { borderColor: theme.colors.border }]}
          onPress={onAddOption}
          activeOpacity={0.7}
        >
          <View
            style={[
              styles.addPollOptionIcon,
              { backgroundColor: theme.colors.backgroundSecondary },
            ]}
          >
            <Plus size={16} color={theme.colors.primary} />
          </View>
          <Text style={[styles.addPollOptionText, { color: theme.colors.primary }]}>
            {t("Add option")}
          </Text>
        </TouchableOpacity>
      )}

      <Text style={[styles.pollHint, { color: theme.colors.textTertiary }]}>
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
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
    marginRight: 12,
  },
  pollHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  pollHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  pollTitle: {
    fontSize: 15,
    fontWeight: "700",
  },
  pollCloseBtn: {
    padding: 4,
  },
  pollQuestionContainer: {
    marginBottom: 10,
  },
  pollTitleInput: {
    borderWidth: 1.5,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    minHeight: 44,
    textAlignVertical: "top",
  },
  pollCharCount: {
    fontSize: 10,
    marginTop: 4,
    marginLeft: 2,
    fontWeight: "500",
  },
  pollOptionsContainer: {
    marginBottom: 8,
    gap: 8,
  },
  pollOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  pollOptionNumber: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  pollOptionNumberText: {
    fontSize: 12,
    fontWeight: "700",
  },
  pollOptionInput: {
    flex: 1,
    borderWidth: 1.5,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    minHeight: 44,
  },
  pollOptionRemoveBtn: {
    padding: 4,
    flexShrink: 0,
  },
  addPollOptionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1.5,
    borderStyle: "dashed",
    marginBottom: 6,
  },
  addPollOptionIcon: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  addPollOptionText: {
    fontSize: 14,
    fontWeight: "600",
  },
  pollHint: {
    fontSize: 11,
    marginTop: 2,
    marginLeft: 2,
  },
});
