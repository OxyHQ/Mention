import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { show as toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxyhq/services';
import { starterPacksService, type StarterPackCollection } from '@/services/starterPacksService';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('AddToStarterPackSheet');

/**
 * React Query cache key for the viewer's own (editable) starter packs. This
 * sheet is the React Query owner of the viewer's pack membership: it fetches the
 * list, updates it optimistically on add/remove toggle, and revalidates on
 * success. The create screen (`/starter-packs/create`) imports this key and
 * invalidates it after creating a pack, so a freshly created pack shows up the
 * next time the sheet opens — which is why the query can inherit the global
 * 5-min staleTime instead of forcing `staleTime: 0` (a refetch on every open).
 */
export const STARTER_PACKS_MINE_KEY = ['starter-packs', 'mine'] as const;

interface PackRow {
  id: string;
  name: string;
  hasUser: boolean;
  /** Toggle is in flight; the row is disabled and shows a spinner. */
  pending: boolean;
}

interface AddToStarterPackSheetProps {
  /** Oxy user id of the target the viewer is adding/removing from packs. */
  targetUserId: string;
  /** Display handle/name used in toast feedback. */
  targetLabel?: string;
  /** Dismiss the containing bottom sheet. */
  onClose: () => void;
}

/** Best-effort extraction of a server-authored error message (e.g. the 150-member cap). */
function readServerError(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'response' in error) {
    const response = (error as { response?: { data?: { error?: unknown } } }).response;
    const message = response?.data?.error;
    if (typeof message === 'string' && message.trim().length > 0) {
      return message;
    }
  }
  return undefined;
}

/**
 * Bottom-sheet content that lets the viewer add/remove a user to/from their own
 * starter packs. Opened from another user's profile overflow menu. Membership
 * toggles go through `starterPacksService`; the viewer's packs are owned by a
 * React Query cache that is updated optimistically and revalidated on success.
 * Mirrors `AddToListSheet`'s UX (toggle rows, optimistic state, toasts).
 */
