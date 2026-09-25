import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { Loading } from '@oxy.so/bloom/loading';
import { Button } from '@oxy.so/bloom/button';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons/RiCloseCircleLine';
import { Avatar } from '@oxy.so/bloom/avatar';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { toast } from '@oxy.so/bloom/toast';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import type { User } from '@oxy.so/core';
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

import { Slider } from '@oxy.so/bloom/slider';
import { Switch } from '@oxy.so/bloom/switch';
import { Field } from '@oxy.so/bloom/field';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { TagField, commitTag } from '@oxy.so/bloom/tag-field';
import { Search } from '@oxy.so/bloom/search';
import { Divider } from '@oxy.so/bloom/divider';
import { useHaptics } from '@oxy.so/bloom/hooks';
import { useTheme } from '@oxy.so/bloom/theme';
import { useAuth } from '@oxy.so/services/ui/client';
import { useSafeBack } from '@/hooks/useSafeBack';
import { customFeedsService } from '@/services/customFeedsService';
import { useFeedModules } from '@/hooks/useFeedModules';
import Feed from '@/components/Feed/Feed';
import { logger } from '@oxy.so/core/logger';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { HIT_SLOP_MD } from '@/styles/hitSlop';
import { SignInRequired } from '@/components/common/SignInRequired';

type MinimalUser = Pick<User, 'id' | 'username' | 'name' | 'avatar'>;
type ModuleState = { enabled: boolean; params: Record<string, unknown> };
type ModuleStates = Record<string, ModuleState>;
/** The three module lists a definition carries. */
type ModuleKind = 'sources' | 'filters' | 'signals';

/**
 * Text typed into a tag field but not yet committed as a chip, keyed by
 * {@link chipDraftKey}. Held by the builder (not the field) so Save can fold it
 * into the list instead of silently dropping it.
 */
type ChipDrafts = Record<string, string>;

function chipDraftKey(kind: ModuleKind, moduleId: string, param: string): string {
  return `${kind}\u0000${moduleId}\u0000${param}`;
}

interface ChipDraftStore {
  drafts: ChipDrafts;
  setDraft: (key: string, text: string) => void;
}

const ChipDraftContext = createContext<ChipDraftStore | null>(null);

/**
 * Fold every pending tag-field draft of `kind` into its module's string-array
 * param, with the same rule the field applies on Enter (`commitTag`: trimmed,
 * case-insensitive dedupe, `max` respected). Returns `states` itself when there
 * was nothing to merge.
 */
function mergeChipDrafts(
  kind: ModuleKind,
  entries: ModuleCatalogEntry[],
  states: ModuleStates,
  drafts: ChipDrafts,
): ModuleStates {
  let next = states;
  for (const entry of entries) {
    const paramKeys = new Set([...entry.params.map((param) => param.key), ...Object.keys(entry.paramsSchema.properties)]);
    for (const param of paramKeys) {
      const draft = drafts[chipDraftKey(kind, entry.id, param)];
      if (!draft) continue;
      const current = next[entry.id]?.params?.[param];
      const list = Array.isArray(current) ? current.filter((x): x is string => typeof x === 'string') : [];
      const max = entry.params.find((descriptor) => descriptor.key === param)?.maxItems;
      const { next: merged } = commitTag(list, draft, { max });
      if (!merged) continue;
      const prev = next[entry.id];
      next = {
        ...next,
        [entry.id]: { enabled: prev?.enabled ?? true, params: { ...(prev?.params ?? {}), [param]: [...merged] } },
      };
    }
  }
  return next;
}

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

/** Rows the builder's live preview shows (it is embedded, so every row is mounted). */
const FEED_PREVIEW_ROWS = 10;

/**
 * A switch that ticks a light haptic on change, as the builder's toggles always
 * have. A hook, not a wrapper component: the control rendered is Bloom's Switch.
 */
function useHapticChange(onChange: (value: boolean) => void): (value: boolean) => void {
  const haptic = useHaptics();
  return useCallback(
    (value: boolean) => {
      haptic('light');
      onChange(value);
    },
    [haptic, onChange],
  );
}

