import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Platform, type TextStyle } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { Avatar } from '@oxyhq/bloom/avatar';
import { show as toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import { Ionicons } from '@expo/vector-icons';
import { queryKeys, useAuth } from '@oxyhq/services';
import { useTranslation } from 'react-i18next';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { listsService } from '@/services/listsService';
import { useSafeBack } from '@/hooks/useSafeBack';
import { logger } from '@/lib/logger';
import { queryClient } from '@/lib/queryClient';
import type { User } from '@oxyhq/core';
import { displayNameOrHandle } from '@/utils/displayName';

interface MemberProfile {
  id: string;
  username: string;
  name: {
    displayName: string;
  };
  avatar?: string;
}

const SEARCH_DEBOUNCE_MS = 300;

// Remove the web focus outline to match the other text inputs in the app.
// `outlineWidth` is a valid numeric react-native-web TextStyle property.
const INPUT_STYLE: TextStyle = Platform.OS === 'web' ? { outlineWidth: 0 } : {};

/**
 * List member management screen. Resolves the broken `/lists/:id/edit` route that
 * the list detail screen ("Add people" / edit icon) navigates to.
 *
 * Owners search users and add/remove them. Each add/remove persists immediately
 * via `listsService.addMembers`/`removeMembers`, which broadcasts the change so
 * the list-backed feed (and the list detail screen) refresh automatically.
 */
export default function EditListMembersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const listId = String(id);
  const { oxyServices } = useAuth();
  const theme = useTheme();
  const { t } = useTranslation();
  const safeBack = useSafeBack();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberProfile[]>([]);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<MemberProfile[]>([]);
  const [searching, setSearching] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const memberIdSet = useMemo(() => new Set(members.map((m) => m.id)), [members]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listsService.get(listId);
      const memberIds: string[] = Array.isArray(data?.memberOxyUserIds) ? data.memberOxyUserIds : [];
      // Single bulk fetch (no per-id N+1); prime the shared React Query cache so
      // downstream profile reads for these members hit the cache.
      const fetched = await oxyServices.getUsersByIds(memberIds);
      for (const user of fetched) {
        if (user?.id) {
          queryClient.setQueryData(queryKeys.users.detail(user.id), user);
        }
      }
      const byId = new Map(fetched.map((user) => [user.id, user]));
      const profiles = memberIds
        .map((uid) => byId.get(uid))
        .filter((profile): profile is User => Boolean(profile))
        .map((profile) => ({
          id: profile.id,
          username: profile.username,
          name: { displayName: displayNameOrHandle(profile.name.displayName, profile.username) },
          avatar: profile.avatar ?? undefined,
        }));
      setMembers(profiles);
    } catch (e) {
      logger.warn('Failed to load list for editing', { error: e });
      setError(t('lists.edit.loadError', { defaultValue: 'Could not load this list' }));
    } finally {
      setLoading(false);
    }
  }, [listId, oxyServices, t]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
  }, []);

  const runSearch = useCallback((q: string) => {
    setSearch(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const trimmed = q.trim();
    if (!trimmed) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await oxyServices.searchProfiles(trimmed, { limit: 10 });
        setResults(res.data.map((profile: User) => ({
          id: profile.id,
          username: profile.username,
          name: { displayName: displayNameOrHandle(profile.name.displayName, profile.username) },
          avatar: profile.avatar ?? undefined,
        })));
      } catch (e) {
        logger.warn('searchProfiles failed', { error: e });
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
  }, [oxyServices]);

  const setPending = useCallback((uid: string, on: boolean) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(uid); else next.delete(uid);
      return next;
    });
  }, []);

  const addMember = useCallback(async (profile: MemberProfile) => {
    if (memberIdSet.has(profile.id) || pendingIds.has(profile.id)) return;
    setPending(profile.id, true);
    // Optimistic insert.
    setMembers((prev) => [profile, ...prev]);
    try {
      await listsService.addMembers(listId, [profile.id]);
      toast(t('lists.edit.added', { user: profile.username, defaultValue: `Added @${profile.username}` }), { type: 'success' });
    } catch (e) {
      logger.error('Add member failed', { error: e });
      setMembers((prev) => prev.filter((m) => m.id !== profile.id));
      toast(t('lists.edit.addFailed', { defaultValue: 'Failed to add member' }), { type: 'error' });
    } finally {
      setPending(profile.id, false);
    }
  }, [listId, memberIdSet, pendingIds, setPending, t]);

  const removeMember = useCallback(async (profile: MemberProfile) => {
    if (pendingIds.has(profile.id)) return;
    setPending(profile.id, true);
    // Optimistic removal.
    const previous = members;
    setMembers((prev) => prev.filter((m) => m.id !== profile.id));
    try {
      await listsService.removeMembers(listId, [profile.id]);
      toast(t('lists.edit.removed', { user: profile.username, defaultValue: `Removed @${profile.username}` }), { type: 'success' });
    } catch (e) {
      logger.error('Remove member failed', { error: e });
      setMembers(previous);
      toast(t('lists.edit.removeFailed', { defaultValue: 'Failed to remove member' }), { type: 'error' });
    } finally {
      setPending(profile.id, false);
    }
  }, [listId, members, pendingIds, setPending, t]);

  const header = (
    <Header
      options={{
        title: t('lists.edit.title', { defaultValue: 'Edit members' }),
        leftComponents: [
          <IconButton variant="icon" key="back" onPress={() => safeBack()}>
            <BackArrowIcon size={20} className="text-foreground" />
          </IconButton>,
        ],
      }}
      hideBottomBorder
      disableSticky
    />
  );

  if (loading) {
    return (
      <ThemedView className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center">
          <SpinnerIcon size={28} className="text-primary" />
        </View>
      </ThemedView>
    );
  }

  if (error) {
    return (
      <ThemedView className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center gap-3 px-8">
          <Ionicons name="alert-circle-outline" size={48} color={theme.colors.textSecondary} />
          <Text className="text-muted-foreground text-base text-center">{error}</Text>
          <TouchableOpacity onPress={load}>
            <Text className="text-primary text-sm font-semibold">{t('common.retry', { defaultValue: 'Try again' })}</Text>
          </TouchableOpacity>
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      {header}
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 100 }} keyboardShouldPersistTaps="handled">
        <Text className="text-sm text-muted-foreground mb-1.5 font-primary">
          {t('lists.edit.addMembers', { defaultValue: 'Add members' })}
        </Text>
        <View className="flex-row items-center border border-border rounded-[10px] px-2.5 mb-2.5 bg-background">
          <Ionicons name="search" size={18} color={theme.colors.textSecondary} />
          <TextInput
            value={search}
            onChangeText={runSearch}
            placeholder={t('lists.create.searchUsersPlaceholder', { defaultValue: 'Search users' })}
            placeholderTextColor={theme.colors.textSecondary}
            className="flex-1 p-2.5 text-foreground font-primary"
            style={INPUT_STYLE}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {searching && <SpinnerIcon size={16} className="text-primary" />}
        </View>

        {results.length > 0 && (
          <View className="border border-border rounded-[10px] overflow-hidden mb-3">
            {results.map((u) => {
              const already = memberIdSet.has(u.id);
              const busy = pendingIds.has(u.id);
              return (
                <TouchableOpacity
                  key={u.id}
                  className="flex-row items-center gap-3 px-3 py-2.5 border-b border-border"
                  onPress={() => addMember(u)}
                  disabled={already || busy}
                  activeOpacity={0.7}
                >
                  <Avatar source={u.avatar} size={36} />
                  <View className="flex-1">
                    <Text className="text-foreground font-medium" numberOfLines={1}>@{u.username}</Text>
                    <Text className="text-muted-foreground text-xs" numberOfLines={1}>{u.name.displayName}</Text>
                  </View>
                  {busy ? (
                    <SpinnerIcon size={18} className="text-primary" />
                  ) : already ? (
                    <Ionicons name="checkmark-circle" size={22} color={theme.colors.primary} />
                  ) : (
                    <Text className="text-primary font-semibold font-primary">{t('lists.create.add', { defaultValue: 'Add' })}</Text>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        <Text className="text-sm text-muted-foreground mb-1.5 mt-1 font-primary">
          {members.length} {members.length === 1
            ? t('lists.memberSingular', { defaultValue: 'member' })
            : t('lists.memberPlural', { defaultValue: 'members' })}
        </Text>

        {members.length === 0 ? (
          <View className="items-center justify-center py-10 gap-3">
            <Ionicons name="people-outline" size={44} color={theme.colors.textSecondary} />
            <Text className="text-muted-foreground text-sm text-center">
              {t('lists.emptyMembersSubtext', { defaultValue: 'Add people to curate this list' })}
            </Text>
          </View>
        ) : (
          <View className="border border-border rounded-[10px] overflow-hidden">
            {members.map((m) => {
              const busy = pendingIds.has(m.id);
              return (
                <View key={m.id} className="flex-row items-center gap-3 px-3 py-2.5 border-b border-border">
                  <Avatar source={m.avatar} size={36} />
                  <View className="flex-1">
                    <Text className="text-foreground font-medium" numberOfLines={1}>@{m.username}</Text>
                    <Text className="text-muted-foreground text-xs" numberOfLines={1}>{m.name.displayName}</Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => removeMember(m)}
                    disabled={busy}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t('lists.create.remove', { defaultValue: 'Remove' })}
                  >
                    {busy ? (
                      <SpinnerIcon size={18} className="text-destructive" />
                    ) : (
                      <Ionicons name="remove-circle-outline" size={24} color={theme.colors.error} />
                    )}
                  </TouchableOpacity>
                </View>
              );
            })}
          </View>
        )}
      </ScrollView>
    </ThemedView>
  );
}
