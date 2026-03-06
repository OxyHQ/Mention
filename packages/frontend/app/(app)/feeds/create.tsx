import React, { useCallback, useRef, useState } from 'react';
import { View, Text, TextInput, StyleSheet, TouchableOpacity, ScrollView, Switch } from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import Avatar from '@/components/Avatar';
import { useTheme } from '@/hooks/useTheme';
import { useAuth } from '@oxyhq/services';
import { customFeedsService } from '@/services/customFeedsService';
import { listsService } from '@/services/listsService';
import { router } from 'expo-router';
import { toast } from '@/lib/sonner';
import { useTranslation } from 'react-i18next';

type MinimalUser = { id: string; username: string; name?: { full?: string }; avatar?: any };

const CreateFeedScreen: React.FC = () => {
  const theme = useTheme();
  const { oxyServices } = useAuth();
  const { t } = useTranslation();
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
    <ThemedView style={{ flex: 1 }}>
      <Header
        options={{
          title: t('feeds.create.title'),
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
        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>{t('feeds.create.titleLabel')}</Text>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder={t('feeds.create.titlePlaceholder')}
          placeholderTextColor={theme.colors.textSecondary}
          style={[styles.input, {
            color: theme.colors.text,
            backgroundColor: theme.colors.backgroundSecondary,
            borderColor: theme.colors.border
          }]}
        />

        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>{t('feeds.create.descriptionLabel')}</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          placeholder={t('feeds.create.descriptionPlaceholder')}
          placeholderTextColor={theme.colors.textSecondary}
          style={[styles.input, {
            height: 80,
            color: theme.colors.text,
            backgroundColor: theme.colors.backgroundSecondary,
            borderColor: theme.colors.border
          }]}
          multiline
        />

        <Text style={[styles.label, { color: theme.colors.textSecondary }]}>{t('feeds.create.keywordsLabel')}</Text>
        <TextInput
          value={keywords}
          onChangeText={setKeywords}
          placeholder={t('feeds.create.keywordsPlaceholder')}
          placeholderTextColor={theme.colors.textSecondary}
          style={[styles.input, {
            color: theme.colors.text,
            backgroundColor: theme.colors.backgroundSecondary,
            borderColor: theme.colors.border
          }]}
        />

        <View style={styles.row}>
          <Text style={[styles.label, { color: theme.colors.textSecondary }]}>{t('feeds.create.publicLabel')}</Text>
          <Switch value={isPublic} onValueChange={setIsPublic} />
        </View>

        <View style={styles.row}>
          <Text style={[styles.label, { color: theme.colors.textSecondary }]}>{t('feeds.create.includeReplies')}</Text>
          <Switch value={includeReplies} onValueChange={setIncludeReplies} />
        </View>
        <View style={styles.row}>
          <Text style={[styles.label, { color: theme.colors.textSecondary }]}>{t('feeds.create.includeReposts')}</Text>
          <Switch value={includeReposts} onValueChange={setIncludeReposts} />
        </View>
        <View style={styles.row}>
          <Text style={[styles.label, { color: theme.colors.textSecondary }]}>{t('feeds.create.includeMedia')}</Text>
          <Switch value={includeMedia} onValueChange={setIncludeMedia} />
        </View>

        <Text style={[styles.label, { marginTop: 12, color: theme.colors.textSecondary }]}>{t('feeds.create.addLists')}</Text>
        <TouchableOpacity onPress={async () => {
          if (listsLoaded) { setMyLists([]); setListsLoaded(false); return; }
          try {
            const res = await listsService.list({ mine: true });
            setMyLists(res.items || []);
            setListsLoaded(true);
          } catch (e) { console.warn('load my lists failed', e); toast.error('Failed to load lists'); }
        }} style={[styles.createBtn, { backgroundColor: theme.colors.backgroundSecondary, alignItems: 'center' }]}>
          <Text style={{ color: theme.colors.text, fontWeight: '600' }}>
            {listsLoaded ? t('feeds.create.hideLists') : t('feeds.create.loadMyLists')}
          </Text>
        </TouchableOpacity>
        {myLists.map((l) => {
          const id = String(l._id || l.id);
          const selected = selectedListIds.includes(id);
          return (
            <TouchableOpacity
              key={id}
              onPress={() => setSelectedListIds(prev => selected ? prev.filter(x => x !== id) : [...prev, id])}
              style={[styles.resultRow, {
                borderWidth: 1,
                borderColor: selected ? theme.colors.primary : theme.colors.border,
                borderRadius: 8,
                marginTop: 6,
                backgroundColor: selected ? `${theme.colors.primary}15` : 'transparent'
              }]}
            >
              <Text style={[styles.resultText, { color: theme.colors.text }]}>
                {l.title} • {(l.memberOxyUserIds || []).length} members
              </Text>
              <Text style={{ color: selected ? theme.colors.primary : theme.colors.textSecondary }}>
                {selected ? t('feeds.create.selected') : t('feeds.create.select')}
              </Text>
            </TouchableOpacity>
          );
        })}

        <Text style={[styles.label, { marginTop: 12, color: theme.colors.textSecondary }]}>{t('feeds.create.addMembers')}</Text>
        <TextInput
          value={search}
          onChangeText={doSearch}
          placeholder={t('feeds.create.searchUsersPlaceholder')}
          placeholderTextColor={theme.colors.textSecondary}
          style={[styles.input, {
            color: theme.colors.text,
            backgroundColor: theme.colors.backgroundSecondary,
            borderColor: theme.colors.border
          }]}
        />

        {results.length > 0 && (
          <View style={[styles.resultsBox, { borderColor: theme.colors.border }]}>
            {results.map((u) => (
              <TouchableOpacity key={u.id} style={[styles.resultRow, { borderBottomColor: theme.colors.border }]} onPress={() => addMember(u)}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Avatar source={u.avatar} size={36} style={{ marginRight: 10 }} />
                  <Text style={[styles.resultText, { color: theme.colors.text }]}>
                    @{u.username} {(u.name?.full ? `• ${u.name.full}` : '')}
                  </Text>
                </View>
                <Text style={{ color: theme.colors.primary, fontWeight: '600' }}>{t('feeds.create.add')}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {members.length > 0 && (
          <View style={{ marginTop: 10 }}>
            <Text style={[styles.label, { color: theme.colors.textSecondary }]}>{t('feeds.create.members')}</Text>
            {members.map((m) => (
              <View key={m.id} style={styles.memberChipRow}>
                <View style={styles.memberChipInner}>
                  <Avatar source={m.avatar} size={28} />
                  <Text style={{ color: theme.colors.text, marginLeft: 8 }}>@{m.username}</Text>
                </View>
                <TouchableOpacity onPress={() => removeMember(m.id)}>
                  <Text style={{ color: theme.colors.error || '#ff4444', marginLeft: 10, fontWeight: '600' }}>
                    {t('feeds.create.remove')}
                  </Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        <TouchableOpacity
          disabled={saving || !title.trim()}
          onPress={onCreate}
          style={[
            styles.createBtn,
            { backgroundColor: theme.colors.primary },
            (!title.trim()) && { opacity: 0.6 }
          ]}
        >
          {saving ? (
            <Loading variant="inline" size="small" style={{ flex: undefined }} />
          ) : (
            <Text style={[styles.createBtnText, { color: theme.colors.card }]}>{t('feeds.create.createButton')}</Text>
          )}
        </TouchableOpacity>
      </ScrollView>
    </ThemedView>
  );
};

export default CreateFeedScreen;

const styles = StyleSheet.create({
  label: {
    fontSize: 14,
    marginBottom: 6
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10
  },
  resultsBox: {
    borderWidth: 1,
    borderRadius: 10,
    overflow: 'hidden'
  },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  resultText: {},
  memberChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6
  },
  memberChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8
  },
  memberChipInner: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  createBtn: {
    marginTop: 20,
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center'
  },
  createBtnText: {
    fontWeight: '700' as '700'
  },
});
