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
  ModuleCategory,
  ModuleParamDescriptor,
  ModuleParamProperty,
} from '@mention/shared-types';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Toggle } from '@/components/Toggle';
import { Slider } from '@/components/Slider';
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

/** Translate a param descriptor's label, falling back to its English default. */
function useParamLabel(descriptor: ModuleParamDescriptor): string {
  const { t } = useTranslation();
  return t(descriptor.labelKey, { defaultValue: descriptor.label });
}

/**
 * The generic, catalog-driven param control. Renders the right widget purely from
 * the descriptor's `control` type, so adding a new module param to the catalog
 * needs no UI code here:
 *  - `boolean`      → switch;
 *  - `number-range` → slider (min/max/step, live value; the default is DISPLAYED
 *    but only persisted once the viewer moves it, so an untouched range never
 *    writes a value);
 *  - `enum`         → single-select list;
 *  - `multiselect`  → fixed-option chips (when `options`) or a free-entry tag
 *    input (when not), both capped by `maxItems`.
 */
const ParamControl = ({
  descriptor,
  value,
  onChange,
}: {
  descriptor: ModuleParamDescriptor;
  value: unknown;
  onChange: (value: unknown) => void;
}) => {
  const { t } = useTranslation();
  const theme = useTheme();
  const label = useParamLabel(descriptor);

  switch (descriptor.control) {
    case 'boolean':
      return (
        <View className="flex-row items-center justify-between">
          <Text className="text-[13px] font-semibold text-foreground">{label}</Text>
          <Toggle value={value === true} onValueChange={(b) => onChange(b)} />
        </View>
      );

    case 'number-range': {
      const min = descriptor.min ?? 0;
      const max = descriptor.max ?? 100;
      const step = descriptor.step ?? 1;
      const fractional = step < 1;
      const fallback = typeof descriptor.default === 'number' ? descriptor.default : min;
      const current = typeof value === 'number' ? value : fallback;
      return (
        <Slider
          value={current}
          onValueChange={(v) => onChange(fractional ? v : Math.round(v))}
          minimumValue={min}
          maximumValue={max}
          step={step}
          label={label}
          formatValue={(v) => (fractional ? v.toFixed(2) : String(Math.round(v)))}
        />
      );
    }

    case 'enum': {
      const options = descriptor.options ?? [];
      const selected = typeof value === 'string' ? value : undefined;
      return (
        <View className="gap-1.5">
          <Text className="text-[13px] font-semibold text-foreground">{label}</Text>
          <View>
            {options.map((option) => {
              const active = selected === option.value;
              return (
                <TouchableOpacity
                  key={option.value}
                  className="flex-row items-center justify-between py-2"
                  onPress={() => onChange(active ? undefined : option.value)}
                  activeOpacity={0.7}
                >
                  <Text className="text-[14px] text-foreground">
                    {t(option.labelKey, { defaultValue: option.label })}
                  </Text>
                  {active ? <Ionicons name="checkmark" size={18} color={theme.colors.primary} /> : null}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      );
    }

    case 'multiselect': {
      const arr = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
      const cap = descriptor.maxItems;

      if (descriptor.options && descriptor.options.length > 0) {
        const toggle = (optionValue: string) => {
          if (arr.includes(optionValue)) {
            onChange(arr.filter((x) => x !== optionValue));
          } else if (cap === undefined || arr.length < cap) {
            onChange([...arr, optionValue]);
          }
        };
        return (
          <View className="gap-1.5">
            <Text className="text-[13px] font-semibold text-foreground">{label}</Text>
            <View className="flex-row flex-wrap gap-1.5">
              {descriptor.options.map((option) => {
                const active = arr.includes(option.value);
                return (
                  <TouchableOpacity
                    key={option.value}
                    onPress={() => toggle(option.value)}
                    activeOpacity={0.7}
                    className={
                      active
                        ? 'rounded-full px-3 py-1 bg-primary'
                        : 'rounded-full px-3 py-1 bg-background border border-border'
                    }
                  >
                    <Text className={active ? 'text-[13px] text-white' : 'text-[13px] text-foreground'}>
                      {t(option.labelKey, { defaultValue: option.label })}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        );
      }

      return (
        <ChipInput
          label={label}
          values={arr}
          onChange={(next) => onChange(cap !== undefined ? next.slice(0, cap) : next)}
        />
      );
    }

    default:
      return null;
  }
};

/**
 * Fallback editor for a param that exists in a module's JSON-schema but has no
 * curated UI descriptor (e.g. a source's `slug` / `domain` / `postId`). Renders
 * from the schema property type so no composable module ever loses an editor.
 */
const SchemaParamField = ({
  moduleId,
  name,
  prop,
  value,
  onChange,
}: {
  moduleId: string;
  name: string;
  prop: ModuleParamProperty;
  value: unknown;
  onChange: (value: unknown) => void;
}) => {
  const { t } = useTranslation();
  const theme = useTheme();
  const label = t(`feeds.modules.${moduleId}.params.${name}`, { defaultValue: humanize(name) });

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
  const label = t(entry.labelKey, { defaultValue: entry.label || humanize(entry.id) });
  const description = t(entry.descriptionKey, { defaultValue: entry.description || '' });
  const isAccounts = entry.id === 'accounts';

  // Curated descriptor params render as rich controls; any schema param without a
  // descriptor falls back to a type-driven editor. The union of both keeps the
  // builder data-driven while never dropping an editor for an existing module.
  const descriptorKeys = new Set(entry.params.map((param) => param.key));
  const schemaOnlyKeys = Object.keys(entry.paramsSchema.properties).filter((key) => !descriptorKeys.has(key));
  const hasParams = entry.params.length > 0 || schemaOnlyKeys.length > 0;
  const hasBody = enabled && (isAccounts || hasParams);

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
          {isAccounts ? (
            accountsSlot
          ) : (
            <>
              {entry.params.map((param) => (
                <ParamControl
                  key={param.key}
                  descriptor={param}
                  value={state?.params?.[param.key]}
                  onChange={(v) => onParam(param.key, v)}
                />
              ))}
              {schemaOnlyKeys.map((key) => (
                <SchemaParamField
                  key={key}
                  moduleId={entry.id}
                  name={key}
                  prop={entry.paramsSchema.properties[key]}
                  value={state?.params?.[key]}
                  onChange={(v) => onParam(key, v)}
                />
              ))}
            </>
          )}
        </View>
      ) : null}
    </View>
  );
};

/** Deterministic category ordering for the builder's grouped module lists. */
const CATEGORY_ORDER: readonly ModuleCategory[] = [
  'quality',
  'engagement',
  'media',
  'network',
  'language',
  'topics',
  'authors',
  'safety',
  'recency',
  'source',
  'ranking',
];

interface ModuleCategoryGroup {
  category: ModuleCategory;
  entries: ModuleCatalogEntry[];
}

/** Group catalog entries by `category` in a stable, presentation-friendly order. */
function groupEntriesByCategory(entries: ModuleCatalogEntry[]): ModuleCategoryGroup[] {
  const byCategory = new Map<ModuleCategory, ModuleCatalogEntry[]>();
  for (const entry of entries) {
    const list = byCategory.get(entry.category) ?? [];
    list.push(entry);
    byCategory.set(entry.category, list);
  }
  const ordered: ModuleCategory[] = CATEGORY_ORDER.filter((category) => byCategory.has(category));
  const extras: ModuleCategory[] = [...byCategory.keys()].filter((category) => !CATEGORY_ORDER.includes(category));
  return [...ordered, ...extras].map((category) => ({ category, entries: byCategory.get(category) ?? [] }));
}

/**
 * A kind's module list, grouped by `category`. A category subheading is shown only
 * when the list actually spans more than one category (so single-category kinds
 * like sources/signals stay flat). Fully data-driven off the catalog.
 */
const CategorizedModules = ({
  entries,
  states,
  onToggle,
  onParam,
  renderAccountsSlot,
}: {
  entries: ModuleCatalogEntry[];
  states: ModuleStates;
  onToggle: (id: string, enabled: boolean) => void;
  onParam: (id: string, key: string, value: unknown) => void;
  renderAccountsSlot?: (entry: ModuleCatalogEntry) => React.ReactNode;
}) => {
  const { t } = useTranslation();
  const groups = useMemo(() => groupEntriesByCategory(entries), [entries]);
  const showHeadings = groups.length > 1;

  return (
    <>
      {groups.map((group) => (
        <View key={group.category}>
          {showHeadings ? (
            <Text className="text-[13px] font-bold uppercase tracking-wide text-muted-foreground mt-2 mb-1.5">
              {t(`feeds.categories.${group.category}`, { defaultValue: humanize(group.category) })}
            </Text>
          ) : null}
          {group.entries.map((entry) => (
            <ModuleCard
              key={entry.id}
              entry={entry}
              state={states[entry.id]}
              onToggle={(e) => onToggle(entry.id, e)}
              onParam={(k, v) => onParam(entry.id, k, v)}
              accountsSlot={renderAccountsSlot?.(entry)}
            />
          ))}
        </View>
      ))}
    </>
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
  const paramSignal = useCallback((id: string, key: string, value: unknown) =>
    setSignalStates((p) => ({ ...p, [id]: { enabled: p[id]?.enabled ?? true, params: { ...(p[id]?.params ?? {}), [key]: value } } })), []);

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
          <CategorizedModules
            entries={catalog.sources}
            states={sourceStates}
            onToggle={toggleSource}
            onParam={paramSource}
            renderAccountsSlot={(entry) =>
              entry.id === 'accounts'
                ? <AccountPicker selected={selectedAccounts} onChange={setSelectedAccounts} />
                : undefined
            }
          />

          {/* Filters */}
          <Text className="text-[15px] font-bold text-foreground mt-4 mb-1">{t('feeds.builder.filters')}</Text>
          <Text className="text-[13px] text-muted-foreground mb-2">{t('feeds.builder.filtersDescription')}</Text>
          <CategorizedModules
            entries={catalog.filters}
            states={filterStates}
            onToggle={toggleFilter}
            onParam={paramFilter}
          />

          {/* Ranking signals (ranked mode only) */}
          {mode === 'ranked' && catalog.signals.length > 0 ? (
            <>
              <Text className="text-[15px] font-bold text-foreground mt-4 mb-1">{t('feeds.builder.signals')}</Text>
              <Text className="text-[13px] text-muted-foreground mb-2">{t('feeds.builder.signalsDescription')}</Text>
              <CategorizedModules
                entries={catalog.signals}
                states={signalStates}
                onToggle={toggleSignal}
                onParam={paramSignal}
              />
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
