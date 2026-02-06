import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "@/hooks/useTheme";
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

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={[styles.title, { color: theme.colors.text }]}>
            Filters
          </Text>
        </View>

        {/* Date Range */}
        <View style={styles.section}>
          <Text style={[styles.label, { color: theme.colors.text }]}>
            Date Range
          </Text>
          <View style={styles.dateRow}>
            <View style={styles.dateInput}>
              <Text style={[styles.dateLabel, { color: theme.colors.textSecondary }]}>
                From
              </Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: theme.colors.backgroundSecondary,
                    color: theme.colors.text,
                    borderColor: theme.colors.border,
                  }
                ]}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={theme.colors.textSecondary}
                value={dateFrom}
                onChangeText={setDateFrom}
              />
            </View>
            <View style={styles.dateInput}>
              <Text style={[styles.dateLabel, { color: theme.colors.textSecondary }]}>
                To
              </Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: theme.colors.backgroundSecondary,
                    color: theme.colors.text,
                    borderColor: theme.colors.border,
                  }
                ]}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={theme.colors.textSecondary}
                value={dateTo}
                onChangeText={setDateTo}
              />
            </View>
          </View>
        </View>

        {/* Author */}
        <View style={styles.section}>
          <Text style={[styles.label, { color: theme.colors.text }]}>
            Author
          </Text>
          <TextInput
            style={[
              styles.input,
              {
                backgroundColor: theme.colors.backgroundSecondary,
                color: theme.colors.text,
                borderColor: theme.colors.border,
              }
            ]}
            placeholder="Username (e.g., @johndoe)"
            placeholderTextColor={theme.colors.textSecondary}
            value={author}
            onChangeText={setAuthor}
          />
        </View>

        {/* Media Type */}
        <View style={styles.section}>
          <Text style={[styles.label, { color: theme.colors.text }]}>
            Media Type
          </Text>
          <View style={styles.chipRow}>
            {(['all', 'image', 'video', 'gif'] as MediaTypeOption[]).map((type) => (
              <TouchableOpacity
                key={type}
                style={[
                  styles.chip,
                  {
                    backgroundColor: mediaType === type
                      ? theme.colors.primary
                      : theme.colors.backgroundSecondary,
                    borderColor: mediaType === type
                      ? theme.colors.primary
                      : theme.colors.border,
                  }
                ]}
                onPress={() => setMediaType(type)}
              >
                <Text
                  style={[
                    styles.chipText,
                    {
                      color: mediaType === type
                        ? theme.colors.card
                        : theme.colors.text,
                    }
                  ]}
                >
                  {type === 'all' ? 'All' : type.charAt(0).toUpperCase() + type.slice(1) + 's'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Engagement */}
        <View style={styles.section}>
          <Text style={[styles.label, { color: theme.colors.text }]}>
            Engagement
          </Text>
          <View style={styles.engagementRow}>
            <View style={styles.engagementInput}>
              <Text style={[styles.dateLabel, { color: theme.colors.textSecondary }]}>
                Min Likes
              </Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: theme.colors.backgroundSecondary,
                    color: theme.colors.text,
                    borderColor: theme.colors.border,
                  }
                ]}
                placeholder="0"
                placeholderTextColor={theme.colors.textSecondary}
                value={minLikes}
                onChangeText={setMinLikes}
                keyboardType="number-pad"
              />
            </View>
            <View style={styles.engagementInput}>
              <Text style={[styles.dateLabel, { color: theme.colors.textSecondary }]}>
                Min Reposts
              </Text>
              <TextInput
                style={[
                  styles.input,
                  {
                    backgroundColor: theme.colors.backgroundSecondary,
                    color: theme.colors.text,
                    borderColor: theme.colors.border,
                  }
                ]}
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
        <View style={styles.section}>
          <Text style={[styles.label, { color: theme.colors.text }]}>
            Language
          </Text>
          <TextInput
            style={[
              styles.input,
              {
                backgroundColor: theme.colors.backgroundSecondary,
                color: theme.colors.text,
                borderColor: theme.colors.border,
              }
            ]}
            placeholder="e.g., en, es, fr"
            placeholderTextColor={theme.colors.textSecondary}
            value={language}
            onChangeText={setLanguage}
          />
        </View>

        {/* Action Buttons */}
        <View style={styles.actions}>
          <SecondaryButton
            onPress={handleClearLocal}
            style={styles.actionButton}
          >
            Clear
          </SecondaryButton>
          <PrimaryButton
            onPress={handleApply}
            style={styles.actionButton}
          >
            Apply Filters
          </PrimaryButton>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderTopWidth: 1,
    borderTopColor: 'rgba(0, 0, 0, 0.1)',
  },
  scrollView: {
    maxHeight: 500,
  },
  scrollContent: {
    padding: SPACING.base,
  },
  header: {
    marginBottom: SPACING.base,
  },
  title: {
    fontSize: FONT_SIZES.xl,
    fontWeight: '700',
  },
  section: {
    marginBottom: SPACING.lg,
  },
  label: {
    fontSize: FONT_SIZES.md,
    fontWeight: '600',
    marginBottom: SPACING.sm,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    fontSize: FONT_SIZES.md,
  },
  dateRow: {
    flexDirection: 'row',
    gap: SPACING.md,
  },
  dateInput: {
    flex: 1,
  },
  dateLabel: {
    fontSize: FONT_SIZES.sm,
    marginBottom: SPACING.xs,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  chip: {
    paddingHorizontal: SPACING.base,
    paddingVertical: SPACING.sm,
    borderRadius: 20,
    borderWidth: 1,
  },
  chipText: {
    fontSize: FONT_SIZES.sm,
    fontWeight: '600',
  },
  engagementRow: {
    flexDirection: 'row',
    gap: SPACING.md,
  },
  engagementInput: {
    flex: 1,
  },
  actions: {
    flexDirection: 'row',
    gap: SPACING.md,
    marginTop: SPACING.base,
  },
  actionButton: {
    flex: 1,
  },
});
