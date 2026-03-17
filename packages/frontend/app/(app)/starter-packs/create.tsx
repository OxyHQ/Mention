import React, { useCallback, useState } from 'react';
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

type MinimalUser = { id: string; username: string; name?: { full?: string } };

export default function CreateStarterPackScreen() {
  const { oxyServices } = useAuth();
  const safeBack = useSafeBack();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<MinimalUser[]>([]);
  const [members, setMembers] = useState<MinimalUser[]>([]);
  const [saving, setSaving] = useState(false);

  const doSearch = useCallback(async (q: string) => {
    try {
      setSearch(q);
      if (!q.trim()) { setResults([]); return; }
      const res = await oxyServices.searchProfiles(q.trim(), { limit: 8 });
      setResults(res as any);
    } catch (e) {
      console.warn('searchProfiles failed', e);
    }
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
      console.error('Create starter pack failed', e);
    } finally {
      setSaving(false);
    }
  }, [name, description, members]);

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: 'Create Starter Pack',
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
          placeholder="What's this pack about?"
          className="border border-border rounded-[10px] p-2.5 mb-2.5 text-foreground bg-background font-primary h-20"
          style={styles.input}
          multiline
        />

        <Text className="text-sm text-muted-foreground mb-1.5 mt-3 font-primary">Add accounts ({members.length}/150)</Text>
        <TextInput
          value={search}
          onChangeText={doSearch}
          placeholder="Search for users..."
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
