import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { colors } from '@/styles/colors';
import { FONT_FAMILIES } from '@/styles/typography';
import { useAuth } from '@oxyhq/services';
import { starterPacksService } from '@/services/starterPacksService';
import { router } from 'expo-router';
import { useTheme } from '@/hooks/useTheme';

type MinimalUser = { id: string; username: string; name?: { full?: string } };

export default function CreateStarterPackScreen() {
  const { oxyServices } = useAuth();
  const theme = useTheme();
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
    <ThemedView style={{ flex: 1 }}>
      <Header
        options={{
          title: 'Create Starter Pack',
          leftComponents: [
            <IconButton variant="icon"
              key="back"
              onPress={() => router.back()}
            >
              <BackArrowIcon size={20} color={theme.colors.text} />
            </IconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={styles.label}>Name</Text>
        <TextInput value={name} onChangeText={setName} placeholder="e.g. Tech people to follow" style={styles.input} />

        <Text style={styles.label}>Description</Text>
        <TextInput value={description} onChangeText={setDescription} placeholder="What's this pack about?" style={[styles.input, { height: 80 }]} multiline />

        <Text style={[styles.label, { marginTop: 12 }]}>Add accounts ({members.length}/150)</Text>
        <TextInput value={search} onChangeText={doSearch} placeholder="Search for users..." style={styles.input} />

        {results.length > 0 && (
          <View style={styles.resultsBox}>
            {results.map((u) => (
              <TouchableOpacity key={u.id} style={styles.resultRow} onPress={() => addMember(u)}>
                <Text style={styles.resultText}>@{u.username} {(u.name?.full ? `· ${u.name.full}` : '')}</Text>
                <Text style={{ color: colors.linkColor, fontWeight: '600', fontFamily: FONT_FAMILIES.primary }}>Add</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {members.length > 0 && (
          <View style={{ marginTop: 10 }}>
            <Text style={styles.label}>Members</Text>
            {members.map((m) => (
              <View key={m.id} style={styles.memberChip}>
                <Text style={{ color: colors.COLOR_BLACK_LIGHT_1 }}>@{m.username}</Text>
                <TouchableOpacity onPress={() => removeMember(m.id)}>
                  <Text style={{ color: colors.busy, marginLeft: 10 }}>Remove</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        <TouchableOpacity disabled={saving || !name.trim()} onPress={onCreate} style={[styles.createBtn, (!name.trim()) && { opacity: 0.6 }]}>
          <Text style={styles.createBtnText}>{saving ? 'Creating...' : 'Create Starter Pack'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 14, color: colors.COLOR_BLACK_LIGHT_3, marginBottom: 6, fontFamily: FONT_FAMILIES.primary },
  input: { borderWidth: 1, borderColor: colors.COLOR_BLACK_LIGHT_6, borderRadius: 10, padding: 10, marginBottom: 10, color: colors.COLOR_BLACK_LIGHT_1, backgroundColor: colors.primaryLight, fontFamily: FONT_FAMILIES.primary },
  resultsBox: { borderWidth: 1, borderColor: colors.COLOR_BLACK_LIGHT_6, borderRadius: 10, overflow: 'hidden' },
  resultRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.COLOR_BLACK_LIGHT_6 },
  resultText: { color: colors.COLOR_BLACK_LIGHT_1, fontFamily: FONT_FAMILIES.primary },
  memberChip: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  createBtn: { marginTop: 20, backgroundColor: colors.primaryColor, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  createBtnText: { color: colors.primaryLight, fontWeight: '700', fontFamily: FONT_FAMILIES.primary },
});
