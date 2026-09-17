import React, { memo, useEffect, useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { Search } from '@oxy.so/bloom/search';
import { SegmentedControl, SegmentedControlItem, SegmentedControlItemText } from '@oxy.so/bloom/segmented-control';
import {
  COUNTRY_CODES,
  type CountryCode,
  type MentionJobLocation,
  type MentionJobLocationInput,
  type MentionJobPlace,
} from '@mention/shared-types';
import { jobsService } from '@/services/jobsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { useJobVocabulary } from '@/utils/jobVocabulary';
import CodePickerDialog from './CodePickerDialog';

/**
 * What the form holds for a location. Never free text: a Clarity place picked
 * from the autocomplete, a country picked from `COUNTRY_CODES`, or nothing.
 */
export type JobLocationDraft =
  | { kind: 'none' }
  | { kind: 'place'; place: MentionJobPlace | null }
  | { kind: 'country'; countryCode: CountryCode | null };

export const EMPTY_JOB_LOCATION: JobLocationDraft = { kind: 'none' };

/** The stored location, as the form's starting draft (edit). */
export function jobLocationDraftFrom(location: MentionJobLocation | undefined): JobLocationDraft {
  if (!location) return EMPTY_JOB_LOCATION;
  if (!location.placeId) return { kind: 'country', countryCode: location.countryCode };
  return {
    kind: 'place',
    place: {
      id: location.placeId,
      kind: location.city ? 'city' : 'region',
      name: location.city ?? location.region ?? location.countryCode,
      countryCode: location.countryCode,
      region: location.city ? location.region : undefined,
    },
  };
}

/** The request body's `location`: `undefined` when the draft names nothing yet. */
export function jobLocationInputFrom(draft: JobLocationDraft): MentionJobLocationInput | undefined {
  if (draft.kind === 'place' && draft.place) return { placeId: draft.place.id };
  if (draft.kind === 'country' && draft.countryCode) return { countryCode: draft.countryCode };
  return undefined;
}

/** A chosen kind with nothing picked in it — the form should not submit that silently. */
export function isJobLocationIncomplete(draft: JobLocationDraft): boolean {
  return draft.kind !== 'none' && jobLocationInputFrom(draft) === undefined;
}

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
    const timer = setTimeout(() => setDebounced(query.trim()), PLACE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

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
    body = (
      <Text className="text-center text-sm text-muted-foreground py-6">
        {t('jobs.create.placeSearchHint', { defaultValue: 'Type at least 2 letters of a city or region' })}
      </Text>
    );
  } else if (isError) {
    body = (
      <Text className="text-center text-sm text-muted-foreground py-6">
        {t('jobs.create.placeSearchFailed', { defaultValue: 'Place search is unavailable right now' })}
      </Text>
    );
  } else if (isFetching && places.length === 0) {
    body = (
      <View className="items-center py-6">
        <Loading className="text-primary" size="small" />
      </View>
    );
  } else if (places.length === 0) {
    body = (
      <Text className="text-center text-sm text-muted-foreground py-6">
        {t('jobs.create.noMatches', { defaultValue: 'Nothing matches' })}
      </Text>
    );
  } else {
    body = places.map((place) => (
      <Item
        key={place.id}
        onPress={() => {
          setQuery('');
          setDebounced('');
          onSelect(place);
        }}
        title={place.name}
        subtitle={[
          place.region,
          vocabulary.countryName(place.countryCode),
          place.kind === 'region' ? t('jobs.create.placeKindRegion', { defaultValue: 'Region' }) : undefined,
        ]
          .filter(Boolean)
          .join(' · ')}
        selected={place.id === selectedId}
      />
    ));
  }

  const title = t('jobs.create.placeSearchTitle', { defaultValue: 'Find a city or region' });
  return (
    <Dialog open={open} onClose={close} title={title} label={title}>
      <Search
        label={t('jobs.create.placeSearchLabel', { defaultValue: 'Search places' })}
        value={query}
        onChangeText={setQuery}
        onClearText={() => setQuery('')}
      />
      <ScrollView style={{ maxHeight: 360, marginTop: 8 }} keyboardShouldPersistTaps="handled">
        {body}
      </ScrollView>
    </Dialog>
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
const JobLocationField = memo(function JobLocationField({ value, onChange }: JobLocationFieldProps) {
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

  return (
    <View>
      <Text className="text-sm text-muted-foreground mb-1.5 font-primary">{label}</Text>
      <SegmentedControl
        label={label}
        type="radio"
        size="small"
        value={value.kind}
        onChange={(kind) => {
          if (kind === value.kind) return;
          onChange(
            kind === 'place'
              ? { kind: 'place', place: null }
              : kind === 'country'
                ? { kind: 'country', countryCode: null }
                : EMPTY_JOB_LOCATION,
          );
        }}
      >
        <SegmentedControlItem value="none">
          <SegmentedControlItemText>{t('jobs.create.locationNone', { defaultValue: 'None' })}</SegmentedControlItemText>
        </SegmentedControlItem>
        <SegmentedControlItem value="place">
          <SegmentedControlItemText>{t('jobs.create.locationPlace', { defaultValue: 'City or region' })}</SegmentedControlItemText>
        </SegmentedControlItem>
        <SegmentedControlItem value="country">
          <SegmentedControlItemText>{t('jobs.create.locationCountry', { defaultValue: 'Country only' })}</SegmentedControlItemText>
        </SegmentedControlItem>
      </SegmentedControl>

      {value.kind === 'place' ? (
        <View className="border border-border rounded-[14px] overflow-hidden bg-card mt-2">
          <Item
            onPress={() => setPlaceDialogOpen(true)}
            title={value.place ? value.place.name : t('jobs.create.selectPlace', { defaultValue: 'Choose a city or region' })}
            subtitle={
              value.place
                ? [value.place.region, vocabulary.countryName(value.place.countryCode)].filter(Boolean).join(', ')
                : undefined
            }
          />
        </View>
      ) : null}

      {value.kind === 'country' ? (
        <View className="border border-border rounded-[14px] overflow-hidden bg-card mt-2">
          <Item
            onPress={() => setCountryDialogOpen(true)}
            title={
              value.countryCode
                ? vocabulary.countryName(value.countryCode)
                : t('jobs.create.selectCountry', { defaultValue: 'Choose a country' })
            }
            subtitle={value.countryCode && vocabulary.countryName(value.countryCode) !== value.countryCode ? value.countryCode : undefined}
          />
        </View>
      ) : null}

      <PlaceSearchDialog
        open={placeDialogOpen}
        selectedId={value.kind === 'place' ? (value.place?.id ?? null) : null}
        onSelect={(place) => {
          onChange({ kind: 'place', place });
          setPlaceDialogOpen(false);
        }}
        onClose={() => setPlaceDialogOpen(false)}
      />
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
      />
    </View>
  );
});

export default JobLocationField;
