import React, { memo, useMemo, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Item } from '@oxy.so/bloom/item';
import { Search } from '@oxy.so/bloom/search';

export interface CodePickerOption<Code extends string> {
  code: Code;
  /** The localized name, when the platform has one (see `utils/jobVocabulary.ts`). */
  name?: string;
}

/** Case- and accent-insensitive, so `espana` finds `España`. */
function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

interface CodePickerDialogProps<Code extends string> {
  open: boolean;
  title: string;
  searchLabel: string;
  options: readonly CodePickerOption<Code>[];
  selected: Code | null;
  onSelect: (code: Code) => void;
  onClose: () => void;
}

/**
 * Pick one code from a closed list (ISO countries, ISO currencies) — the only
 * way the job form accepts one. Searches code and name; a code the list does
 * not hold cannot be entered at all.
 */
function CodePickerDialogInner<Code extends string>({
  open,
  title,
  searchLabel,
  options,
  selected,
  onSelect,
  onClose,
}: CodePickerDialogProps<Code>) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = fold(query.trim());
    if (!needle) return options;
    return options.filter(
      (option) => fold(option.code).startsWith(needle) || (option.name ? fold(option.name).includes(needle) : false),
    );
  }, [options, query]);

  return (
    <Dialog
      open={open}
      onClose={() => {
        setQuery('');
        onClose();
      }}
      title={title}
      label={title}
    >
      <Search label={searchLabel} value={query} onChangeText={setQuery} onClearText={() => setQuery('')} />
      <ScrollView style={{ maxHeight: 360, marginTop: 8 }} keyboardShouldPersistTaps="handled">
        {filtered.length === 0 ? (
          <Text className="text-center text-sm text-muted-foreground py-6">
            {t('jobs.create.noMatches', { defaultValue: 'Nothing matches' })}
          </Text>
        ) : (
          filtered.map((option) => (
            <Item
              key={option.code}
              onPress={() => {
                setQuery('');
                onSelect(option.code);
              }}
              title={option.name ?? option.code}
              subtitle={option.name ? option.code : undefined}
              selected={option.code === selected}
            />
          ))
        )}
      </ScrollView>
    </Dialog>
  );
}

const CodePickerDialog = memo(CodePickerDialogInner) as typeof CodePickerDialogInner;

export default CodePickerDialog;
