import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
} from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Avatar } from '@/components/Avatar';
import { Toggle } from '@/components/Toggle';
import { useTheme } from '@oxyhq/bloom/theme';
import { useAuth } from '@oxyhq/services';
import { customFeedsService } from '@/services/customFeedsService';
import { listsService } from '@/services/listsService';
import { router } from 'expo-router';
import { useSafeBack } from '@/hooks/useSafeBack';
import { show as toast } from '@oxyhq/bloom/toast';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { logger } from '@/lib/logger';

type MinimalUser = { id: string; username: string; name?: { full?: string }; avatar?: any };

const CreateFeedScreen: React.FC = () => {
  const theme = useTheme();
  const { oxyServices } = useAuth();
  const { t } = useTranslation();
  const safeBack = useSafeBack();
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

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, []);

  const doSearch = useCallback(
    (q: string) => {
      setSearch(q);
      if (searchTimer.current) clearTimeout(searchTimer.current);
      if (!q.trim()) {
        setResults([]);
        return;
      }
      searchTimer.current = setTimeout(async () => {
        try {
          const res = await oxyServices.searchProfiles(q.trim(), { limit: 8 });
          const data = (res as any)?.data ?? res;
          setResults(Array.isArray(data) ? data : []);
        } catch (e) {
          logger.warn('searchProfiles failed', { error: e });
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
      toast('Feed created', { type: 'success' });
      router.replace('/feeds');
    } catch (e) {
      logger.error('Create feed failed', { error: e });
      toast('Create feed failed', { type: 'error' });
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

  const handleLoadLists = useCallback(async () => {
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
      logger.warn('load my lists failed', { error: e });
      toast('Failed to load lists', { type: 'error' });
    }
  }, [listsLoaded]);

  const canCreate = title.trim().length > 0;

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('feeds.create.title', { defaultValue: 'Create feed' }),
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
          rightComponents: canCreate
            ? [
                <TouchableOpacity
                  key="create"
                  onPress={onCreate}
                  disabled={saving}
                  className="px-4 py-[7px] rounded-[20px] bg-primary"
                >
                  {saving ? (
                    <Loading variant="inline" size="small" style={{ flex: undefined }} />
                  ) : (
                    <Text className="text-white font-bold text-sm">
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
        <View className="rounded-2xl p-4 bg-secondary">
          <View className="gap-1">
            <Text className="text-sm font-semibold text-foreground">
              {t('feeds.create.titleLabel', { defaultValue: 'Feed name' })}
            </Text>
            <TextInput
              value={title}
              onChangeText={setTitle}
              placeholder={t('feeds.create.titlePlaceholder', {
                defaultValue: 'Enter a name for your feed',
              })}
              placeholderTextColor={theme.colors.textSecondary}
              style={styles.fieldInput}
              className="text-[15px] text-foreground"
              maxLength={64}
            />
          </View>

          <View style={styles.separator} className="bg-border" />

          <View className="gap-1">
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder={t('feeds.create.descriptionPlaceholder', {
                defaultValue: 'Enter a brief description.',
              })}
              placeholderTextColor={theme.colors.textSecondary}
              style={styles.fieldInput}
              className="text-[15px] text-foreground"
              multiline
              maxLength={300}
            />
          </View>

          <View style={styles.separator} className="bg-border" />

          <View className="flex-row items-center justify-between gap-4 py-1">
            <View className="flex-1 gap-1">
              <Text className="text-[15px] font-semibold text-foreground">
                {t('feeds.create.publicLabel', { defaultValue: 'Public feed' })}
              </Text>
              <Text className="text-[13px] leading-[18px] text-muted-foreground">
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
        <Text className="text-[13px] font-semibold uppercase tracking-wide mt-4 mb-1 px-1 text-muted-foreground">
          {t('feeds.create.inThisFeed', { defaultValue: 'In this feed' })}
        </Text>

        <View className="rounded-2xl p-4 bg-secondary">
          <TouchableOpacity
            className="flex-row items-center gap-3.5"
            onPress={() => setShowSearch(!showSearch)}
            activeOpacity={0.7}
          >
            <View className="w-10 h-10 rounded-full items-center justify-center bg-background">
              <Ionicons name="add" size={22} color={theme.colors.text} />
            </View>
            <Text className="text-[15px] font-medium text-foreground">
              {t('feeds.create.addProfilesOrTopics', {
                defaultValue: 'Add profiles or topics',
              })}
            </Text>
          </TouchableOpacity>

          {showSearch && (
            <View className="mt-3 gap-1">
              <TextInput
                value={search}
                onChangeText={doSearch}
                placeholder={t('feeds.create.searchUsersPlaceholder', {
                  defaultValue: 'Search profiles...',
                })}
                placeholderTextColor={theme.colors.textSecondary}
                style={styles.searchInput}
                className="text-[15px] text-foreground bg-background border border-border rounded-xl px-3.5 py-2.5"
                autoFocus
              />
              {results.map((u) => (
                <TouchableOpacity
                  key={u.id}
                  className="flex-row items-center gap-3 py-2.5"
                  onPress={() => addMember(u)}
                  activeOpacity={0.7}
                >
                  <Avatar source={u.avatar} size={40} />
                  <View className="flex-1 gap-px">
                    <Text className="text-[15px] font-semibold text-foreground" numberOfLines={1}>
                      {u.name?.full || u.username}
                    </Text>
                    <Text className="text-[13px] text-muted-foreground" numberOfLines={1}>
                      @{u.username}
                    </Text>
                  </View>
                  <View className="border border-border rounded-[10px] px-4 py-1.5">
                    <Text className="text-[13px] font-semibold text-foreground">
                      {t('feeds.create.add', { defaultValue: 'Add' })}
                    </Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* Added members */}
          {members.map((m) => (
            <View key={m.id} className="flex-row items-center gap-3 py-2.5 mt-1">
              <Avatar source={m.avatar} size={40} />
              <View className="flex-1 gap-px">
                <Text className="text-[15px] font-semibold text-foreground" numberOfLines={1}>
                  {m.name?.full || m.username}
                </Text>
                <Text className="text-[13px] text-muted-foreground" numberOfLines={1}>
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
          className="flex-row items-center gap-1.5 py-3 px-1"
          onPress={() => setShowAdvanced(!showAdvanced)}
          activeOpacity={0.7}
        >
          <Ionicons
            name={showAdvanced ? 'chevron-up' : 'chevron-down'}
            size={18}
            color={theme.colors.textSecondary}
          />
          <Text className="text-sm font-medium text-muted-foreground">
            {t('feeds.create.advancedSettings', { defaultValue: 'Advanced settings' })}
          </Text>
        </TouchableOpacity>

        {showAdvanced && (
          <View className="rounded-2xl p-4 bg-secondary">
            <View className="gap-1">
              <Text className="text-sm font-semibold text-foreground">
                {t('feeds.create.keywordsLabel', { defaultValue: 'Keywords' })}
              </Text>
              <TextInput
                value={keywords}
                onChangeText={setKeywords}
                placeholder={t('feeds.create.keywordsPlaceholder', {
                  defaultValue: 'cooking, recipes, food',
                })}
                placeholderTextColor={theme.colors.textSecondary}
                style={styles.fieldInput}
                className="text-[15px] text-foreground"
              />
            </View>

            <View style={styles.separator} className="bg-border" />

            <View className="flex-row items-center justify-between gap-4 py-1">
              <Text className="text-[15px] font-semibold text-foreground flex-1">
                {t('feeds.create.includeReplies', { defaultValue: 'Include replies' })}
              </Text>
              <Toggle value={includeReplies} onValueChange={setIncludeReplies} />
            </View>

            <View style={styles.separator} className="bg-border" />

            <View className="flex-row items-center justify-between gap-4 py-1">
              <Text className="text-[15px] font-semibold text-foreground flex-1">
                {t('feeds.create.includeReposts', { defaultValue: 'Include reposts' })}
              </Text>
              <Toggle value={includeReposts} onValueChange={setIncludeReposts} />
            </View>

            <View style={styles.separator} className="bg-border" />

            <View className="flex-row items-center justify-between gap-4 py-1">
              <Text className="text-[15px] font-semibold text-foreground flex-1">
                {t('feeds.create.includeMedia', { defaultValue: 'Include media' })}
              </Text>
              <Toggle value={includeMedia} onValueChange={setIncludeMedia} />
            </View>

            <View style={styles.separator} className="bg-border" />

            {/* Import from lists */}
            <TouchableOpacity
              onPress={handleLoadLists}
              className="flex-row items-center justify-between gap-4 py-1"
              activeOpacity={0.7}
            >
              <Text className="text-[15px] font-semibold text-foreground flex-1">
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
                  <Text className="text-sm flex-1 text-foreground">
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

        <View className="h-10" />
      </ScrollView>
    </ThemedView>
  );
};

export default CreateFeedScreen;

const styles = StyleSheet.create({
  scrollContent: {
    padding: 16,
    gap: 8,
  },
  fieldInput: {
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
  searchInput: {
    ...Platform.select({
      web: { outlineStyle: 'none' as any },
    }),
  },
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
});
