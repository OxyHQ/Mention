import { useCallback, useState } from 'react';
import type {
  CountryCode,
  CurrencyCode,
  MentionJobApplicationMode,
  MentionJobEmploymentType,
  MentionJobLocation,
  MentionJobLocationInput,
  MentionJobPlace,
  MentionJobSalaryInterval,
  MentionJobWorkplaceType,
} from '@mention/shared-types';
import type { jobsService } from '@/services/jobsService';

// The form's state and its wire helpers, apart from the fields that render it
// (`JobFormFields`, loaded through `LazyJobFormFields`): the create and edit
// routes hold this state themselves, and a static import of the fields from
// both would hoist them into the startup chunk.

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

type LoadedJob = Awaited<ReturnType<typeof jobsService.get>>['job'];

/**
 * The editable listing fields shared by `jobs/create.tsx` and
 * `jobs/[id]/edit.tsx`. The screens own what differs — the employer picker,
 * the submit actions and the wire payload (create omits cleared fields, edit
 * sends an explicit `null` to clear them).
 */
export function useJobForm() {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState<JobLocationDraft>(EMPTY_JOB_LOCATION);
  const [workplaceType, setWorkplaceType] = useState<MentionJobWorkplaceType | ''>('');
  const [employmentType, setEmploymentType] = useState<MentionJobEmploymentType | ''>('');
  const [salaryMin, setSalaryMin] = useState('');
  const [salaryMax, setSalaryMax] = useState('');
  const [salaryCurrency, setSalaryCurrency] = useState<CurrencyCode>('USD');
  const [salaryInterval, setSalaryInterval] = useState<MentionJobSalaryInterval>('year');
  const [skills, setSkills] = useState<string[]>([]);
  const [applicationMode, setApplicationMode] = useState<MentionJobApplicationMode>('mention');
  const [externalApplyUrl, setExternalApplyUrl] = useState('');

  const hydrate = useCallback((job: LoadedJob) => {
    setTitle(job.title);
    setDescription(job.description);
    setLocation(jobLocationDraftFrom(job.location));
    setWorkplaceType(job.workplaceType ?? '');
    setEmploymentType(job.employmentType ?? '');
    setSalaryMin(job.salary?.min !== undefined ? String(job.salary.min) : '');
    setSalaryMax(job.salary?.max !== undefined ? String(job.salary.max) : '');
    setSalaryCurrency(job.salary?.currency ?? 'USD');
    setSalaryInterval(job.salary?.interval ?? 'year');
    setSkills(job.skills ?? []);
    setApplicationMode(job.applicationMode);
    setExternalApplyUrl(job.externalApplyUrl ?? '');
  }, []);

  const hasSalary = salaryMin.trim().length > 0 || salaryMax.trim().length > 0;
  const min = salaryMin.trim() ? Number(salaryMin) : undefined;
  const max = salaryMax.trim() ? Number(salaryMax) : undefined;
  const salary = hasSalary
    ? {
        min: Number.isFinite(min) ? min : undefined,
        max: Number.isFinite(max) ? max : undefined,
        currency: salaryCurrency,
        interval: salaryInterval,
      }
    : undefined;

  const isComplete = Boolean(
    title.trim() && description.trim() && !isJobLocationIncomplete(location),
  );
  const isApplyReady = applicationMode !== 'external' || externalApplyUrl.trim().length > 0;

  return {
    title,
    setTitle,
    description,
    setDescription,
    location,
    setLocation,
    workplaceType,
    setWorkplaceType,
    employmentType,
    setEmploymentType,
    salaryMin,
    setSalaryMin,
    salaryMax,
    setSalaryMax,
    salaryCurrency,
    setSalaryCurrency,
    salaryInterval,
    setSalaryInterval,
    skills,
    setSkills,
    applicationMode,
    setApplicationMode,
    externalApplyUrl,
    setExternalApplyUrl,
    hydrate,
    /** Wire-shaped salary, or `undefined` when neither bound is filled in. */
    salary,
    /** Title, description and location are valid (enough to save a draft). */
    isComplete,
    /** An external application mode has its URL (required to publish). */
    isApplyReady,
  };
}

export type JobForm = ReturnType<typeof useJobForm>;
