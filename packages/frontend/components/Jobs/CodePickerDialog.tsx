import { memo, useMemo, useState } from 'react';
import { ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Embed, RawText, toElement } from '@oxy.so/bloom-language';
import { Row } from '@oxy.so/bloom-language/containers';
import { Search as LSearch } from '@oxy.so/bloom-language/inputs';
import { Dialog as LDialog } from '@oxy.so/bloom-language/overlays';

interface CodePickerOption<Code extends string> {
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
      (option) =>
        fold(option.code).startsWith(needle) ||
        (option.name ? fold(option.name).includes(needle) : false),
    );
  }, [options, query]);

  return toElement(
    LDialog(
      LSearch([query, setQuery])
        .label(searchLabel)
        .onClearText(() => setQuery('')),
      Embed(
        <ScrollView style={{ maxHeight: 360, marginTop: 8 }} keyboardShouldPersistTaps="handled">
          {filtered.length === 0
            ? toElement(
                RawText(t('jobs.create.noMatches', { defaultValue: 'Nothing matches' }))
                  .padding('vertical', '2xl')
                  .textAlign('center')
                  .font('14')
                  .leading('20px')
                  .foreground('muted'),
              )
            : filtered.map((option) =>
                toElement(
                  Row(option.name ?? option.code)
                    .onPress(() => {
                      setQuery('');
                      onSelect(option.code);
                    })
                    .subtitle(option.name ? option.code : undefined)
                    .selected(option.code === selected),
                  option.code,
                ),
              )}
        </ScrollView>,
      ),
    )
      .title(title)
      .label(title)
      .presented([
        open,
        () => {
          setQuery('');
          onClose();
        },
      ]),
  );
}

const CodePickerDialog = memo(CodePickerDialogInner) as typeof CodePickerDialogInner;

export default CodePickerDialog;
