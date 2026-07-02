import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Platform, StyleSheet } from 'react-native';
import { Loading } from '@oxyhq/bloom/loading';
import { Ionicons } from '@expo/vector-icons';
import { Avatar } from '@oxyhq/bloom/avatar';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { show as toast } from '@oxyhq/bloom/toast';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { User } from '@oxyhq/core';
import { getNormalizedUserHandle } from '@oxyhq/core';
import type {
  CustomFeed,
  FeedDefinitionInput,
  FeedDefinitionMode,
  FeedModuleRef,
  FeedVisibility,
  ModuleCatalogEntry,
  ModuleParamProperty,
} from '@mention/shared-types';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Toggle } from '@/components/Toggle';
import { useTheme } from '@oxyhq/bloom/theme';
import { useAuth } from '@oxyhq/services';
import { useSafeBack } from '@/hooks/useSafeBack';
import { customFeedsService } from '@/services/customFeedsService';
import { useFeedModules } from '@/hooks/useFeedModules';
import Feed from '@/components/Feed/Feed';
import { logger } from '@/lib/logger';

type MinimalUser = Pick<User, 'id' | 'username' | 'name' | 'avatar'>;
type ModuleState = { enabled: boolean; params: Record<string, unknown> };
type ModuleStates = Record<string, ModuleState>;

/** Turn a camelCase / snake_case module or param id into a readable fallback label. */
function humanize(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

function accountName(u: MinimalUser): string {
  return u.name?.displayName ?? u.username;
}

function toMinimal(u: User): MinimalUser {
  return { id: u.id, username: u.username, name: u.name, avatar: u.avatar };
}

/** Seed builder module state from a stored definition's module refs. */
function statesFromRefs(refs: FeedModuleRef[] | undefined): ModuleStates {
  const out: ModuleStates = {};
  for (const ref of refs ?? []) {
    out[ref.module] = { enabled: ref.enabled, params: ref.params ?? {} };
  }
  return out;
}

/** Drop empty / NaN param values so the persisted definition stays minimal. */
function cleanParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      const arr = value.filter((x) => x !== '' && x != null);
      if (arr.length) out[key] = arr;
      continue;
    }
    if (typeof value === 'number' && Number.isNaN(value)) continue;
    out[key] = value;
  }
  return out;
}

