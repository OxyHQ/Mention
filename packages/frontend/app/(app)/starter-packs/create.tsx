import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, ScrollView, Platform } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useAuth } from '@oxyhq/services';
import { starterPacksService } from '@/services/starterPacksService';
import { router } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { logger } from '@/lib/logger';

type MinimalUser = { id: string; username: string; name?: { full?: string } };

export default function CreateStarterPackScreen() {
  const { oxyServices } = useAuth();
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<MinimalUser[]>([]);
  const [members, setMembers] = useState<MinimalUser[]>([]);
  const [saving, setSaving] = useState(false);

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  const doSearch = useCallback((q: string) => {
    setSearch(q);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (!q.trim()) { setResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      try {
        const res = await oxyServices.searchProfiles(q.trim(), { limit: 8 });
        const data = (res as any)?.data ?? res;
        setResults(Array.isArray(data) ? data : []);
      } catch (e) {
        logger.warn('searchProfiles failed', { error: e });
      }
    }, 300);
  }, [oxyServices]);

  const addMember = (u: MinimalUser) => {
    if (members.find((m) => m.id === u.id)) return;
    if (members.length >= 150) return;
    setMembers((prev) => [...prev, u]);
  };
  const removeMember = (id: string) => setMembers((prev) => prev.filter((m) => m.id !== id));

  const onCreate = useCallback(async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await starterPacksService.create({
        name: name.trim(),
        description: description.trim() || undefined,
        memberOxyUserIds: members.map((m) => m.id),
      });
      router.replace('/starter-packs');
    } catch (e) {
      logger.error('Create starter pack failed', { error: e });
    } finally {
      setSaving(false);
    }
  }, [name, description, members]);

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('starterPacks.create'),
          leftComponents: [
            <IconButton variant="icon"
              key="back"
              onPress={() => safeBack()}
            >
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text className="text-sm text-muted-foreground mb-1.5 font-primary">Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. Tech people to follow"
          className="border border-border rounded-[10px] p-2.5 mb-2.5 text-foreground bg-background font-primary"
          style={styles.input}
        />

        <Text className="text-sm text-muted-foreground mb-1.5 font-primary">Description</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder={t('starterPacks.descriptionPlaceholder')}
          className="border border-border rounded-[10px] p-2.5 mb-2.5 text-foreground bg-background font-primary h-20"
          style={styles.input}
          multiline
        />

        <Text className="text-sm text-muted-foreground mb-1.5 mt-3 font-primary">Add accounts ({members.length}/150)</Text>
        <TextInput
          value={search}
          onChangeText={doSearch}
          placeholder={t('starterPacks.searchUsersPlaceholder')}
          className="border border-border rounded-[10px] p-2.5 mb-2.5 text-foreground bg-background font-primary"
          style={styles.input}
        />

        {results.length > 0 && (
          <View className="border border-border rounded-[10px] overflow-hidden">
            {results.map((u) => (
              <TouchableOpacity key={u.id} className="flex-row items-center justify-between px-3 py-2.5 border-b border-border" onPress={() => addMember(u)}>
                <Text className="text-foreground font-primary">@{u.username} {(u.name?.full ? `· ${u.name.full}` : '')}</Text>
                <Text className="text-primary font-semibold font-primary">Add</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {members.length > 0 && (
          <View className="mt-2.5">
            <Text className="text-sm text-muted-foreground mb-1.5 font-primary">Members</Text>
            {members.map((m) => (
              <View key={m.id} className="flex-row items-center py-1.5">
                <Text className="text-foreground">@{m.username}</Text>
                <TouchableOpacity onPress={() => removeMember(m.id)}>
                  <Text className="text-destructive ml-2.5">Remove</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        <TouchableOpacity
          disabled={saving || !name.trim()}
          onPress={onCreate}
          className={cn(
            "mt-5 py-3 rounded-[10px] items-center bg-primary",
            !name.trim() && "opacity-60"
          )}
        >
          <Text className="text-primary-foreground font-bold font-primary">{saving ? 'Creating...' : 'Create Starter Pack'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  input: {
    ...Platform.select({
      web: { outlineStyle: 'none' as any },
    }),
  },
});