export function AddToStarterPackSheet({ targetUserId, targetLabel, onClose }: AddToStarterPackSheetProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { user, canUsePrivateApi } = useAuth();
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  // Account-scoped cache key: prevents the previous account's packs from leaking
  // after a switch. Shares the `STARTER_PACKS_MINE_KEY` prefix so the create
  // screen's `invalidateQueries({ queryKey: STARTER_PACKS_MINE_KEY })` still
  // matches (invalidation is prefix-based; get/setQueryData below are exact).
  const packsQueryKey = useMemo(() => [...STARTER_PACKS_MINE_KEY, user?.id], [user?.id]);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: packsQueryKey,
    queryFn: () => starterPacksService.list({ mine: true }),
    enabled: canUsePrivateApi,
  });

  const label = useMemo(
    () => targetLabel || t('starterPacks.addTo.thisUser', { defaultValue: 'this user' }),
    [targetLabel, t]
  );

  const rows = useMemo<PackRow[]>(() => {
    const items = data?.items ?? [];
    return items
      .map((p) => {
        const id = String(p._id ?? p.id ?? '');
        const members = Array.isArray(p.memberOxyUserIds) ? p.memberOxyUserIds.map(String) : [];
        return {
          id,
          name: typeof p.name === 'string' && p.name
            ? p.name
            : t('starterPacks.addTo.untitled', { defaultValue: 'Untitled Pack' }),
          hasUser: members.includes(String(targetUserId)),
          pending: pendingIds.has(id),
        };
      })
      .filter((r) => r.id.length > 0);
  }, [data, pendingIds, targetUserId, t]);

  const toggle = useCallback(async (row: PackRow) => {
    if (row.pending) return;
    const willAdd = !row.hasUser;
    const previous = queryClient.getQueryData<StarterPackCollection>(packsQueryKey);

    // Optimistic: flip membership in the cache and disable the row.
    setPendingIds((prev) => new Set(prev).add(row.id));
    queryClient.setQueryData<StarterPackCollection>(packsQueryKey, (prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        items: prev.items.map((it) => {
          if (String(it._id ?? it.id ?? '') !== row.id) return it;
          const members = (Array.isArray(it.memberOxyUserIds) ? it.memberOxyUserIds : []).map(String);
          return {
            ...it,
            memberOxyUserIds: willAdd
              ? Array.from(new Set([...members, String(targetUserId)]))
              : members.filter((m) => m !== String(targetUserId)),
          };
        }),
      };
    });

    try {
      if (willAdd) {
        await starterPacksService.addMembers(row.id, [String(targetUserId)]);
        toast(
          t('starterPacks.addTo.added', { pack: row.name, defaultValue: `Added to ${row.name}` }),
          { type: 'success' }
        );
      } else {
        await starterPacksService.removeMembers(row.id, [String(targetUserId)]);
        toast(
          t('starterPacks.addTo.removed', { pack: row.name, defaultValue: `Removed from ${row.name}` }),
          { type: 'success' }
        );
      }
      // Revalidate against server truth after a successful membership change.
      queryClient.invalidateQueries({ queryKey: packsQueryKey });
    } catch (e) {
      logger.error('Starter pack membership toggle failed', { error: e });
      // Revert optimistic cache state.
      if (previous) queryClient.setQueryData(packsQueryKey, previous);
      toast(
        readServerError(e) ?? t('starterPacks.addTo.toggleFailed', { defaultValue: 'Something went wrong' }),
        { type: 'error' }
      );
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(row.id);
        return next;
      });
    }
  }, [queryClient, targetUserId, t, packsQueryKey]);

  const goCreate = useCallback(() => {
    onClose();
    router.push('/starter-packs/create');
  }, [onClose]);

  return (
    <View className="bg-background px-4 pt-3 pb-2">
      <View className="flex-row items-center justify-between mb-1">
        <Text className="text-foreground text-lg font-bold">
          {t('starterPacks.addTo.title', { user: label, defaultValue: `Add ${label} to starter pack` })}
        </Text>
        <TouchableOpacity onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.close', { defaultValue: 'Close' })}>
          <Ionicons name="close" size={22} color={theme.colors.textSecondary} />
        </TouchableOpacity>
      </View>

      {isLoading ? (
        <View className="items-center justify-center py-10">
          <SpinnerIcon size={26} className="text-primary" />
        </View>
      ) : isError ? (
        <View className="items-center justify-center py-8 gap-3">
          <Text className="text-muted-foreground text-sm text-center">
            {t('starterPacks.addTo.loadError', { defaultValue: 'Could not load your starter packs' })}
          </Text>
          <TouchableOpacity onPress={() => refetch()}>
            <Text className="text-primary text-sm font-semibold">{t('common.retry', { defaultValue: 'Try again' })}</Text>
          </TouchableOpacity>
        </View>
      ) : rows.length === 0 ? (
        <View className="items-center justify-center py-8 gap-3">
          <Ionicons name="rocket-outline" size={40} color={theme.colors.textSecondary} />
          <Text className="text-muted-foreground text-sm text-center">
            {t('starterPacks.addTo.empty', { defaultValue: 'You have no starter packs yet' })}
          </Text>
          <TouchableOpacity onPress={goCreate} className="bg-primary rounded-full px-5 py-2.5">
            <Text className="text-primary-foreground text-sm font-semibold">
              {t('starterPacks.create', { defaultValue: 'Create starter pack' })}
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
                  <Ionicons name="rocket" size={18} color={theme.colors.text} />
                </View>
                <Text className="text-foreground text-[15px] font-medium flex-1" numberOfLines={1}>
                  {row.name}
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
              {t('starterPacks.addTo.newPack', { defaultValue: 'New starter pack' })}
            </Text>
          </TouchableOpacity>
        </ScrollView>
      )}
    </View>
  );
}