// A comma / enter driven string-array editor (keywords, hashtags, domains, …).
const ChipInput = ({
  label,
  values,
  onChange,
  max,
  draftKey,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  max?: number;
  /** Where the uncommitted text lives in the builder's draft store. */
  draftKey: string;
}) => {
  const { t } = useTranslation();
  const store = useContext(ChipDraftContext);
  // Outside a builder (no store) the field keeps its own text.
  const setDraft = store?.setDraft;
  const handleInputChange = useCallback(
    (text: string) => setDraft?.(draftKey, text),
    [setDraft, draftKey],
  );
  return (
    <Field label={label}>
      <TagField
        value={values}
        onChange={(next) => onChange([...next])}
        placeholder={t('feeds.builder.chipPlaceholder')}
        max={max}
        inputValue={store ? (store.drafts[draftKey] ?? '') : undefined}
        onInputValueChange={store ? handleInputChange : undefined}
      />
    </Field>
  );
};

/** A label on the left, a Bloom switch on the right — one boolean param. */
const BooleanParamRow = ({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) => {
  const handleChange = useHapticChange(onChange);
  return (
    <View className="flex-row items-center justify-between">
      <Text className="text-[13px] font-semibold text-foreground">{label}</Text>
      <Switch value={value} onValueChange={handleChange} accessibilityLabel={label} />
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
          <Avatar source={u.avatar ?? undefined} size={36} variant={MEDIA_VARIANT_AVATAR} />
          <View className="flex-1">
            <Text className="text-[15px] font-semibold text-foreground" numberOfLines={1}>{accountName(u)}</Text>
            <Text className="text-[13px] text-muted-foreground" numberOfLines={1}>@{u.username}</Text>
          </View>
          <TouchableOpacity
            onPress={() => onChange(selected.filter((s) => s.id !== u.id))}
            hitSlop={HIT_SLOP_MD}
          >
            <RiCloseCircleLine width={22} height={22} fill={theme.colors.textSecondary} />
          </TouchableOpacity>
        </View>
      ))}

      <Search
        label={t('feeds.builder.searchAccounts')}
        value={search}
        onValueChange={doSearch}
        onClearText={() => doSearch('')}
      />

      {results.map((u) => (
        <TouchableOpacity key={u.id} className="flex-row items-center gap-3 py-1.5" onPress={() => add(u)} activeOpacity={0.7}>
          <Avatar source={u.avatar ?? undefined} size={36} variant={MEDIA_VARIANT_AVATAR} />
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
  draftKey,
}: {
  descriptor: ModuleParamDescriptor;
  value: unknown;
  onChange: (value: unknown) => void;
  draftKey: string;
}) => {
  const { t } = useTranslation();
  const theme = useTheme();
  const label = useParamLabel(descriptor);

  switch (descriptor.control) {
    case 'boolean':
      return <BooleanParamRow label={label} value={value === true} onChange={(b) => onChange(b)} />;

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
          min={min}
          max={max}
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
                  {active ? <RiCheckLine width={18} height={18} fill={theme.colors.primary} /> : null}
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
          max={cap}
          draftKey={draftKey}
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
  draftKey,
}: {
  moduleId: string;
  name: string;
  prop: ModuleParamProperty;
  value: unknown;
  onChange: (value: unknown) => void;
  draftKey: string;
}) => {
  const { t } = useTranslation();
  const label = t(`feeds.modules.${moduleId}.params.${name}`, { defaultValue: humanize(name) });

  if (prop.type === 'array') {
    const arr = Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
    return <ChipInput label={label} values={arr} draftKey={draftKey} onChange={(next) => onChange(next)} />;
  }

  if (prop.type === 'boolean') {
    return <BooleanParamRow label={label} value={value === true} onChange={(b) => onChange(b)} />;
  }

  if (prop.type === 'number') {
    return (
      <Field label={label}>
        <TextFieldInput
          label={label}
          placeholder={null}
          keyboardType="numeric"
          value={value == null ? '' : String(value)}
          onValueChange={(txt) => {
            if (txt.trim() === '') return onChange(undefined);
            const n = Number(txt);
            onChange(Number.isNaN(n) ? undefined : n);
          }}
        />
      </Field>
    );
  }

  return (
    <Field label={label}>
      <TextFieldInput
        label={label}
        placeholder={null}
        value={typeof value === 'string' ? value : ''}
        onValueChange={(txt) => onChange(txt)}
      />
    </Field>
  );
};

// One module: an enable toggle + (when enabled) its param editors.
const ModuleCard = ({
  kind,
  entry,
  state,
  onToggle,
  onParam,
  accountsSlot,
}: {
  kind: ModuleKind;
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
  const handleToggle = useHapticChange(onToggle);

  // Curated descriptor params render as rich controls; any schema param without a
  // descriptor falls back to a type-driven editor. The union of both keeps the
  // builder data-driven while never dropping an editor for an existing module.
  const descriptorKeys = new Set(entry.params.map((param) => param.key));
  const schemaOnlyKeys = Object.keys(entry.paramsSchema.properties).filter((key) => !descriptorKeys.has(key));
  const hasParams = entry.params.length > 0 || schemaOnlyKeys.length > 0;
  const hasBody = enabled && (isAccounts || hasParams);

  return (
    <View className="rounded-2xl p-4 bg-muted mb-2">
      <View className="flex-row items-center gap-3">
        <View className="flex-1 gap-0.5">
          <Text className="text-[15px] font-semibold text-foreground">{label}</Text>
          {description ? (
            <Text className="text-[13px] leading-[18px] text-muted-foreground">{description}</Text>
          ) : null}
        </View>
        <Switch value={enabled} onValueChange={handleToggle} accessibilityLabel={label} />
      </View>
      {hasBody ? (
        <View className="mt-3 gap-3">
          <Divider spacing={12} />
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
                  draftKey={chipDraftKey(kind, entry.id, param.key)}
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
                  draftKey={chipDraftKey(kind, entry.id, key)}
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
  kind,
  entries,
  states,
  onToggle,
  onParam,
  renderAccountsSlot,
}: {
  kind: ModuleKind;
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
              kind={kind}
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
  const safeBack = useSafeBack();
  const { oxyServices, user, canUsePrivateApi } = useAuth();
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
  const handlePublicChange = useHapticChange(setIsPublic);
  const [chipDrafts, setChipDrafts] = useState<ChipDrafts>({});

  const setChipDraft = useCallback((key: string, text: string) => {
    setChipDrafts((prev) => {
      if ((prev[key] ?? '') === text) return prev;
      const next = { ...prev };
      if (text === '') delete next[key];
      else next[key] = text;
      return next;
    });
  }, []);
  const chipDraftStore = useMemo<ChipDraftStore>(
    () => ({ drafts: chipDrafts, setDraft: setChipDraft }),
    [chipDrafts, setChipDraft],
  );

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

    // Text typed into a tag field but never committed (no Enter / comma) is
    // still what the viewer meant: fold it into its list before saving, and show
    // it as chips from now on.
    const nextSourceStates = mergeChipDrafts('sources', catalog.sources, sourceStates, chipDrafts);
    const nextFilterStates = mergeChipDrafts('filters', catalog.filters, filterStates, chipDrafts);
    const nextSignalStates = mergeChipDrafts('signals', catalog.signals, signalStates, chipDrafts);
    if (nextSourceStates !== sourceStates) setSourceStates(nextSourceStates);
    if (nextFilterStates !== filterStates) setFilterStates(nextFilterStates);
    if (nextSignalStates !== signalStates) setSignalStates(nextSignalStates);
    if (Object.keys(chipDrafts).length > 0) setChipDrafts({});

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
      sources: buildRefs(catalog.sources, nextSourceStates),
      signals: mode === 'ranked' ? buildRefs(catalog.signals, nextSignalStates) : [],
      filters: buildRefs(catalog.filters, nextFilterStates),
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
      queryClient.invalidateQueries({
        queryKey: viewerQueryKeys.feedPreferences(user?.id),
      });
      queryClient.invalidateQueries({
        queryKey: viewerQueryKeys.customFeedsRoot(user?.id),
      });
      setPreviewKey((k) => k + 1);
      toast(t('feeds.builder.saved'), { type: 'success' });
    } catch (error) {
      logger.error('Save feed failed', error);
      toast(t('feeds.builder.saveFailed'), { type: 'error' });
    } finally {
      setSaving(false);
    }
  }, [catalog, title, description, isPublic, mode, sourceStates, filterStates, signalStates, chipDrafts, selectedAccounts, savedFeedId, queryClient, t, user?.id]);

  const canSave = title.trim().length > 0 && Boolean(catalog);

  return (
    <View className="flex-1">
      <PageHeader
        title={feedId ? t('feeds.builder.editTitle') : t('feeds.builder.createTitle')}
        onBack={() => safeBack()}
        backLabel={t('common.back', { defaultValue: 'Back' })}
        actions={
          canUsePrivateApi ? (
            <Button size="small" onPress={handleSave} disabled={!canSave} loading={saving}>
              {savedFeedId ? t('feeds.builder.saveChanges') : t('feeds.builder.create')}
            </Button>
          ) : undefined
        }
      />

      <SignInRequired
        label={t('feeds.builder.signInRequired', { defaultValue: 'Sign in to build a feed' })}
        description={t('feeds.builder.signInRequiredDesc', {
          defaultValue: 'Custom feeds are saved to your account, so you can pin and share them.',
        })}
      >
        {catalogLoading || !catalog ? (
          <View className="flex-1 items-center justify-center">
            <Loading className="text-primary" size="large" />
          </View>
        ) : (
          <ChipDraftContext.Provider value={chipDraftStore}>
            <ScrollView
              contentContainerStyle={styles.scrollContent}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            >
              {/* Details */}
              <View className="rounded-2xl p-4 bg-muted">
                <Field label={t('feeds.builder.titleLabel')}>
                  <TextFieldInput
                    label={t('feeds.builder.titleLabel')}
                    value={title}
                    onValueChange={setTitle}
                    placeholder={t('feeds.builder.titlePlaceholder')}
                    maxLength={100}
                  />
                </Field>
                <Divider spacing={12} />
                <Field label={t('feeds.builder.descriptionLabel')}>
                  <Textarea
                    value={description}
                    onValueChange={setDescription}
                    placeholder={t('feeds.builder.descriptionPlaceholder')}
                    maxLength={500}
                    autoResize
                    rows={2}
                    maxRows={6}
                  />
                </Field>
              </View>

              {/* Visibility */}
              <SettingsListGroup title={t('feeds.builder.visibility')} footer={t('feeds.builder.publicDescription')}>
                <SettingsListItem
                  title={t('feeds.builder.public')}
                  showChevron={false}
                  rightElement={
                    <Switch
                      value={isPublic}
                      onValueChange={handlePublicChange}
                      accessibilityLabel={t('feeds.builder.public')}
                    />
                  }
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
                kind="sources"
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
                kind="filters"
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
                    kind="signals"
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
                  {/* Non-scrolling inside the builder's ScrollView, so it is not
                      virtualized: bounded to a preview's worth of rows and never
                      pages (#1103). The full feed is one tap away once saved. */}
                  <Feed
                    type="custom"
                    filters={{ customFeedId: savedFeedId }}
                    scrollEnabled={false}
                    previewLimit={FEED_PREVIEW_ROWS}
                    reloadKey={previewKey}
                    hideHeader
                  />
                </View>
              ) : (
                <Text className="text-[13px] text-muted-foreground">{t('feeds.builder.saveToPreview')}</Text>
              )}

              <View className="h-10" />
            </ScrollView>
          </ChipDraftContext.Provider>
        )}
      </SignInRequired>
    </View>
  );
}

const ModeCheck = ({ active }: { active: boolean }) => {
  const theme = useTheme();
  return active ? <RiCheckLine size="md" fill={theme.colors.primary} /> : <View className="w-5 h-5" />;
};

const styles = StyleSheet.create({
  scrollContent: {
    padding: 16,
    gap: 8,
    paddingBottom: 80,
  },
});
