import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import type React from 'react';
import { memo, useEffect, useMemo, useState } from 'react';
import { ScrollView } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { SegmentedControlItemText } from '@oxy.so/bloom/segmented-control';
import type { MentionJobPlace } from '@mention/shared-types';
import { COUNTRY_CODES } from '@mention/shared-types/job';
import { jobsService } from '@/services/jobsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { useJobVocabulary } from '@/utils/jobVocabulary';
import CodePickerDialog from './CodePickerDialog';
import { EMPTY_JOB_LOCATION, type JobLocationDraft } from './jobForm';

import {
  Dialog as LDialog,
  Embed,
  Option,
  RawText,
  Row,
  Search as LSearch,
  Segmented,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

const MIN_PLACE_QUERY_LENGTH = 2;
const PLACE_SEARCH_DEBOUNCE_MS = 300;

const PlaceSearchDialog = memo(function PlaceSearchDialog({
  open,
  selectedId,
  onSelect,
  onClose,
}: {
  open: boolean;
  selectedId: string | null;
  onSelect: (place: MentionJobPlace) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { user, canUsePrivateApi } = useAuth();
  const vocabulary = useJobVocabulary();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const next = query.trim();
    // Nothing to debounce (the dialog is mounted closed, or was just cleared):
    // scheduling a timer anyway would update state on a picker nobody opened.
    if (next === debounced) return;
    const timer = setTimeout(() => setDebounced(next), PLACE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, debounced]);

  const enabled = open && debounced.length >= MIN_PLACE_QUERY_LENGTH;
  const { data, isFetching, isError } = useQuery({
    queryKey: viewerQueryKeys.jobPlaces(user?.id, debounced),
    queryFn: ({ signal }) => jobsService.searchPlaces({ q: debounced }, signal),
    enabled: enabled && canUsePrivateApi,
    staleTime: 5 * 60 * 1000,
  });
  const places = enabled ? (data?.places ?? []) : [];

  const close = () => {
    setQuery('');
    setDebounced('');
    onClose();
  };

  let body: React.ReactNode;
  if (!enabled) {
    body = toElement(
      RawText(
        t('jobs.create.placeSearchHint', {
          defaultValue: 'Type at least 2 letters of a city or region',
        }),
      )
        .padding('vertical', '2xl')
        .textAlign('center')
        .font('14')
        .leading('20px')
        .foreground('muted'),
    );
  } else if (isError) {
    body = toElement(
      RawText(
        t('jobs.create.placeSearchFailed', {
          defaultValue: 'Place search is unavailable right now',
        }),
      )
        .padding('vertical', '2xl')
        .textAlign('center')
        .font('14')
        .leading('20px')
        .foreground('muted'),
    );
  } else if (isFetching && places.length === 0) {
    body = <ListSkeleton count={2} />;
  } else if (places.length === 0) {
    body = toElement(
      RawText(t('jobs.create.noMatches', { defaultValue: 'Nothing matches' }))
        .padding('vertical', '2xl')
        .textAlign('center')
        .font('14')
        .leading('20px')
        .foreground('muted'),
    );
  } else {
    body = places.map((place) =>
      toElement(
        Row(place.name)
          .onPress(() => {
            setQuery('');
            setDebounced('');
            onSelect(place);
          })
          .subtitle(
            [
              place.region,
              vocabulary.countryName(place.countryCode),
              place.kind === 'region'
                ? t('jobs.create.placeKindRegion', { defaultValue: 'Region' })
                : undefined,
            ]
              .filter(Boolean)
              .join(' · '),
          )
          .selected(place.id === selectedId),
        place.id,
      ),
    );
  }

  const title = t('jobs.create.placeSearchTitle', { defaultValue: 'Find a city or region' });
  return toElement(
    LDialog(
      LSearch([query, setQuery])
        .label(t('jobs.create.placeSearchLabel', { defaultValue: 'Search places' }))
        .onClearText(() => setQuery('')),
      Embed(
        <ScrollView style={{ maxHeight: 360, marginTop: 8 }} keyboardShouldPersistTaps="handled">
          {body}
        </ScrollView>,
      ),
    )
      .title(title)
      .label(title)
      .presented([open, () => close()]),
  );
});

interface JobLocationFieldProps {
  value: JobLocationDraft;
  onChange: (next: JobLocationDraft) => void;
}

/**
 * The job form's location: none, a Clarity place (city or region, from the
 * autocomplete behind `GET /jobs/places/search`), or a country alone. The
 * server derives a place's country/region/city itself, so the form only ever
 * sends the place id.
 */
const JobLocationField = memo(function JobLocationField({
  value,
  onChange,
}: JobLocationFieldProps) {
  const { t } = useTranslation();
  const vocabulary = useJobVocabulary();
  const [placeDialogOpen, setPlaceDialogOpen] = useState(false);
  const [countryDialogOpen, setCountryDialogOpen] = useState(false);

  const countryOptions = useMemo(
    () =>
      COUNTRY_CODES.map((code) => {
        const name = vocabulary.countryName(code);
        return { code, name: name === code ? undefined : name };
      }).sort((a, b) => (a.name ?? a.code).localeCompare(b.name ?? b.code, vocabulary.locale)),
    [vocabulary],
  );

  const label = t('jobs.create.location', { defaultValue: 'Location' });

  return toElement(
    VStack(
      RawText(label).font('14').leading('20px').foreground('muted').margin('bottom', '6'),
      Segmented(
        [
          value.kind,
          (kind) => {
            if (kind === value.kind) return;
            onChange(
              kind === 'place'
                ? { kind: 'place', place: null }
                : kind === 'country'
                  ? { kind: 'country', countryCode: null }
                  : EMPTY_JOB_LOCATION,
            );
          },
        ],
        Option('none', t('jobs.create.locationNone', { defaultValue: 'None' })),
        Option('place', t('jobs.create.locationPlace', { defaultValue: 'City or region' })),
        Option('country', t('jobs.create.locationCountry', { defaultValue: 'Country only' })),
      )
        .label(label)
        .size('sm'),
      value.kind === 'place'
        ? VStack(
            Row(
              value.place
                ? value.place.name
                : t('jobs.create.selectPlace', { defaultValue: 'Choose a city or region' }),
            )
              .onPress(() => setPlaceDialogOpen(true))
              .subtitle(
                value.place
                  ? [value.place.region, vocabulary.countryName(value.place.countryCode)]
                      .filter(Boolean)
                      .join(', ')
                  : undefined,
              ),
          )
            .background('card')
            .border('border', 'thin')
            .corner('14')
            .clipped()
            .margin('top', 'sm')
        : null,
      value.kind === 'country'
        ? VStack(
            Row(
              value.countryCode
                ? vocabulary.countryName(value.countryCode)
                : t('jobs.create.selectCountry', { defaultValue: 'Choose a country' }),
            )
              .onPress(() => setCountryDialogOpen(true))
              .subtitle(
                value.countryCode && vocabulary.countryName(value.countryCode) !== value.countryCode
                  ? value.countryCode
                  : undefined,
              ),
          )
            .background('card')
            .border('border', 'thin')
            .corner('14')
            .clipped()
            .margin('top', 'sm')
        : null,
      Embed(
        <PlaceSearchDialog
          open={placeDialogOpen}
          selectedId={value.kind === 'place' ? (value.place?.id ?? null) : null}
          onSelect={(place) => {
            onChange({ kind: 'place', place });
            setPlaceDialogOpen(false);
          }}
          onClose={() => setPlaceDialogOpen(false)}
        />,
      ),
      Embed(
        <CodePickerDialog
          open={countryDialogOpen}
          title={t('jobs.create.selectCountry', { defaultValue: 'Choose a country' })}
          searchLabel={t('jobs.create.countrySearchLabel', { defaultValue: 'Search countries' })}
          options={countryOptions}
          selected={value.kind === 'country' ? value.countryCode : null}
          onSelect={(countryCode) => {
            onChange({ kind: 'country', countryCode });
            setCountryDialogOpen(false);
          }}
          onClose={() => setCountryDialogOpen(false)}
        />,
      ),
    ),
  );
});

export default JobLocationField;
