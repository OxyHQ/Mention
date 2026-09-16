import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { Chip } from '@oxy.so/bloom/chip';
import { Loading } from '@oxy.so/bloom/loading';
import { SegmentedControl, SegmentedControlItem, SegmentedControlItemText } from '@oxy.so/bloom/segmented-control';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { logger } from '@oxy.so/core/logger';
import {
  MENTION_JOB_APPLICATION_MODES,
  MENTION_JOB_EMPLOYMENT_TYPES,
  MENTION_JOB_SALARY_INTERVALS,
  MENTION_JOB_WORKPLACE_TYPES,
  type MentionJobApplicationMode,
  type MentionJobEmploymentType,
  type MentionJobSalaryInterval,
  type MentionJobWorkplaceType,
  type UpdateMentionJobRequest,
} from '@mention/shared-types';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { jobsService, getJobErrorMessage } from '@/services/jobsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';

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
  month: 'Month',
  year: 'Year',
};

/**
 * Edit an existing Mention job listing. Same fields as `jobs/create.tsx`
 * minus the employer picker — the employer is immutable after creation
 * (`UpdateMentionJobRequest` omits `employerOxyUserId`). Status transitions
 * (publish/pause/close/duplicate) live on the dashboard (`jobs/mine.tsx`),
 * not here.
 */
