import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
} from 'react-native';
import { Loading } from '@/components/ui/Loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import Avatar from '@/components/Avatar';
import { Toggle } from '@/components/Toggle';
import { useTheme } from '@/hooks/useTheme';
import { useAuth } from '@oxyhq/services';
import { customFeedsService } from '@/services/customFeedsService';
import { listsService } from '@/services/listsService';
import { router } from 'expo-router';
import { toast } from '@/lib/sonner';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';

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
  const [showSearch, setShowSearch] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Advanced options
  const [keywords, setKeywords] = useState('');
  const [includeReplies, setIncludeReplies] = useState(true);
  const [includeReposts, setIncludeReposts] = useState(true);
  const [includeMedia, setIncludeMedia] = useState(true);
  const [myLists, setMyLists] = useState<any[]>([]);
  const [selectedListIds, setSelectedListIds] = useState<string[]>([]);
  const [listsLoaded, setListsLoaded] = useState(false);

  const searchTimer = useRef<number | null>(null);

  const doSearch = useCallback(
    (q: string) => {
      setSearch(q);
      if (searchTimer.current) clearTimeout(searchTimer.current);
      if (!q.trim()) {
        setResults([]);
        return;
      }
      searchTimer.current = window.setTimeout(async () => {
        try {
          const res = await oxyServices.searchProfiles(q.trim(), { limit: 8 });
          setResults(res as any);
        } catch (e) {
          console.warn('searchProfiles failed', e);
        }
      }, 300);
    },
    [oxyServices],
  );

  const addMember = (u: MinimalUser) => {
    if (members.find((m) => m.id === u.id)) return;
    setMembers((prev) => [...prev, u]);
    setSearch('');
    setResults([]);
  };

  const removeMember = (id: string) =>
    setMembers((prev) => prev.filter((m) => m.id !== id));

  const onCreate = useCallback(async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      await customFeedsService.create({
        title: title.trim(),
        description: description.trim() || undefined,
        isPublic,
        memberOxyUserIds: members.map((m) => m.id),
        keywords: keywords
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
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
  }, [
    title,
    description,
    isPublic,
    members,
    keywords,
    includeReplies,
    includeReposts,
    includeMedia,
    selectedListIds,
  ]);

  const canCreate = title.trim().length > 0;

  return (
    <ThemedView style={styles.container}>
      <Header
        options={{
          title: t('feeds.create.title', { defaultValue: 'Create feed' }),
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </IconButton>,
          ],
          rightComponents: canCreate
            ? [
                <TouchableOpacity
                  key="create"
                  onPress={onCreate}
                  disabled={saving}
                  style={[styles.headerCreateBtn, { backgroundColor: theme.colors.primary }]}
                >
                  {saving ? (
                    <Loading variant="inline" size="small" style={{ flex: undefined }} />
                  ) : (
                    <Text style={styles.headerCreateText}>
                      {t('feeds.create.createButton', { defaultValue: 'Create' })}
                    </Text>
                  )}
                </TouchableOpacity>,
              ]
            : [],
        }}
        hideBottomBorder
        disableSticky
      />

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Main card: name, description, public toggle */}
        <View style={[styles.card, { backgroundColor: theme.colors.backgroundSecondary }]}>
          <View style={styles.fieldGroup}>
            <Text style={[styles.fieldLabel, { color: theme.colors.text }]}>
              {t('feeds.create.titleLabel', { defaultValue: 'Feed name' })}
            </Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder={t('feeds.create.titlePlaceholder', {
                defaultValue: 'Enter a name for your feed',
              })}
              placeholderTextColor={theme.colors.textSecondary}
              style={[styles.fieldInput, { color: theme.colors.text }]}
              maxLength={64}
            />
          </View>

          <View style={[styles.separator, { backgroundColor: theme.colors.border }]} />

          <View style={styles.fieldGroup}>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder={t('feeds.create.descriptionPlaceholder', {
                defaultValue: 'Enter a brief description.',
              })}
              placeholderTextColor={theme.colors.textSecondary}
              style={[styles.fieldInput, { color: theme.colors.text }]}
              multiline
              maxLength={300}
            />
          </View>

          <View style={[styles.separator, { backgroundColor: theme.colors.border }]} />

          <View style={styles.toggleRow}>
            <View style={styles.toggleInfo}>
              <Text style={[styles.toggleLabel, { color: theme.colors.text }]}>
                {t('feeds.create.publicLabel', { defaultValue: 'Public feed' })}
              </Text>
              <Text style={[styles.toggleDescription, { color: theme.colors.textSecondary }]}>
                {t('feeds.create.publicDescription', {
                  defaultValue:
                    'When this is on, anyone can see and share this feed. The feed and its profiles may be suggested for others to follow.',
                })}
              </Text>
            </View>
            <Toggle value={isPublic} onValueChange={setIsPublic} />
          </View>
        </View>

        {/* In this feed section */}
        <Text style={[styles.sectionLabel, { color: theme.colors.textSecondary }]}>
          {t('feeds.create.inThisFeed', { defaultValue: 'In this feed' })}
        </Text>

        <View style={[styles.card, { backgroundColor: theme.colors.backgroundSecondary }]}>
          <TouchableOpacity
            style={styles.addProfilesRow}
            onPress={() => setShowSearch(!showSearch)}
            activeOpacity={0.7}
          >
            <View style={[styles.addIcon, { backgroundColor: theme.colors.background }]}>
              <Ionicons name="add" size={22} color={theme.colors.text} />
            </View>
            <Text style={[styles.addProfilesText, { color: theme.colors.text }]}>
              {t('feeds.create.addProfilesOrTopics', {
                defaultValue: 'Add profiles or topics',
              })}
            </Text>
          </TouchableOpacity>

          {showSearch && (
            <View style={styles.searchSection}>
              <TextInput
                value={search}
                onChangeText={doSearch}
                placeholder={t('feeds.create.searchUsersPlaceholder', {
                  defaultValue: 'Search profiles...',
                })}
                placeholderTextColor={theme.colors.textSecondary}
                style={[
                  styles.searchInput,
                  {
                    color: theme.colors.text,
                    backgroundColor: theme.colors.background,
                    borderColor: theme.colors.border,
                  },
                ]}
                autoFocus
              />
              {results.map((u) => (
                <TouchableOpacity
                  key={u.id}
                  style={styles.resultRow}
                  onPress={() => addMember(u)}
                  activeOpacity={0.7}
                >
                  <Avatar source={u.avatar} size={40} />
                  <View style={styles.resultInfo}>
                    <Text style={[styles.resultName, { color: theme.colors.text }]} numberOfLines={1}>
                      {u.name?.full || u.username}
                    </Text>
                    <Text style={[styles.resultHandle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                      @{u.username}
                    </Text>
                  </View>
                  <TouchableOpacity
                    onPress={() => addMember(u)}
                    style={[styles.addBtn, { borderColor: theme.colors.border }]}
                  >
                    <Text style={[styles.addBtnText, { color: theme.colors.text }]}>
                      {t('feeds.create.add', { defaultValue: 'Add' })}
                    </Text>
                  </TouchableOpacity>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Added members */}
          {members.map((m) => (
            <View key={m.id} style={styles.memberRow}>
              <Avatar source={m.avatar} size={40} />
              <View style={styles.resultInfo}>
                <Text style={[styles.resultName, { color: theme.colors.text }]} numberOfLines={1}>
                  {m.name?.full || m.username}
                </Text>
                <Text style={[styles.resultHandle, { color: theme.colors.textSecondary }]} numberOfLines={1}>
                  @{m.username}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => removeMember(m.id)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Ionicons name="close-circle" size={22} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            </View>
          ))}
        </View>

        {/* Advanced settings */}
        <TouchableOpacity
          style={styles.advancedToggle}
          onPress={() => setShowAdvanced(!showAdvanced)}
          activeOpacity={0.7}
        >
          <Ionicons
            name={showAdvanced ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={theme.colors.textSecondary}
          />
          <Text style={[styles.advancedToggleText, { color: theme.colors.textSecondary }]}>
            {t('feeds.create.advancedSettings', { defaultValue: 'Advanced settings' })}
          </Text>
        </TouchableOpacity>

        {showAdvanced && (
          <View style={[styles.card, { backgroundColor: theme.colors.backgroundSecondary }]}>
            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: theme.colors.text }]}>
                {t('feeds.create.keywordsLabel', { defaultValue: 'Keywords' })}
              </Text>
              <TextInput
                value={keywords}
                onChangeText={setKeywords}
                placeholder={t('feeds.create.keywordsPlaceholder', {
                  defaultValue: 'cooking, recipes, food',
                })}
                placeholderTextColor={theme.colors.textSecondary}
                style={[styles.fieldInput, { color: theme.colors.text }]}
              />
            </View>

            <View style={[styles.separator, { backgroundColor: theme.colors.border }]} />

            <View style={styles.toggleRow}>
              <Text style={[styles.toggleLabel, { color: theme.colors.text, flex: 1 }]}>
                {t('feeds.create.includeReplies', { defaultValue: 'Include replies' })}
              </Text>
              <Toggle value={includeReplies} onValueChange={setIncludeReplies} />
            </View>

            <View style={[styles.separator, { backgroundColor: theme.colors.border }]} />

            <View style={styles.toggleRow}>
              <Text style={[styles.toggleLabel, { color: theme.colors.text, flex: 1 }]}>
                {t('feeds.create.includeReposts', { defaultValue: 'Include reposts' })}
              </Text>
              <Toggle value={includeReposts} onValueChange={setIncludeReposts} />
            </View>

            <View style={[styles.separator, { backgroundColor: theme.colors.border }]} />

            <View style={styles.toggleRow}>
              <Text style={[styles.toggleLabel, { color: theme.colors.text, flex: 1 }]}>
                {t('feeds.create.includeMedia', { defaultValue: 'Include media' })}
              </Text>
              <Toggle value={includeMedia} onValueChange={setIncludeMedia} />
            </View>

            <View style={[styles.separator, { backgroundColor: theme.colors.border }]} />

            {/* Import from lists */}
            <TouchableOpacity
              onPress={async () => {
                if (listsLoaded) {
                  setMyLists([]);
                  setListsLoaded(false);
                  return;
                }
                try {
                  const res = await listsService.list({ mine: true });
                  setMyLists(res.items || []);
                  setListsLoaded(true);
                } catch (e) {
                  console.warn('load my lists failed', e);
                  toast.error('Failed to load lists');
                }
              }}
              style={styles.toggleRow}
              activeOpacity={0.7}
            >
              <Text style={[styles.toggleLabel, { color: theme.colors.text, flex: 1 }]}>
                {t('feeds.create.addLists', { defaultValue: 'Import from lists' })}
              </Text>
              <Ionicons
                name={listsLoaded ? 'chevron-up' : 'chevron-down'}
                size={18}
                color={theme.colors.textSecondary}
              />
            </TouchableOpacity>

            {myLists.map((l) => {
              const id = String(l._id || l.id);
              const selected = selectedListIds.includes(id);
              return (
                <TouchableOpacity
                  key={id}
                  onPress={() =>
                    setSelectedListIds((prev) =>
                      selected ? prev.filter((x) => x !== id) : [...prev, id],
                    )
                  }
                  style={[
                    styles.listRow,
                    {
                      borderColor: selected ? theme.colors.primary : theme.colors.border,
                      backgroundColor: selected ? `${theme.colors.primary}15` : 'transparent',
                    },
                  ]}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.listRowText, { color: theme.colors.text }]}>
                    {l.title} {'\u00B7'} {(l.memberOxyUserIds || []).length} members
                  </Text>
                  <Ionicons
                    name={selected ? 'checkmark-circle' : 'ellipse-outline'}
                    size={20}
                    color={selected ? theme.colors.primary : theme.colors.textSecondary}
                  />
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </ThemedView>
  );
};

export default CreateFeedScreen;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    gap: 8,
  },
  // Header create button
  headerCreateBtn: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 20,
  },
  headerCreateText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  // Cards
  card: {
    borderRadius: 16,
    padding: 16,
  },
  fieldGroup: {
    gap: 4,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  fieldInput: {
    fontSize: 15,
    paddingVertical: 4,
    minHeight: 24,
    ...Platform.select({
      web: { outlineStyle: 'none' as any },
    }),
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 12,
  },
  // Toggle rows
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingVertical: 4,
  },
  toggleInfo: {
    flex: 1,
    gap: 4,
  },
  toggleLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  toggleDescription: {
    fontSize: 13,
    lineHeight: 18,
  },
  // Section labels
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 16,
    marginBottom: 4,
    paddingHorizontal: 4,
  },
  // Add profiles
  addProfilesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  addIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addProfilesText: {
    fontSize: 15,
    fontWeight: '500',
  },
  // Search
  searchSection: {
    marginTop: 12,
    gap: 4,
  },
  searchInput: {
    fontSize: 15,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    ...Platform.select({
      web: { outlineStyle: 'none' as any },
    }),
  },
  // Result/member rows
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    marginTop: 4,
  },
  resultInfo: {
    flex: 1,
    gap: 1,
  },
  resultName: {
    fontSize: 15,
    fontWeight: '600',
  },
  resultHandle: {
    fontSize: 13,
  },
  addBtn: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  addBtnText: {
    fontSize: 13,
    fontWeight: '600',
  },
  // Advanced
  advancedToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 12,
    paddingHorizontal: 4,
  },
  advancedToggleText: {
    fontSize: 14,
    fontWeight: '500',
  },
  // List rows
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 8,
  },
  listRowText: {
    fontSize: 14,
    flex: 1,
  },
});
