import React, { useCallback, useState } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, ScrollView, Switch } from 'react-native';
import { Header } from '@/components/Header';
import { colors } from '@/styles/colors';
import { useOxy } from '@oxyhq/services';
import { listsService } from '@/services/listsService';
import { router } from 'expo-router';

type MinimalUser = { id: string; username: string; name?: { full?: string } };

export default function CreateListScreen() {
  const { oxyServices } = useOxy();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
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
    setMembers((prev) => [...prev, u]);
  };
  const removeMember = (id: string) => setMembers((prev) => prev.filter((m) => m.id !== id));

  const onCreate = useCallback(async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await listsService.create({
        title: title.trim(),
        description: description.trim() || undefined,
        isPublic,
        memberOxyUserIds: members.map((m) => m.id),
      });
      router.replace('/lists');
    } catch (e) {
      console.error('Create list failed', e);
    } finally {
      setSaving(false);
    }
  }, [title, description, isPublic, members]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.primaryLight }}>
      <Header options={{ title: 'Create List', showBackButton: true }} />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={styles.label}>Title</Text>
        <TextInput value={title} onChangeText={setTitle} placeholder="Local Journalists" style={styles.input} />

        <Text style={styles.label}>Description</Text>
        <TextInput value={description} onChangeText={setDescription} placeholder="What is this list about?" style={[styles.input, { height: 80 }]} multiline />

        <View style={styles.row}>
          <Text style={styles.label}>Public</Text>
          <Switch value={isPublic} onValueChange={setIsPublic} />
        </View>

        <Text style={[styles.label, { marginTop: 12 }]}>Add Members</Text>
        <TextInput value={search} onChangeText={doSearch} placeholder="Search users" style={styles.input} />

        {results.length > 0 && (
          <View style={styles.resultsBox}>
            {results.map((u) => (
              <TouchableOpacity key={u.id} style={styles.resultRow} onPress={() => addMember(u)}>
                <Text style={styles.resultText}>@{u.username} {(u.name?.full ? `• ${u.name.full}` : '')}</Text>
                <Text style={{ color: colors.linkColor, fontWeight: '600' }}>Add</Text>
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

        <TouchableOpacity disabled={saving || !title.trim()} onPress={onCreate} style={[styles.createBtn, (!title.trim()) && { opacity: 0.6 } ]}>
          <Text style={styles.createBtnText}>{saving ? 'Saving…' : 'Create List'}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 14, color: colors.COLOR_BLACK_LIGHT_3, marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.COLOR_BLACK_LIGHT_6, borderRadius: 10, padding: 10, marginBottom: 10, color: colors.COLOR_BLACK_LIGHT_1, backgroundColor: colors.primaryLight },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  resultsBox: { borderWidth: 1, borderColor: colors.COLOR_BLACK_LIGHT_6, borderRadius: 10, overflow: 'hidden' },
  resultRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.COLOR_BLACK_LIGHT_6 },
  resultText: { color: colors.COLOR_BLACK_LIGHT_1 },
  memberChip: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  createBtn: { marginTop: 20, backgroundColor: colors.primaryColor, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  createBtnText: { color: colors.primaryLight, fontWeight: '700' },
});