export default function EditJobScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const jobId = String(id);
  const { t } = useTranslation();
  const { user } = useAuth();
  const safeBack = useSafeBack();
  const queryClient = useQueryClient();

  const jobQuery = useQuery({
    queryKey: viewerQueryKeys.jobDetail(user?.id, jobId),
    queryFn: () => jobsService.get(jobId),
    enabled: Boolean(jobId),
  });

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [locationRaw, setLocationRaw] = useState('');
  const [workplaceType, setWorkplaceType] = useState<MentionJobWorkplaceType | ''>('');
  const [employmentType, setEmploymentType] = useState<MentionJobEmploymentType | ''>('');
  const [salaryMin, setSalaryMin] = useState('');
  const [salaryMax, setSalaryMax] = useState('');
  const [salaryCurrency, setSalaryCurrency] = useState('USD');
  const [salaryInterval, setSalaryInterval] = useState<MentionJobSalaryInterval>('year');
  const [skillDraft, setSkillDraft] = useState('');
  const [skills, setSkills] = useState<string[]>([]);
  const [applicationMode, setApplicationMode] = useState<MentionJobApplicationMode>('mention');
  const [externalApplyUrl, setExternalApplyUrl] = useState('');
  const [hydrated, setHydrated] = useState(false);

  // Prefill once, when the job loads. A ref-free one-shot guard (`hydrated`)
  // rather than syncing on every refetch: a background refetch mid-edit must
  // not stomp on what the operator is actively typing.
  useEffect(() => {
    const job = jobQuery.data?.job;
    if (!job || hydrated) return;
    setTitle(job.title);
    setDescription(job.description);
    setLocationRaw(job.location?.raw ?? '');
    setWorkplaceType(job.workplaceType ?? '');
    setEmploymentType(job.employmentType ?? '');
    setSalaryMin(job.salary?.min !== undefined ? String(job.salary.min) : '');
    setSalaryMax(job.salary?.max !== undefined ? String(job.salary.max) : '');
    setSalaryCurrency(job.salary?.currency ?? 'USD');
    setSalaryInterval(job.salary?.interval ?? 'year');
    setSkills(job.skills ?? []);
    setApplicationMode(job.applicationMode);
    setExternalApplyUrl(job.externalApplyUrl ?? '');
    setHydrated(true);
  }, [jobQuery.data, hydrated]);

  const addSkill = useCallback(() => {
    const value = skillDraft.trim();
    if (!value) return;
    setSkills((prev) => (prev.includes(value) ? prev : [...prev, value]));
    setSkillDraft('');
  }, [skillDraft]);

  const removeSkill = useCallback((value: string) => {
    setSkills((prev) => prev.filter((s) => s !== value));
  }, []);

  const updateMutation = useMutation({
    mutationFn: (patch: UpdateMentionJobRequest) => jobsService.update(jobId, patch),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: viewerQueryKeys.jobDetail(user?.id, jobId) }),
        queryClient.invalidateQueries({ queryKey: viewerQueryKeys.jobsMine(user?.id) }),
      ]);
      toast.success(t('jobs.edit.saved', { defaultValue: 'Job updated' }));
      router.replace('/jobs/mine');
    },
    onError: (error) => {
      logger.error('[jobs/edit] Failed to update job', error);
      toast.error(getJobErrorMessage(error, t('jobs.edit.failed', { defaultValue: 'Could not save these changes' })));
    },
  });

  const save = useCallback(() => {
    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();
    if (!trimmedTitle || !trimmedDescription) return;

    const trimmedLocation = locationRaw.trim();
    const hasSalary = salaryMin.trim().length > 0 || salaryMax.trim().length > 0;
    const min = salaryMin.trim() ? Number(salaryMin) : undefined;
    const max = salaryMax.trim() ? Number(salaryMax) : undefined;

    // The wire contract (see `~/Oxy/Mention/.../job.ts` `UpdateMentionJobRequest`
    // background) lets an explicit `null` CLEAR a field — distinct from omitting
    // it, which leaves the stored value untouched. `Partial<...>` only types the
    // "send what changed" (`undefined`) half of that contract, so a field the
    // operator has actually cleared is cast through at the call site rather than
    // silently left unclearable.
    const patch = {
      title: trimmedTitle,
      description: trimmedDescription,
      location: trimmedLocation ? { raw: trimmedLocation } : null,
      workplaceType: workplaceType || null,
      employmentType: employmentType || null,
      salary: hasSalary
        ? {
            min: Number.isFinite(min) ? min : undefined,
            max: Number.isFinite(max) ? max : undefined,
            currency: salaryCurrency.trim() || 'USD',
            interval: salaryInterval,
          }
        : null,
      skills,
      applicationMode,
      externalApplyUrl: applicationMode === 'external' ? externalApplyUrl.trim() || null : null,
    } as UpdateMentionJobRequest;

    updateMutation.mutate(patch);
  }, [
    title,
    description,
    locationRaw,
    workplaceType,
    employmentType,
    salaryMin,
    salaryMax,
    salaryCurrency,
    salaryInterval,
    skills,
    applicationMode,
    externalApplyUrl,
    updateMutation,
  ]);

  const canSave = Boolean(
    title.trim() &&
      description.trim() &&
      (applicationMode !== 'external' || externalApplyUrl.trim().length > 0),
  );

  const header = (
    <Header
      options={{
        title: t('jobs.edit.title', { defaultValue: 'Edit job' }),
        leftComponents: [
          <IconButton key="back" variant="icon" onPress={safeBack}>
            <BackArrowIcon size={20} className="text-foreground" />
          </IconButton>,
        ],
      }}
      hideBottomBorder
      disableSticky
    />
  );

  if (jobQuery.isLoading || !hydrated) {
    return (
      <ThemedView className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center">
          <Loading className="text-primary" size="large" />
        </View>
      </ThemedView>
    );
  }

  if (jobQuery.isError || !jobQuery.data) {
    return (
      <ThemedView className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center gap-3 px-8">
          <Text className="text-muted-foreground text-base text-center">
            {t('jobs.edit.loadFailed', { defaultValue: 'Could not load this job' })}
          </Text>
          <Button variant="secondary" size="small" onPress={() => jobQuery.refetch()}>
            {t('common.tryAgain', { defaultValue: 'Try again' })}
          </Button>
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      {header}
      <ScrollView contentContainerClassName="px-4 pb-16 pt-2" keyboardShouldPersistTaps="handled">
        <View className="mt-1">
          <TextField>
            <TextFieldInput label={t('jobs.create.jobTitle', { defaultValue: 'Job title' })} value={title} onChangeText={setTitle} maxLength={200} />
          </TextField>
        </View>

        <View className="mt-3">
          <TextField>
            <TextFieldInput
              label={t('jobs.create.description', { defaultValue: 'Description' })}
              value={description}
              onChangeText={setDescription}
              multiline
              numberOfLines={6}
              style={{ minHeight: 120, textAlignVertical: 'top' }}
            />
          </TextField>
        </View>

        <View className="mt-3">
          <TextField>
            <TextFieldInput label={t('jobs.create.location', { defaultValue: 'Location' })} value={locationRaw} onChangeText={setLocationRaw} />
          </TextField>
        </View>

        <View className="mt-4">
          <Text className="text-sm text-muted-foreground mb-1.5 font-primary">
            {t('jobs.create.workplaceType', { defaultValue: 'Workplace type' })}
          </Text>
          <SegmentedControl
            label={t('jobs.create.workplaceType', { defaultValue: 'Workplace type' })}
            type="radio"
            value={workplaceType || 'unset'}
            onChange={(value) => setWorkplaceType(value === 'unset' ? '' : value)}
          >
            <SegmentedControlItem value="unset">
              <SegmentedControlItemText>{t('jobs.create.notSpecified', { defaultValue: 'Not specified' })}</SegmentedControlItemText>
            </SegmentedControlItem>
            {MENTION_JOB_WORKPLACE_TYPES.map((value) => (
              <SegmentedControlItem key={value} value={value}>
                <SegmentedControlItemText>{WORKPLACE_LABELS[value]}</SegmentedControlItemText>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </View>

        <View className="mt-4">
          <Text className="text-sm text-muted-foreground mb-1.5 font-primary">
            {t('jobs.create.employmentType', { defaultValue: 'Employment type' })}
          </Text>
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
        </View>

        <View className="mt-4">
          <Text className="text-sm text-muted-foreground mb-1.5 font-primary">
            {t('jobs.create.salary', { defaultValue: 'Salary (optional)' })}
          </Text>
          <View className="flex-row gap-2">
            <View className="flex-1">
              <TextField>
                <TextFieldInput label={t('jobs.create.salaryMin', { defaultValue: 'Min' })} value={salaryMin} onChangeText={setSalaryMin} keyboardType="numeric" />
              </TextField>
            </View>
            <View className="flex-1">
              <TextField>
                <TextFieldInput label={t('jobs.create.salaryMax', { defaultValue: 'Max' })} value={salaryMax} onChangeText={setSalaryMax} keyboardType="numeric" />
              </TextField>
            </View>
            <View style={{ width: 90 }}>
              <TextField>
                <TextFieldInput
                  label={t('jobs.create.currency', { defaultValue: 'Currency' })}
                  value={salaryCurrency}
                  onChangeText={(v) => setSalaryCurrency(v.toUpperCase())}
                  autoCapitalize="characters"
                  maxLength={3}
                />
              </TextField>
            </View>
          </View>
          <View className="mt-2">
            <SegmentedControl
              label={t('jobs.create.salaryInterval', { defaultValue: 'Per' })}
              type="radio"
              size="small"
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
        </View>

        <View className="mt-4">
          <Text className="text-sm text-muted-foreground mb-1.5 font-primary">
            {t('jobs.create.skills', { defaultValue: 'Skills' })}
          </Text>
          <View className="flex-row gap-2 items-start">
            <View className="flex-1">
              <TextField>
                <TextFieldInput
                  label={t('jobs.create.addSkill', { defaultValue: 'Add a skill' })}
                  value={skillDraft}
                  onChangeText={setSkillDraft}
                  onSubmitEditing={addSkill}
                  returnKeyType="done"
                />
              </TextField>
            </View>
            <Button variant="secondary" size="medium" onPress={addSkill} disabled={!skillDraft.trim()}>
              {t('common.add', { defaultValue: 'Add' })}
            </Button>
          </View>
          {skills.length > 0 ? (
            <View className="flex-row flex-wrap gap-2 mt-2">
              {skills.map((skill) => (
                <Chip key={skill} onClose={() => removeSkill(skill)}>
                  {skill}
                </Chip>
              ))}
            </View>
          ) : null}
        </View>

        <View className="mt-4">
          <Text className="text-sm text-muted-foreground mb-1.5 font-primary">
            {t('jobs.create.applicationMode', { defaultValue: 'How do people apply?' })}
          </Text>
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
          ) : null}
        </View>

        <View className="mt-6">
          <Button
            variant="primary"
            size="large"
            loading={updateMutation.isPending}
            disabled={!canSave || updateMutation.isPending}
            onPress={save}
          >
            {t('jobs.edit.save', { defaultValue: 'Save changes' })}
          </Button>
        </View>
      </ScrollView>
    </ThemedView>
  );
}
