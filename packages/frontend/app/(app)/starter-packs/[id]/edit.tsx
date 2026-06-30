import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Platform, type TextStyle } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { Avatar } from '@oxyhq/bloom/avatar';
import { Button } from '@oxyhq/bloom/button';
import { Item } from '@oxyhq/bloom/item';
import { SearchInput } from '@oxyhq/bloom/search-input';
import { show as toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import {
  Group3_Stroke2_Corner0_Rounded as GroupIcon,
  CheckThick_Stroke2_Corner0_Rounded as CheckIcon,
  PlusLarge_Stroke2_Corner0_Rounded as PlusIcon,
  Trash_Stroke2_Corner0_Rounded as TrashIcon,
  CircleX_Stroke2_Corner0_Rounded as ErrorIcon,
} from '@oxyhq/bloom/icons';
import { useAuth } from '@oxyhq/services';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { starterPacksService } from '@/services/starterPacksService';
import { useSafeBack } from '@/hooks/useSafeBack';
import { confirmDestructive } from '@/utils/alerts';
import { displayNameOrHandle } from '@/utils/displayName';
import { cn } from '@/lib/utils';
import { logger } from '@/lib/logger';
import type { User } from '@oxyhq/core';

interface MemberProfile {
  id: string;
  username: string;
  name: {
    displayName: string;
  };
  avatar?: string;
}

const SEARCH_DEBOUNCE_MS = 300;
const MAX_MEMBERS = 150;

// Remove the web focus outline to match the other text inputs in the app.
const INPUT_STYLE: TextStyle = Platform.OS === 'web' ? { outlineWidth: 0 } : {};

/**
 * Starter pack edit screen (owner only). Mirrors the list member editor at
 * `app/(app)/lists/[id]/edit.tsx`:
 * - name + description persist via `PUT /starter-packs/:id` on Save.
 * - members add/remove persist immediately via the dedicated member endpoints.
 * - the pack can be deleted (with a destructive confirm).
 *
 * Owner gating lives on the detail screen (the Edit entry point only shows for
 * the owner); this screen re-verifies ownership once the pack loads.
 */
export default function EditStarterPackScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const packId = String(id);
  const { user, oxyServices } = useAuth();
  const theme = useTheme();
  const safeBack = useSafeBack();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);
  const [members, setMembers] = useState<MemberProfile[]>([]);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<MemberProfile[]>([]);
  const [searching, setSearching] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const memberIdSet = useMemo(() => new Set(members.map((m) => m.id)), [members]);
  const atCapacity = members.length >= MAX_MEMBERS;
  const remainingCapacity = Math.max(MAX_MEMBERS - members.length, 0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const pack = await starterPacksService.get(packId);
      if (pack.ownerOxyUserId && user?.id && pack.ownerOxyUserId !== user.id) {
        setError('You can only edit your own starter packs');
        return;
      }
      setName(pack.name ?? '');
      setDescription(pack.description ?? '');
      // Members are hydrated server-side (identity + fully-resolved avatar URL);
      // the browser has no service credential for the bulk user lookup, so we
      // read them straight from the detail response instead of resolving ids.
      setMembers(
        (pack.members ?? []).map((m) => ({
          id: m.id,
          username: m.username,
          name: { displayName: displayNameOrHandle(m.displayName, m.username) },
          avatar: m.avatar ?? undefined,
        })),
      );
    } catch (e) {
      logger.warn('Failed to load starter pack for editing', { error: e });
      setError('Could not load this starter pack');
    } finally {
      setLoading(false);
    }
  }, [packId, user?.id]);

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

  const clearSearch = useCallback(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setSearch('');
    setResults([]);
    setSearching(false);
  }, []);

  const setPending = useCallback((uid: string, on: boolean) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(uid); else next.delete(uid);
      return next;
    });
  }, []);

  const addMember = useCallback(async (profile: MemberProfile) => {
    if (memberIdSet.has(profile.id) || pendingIds.has(profile.id)) return;
    if (members.length >= MAX_MEMBERS) {
      toast(`A starter pack can hold up to ${MAX_MEMBERS} accounts`, { type: 'error' });
      return;
    }
    setPending(profile.id, true);
    // Optimistic insert.
    setMembers((prev) => [profile, ...prev]);
    try {
      await starterPacksService.addMembers(packId, [profile.id]);
      toast(`Added @${profile.username}`, { type: 'success' });
    } catch (e) {
      logger.error('Add member failed', { error: e });
      setMembers((prev) => prev.filter((m) => m.id !== profile.id));
      toast('Failed to add member', { type: 'error' });
    } finally {
      setPending(profile.id, false);
    }
  }, [packId, memberIdSet, members.length, pendingIds, setPending]);

  const removeMember = useCallback(async (profile: MemberProfile) => {
    if (pendingIds.has(profile.id)) return;
    setPending(profile.id, true);
    // Optimistic removal.
    const previous = members;
    setMembers((prev) => prev.filter((m) => m.id !== profile.id));
    try {
      await starterPacksService.removeMembers(packId, [profile.id]);
      toast(`Removed @${profile.username}`, { type: 'success' });
    } catch (e) {
      logger.error('Remove member failed', { error: e });
      setMembers(previous);
      toast('Failed to remove member', { type: 'error' });
    } finally {
      setPending(profile.id, false);
    }
  }, [packId, members, pendingIds, setPending]);

  const saveDetails = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName || savingDetails) return;
    setSavingDetails(true);
    try {
      await starterPacksService.update(packId, {
        name: trimmedName,
        description: description.trim() || undefined,
        memberOxyUserIds: members.map((m) => m.id),
      });
      toast('Starter pack updated', { type: 'success' });
      safeBack();
    } catch (e) {
      logger.error('Update starter pack failed', { error: e });
      toast('Failed to update starter pack', { type: 'error' });
    } finally {
      setSavingDetails(false);
    }
  }, [packId, name, description, members, savingDetails, safeBack]);

  const deletePack = useCallback(async () => {
    const confirmed = await confirmDestructive(
      'Delete starter pack?',
      'This permanently removes the pack. This cannot be undone.',
    );
    if (!confirmed) return;
    try {
      await starterPacksService.remove(packId);
      router.replace('/starter-packs');
    } catch (e) {
      logger.error('Failed to delete starter pack', { error: e });
      toast('Failed to delete starter pack', { type: 'error' });
    }
  }, [packId]);

  const header = (
    <Header
      options={{
        title: 'Edit starter pack',
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
          <ErrorIcon size="3xl" fill={theme.colors.textSecondary} />
          <Text className="text-muted-foreground text-base text-center">{error}</Text>
          <TouchableOpacity onPress={load}>
            <Text className="text-primary text-sm font-semibold">Try again</Text>
          </TouchableOpacity>
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      {header}
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 120 }} keyboardShouldPersistTaps="handled">
        <Text className="text-sm text-muted-foreground mb-1.5 font-primary">Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. Tech people to follow"
          placeholderTextColor={theme.colors.textSecondary}
          className="border border-border rounded-[10px] p-2.5 mb-2.5 text-foreground bg-background font-primary"
          style={INPUT_STYLE}
        />

        <Text className="text-sm text-muted-foreground mb-1.5 font-primary">Description</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder="What is this starter pack about?"
          placeholderTextColor={theme.colors.textSecondary}
          className="border border-border rounded-[10px] p-2.5 mb-3 text-foreground bg-background font-primary h-20"
          style={INPUT_STYLE}
          multiline
        />

        {/* Add accounts: themed Bloom search field + result rows. */}
        <View className="flex-row items-center justify-between mb-1.5">
          <Text className="text-sm text-muted-foreground font-primary">Add accounts</Text>
          <Text className={cn('text-xs font-primary', atCapacity ? 'text-destructive' : 'text-muted-foreground')}>
            {members.length}/{MAX_MEMBERS}
          </Text>
        </View>

        <SearchInput
          label="Search people"
          value={search}
          onChangeText={runSearch}
          onClearText={clearSearch}
          editable={!atCapacity}
        />

        {searching && (
          <View className="flex-row items-center gap-2 mt-2.5">
            <SpinnerIcon size={16} className="text-primary" />
            <Text className="text-muted-foreground text-xs font-primary">Searching…</Text>
          </View>
        )}

        {atCapacity && (
          <Text className="text-xs text-destructive mt-2 font-primary">
            This starter pack is full. Remove an account to add another.
          </Text>
        )}

        {results.length > 0 && (
          <View className="border border-border rounded-[14px] overflow-hidden mt-2.5 bg-background">
            {results.map((u, index) => {
              const already = memberIdSet.has(u.id);
              const busy = pendingIds.has(u.id);
              const blockedByCap = atCapacity && !already;
              return (
                <View key={u.id} className={cn(index < results.length - 1 && 'border-b border-border')}>
                  <Item
                    leading={<Avatar source={u.avatar} name={u.name.displayName} size={40} />}
                    title={u.name.displayName}
                    subtitle={`@${u.username}`}
                    onPress={blockedByCap || already || busy ? undefined : () => addMember(u)}
                    accessibilityLabel={already ? `${u.name.displayName} already added` : `Add ${u.name.displayName}`}
                    trailing={
                      already ? (
                        <Button
                          variant="secondary"
                          size="small"
                          disabled
                          icon={<CheckIcon size="xs" fill={theme.colors.success} />}
                          accessibilityLabel={`${u.name.displayName} added`}
                        >
                          Added
                        </Button>
                      ) : (
                        <Button
                          variant="primary"
                          size="small"
                          loading={busy}
                          disabled={blockedByCap}
                          icon={<PlusIcon size="xs" fill={theme.colors.primaryForeground} />}
                          onPress={() => addMember(u)}
                          accessibilityLabel={`Add ${u.name.displayName}`}
                        >
                          Add
                        </Button>
                      )
                    }
                  />
                </View>
              );
            })}
          </View>
        )}

        {/* Current members. */}
        <View className="flex-row items-center justify-between mt-5 mb-1.5">
          <Text className="text-sm text-foreground font-semibold font-primary">
            Members ({members.length})
          </Text>
          {!atCapacity && members.length > 0 && (
            <Text className="text-xs text-muted-foreground font-primary">
              {remainingCapacity} {remainingCapacity === 1 ? 'spot' : 'spots'} left
            </Text>
          )}
        </View>

        {members.length === 0 ? (
          <View className="items-center justify-center py-10 gap-3">
            <GroupIcon size="2xl" fill={theme.colors.textSecondary} />
            <Text className="text-muted-foreground text-sm text-center font-primary">
              Search above to add people to this starter pack
            </Text>
          </View>
        ) : (
          <View className="border border-border rounded-[14px] overflow-hidden bg-background">
            {members.map((m, index) => {
              const busy = pendingIds.has(m.id);
              return (
                <View key={m.id} className={cn(index < members.length - 1 && 'border-b border-border')}>
                  <Item
                    leading={<Avatar source={m.avatar} name={m.name.displayName} size={40} />}
                    title={m.name.displayName}
                    subtitle={`@${m.username}`}
                    trailing={
                      <Button
                        variant="ghost"
                        size="small"
                        loading={busy}
                        onPress={() => removeMember(m)}
                        icon={<TrashIcon size="sm" fill={theme.colors.error} />}
                        accessibilityLabel={`Remove ${m.name.displayName}`}
                      />
                    }
                  />
                </View>
              );
            })}
          </View>
        )}

        <TouchableOpacity
          disabled={savingDetails || !name.trim()}
          onPress={saveDetails}
          className={cn(
            'mt-5 py-3 rounded-[10px] items-center bg-primary flex-row justify-center gap-2',
            (savingDetails || !name.trim()) && 'opacity-60',
          )}
          accessibilityRole="button"
          accessibilityLabel="Save starter pack"
        >
          {savingDetails && <SpinnerIcon size={16} className="text-primary-foreground" />}
          <Text className="text-primary-foreground font-bold font-primary">
            {savingDetails ? 'Saving...' : 'Save changes'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={deletePack}
          className="mt-3 py-3 rounded-[10px] items-center border border-border"
          accessibilityRole="button"
          accessibilityLabel="Delete starter pack"
        >
          <Text className="text-destructive font-semibold font-primary">Delete starter pack</Text>
        </TouchableOpacity>
      </ScrollView>
    </ThemedView>
  );
}
