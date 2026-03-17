import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
} from "react-native";
import { useTheme } from '@oxyhq/bloom/theme';
import { SearchFilters as SearchFiltersType } from "@/services/searchService";
import { SPACING } from "@/styles/spacing";
import { FONT_SIZES } from "@/styles/typography";
import { PrimaryButton, SecondaryButton } from "@/components/ui/Button";

interface SearchFiltersProps {
  filters: SearchFiltersType;
  onApply: (filters: SearchFiltersType) => void;
  onClear: () => void;
  visible: boolean;
}

type MediaTypeOption = 'all' | 'image' | 'video' | 'gif';

export function SearchFilters({ filters, onApply, onClear, visible }: SearchFiltersProps) {
  const theme = useTheme();

  const [dateFrom, setDateFrom] = useState(filters.dateFrom || "");
  const [dateTo, setDateTo] = useState(filters.dateTo || "");
  const [author, setAuthor] = useState(filters.author || "");
  const [minLikes, setMinLikes] = useState(filters.minLikes?.toString() || "");
  const [minReposts, setMinReposts] = useState(filters.minReposts?.toString() || "");
  const [mediaType, setMediaType] = useState<MediaTypeOption>(
    filters.mediaType || (filters.hasMedia ? 'all' : 'all')
  );
  const [language, setLanguage] = useState(filters.language || "");

  const handleApply = useCallback(() => {
    const newFilters: SearchFiltersType = {};

    if (dateFrom) newFilters.dateFrom = dateFrom;
    if (dateTo) newFilters.dateTo = dateTo;
    if (author) newFilters.author = author;
    if (minLikes) newFilters.minLikes = parseInt(minLikes, 10);
    if (minReposts) newFilters.minReposts = parseInt(minReposts, 10);
    if (mediaType !== 'all') {
      newFilters.mediaType = mediaType as 'image' | 'video' | 'gif';
      newFilters.hasMedia = true;
    }
    if (language) newFilters.language = language;

    onApply(newFilters);
  }, [dateFrom, dateTo, author, minLikes, minReposts, mediaType, language, onApply]);

  const handleClearLocal = useCallback(() => {
    setDateFrom("");
    setDateTo("");
    setAuthor("");
    setMinLikes("");
    setMinReposts("");
    setMediaType('all');
    setLanguage("");
    onClear();
  }, [onClear]);

  if (!visible) return null;

  const inputStyle = {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    fontSize: FONT_SIZES.md,
    backgroundColor: theme.colors.backgroundSecondary,
    color: theme.colors.text,
    borderColor: theme.colors.border,
  };

  return (
    <View className="bg-background" style={{ borderTopWidth: 1, borderTopColor: 'rgba(0, 0, 0, 0.1)' }}>
      <ScrollView
        style={{ maxHeight: 500 }}
        contentContainerStyle={{ padding: SPACING.base }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={{ marginBottom: SPACING.base }}>
          <Text
            className="text-foreground font-bold"
            style={{ fontSize: FONT_SIZES.xl }}
          >
            Filters
          </Text>
        </View>

        {/* Date Range */}
        <View style={{ marginBottom: SPACING.lg }}>
          <Text
            className="text-foreground font-semibold"
            style={{ fontSize: FONT_SIZES.md, marginBottom: SPACING.sm }}
          >
            Date Range
          </Text>
          <View className="flex-row" style={{ gap: SPACING.md }}>
            <View className="flex-1">
              <Text
                className="text-muted-foreground"
                style={{ fontSize: FONT_SIZES.sm, marginBottom: SPACING.xs }}
              >
                From
              </Text>
              <TextInput
                style={inputStyle}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={theme.colors.textSecondary}
                value={dateFrom}
                onChangeText={setDateFrom}
              />
            </View>
            <View className="flex-1">
              <Text
                className="text-muted-foreground"
                style={{ fontSize: FONT_SIZES.sm, marginBottom: SPACING.xs }}
              >
                To
              </Text>
              <TextInput
                style={inputStyle}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={theme.colors.textSecondary}
                value={dateTo}
                onChangeText={setDateTo}
              />
            </View>
          </View>
        </View>

        {/* Author */}
        <View style={{ marginBottom: SPACING.lg }}>
          <Text
            className="text-foreground font-semibold"
            style={{ fontSize: FONT_SIZES.md, marginBottom: SPACING.sm }}
          >
            Author
          </Text>
          <TextInput
            style={inputStyle}
            placeholder="Username (e.g., @johndoe)"
            placeholderTextColor={theme.colors.textSecondary}
            value={author}
            onChangeText={setAuthor}
          />
        </View>

        {/* Media Type */}
        <View style={{ marginBottom: SPACING.lg }}>
          <Text
            className="text-foreground font-semibold"
            style={{ fontSize: FONT_SIZES.md, marginBottom: SPACING.sm }}
          >
            Media Type
          </Text>
          <View className="flex-row flex-wrap" style={{ gap: SPACING.sm }}>
            {(['all', 'image', 'video', 'gif'] as MediaTypeOption[]).map((type) => (
              <TouchableOpacity
                key={type}
                className="border rounded-full"
                style={{
                  paddingHorizontal: SPACING.base,
                  paddingVertical: SPACING.sm,
                  backgroundColor: mediaType === type
                    ? theme.colors.primary
                    : theme.colors.backgroundSecondary,
                  borderColor: mediaType === type
                    ? theme.colors.primary
                    : theme.colors.border,
                }}
                onPress={() => setMediaType(type)}
              >
                <Text
                  className="font-semibold"
                  style={{
                    fontSize: FONT_SIZES.sm,
                    color: mediaType === type
                      ? theme.colors.card
                      : theme.colors.text,
                  }}
                >
                  {type === 'all' ? 'All' : type.charAt(0).toUpperCase() + type.slice(1) + 's'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Engagement */}
        <View style={{ marginBottom: SPACING.lg }}>
          <Text
            className="text-foreground font-semibold"
            style={{ fontSize: FONT_SIZES.md, marginBottom: SPACING.sm }}
          >
            Engagement
          </Text>
          <View className="flex-row" style={{ gap: SPACING.md }}>
            <View className="flex-1">
              <Text
                className="text-muted-foreground"
                style={{ fontSize: FONT_SIZES.sm, marginBottom: SPACING.xs }}
              >
                Min Likes
              </Text>
              <TextInput
                style={inputStyle}
                placeholder="0"
                placeholderTextColor={theme.colors.textSecondary}
                value={minLikes}
                onChangeText={setMinLikes}
                keyboardType="number-pad"
              />
            </View>
            <View className="flex-1">
              <Text
                className="text-muted-foreground"
                style={{ fontSize: FONT_SIZES.sm, marginBottom: SPACING.xs }}
              >
                Min Reposts
              </Text>
              <TextInput
                style={inputStyle}
                placeholder="0"
                placeholderTextColor={theme.colors.textSecondary}
                value={minReposts}
                onChangeText={setMinReposts}
                keyboardType="number-pad"
              />
            </View>
          </View>
        </View>

        {/* Language */}
        <View style={{ marginBottom: SPACING.lg }}>
          <Text
            className="text-foreground font-semibold"
            style={{ fontSize: FONT_SIZES.md, marginBottom: SPACING.sm }}
          >
            Language
          </Text>
          <TextInput
            style={inputStyle}
            placeholder="e.g., en, es, fr"
            placeholderTextColor={theme.colors.textSecondary}
            value={language}
            onChangeText={setLanguage}
          />
        </View>

        {/* Action Buttons */}
        <View className="flex-row" style={{ gap: SPACING.md, marginTop: SPACING.base }}>
          <SecondaryButton
            onPress={handleClearLocal}
            style={{ flex: 1 }}
          >
            Clear
          </SecondaryButton>
          <PrimaryButton
            onPress={handleApply}
            style={{ flex: 1 }}
          >
            Apply Filters
          </PrimaryButton>
        </View>
      </ScrollView>
    </View>
  );
}
