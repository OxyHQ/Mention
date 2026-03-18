import React, { useState, useCallback } from 'react';
import {
  LayoutAnimation,
  Pressable,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTheme } from '@oxyhq/bloom/theme';
import { getEntries, type LogEntry } from '@/lib/logger/logDump';
import { timeAgo } from '@/lib/logger/util';

function LogEntryRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: LogEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { colors } = useTheme();
  const isWarningOrError =
    entry.level === 'warn' || entry.level === 'error';
  const hasMetadata =
    entry.metadata && Object.keys(entry.metadata).length > 0;

  return (
    <View>
      <Pressable
        className="flex-row items-center py-3 px-3 gap-2 border-b border-border"
        onPress={onToggle}
        accessibilityLabel="View log entry"
        accessibilityHint="Opens additional details for a log entry"
      >
        {isWarningOrError ? (
          <Ionicons
            name="warning"
            size={16}
            color={colors.notification}
          />
        ) : (
          <Ionicons
            name="information-circle"
            size={16}
            color={colors.text}
            style={{ opacity: 0.6 }}
          />
        )}
        <View className="flex-1 flex-row items-center gap-1.5">
          {entry.context && (
            <Text
              className="text-muted-foreground text-xs"
              numberOfLines={1}
            >
              ({String(entry.context)})
            </Text>
          )}
          <Text
            className="text-foreground text-sm flex-1"
            numberOfLines={expanded ? undefined : 1}
          >
            {String(entry.message)}
          </Text>
        </View>
        {hasMetadata &&
          (expanded ? (
            <Ionicons
              name="chevron-up"
              size={14}
              color={colors.text}
              style={{ opacity: 0.4 }}
            />
          ) : (
            <Ionicons
              name="chevron-down"
              size={14}
              color={colors.text}
              style={{ opacity: 0.4 }}
            />
          ))}
        <Text className="text-muted-foreground text-xs" style={{ minWidth: 28 }}>
          {timeAgo(entry.timestamp)}
        </Text>
      </Pressable>
      {expanded && hasMetadata && (
        <View className="bg-muted/30 rounded-sm p-2 mx-3 my-1 border-b border-border">
          <Text
            className="text-foreground text-xs leading-5"
            style={{ fontFamily: 'monospace' }}
          >
            {JSON.stringify(entry.metadata, null, 2)}
          </Text>
        </View>
      )}
    </View>
  );
}

export default function SystemLogScreen() {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const [expanded, setExpanded] = useState<string[]>([]);
  const [entries, setEntries] = useState<LogEntry[]>([]);

  useFocusEffect(
    useCallback(() => {
      setEntries(getEntries());
    }, []),
  );

  const toggleEntry = (id: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded(prev =>
      prev.includes(id) ? prev.filter(v => v !== id) : [...prev, id],
    );
  };

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('settings.systemLog', { defaultValue: 'System log' }),
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
        }}
        hideBottomBorder
        disableSticky
      />
      <ScrollView className="flex-1" showsVerticalScrollIndicator={false}>
        {entries.length === 0 ? (
          <View className="items-center justify-center py-12">
            <Ionicons name="document-text-outline" size={32} color="#999" />
            <Text className="text-muted-foreground text-sm mt-2">
              {t('settings.noLogEntries', {
                defaultValue: 'No log entries yet',
              })}
            </Text>
          </View>
        ) : (
          entries.map(entry => (
            <LogEntryRow
              key={entry.id}
              entry={entry}
              expanded={expanded.includes(entry.id)}
              onToggle={() => toggleEntry(entry.id)}
            />
          ))
        )}
      </ScrollView>
    </ThemedView>
  );
}
