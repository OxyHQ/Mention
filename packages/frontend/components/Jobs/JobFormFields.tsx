import { useCallback } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Chip } from '@oxy.so/bloom/chip';
import { Field } from '@oxy.so/bloom/field';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { TagField } from '@oxy.so/bloom/tag-field';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
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
      <View className="mt-4">
        <TextField>
          <TextFieldInput
            label={t('jobs.create.jobTitle', { defaultValue: 'Job title' })}
            value={title}
            onChangeText={setTitle}
            maxLength={200}
          />
        </TextField>
      </View>

      <View className="mt-3">
        <Textarea
          accessibilityLabel={t('jobs.create.description', { defaultValue: 'Description' })}
          placeholder={t('jobs.create.description', { defaultValue: 'Description' })}
          value={description}
          onChangeText={setDescription}
          rows={6}
        />
      </View>

      {/* Location — a Clarity place or a country, never free text */}
      <View className="mt-4">
        <JobLocationField value={location} onChange={setLocation} />
      </View>

      <Field
        label={t('jobs.create.workplaceType', { defaultValue: 'Workplace type' })}
        style={{ marginTop: 16 }}
      >
        <SegmentedControl
          label={t('jobs.create.workplaceType', { defaultValue: 'Workplace type' })}
          type="radio"
          value={workplaceType || 'unset'}
          onChange={(value) =>
            setWorkplaceType(value === 'unset' ? '' : (value as MentionJobWorkplaceType))
          }
        >
          <SegmentedControlItem value="unset">
            <SegmentedControlItemText>
              {t('jobs.create.notSpecified', { defaultValue: 'Not specified' })}
            </SegmentedControlItemText>
          </SegmentedControlItem>
          {MENTION_JOB_WORKPLACE_TYPES.map((value) => (
            <SegmentedControlItem key={value} value={value}>
              <SegmentedControlItemText>{WORKPLACE_LABELS[value]}</SegmentedControlItemText>
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
      </Field>

      {/* Employment type — a chip row rather than a SegmentedControl: six
          values would cram into an unreadable pill row on a phone width. */}
      <Field
        label={t('jobs.create.employmentType', { defaultValue: 'Employment type' })}
        multiple
        style={{ marginTop: 16 }}
      >
        <View className="flex-row flex-wrap gap-2">
          {MENTION_JOB_EMPLOYMENT_TYPES.map((value) => (
            <Chip
              key={value}
              selected={employmentType === value}
              onPress={() => setEmploymentType((prev) => (prev === value ? '' : value))}
            >
              {EMPLOYMENT_LABELS[value]}
            </Chip>
          ))}
        </View>
      </Field>

      <Field
        label={t('jobs.create.salary', { defaultValue: 'Salary (optional)' })}
        multiple
        style={{ marginTop: 16 }}
      >
        <View className="flex-row gap-2">
          <View className="flex-1">
            <TextField>
              <TextFieldInput
                label={t('jobs.create.salaryMin', { defaultValue: 'Min' })}
                value={salaryMin}
                onChangeText={setSalaryMin}
                keyboardType="numeric"
              />
            </TextField>
          </View>
          <View className="flex-1">
            <TextField>
              <TextFieldInput
                label={t('jobs.create.salaryMax', { defaultValue: 'Max' })}
                value={salaryMax}
                onChangeText={setSalaryMax}
                keyboardType="numeric"
              />
            </TextField>
          </View>
        </View>
        <View className="mt-2">
          <JobCurrencyField value={salaryCurrency} onChange={setSalaryCurrency} />
        </View>
        <View className="mt-2">
          <SegmentedControl
            label={t('jobs.create.salaryInterval', { defaultValue: 'Per' })}
            type="radio"
            size="sm"
            value={salaryInterval}
            onChange={setSalaryInterval}
          >
            {MENTION_JOB_SALARY_INTERVALS.map((value) => (
              <SegmentedControlItem key={value} value={value}>
                <SegmentedControlItemText>{INTERVAL_LABELS[value]}</SegmentedControlItemText>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </View>
      </Field>

      {/* Skills — Enter or a comma commits a skill; each chip removes itself. */}
      <Field label={t('jobs.create.skills', { defaultValue: 'Skills' })} style={{ marginTop: 16 }}>
        <TagField
          value={skills}
          onChange={handleSkillsChange}
          placeholder={t('jobs.create.addSkill', { defaultValue: 'Add a skill' })}
        />
      </Field>

      <View className="mt-4">
        <Field label={t('jobs.create.applicationMode', { defaultValue: 'How do people apply?' })}>
          <SegmentedControl
            label={t('jobs.create.applicationMode', { defaultValue: 'How do people apply?' })}
            type="radio"
            value={applicationMode}
            onChange={setApplicationMode}
          >
            {MENTION_JOB_APPLICATION_MODES.map((value) => (
              <SegmentedControlItem key={value} value={value}>
                <SegmentedControlItemText>
                  {value === 'mention'
                    ? t('jobs.create.applyViaMention', { defaultValue: 'On Mention' })
                    : t('jobs.create.applyExternally', { defaultValue: 'External link' })}
                </SegmentedControlItemText>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </Field>
        {applicationMode === 'external' ? (
          <View className="mt-2">
            <TextField isInvalid={!externalApplyUrl.trim()}>
              <TextFieldInput
                label={t('jobs.create.externalApplyUrl', { defaultValue: 'Application URL' })}
                value={externalApplyUrl}
                onChangeText={setExternalApplyUrl}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
            </TextField>
          </View>
        ) : (
          <Text className="text-muted-foreground text-xs mt-2">
            {t('jobs.create.applyViaMentionHint', {
              defaultValue:
                'Applicants apply through Mention, and you’ll review applications from your dashboard.',
            })}
          </Text>
        )}
      </View>
    </>
  );
}
