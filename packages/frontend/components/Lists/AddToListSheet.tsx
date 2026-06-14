import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { show as toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { listsService } from '@/services/listsService';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('AddToListSheet');

interface ListRow {
  id: string;
  title: string;
  hasUser: boolean;
  /** Toggle is in flight; the row is disabled and shows a spinner. */
  pending: boolean;
}

interface AddToListSheetProps {
  /** Oxy user id of the target the user is adding/removing from lists. */
  targetUserId: string;
  /** Display handle/name used in toast feedback. */
  targetLabel?: string;
  /** Dismiss the containing bottom sheet. */
  onClose: () => void;
}

function extractMemberIds(list: unknown): string[] {
  const members = (list as { memberOxyUserIds?: unknown })?.memberOxyUserIds;
  return Array.isArray(members) ? members.map((m) => String(m)) : [];
}

/**
 * Bottom-sheet content that lets the viewer add/remove a user to/from their own
 * custom lists. Opened from a profile's overflow menu and from a post's action
 * menu. Membership toggles go through `listsService`, which broadcasts the
 * change so list-backed feeds refresh automatically.
 */
export function AddToListSheet({ targetUserId, targetLabel, onClose }: AddToListSheetProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [rows, setRows] = useState<ListRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await listsService.list({ mine: true });
      const items = Array.isArray(res?.items) ? res.items : [];
      const next: ListRow[] = items.map((l: Record<string, unknown>) => {
        const id = String(l._id ?? l.id ?? '');
        return {
          id,
          title: typeof l.title === 'string' && l.title ? l.title : 'Untitled List',
          hasUser: extractMemberIds(l).includes(String(targetUserId)),
          pending: false,
        };
      }).filter((r) => r.id.length > 0);
      setRows(next);
    } catch (e) {
      logger.warn('Failed to load lists', { error: e });
      setError(t('lists.addTo.loadError', { defaultValue: 'Could not load your lists' }));
    } finally {
      setLoading(false);
    }
  }, [targetUserId, t]);

  useEffect(() => {
    load();
  }, [load]);

  const label = useMemo(() => targetLabel || t('lists.addTo.thisUser', { defaultValue: 'this user' }), [targetLabel, t]);

  const toggle = useCallback(async (row: ListRow) => {
    if (row.pending) return;
    const willAdd = !row.hasUser;

    // Optimistic update.
    setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, hasUser: willAdd, pending: true } : r)));

    try {
      if (willAdd) {
        await listsService.addMembers(row.id, [String(targetUserId)]);
        toast(
          t('lists.addTo.added', { list: row.title, defaultValue: `Added to ${row.title}` }),
          { type: 'success' }
        );
      } else {
        await listsService.removeMembers(row.id, [String(targetUserId)]);
        toast(
          t('lists.addTo.removed', { list: row.title, defaultValue: `Removed from ${row.title}` }),
          { type: 'success' }
        );
      }
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, pending: false } : r)));
    } catch (e) {
      logger.error('List membership toggle failed', { error: e });
      // Revert optimistic state.
      setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, hasUser: !willAdd, pending: false } : r)));
      toast(t('lists.addTo.toggleFailed', { defaultValue: 'Something went wrong' }), { type: 'error' });
    }
  }, [targetUserId, t]);

  const goCreate = useCallback(() => {
    onClose();
    router.push('/lists/create');
  }, [onClose]);

  return (
    <View className="bg-background px-4 pt-3 pb-2">
      <View className="flex-row items-center justify-between mb-1">
        <Text className="text-foreground text-lg font-bold">
          {t('lists.addTo.title', { user: label, defaultValue: `Add ${label} to list` })}
        </Text>
        <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.close', { defaultValue: 'Close' })}>
          <Ionicons name="close" size={22} color={theme.colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View className="items-center justify-center py-10">
          <SpinnerIcon size={26} className="text-primary" />
        </View>
      ) : error ? (
        <View className="items-center justify-center py-8 gap-3">
          <Text className="text-muted-foreground text-sm text-center">{error}</Text>
          <TouchableOpacity onPress={load}>
            <Text className="text-primary text-sm font-semibold">{t('common.retry', { defaultValue: 'Try again' })}</Text>
          </TouchableOpacity>
        </View>
      ) : rows.length === 0 ? (
        <View className="items-center justify-center py-8 gap-3">
          <Ionicons name="list-outline" size={40} color={theme.colors.textSecondary} />
          <Text className="text-muted-foreground text-sm text-center">
            {t('lists.addTo.empty', { defaultValue: 'You have no lists yet' })}
          </Text>
          <TouchableOpacity onPress={goCreate} className="bg-primary rounded-full px-5 py-2.5">
            <Text className="text-primary-foreground text-sm font-semibold">
              {t('lists.createList', { defaultValue: 'Create list' })}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView style={{ maxHeight: 360 }} showsVerticalScrollIndicator={false}>
          {rows.map((row) => (
            <TouchableOpacity
              key={row.id}
              className="flex-row items-center justify-between py-3 border-b border-border"
              onPress={() => toggle(row)}
              disabled={row.pending}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityState={{ checked: row.hasUser, disabled: row.pending }}
            >
              <View className="flex-row items-center gap-3 flex-1">
                <View className="w-9 h-9 rounded-lg items-center justify-center bg-secondary">
                  <Ionicons name="list" size={18} color={theme.colors.text} />
                </View>
                <Text className="text-foreground text-[15px] font-medium flex-1" numberOfLines={1}>
                  {row.title}
                </Text>
              </View>
              {row.pending ? (
                <SpinnerIcon size={18} className="text-primary" />
              ) : row.hasUser ? (
                <Ionicons name="checkmark-circle" size={24} color={theme.colors.primary} />
              ) : (
                <Ionicons name="ellipse-outline" size={24} color={theme.colors.textSecondary} />
              )}
            </TouchableOpacity>
          ))}

          <TouchableOpacity
            className="flex-row items-center gap-3 py-3.5"
            onPress={goCreate}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            <View className="w-9 h-9 rounded-lg items-center justify-center bg-primary">
              <Ionicons name="add" size={20} color="#fff" />
            </View>
            <Text className="text-primary text-[15px] font-semibold">
              {t('lists.addTo.newList', { defaultValue: 'New list' })}
            </Text>
          </TouchableOpacity>
        </ScrollView>
      )}
    </View>
  );
}
