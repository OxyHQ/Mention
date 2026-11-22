import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Field } from '@oxy.so/bloom/field';
import { SegmentedControlItemText } from '@oxy.so/bloom/segmented-control';
import { TagField } from '@oxy.so/bloom/tag-field';
import type {
  MentionJobEmploymentType,
  MentionJobSalaryInterval,
  MentionJobWorkplaceType,
} from '@mention/shared-types';
import {
  MENTION_JOB_APPLICATION_MODES,
  MENTION_JOB_EMPLOYMENT_TYPES,
  MENTION_JOB_SALARY_INTERVALS,
  MENTION_JOB_WORKPLACE_TYPES,
} from '@mention/shared-types/job';
import JobLocationField from '@/components/Jobs/JobLocationField';
import type { JobForm } from '@/components/Jobs/jobForm';
import JobCurrencyField from '@/components/Jobs/JobCurrencyField';

import {
  Chip as LChip,
  Embed,
  Field as LField,
  HStack,
  Option,
  RawText,
  Segmented,
  Text as LText,
  TextEditor,
  TextField as LTextField,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

const WORKPLACE_LABELS: Record<MentionJobWorkplaceType, string> = {
  onsite: 'On-site',
  hybrid: 'Hybrid',
  remote: 'Remote',
};

const EMPLOYMENT_LABELS: Record<MentionJobEmploymentType, string> = {
  full_time: 'Full-time',
  part_time: 'Part-time',
  contract: 'Contract',
  temporary: 'Temporary',
  internship: 'Internship',
  other: 'Other',
};

const INTERVAL_LABELS: Record<MentionJobSalaryInterval, string> = {
  hour: 'Hour',
  day: 'Day',
  week: 'Week',
  month: 'Month',
  year: 'Year',
};

export function JobFormFields({ form }: { form: JobForm }) {
  const { t } = useTranslation();
  const {
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
  } = form;

  const handleSkillsChange = useCallback(
    (next: readonly string[]) => {
      setSkills([...next]);
    },
    [setSkills],
  );

  return (
    <>
      {toElement(
        VStack(
          LTextField(
            [title, setTitle],
            t('jobs.create.jobTitle', { defaultValue: 'Job title' }),
          ).maxLength(200),
        ).margin('top', 'lg'),
      )}
      {toElement(
        VStack(
          TextEditor([description, setDescription])
            .label(t('jobs.create.description', { defaultValue: 'Description' }))
            .placeholder(t('jobs.create.description', { defaultValue: 'Description' }))
            .rows(6),
        ).margin('top', 'md'),
      )}
      {/* Location — a Clarity place or a country, never free text */}
      {toElement(
        VStack(Embed(<JobLocationField value={location} onChange={setLocation} />)).margin(
          'top',
          'lg',
        ),
      )}
      {toElement(
        LField(
          t('jobs.create.workplaceType', { defaultValue: 'Workplace type' }),
          Segmented(
            [
              workplaceType || 'unset',
              (value) =>
                setWorkplaceType(value === 'unset' ? '' : (value as MentionJobWorkplaceType)),
            ],
            Option('unset', t('jobs.create.notSpecified', { defaultValue: 'Not specified' })),
            MENTION_JOB_WORKPLACE_TYPES.map((value) => Option(value, WORKPLACE_LABELS[value])),
          ).label(t('jobs.create.workplaceType', { defaultValue: 'Workplace type' })),
        ).margin('top', 'lg'),
      )}
      {/* Employment type — a chip row rather than a SegmentedControl: six
          values would cram into an unreadable pill row on a phone width. */}
      <Field
        label={t('jobs.create.employmentType', { defaultValue: 'Employment type' })}
        multiple
        style={{ marginTop: 16 }}
      >
        {toElement(
          HStack(
            Embed(
              MENTION_JOB_EMPLOYMENT_TYPES.map((value) =>
                toElement(
                  LChip(LText(EMPLOYMENT_LABELS[value]))
                    .selected(employmentType === value)
                    .onPress(() => setEmploymentType((prev) => (prev === value ? '' : value))),
                  value,
                ),
              ),
            ),
          )
            .wrap()
            .spacing('sm'),
        )}
      </Field>
      <Field
        label={t('jobs.create.salary', { defaultValue: 'Salary (optional)' })}
        multiple
        style={{ marginTop: 16 }}
      >
        {toElement(
          HStack(
            VStack(
              LTextField(
                [salaryMin, setSalaryMin],
                t('jobs.create.salaryMin', { defaultValue: 'Min' }),
              ).keyboard('numeric'),
            ).flex('1'),
            VStack(
              LTextField(
                [salaryMax, setSalaryMax],
                t('jobs.create.salaryMax', { defaultValue: 'Max' }),
              ).keyboard('numeric'),
            ).flex('1'),
          ).spacing('sm'),
        )}
        {toElement(
          VStack(
            Embed(<JobCurrencyField value={salaryCurrency} onChange={setSalaryCurrency} />),
          ).margin('top', 'sm'),
        )}
        {toElement(
          VStack(
            Segmented(
              [salaryInterval, setSalaryInterval],
              MENTION_JOB_SALARY_INTERVALS.map((value) => Option(value, INTERVAL_LABELS[value])),
            )
              .label(t('jobs.create.salaryInterval', { defaultValue: 'Per' }))
              .size('sm'),
          ).margin('top', 'sm'),
        )}
      </Field>
      {/* Skills — Enter or a comma commits a skill; each chip removes itself. */}
      {toElement(
        LField(
          t('jobs.create.skills', { defaultValue: 'Skills' }),
          Embed(
            <TagField
              value={skills}
              onChange={handleSkillsChange}
              placeholder={t('jobs.create.addSkill', { defaultValue: 'Add a skill' })}
            />,
          ),
        ).margin('top', 'lg'),
      )}
      {toElement(
        VStack(
          LField(
            t('jobs.create.applicationMode', { defaultValue: 'How do people apply?' }),
            Segmented(
              [applicationMode, setApplicationMode],
              MENTION_JOB_APPLICATION_MODES.map((value) =>
                Option(
                  value,
                  value === 'mention'
                    ? t('jobs.create.applyViaMention', { defaultValue: 'On Mention' })
                    : t('jobs.create.applyExternally', { defaultValue: 'External link' }),
                ),
              ),
            ).label(t('jobs.create.applicationMode', { defaultValue: 'How do people apply?' })),
          ),
          applicationMode === 'external'
            ? VStack(
                LTextField(
                  [externalApplyUrl, setExternalApplyUrl],
                  t('jobs.create.externalApplyUrl', { defaultValue: 'Application URL' }),
                )
                  .invalid(!externalApplyUrl.trim())
                  .autocapitalize('none')
                  .autocorrect(false)
                  .keyboard('url'),
              ).margin('top', 'sm')
            : RawText(
                t('jobs.create.applyViaMentionHint', {
                  defaultValue:
                    'Applicants apply through Mention, and you’ll review applications from your dashboard.',
                }),
              )
                .foreground('muted')
                .font('xs')
                .leading('16px')
                .margin('top', 'sm'),
        ).margin('top', 'lg'),
      )}
    </>
  );
}
