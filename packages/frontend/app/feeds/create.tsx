import React, { useCallback, useRef, useState } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, ScrollView, Switch, ActivityIndicator } from 'react-native';
import { Header } from '@/components/Header';
import Avatar from '@/components/Avatar';
import { colors } from '@/styles/colors';
import { useOxy } from '@oxyhq/services';
import { customFeedsService } from '@/services/customFeedsService';
import { listsService } from '@/services/listsService';
import { router } from 'expo-router';
import { toast } from '@/lib/sonner';

type MinimalUser = { id: string; username: string; name?: { full?: string } ; avatar?: any };

const CreateFeedScreen: React.FC = () => {
  const { oxyServices } = useOxy();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<MinimalUser[]>([]);
  const [members, setMembers] = useState<MinimalUser[]>([]);
  const [saving, setSaving] = useState(false);
  const [keywords, setKeywords] = useState('');
  const [includeReplies, setIncludeReplies] = useState(true);
  const [includeReposts, setIncludeReposts] = useState(true);
  const [includeMedia, setIncludeMedia] = useState(true);
  const [myLists, setMyLists] = useState<any[]>([]);
  const [selectedListIds, setSelectedListIds] = useState<string[]>([]);
  const [listsLoaded, setListsLoaded] = useState(false);
  const searchTimer = useRef<number | null>(null);

  

  const doSearch = useCallback((q: string) => {
    setSearch(q);
    if (searchTimer.current) { clearTimeout(searchTimer.current); }
    if (!q.trim()) { setResults([]); return; }
    // debounce quick typing
    searchTimer.current = window.setTimeout(async () => {
      try {
        const res = await oxyServices.searchProfiles(q.trim(), { limit: 8 });
        setResults(res as any);
      } catch (e) {
        console.warn('searchProfiles failed', e);
      }
    }, 300);
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
      await customFeedsService.create({
        title: title.trim(),
        description: description.trim() || undefined,
        isPublic,
        memberOxyUserIds: members.map((m) => m.id),
        keywords: keywords.split(',').map((s) => s.trim()).filter(Boolean),
        includeReplies,
        includeReposts,
        includeMedia,
        sourceListIds: selectedListIds,
      });
      toast.success('Feed created');
      router.replace('/feeds');
    } catch (e) {
      console.error('Create feed failed', e);
      toast.error('Create feed failed');
    } finally {
      setSaving(false);
    }
  }, [title, description, isPublic, members, keywords, includeReplies, includeReposts, includeMedia, selectedListIds]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.primaryLight }}>
      <Header options={{ title: 'Create Feed', showBackButton: true }} />
      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <Text style={styles.label}>Title</Text>
        <TextInput value={title} onChangeText={setTitle} placeholder="My awesome feed" style={styles.input} />

        <Text style={styles.label}>Description</Text>
        <TextInput value={description} onChangeText={setDescription} placeholder="What is this feed about?" style={[styles.input, { height: 80 }]} multiline />

        <Text style={styles.label}>Keywords (comma separated)</Text>
        <TextInput value={keywords} onChangeText={setKeywords} placeholder="cats, memes" style={styles.input} />

        <View style={styles.row}>
          <Text style={styles.label}>Public</Text>
          <Switch value={isPublic} onValueChange={setIsPublic} />
        </View>

        <View style={styles.row}><Text style={styles.label}>Include replies</Text><Switch value={includeReplies} onValueChange={setIncludeReplies} /></View>
        <View style={styles.row}><Text style={styles.label}>Include reposts</Text><Switch value={includeReposts} onValueChange={setIncludeReposts} /></View>
        <View style={styles.row}><Text style={styles.label}>Include media</Text><Switch value={includeMedia} onValueChange={setIncludeMedia} /></View>

        <Text style={[styles.label, { marginTop: 12 }]}>Add Lists (optional)</Text>
        <TouchableOpacity onPress={async () => {
          if (listsLoaded) { setMyLists([]); setListsLoaded(false); return; }
          try {
            const res = await listsService.list({ mine: true });
            setMyLists(res.items || []);
            setListsLoaded(true);
          } catch (e) { console.warn('load my lists failed', e); toast.error('Failed to load lists'); }
        }} style={[styles.createBtn, { backgroundColor: colors.COLOR_BLACK_LIGHT_8, alignItems: 'center' }]}>
          <Text style={{ color: colors.COLOR_BLACK_LIGHT_3, fontWeight: '600' }}>{listsLoaded ? 'Hide Lists' : 'Load My Lists'}</Text>
        </TouchableOpacity>
        {myLists.map((l) => {
          const id = String(l._id || l.id);
          const selected = selectedListIds.includes(id);
          return (
            <TouchableOpacity key={id} onPress={() => setSelectedListIds(prev => selected ? prev.filter(x => x !== id) : [...prev, id])} style={[styles.resultRow, { borderWidth: 1, borderColor: selected ? colors.primaryColor : colors.COLOR_BLACK_LIGHT_6, borderRadius: 8, marginTop: 6 }]}>
              <Text style={styles.resultText}>{l.title} • {(l.memberOxyUserIds || []).length} members</Text>
              <Text style={{ color: selected ? colors.primaryColor : colors.linkColor }}>{selected ? 'Selected' : 'Select'}</Text>
            </TouchableOpacity>
          );
        })}

  <Text style={[styles.label, { marginTop: 12 }]}>Add Members</Text>
  <TextInput value={search} onChangeText={doSearch} placeholder="Search users" style={styles.input} />

        {results.length > 0 && (
          <View style={styles.resultsBox}>
            {results.map((u) => (
              <TouchableOpacity key={u.id} style={styles.resultRow} onPress={() => addMember(u)}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Avatar source={u.avatar} size={36} style={{ marginRight: 10 }} />
                  <Text style={styles.resultText}>@{u.username} {(u.name?.full ? `• ${u.name.full}` : '')}</Text>
                </View>
                <Text style={{ color: colors.linkColor, fontWeight: '600' }}>Add</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {members.length > 0 && (
          <View style={{ marginTop: 10 }}>
            <Text style={styles.label}>Members</Text>
            {members.map((m) => (
              <View key={m.id} style={styles.memberChipRow}>
                <View style={styles.memberChipInner}>
                  <Avatar source={m.avatar} size={28} />
                  <Text style={{ color: colors.COLOR_BLACK_LIGHT_1, marginLeft: 8 }}>@{m.username}</Text>
                </View>
                <TouchableOpacity onPress={() => removeMember(m.id)}>
                  <Text style={{ color: colors.busy, marginLeft: 10, fontWeight: '600' }}>Remove</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        <TouchableOpacity disabled={saving || !title.trim()} onPress={onCreate} style={[styles.createBtn, (!title.trim()) && { opacity: 0.6 } ]}>
          {saving ? <ActivityIndicator color={colors.primaryLight} /> : <Text style={styles.createBtnText}>Create Feed</Text>}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
};

export default CreateFeedScreen;

const styles = StyleSheet.create({
  label: { fontSize: 14, color: colors.COLOR_BLACK_LIGHT_3, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: colors.COLOR_BLACK_LIGHT_6,
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
    color: colors.COLOR_BLACK_LIGHT_1,
    backgroundColor: colors.primaryLight,
  },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
  resultsBox: { borderWidth: 1, borderColor: colors.COLOR_BLACK_LIGHT_6, borderRadius: 10, overflow: 'hidden' },
  resultRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.COLOR_BLACK_LIGHT_6 },
  resultText: { color: colors.COLOR_BLACK_LIGHT_1 },
  memberChip: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  memberChipRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
  memberChipInner: { flexDirection: 'row', alignItems: 'center' },
  createBtn: { marginTop: 20, backgroundColor: colors.primaryColor, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  createBtnText: { color: colors.primaryLight, fontWeight: '700' },
});