// A comma / enter driven string-array editor (keywords, hashtags, domains, …).
const ChipInput = ({
  label,
  values,
  onChange,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
}) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const [draft, setDraft] = useState('');

  const commit = useCallback(() => {
    const tokens = draft.split(',').map((s) => s.trim()).filter(Boolean);
    if (tokens.length === 0) return;
    onChange(Array.from(new Set([...values, ...tokens])));
    setDraft('');
  }, [draft, values, onChange]);

  return (
    <View className="gap-1.5">
      <Text className="text-[13px] font-semibold text-foreground">{label}</Text>
      {values.length > 0 ? (
        <View className="flex-row flex-wrap gap-1.5">
          {values.map((v) => (
            <View key={v} className="flex-row items-center gap-1 rounded-full px-3 py-1 bg-background">
              <Text className="text-[13px] text-foreground">{v}</Text>
              <TouchableOpacity
                onPress={() => onChange(values.filter((x) => x !== v))}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                <Ionicons name="close" size={13} color={theme.colors.textSecondary} />
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ) : null}
      <TextInput
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={commit}
        onBlur={commit}
        placeholder={t('feeds.builder.chipPlaceholder')}
        placeholderTextColor={theme.colors.textSecondary}
        style={styles.input}
        className="text-[15px] text-foreground bg-background border border-border rounded-xl px-3"
        blurOnSubmit={false}
        returnKeyType="done"
      />
    </View>
  );
};

// User-search picker for the `accounts` source (its `authorIds` param).
const AccountPicker = ({
  selected,
  onChange,
}: {
  selected: MinimalUser[];
  onChange: (next: MinimalUser[]) => void;
}) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const { oxyServices } = useAuth();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<MinimalUser[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const doSearch = useCallback(
    (q: string) => {
      setSearch(q);
      if (timer.current) clearTimeout(timer.current);
      if (!q.trim()) {
        setResults([]);
        return;
      }
      timer.current = setTimeout(async () => {
        try {
          const { data } = await oxyServices.searchProfiles(q.trim(), { limit: 8 });
          setResults(data.map(toMinimal));
        } catch (error) {
          logger.warn('searchProfiles failed', { error });
        }
      }, 300);
    },
    [oxyServices],
  );

  const add = (u: MinimalUser) => {
    if (!selected.some((s) => s.id === u.id)) onChange([...selected, u]);
    setSearch('');
    setResults([]);
  };

  return (
    <View className="gap-2">
      <Text className="text-[13px] font-semibold text-foreground">{t('feeds.builder.addAccounts')}</Text>

      {selected.map((u) => (
        <View key={u.id} className="flex-row items-center gap-3">
          <Avatar source={u.avatar ?? undefined} size={36} />
          <View className="flex-1">
            <Text className="text-[15px] font-semibold text-foreground" numberOfLines={1}>{accountName(u)}</Text>
            <Text className="text-[13px] text-muted-foreground" numberOfLines={1}>@{u.username}</Text>
          </View>
          <TouchableOpacity
            onPress={() => onChange(selected.filter((s) => s.id !== u.id))}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="close-circle" size={22} color={theme.colors.textSecondary} />
          </TouchableOpacity>
        </View>
      ))}

      <TextInput
        value={search}
        onChangeText={doSearch}
        placeholder={t('feeds.builder.searchAccounts')}
        placeholderTextColor={theme.colors.textSecondary}
        style={styles.input}
        className="text-[15px] text-foreground bg-background border border-border rounded-xl px-3"
      />

      {results.map((u) => (
        <TouchableOpacity key={u.id} className="flex-row items-center gap-3 py-1.5" onPress={() => add(u)} activeOpacity={0.7}>
          <Avatar source={u.avatar ?? undefined} size={36} />
          <View className="flex-1">
            <Text className="text-[15px] font-semibold text-foreground" numberOfLines={1}>{accountName(u)}</Text>
            <Text className="text-[13px] text-muted-foreground" numberOfLines={1}>@{u.username}</Text>
          </View>
          <View className="border border-border rounded-[10px] px-3 py-1">
            <Text className="text-[13px] font-semibold text-foreground">{t('feeds.builder.add')}</Text>
          </View>
        </TouchableOpacity>
      ))}
    </View>
  );
};

// One schema-driven param editor (string / number / boolean / string-array).
const ParamField = ({
  name,
  prop,
  value,
  onChange,
}: {
  name: string;
  prop: ModuleParamProperty;
  value: unknown;
  onChange: (value: unknown) => void;
}) => {
  const theme = useTheme();
  const label = humanize(name);

  if (prop.type === 'array') {
    const arr = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
    return <ChipInput label={label} values={arr} onChange={(next) => onChange(next)} />;
  }

  if (prop.type === 'boolean') {
    return (
      <View className="flex-row items-center justify-between">
        <Text className="text-[13px] font-semibold text-foreground">{label}</Text>
        <Toggle value={value === true} onValueChange={(b) => onChange(b)} />
      </View>
    );
  }

  if (prop.type === 'number') {
    return (
      <View className="gap-1.5">
        <Text className="text-[13px] font-semibold text-foreground">{label}</Text>
        <TextInput
          keyboardType="numeric"
          value={value == null ? '' : String(value)}
          onChangeText={(txt) => {
            if (txt.trim() === '') return onChange(undefined);
            const n = Number(txt);
            onChange(Number.isNaN(n) ? undefined : n);
          }}
          placeholderTextColor={theme.colors.textSecondary}
          style={styles.input}
          className="text-[15px] text-foreground bg-background border border-border rounded-xl px-3"
        />
      </View>
    );
  }

  return (
    <View className="gap-1.5">
      <Text className="text-[13px] font-semibold text-foreground">{label}</Text>
      <TextInput
        value={typeof value === 'string' ? value : ''}
        onChangeText={(txt) => onChange(txt)}
        placeholderTextColor={theme.colors.textSecondary}
        style={styles.input}
        className="text-[15px] text-foreground bg-background border border-border rounded-xl px-3"
      />
    </View>
  );
};

// One module: an enable toggle + (when enabled) its param editors.
const ModuleCard = ({
  entry,
  state,
  onToggle,
  onParam,
  accountsSlot,
}: {
  entry: ModuleCatalogEntry;
  state: ModuleState | undefined;
  onToggle: (enabled: boolean) => void;
  onParam: (key: string, value: unknown) => void;
  accountsSlot?: React.ReactNode;
}) => {
  const { t } = useTranslation();
  const enabled = state?.enabled ?? false;
  const label = t(entry.labelKey, { defaultValue: humanize(entry.id) });
  const description = t(entry.descriptionKey, { defaultValue: '' });
  const paramKeys = Object.keys(entry.paramsSchema.properties);
  const isAccounts = entry.id === 'accounts';
  const hasBody = enabled && (isAccounts || paramKeys.length > 0);

  return (
    <View className="rounded-2xl p-4 bg-secondary mb-2">
      <View className="flex-row items-center gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-[15px] font-semibold text-foreground">{label}</Text>
          {description ? (
            <Text className="text-[13px] leading-[18px] text-muted-foreground">{description}</Text>
          ) : null}
        </View>
        <Toggle value={enabled} onValueChange={onToggle} />
      </View>
      {hasBody ? (
        <View className="mt-3 gap-3">
          <View style={styles.divider} className="bg-border" />
          {isAccounts
            ? accountsSlot
            : paramKeys.map((key) => (
                <ParamField
                  key={key}
                  name={key}
                  prop={entry.paramsSchema.properties[key]}
                  value={state?.params?.[key]}
                  onChange={(v) => onParam(key, v)}
                />
              ))}
        </View>
      ) : null}
    </View>
  );
};

/**
 * The custom-feed builder used by both the new-feed and edit-feed screens.
 * Composes a {@link FeedDefinitionInput} from the module catalog and persists it
 * via POST/PUT /feeds; once saved, previews the result through the engine
 * timeline (`/feeds/:id/timeline`) in an embedded, non-scroll-owning feed.
 */
export function FeedBuilder({ feedId, initialFeed }: { feedId?: string; initialFeed?: CustomFeed }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const safeBack = useSafeBack();
  const { oxyServices } = useAuth();
  const queryClient = useQueryClient();
  const { catalog, isLoading: catalogLoading } = useFeedModules();

  const def = initialFeed?.definition;

  const [title, setTitle] = useState(initialFeed?.title ?? '');
  const [description, setDescription] = useState(initialFeed?.description ?? '');
  const [isPublic, setIsPublic] = useState(initialFeed?.isPublic ?? true);
  const [mode, setMode] = useState<FeedDefinitionMode>(def?.mode ?? 'chronological');
  const [sourceStates, setSourceStates] = useState<ModuleStates>(() => statesFromRefs(def?.sources));
  const [filterStates, setFilterStates] = useState<ModuleStates>(() => statesFromRefs(def?.filters));
  const [signalStates, setSignalStates] = useState<ModuleStates>(() => statesFromRefs(def?.signals));
  const [selectedAccounts, setSelectedAccounts] = useState<MinimalUser[]>([]);
  const [savedFeedId, setSavedFeedId] = useState<string | undefined>(feedId);
  const [previewKey, setPreviewKey] = useState(0);
  const [saving, setSaving] = useState(false);

  // Resolve the `accounts` source's stored authorIds → display users (edit mode).
  const initialAuthorIds = useMemo(() => {
    const ids = def?.sources?.find((s) => s.module === 'accounts')?.params?.authorIds;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
  }, [def]);

  useEffect(() => {
    if (initialAuthorIds.length === 0) return;
    let cancelled = false;
    oxyServices
      .getUsersByIds(initialAuthorIds)
      .then((users) => { if (!cancelled) setSelectedAccounts(users.map(toMinimal)); })
      .catch((error) => logger.warn('Failed to resolve builder accounts', { error }));
    return () => { cancelled = true; };
  }, [initialAuthorIds, oxyServices]);

  const toggleSource = useCallback((id: string, enabled: boolean) =>
    setSourceStates((p) => ({ ...p, [id]: { enabled, params: p[id]?.params ?? {} } })), []);
  const paramSource = useCallback((id: string, key: string, value: unknown) =>
    setSourceStates((p) => ({ ...p, [id]: { enabled: p[id]?.enabled ?? true, params: { ...(p[id]?.params ?? {}), [key]: value } } })), []);
  const toggleFilter = useCallback((id: string, enabled: boolean) =>
    setFilterStates((p) => ({ ...p, [id]: { enabled, params: p[id]?.params ?? {} } })), []);
  const paramFilter = useCallback((id: string, key: string, value: unknown) =>
    setFilterStates((p) => ({ ...p, [id]: { enabled: p[id]?.enabled ?? true, params: { ...(p[id]?.params ?? {}), [key]: value } } })), []);
  const toggleSignal = useCallback((id: string, enabled: boolean) =>
    setSignalStates((p) => ({ ...p, [id]: { enabled, params: p[id]?.params ?? {} } })), []);

  const handleSave = useCallback(async () => {
    if (!catalog) return;
    if (!title.trim()) {
      toast(t('feeds.builder.needsTitle'), { type: 'error' });
      return;
    }

    const buildRefs = (entries: ModuleCatalogEntry[], states: ModuleStates): FeedModuleRef[] => {
      const refs: FeedModuleRef[] = [];
      for (const entry of entries) {
        const st = states[entry.id];
        if (!st?.enabled) continue;
        let params = cleanParams(st.params ?? {});
        if (entry.id === 'accounts') params = { ...params, authorIds: selectedAccounts.map((u) => u.id) };
        const ref: FeedModuleRef = { module: entry.id, enabled: true };
        if (Object.keys(params).length > 0) ref.params = params;
        refs.push(ref);
      }
      return refs;
    };

    const definition: FeedDefinitionInput = {
      mode,
      sources: buildRefs(catalog.sources, sourceStates),
      signals: mode === 'ranked' ? buildRefs(catalog.signals, signalStates) : [],
      filters: buildRefs(catalog.filters, filterStates),
    };

    if (definition.sources.length === 0) {
      toast(t('feeds.builder.needsSource'), { type: 'error' });
      return;
    }

    const visibility: FeedVisibility = isPublic ? 'public' : 'private';
    const payload = {
      title: title.trim(),
      description: description.trim() || undefined,
      visibility,
      definition,
    };

    setSaving(true);
    try {
      if (savedFeedId) {
        await customFeedsService.update(savedFeedId, payload);
      } else {
        const created = await customFeedsService.create(payload);
        setSavedFeedId(String(created.id ?? created._id ?? ''));
      }
      queryClient.invalidateQueries({ queryKey: ['feedPreferences'] });
      queryClient.invalidateQueries({ queryKey: ['customFeeds'] });
      setPreviewKey((k) => k + 1);
      toast(t('feeds.builder.saved'), { type: 'success' });
    } catch (error) {
      logger.error('Save feed failed', { error });
      toast(t('feeds.builder.saveFailed'), { type: 'error' });
    } finally {
      setSaving(false);
    }
  }, [catalog, title, description, isPublic, mode, sourceStates, filterStates, signalStates, selectedAccounts, savedFeedId, queryClient, t]);

  const canSave = title.trim().length > 0 && !saving && Boolean(catalog);

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: feedId ? t('feeds.builder.editTitle') : t('feeds.builder.createTitle'),
          leftComponents: [
            <IconButton variant="icon" key="back" onPress={() => safeBack()}>
              <BackArrowIcon size={20} className="text-foreground" />
            </IconButton>,
          ],
          rightComponents: [
            <TouchableOpacity
              key="save"
              onPress={handleSave}
              disabled={!canSave}
              className="px-4 py-[7px] rounded-[20px] bg-primary"
              style={!canSave ? styles.disabledBtn : undefined}
            >
              {saving ? (
                <Loading className="text-primary" variant="inline" size="small" style={{ flex: undefined }} />
              ) : (
                <Text className="text-white font-bold text-sm">
                  {savedFeedId ? t('feeds.builder.saveChanges') : t('feeds.builder.create')}
                </Text>
              )}
            </TouchableOpacity>,
          ],
        }}
        hideBottomBorder
        disableSticky
      />

      {catalogLoading || !catalog ? (
        <View className="flex-1 items-center justify-center">
          <Loading className="text-primary" size="large" />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Details */}
          <View className="rounded-2xl p-4 bg-secondary">
            <View className="gap-1">
              <Text className="text-sm font-semibold text-foreground">{t('feeds.builder.titleLabel')}</Text>
              <TextInput
                value={title}
                onChangeText={setTitle}
                placeholder={t('feeds.builder.titlePlaceholder')}
                placeholderTextColor={theme.colors.textSecondary}
                style={styles.fieldInput}
                className="text-[15px] text-foreground"
                maxLength={100}
              />
            </View>
            <View style={styles.divider} className="bg-border" />
            <View className="gap-1">
              <Text className="text-sm font-semibold text-foreground">{t('feeds.builder.descriptionLabel')}</Text>
              <TextInput
                value={description}
                onChangeText={setDescription}
                placeholder={t('feeds.builder.descriptionPlaceholder')}
                placeholderTextColor={theme.colors.textSecondary}
                style={styles.fieldInput}
                className="text-[15px] text-foreground"
                multiline
                maxLength={500}
              />
            </View>
          </View>

          {/* Visibility */}
          <SettingsListGroup title={t('feeds.builder.visibility')} footer={t('feeds.builder.publicDescription')}>
            <SettingsListItem
              title={t('feeds.builder.public')}
              showChevron={false}
              rightElement={<Toggle value={isPublic} onValueChange={setIsPublic} />}
            />
          </SettingsListGroup>

          {/* Mode */}
          <SettingsListGroup title={t('feeds.builder.mode')} footer={t('feeds.builder.modeDescription')}>
            <SettingsListItem
              title={t('feeds.builder.ranked')}
              onPress={() => setMode('ranked')}
              showChevron={false}
              rightElement={<ModeCheck active={mode === 'ranked'} />}
            />
            <SettingsListItem
              title={t('feeds.builder.chronological')}
              onPress={() => setMode('chronological')}
              showChevron={false}
              rightElement={<ModeCheck active={mode === 'chronological'} />}
            />
          </SettingsListGroup>

          {/* Sources */}
          <Text className="text-[15px] font-bold text-foreground mt-4 mb-1">{t('feeds.builder.sources')}</Text>
          <Text className="text-[13px] text-muted-foreground mb-2">{t('feeds.builder.sourcesDescription')}</Text>
          {catalog.sources.map((entry) => (
            <ModuleCard
              key={entry.id}
              entry={entry}
              state={sourceStates[entry.id]}
              onToggle={(e) => toggleSource(entry.id, e)}
              onParam={(k, v) => paramSource(entry.id, k, v)}
              accountsSlot={
                entry.id === 'accounts'
                  ? <AccountPicker selected={selectedAccounts} onChange={setSelectedAccounts} />
                  : undefined
              }
            />
          ))}

          {/* Filters */}
          <Text className="text-[15px] font-bold text-foreground mt-4 mb-1">{t('feeds.builder.filters')}</Text>
          <Text className="text-[13px] text-muted-foreground mb-2">{t('feeds.builder.filtersDescription')}</Text>
          {catalog.filters.map((entry) => (
            <ModuleCard
              key={entry.id}
              entry={entry}
              state={filterStates[entry.id]}
              onToggle={(e) => toggleFilter(entry.id, e)}
              onParam={(k, v) => paramFilter(entry.id, k, v)}
            />
          ))}

          {/* Ranking signals (ranked mode only) */}
          {mode === 'ranked' && catalog.signals.length > 0 ? (
            <>
              <Text className="text-[15px] font-bold text-foreground mt-4 mb-1">{t('feeds.builder.signals')}</Text>
              <Text className="text-[13px] text-muted-foreground mb-2">{t('feeds.builder.signalsDescription')}</Text>
              {catalog.signals.map((entry) => (
                <ModuleCard
                  key={entry.id}
                  entry={entry}
                  state={signalStates[entry.id]}
                  onToggle={(e) => toggleSignal(entry.id, e)}
                  onParam={() => undefined}
                />
              ))}
            </>
          ) : null}

          {/* Live preview (available once the feed is saved) */}
          <Text className="text-[15px] font-bold text-foreground mt-4 mb-2">{t('feeds.builder.preview')}</Text>
          {savedFeedId ? (
            <View className="rounded-2xl overflow-hidden border border-border">
              <Feed
                type="custom"
                filters={{ customFeedId: savedFeedId }}
                scrollEnabled={false}
                reloadKey={previewKey}
                hideHeader
              />
            </View>
          ) : (
            <Text className="text-[13px] text-muted-foreground">{t('feeds.builder.saveToPreview')}</Text>
          )}

          <View className="h-10" />
        </ScrollView>
      )}
    </ThemedView>
  );
}

const ModeCheck = ({ active }: { active: boolean }) => {
  const theme = useTheme();
  return active ? <Ionicons name="checkmark" size={20} color={theme.colors.primary} /> : <View className="w-5 h-5" />;
};

const styles = StyleSheet.create({
  scrollContent: {
    padding: 16,
    gap: 8,
    paddingBottom: 80,
  },
  fieldInput: {
    paddingVertical: 4,
    minHeight: 24,
    ...Platform.select({ web: { outlineWidth: 0 } }),
  },
  input: {
    paddingVertical: 8,
    ...Platform.select({ web: { outlineWidth: 0 } }),
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginVertical: 12,
  },
  disabledBtn: {
    opacity: 0.5,
  },
});
