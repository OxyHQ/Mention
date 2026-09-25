import type { Href } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { Chip } from '@oxy.so/bloom/chip';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { SegmentedControl, SegmentedControlItem, SegmentedControlItemText } from '@oxy.so/bloom/segmented-control';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import type { AccountNode } from '@oxy.so/core';
import { logger } from '@oxy.so/core/logger';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import type {
  CreateMentionJobRequest,
  CurrencyCode,
  MentionJobApplicationMode,
  MentionJobEmploymentType,
  MentionJobSalaryInterval,
  MentionJobWorkplaceType,
} from '@mention/shared-types';
import {
  MENTION_JOB_APPLICATION_MODES,
  MENTION_JOB_ELIGIBLE_EMPLOYER_KINDS,
  MENTION_JOB_EMPLOYMENT_TYPES,
  MENTION_JOB_SALARY_INTERVALS,
  MENTION_JOB_WORKPLACE_TYPES,
} from '@mention/shared-types/job';
import { useSafeBack } from '@/hooks/useSafeBack';
import { displayNameOrHandle } from '@/utils/displayName';
import { jobsService, getJobErrorMessage, isJobEntitlementError } from '@/services/jobsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { SignInRequired } from '@/components/common/SignInRequired';
import JobLocationField, {
  EMPTY_JOB_LOCATION,
  isJobLocationIncomplete,
  jobLocationInputFrom,
  type JobLocationDraft,
} from '@/components/Jobs/JobLocationField';
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

const ELIGIBLE_KINDS: readonly string[] = MENTION_JOB_ELIGIBLE_EMPLOYER_KINDS;

/**
 * Employer account picker — mirrors `components/Compose/PublishAsDialog.tsx`'s
 * Dialog + Item-list shape (the app's existing "who am I posting/acting as"
 * pattern) rather than inventing a new one. It diverges from that dialog in
 * one load-bearing way: there is no "Myself" row. A job's employer must be an
 * organization or project account (`MENTION_JOB_ELIGIBLE_EMPLOYER_KINDS`,
 * enforced again server-side by `jobAuthority.ts`) — a personal account can
 * never be named, so offering it here would just be a control that always 400s.
 */
function EmployerPickerDialog({
  open,
  accounts,
  selectedId,
  onSelect,
  onClose,
}: {
  open: boolean;
  accounts: AccountNode[];
  selectedId: string | null;
  onSelect: (account: AccountNode) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('jobs.create.employerPickerTitle', { defaultValue: 'Publish as' })}
      label={t('jobs.create.employerPickerTitle', { defaultValue: 'Publish as' })}
    >
      {accounts.length === 0 ? (
        <Text className="text-center text-sm text-muted-foreground py-6 px-6">
          {t('jobs.create.noEmployers', {
            defaultValue: 'You do not operate an organization or project account yet. Create one to publish a job.',
          })}
        </Text>
      ) : (
        accounts.map((account) => (
          <Item
            key={account.accountId}
            onPress={() => onSelect(account)}
            leading={
              <Avatar
                source={account.account.avatar}
                size={36}
                variant={MEDIA_VARIANT_AVATAR}
                verified={Boolean(account.account.verified)}
              />
            }
            title={displayNameOrHandle(account.account.name?.displayName, `@${account.account.username}`)}
            subtitle={`@${account.account.username} · ${account.kind}`}
            selected={account.accountId === selectedId}
          />
        ))
      )}
    </Dialog>
  );
}

/**
 * Create a Mention job listing. Every `CreateMentionJobRequest` field has a
 * control here; "Save draft" and "Publish" are two distinct submit actions
 * (`publish: false` / `true`) rather than one button with a toggle, so a
 * draft can never be published by mistake.
 */
export default function CreateJobScreen() {
  const { t } = useTranslation();
  const { user, oxyServices, canUsePrivateApi } = useAuth();
  const safeBack = useSafeBack();
  const queryClient = useQueryClient();

  const { data: accounts = [], isLoading: accountsLoading } = useQuery<AccountNode[]>({
    queryKey: viewerQueryKeys.operatedAccounts(user?.id),
    queryFn: () => oxyServices.listAccounts(),
    enabled: canUsePrivateApi,
  });

  const eligibleAccounts = useMemo(
    () => accounts.filter((account) => ELIGIBLE_KINDS.includes(account.kind)),
    [accounts],
  );

  const [employerPickerOpen, setEmployerPickerOpen] = useState(false);
  const [employer, setEmployer] = useState<AccountNode | null>(null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState<JobLocationDraft>(EMPTY_JOB_LOCATION);

  const [workplaceType, setWorkplaceType] = useState<MentionJobWorkplaceType | ''>('');
  const [employmentType, setEmploymentType] = useState<MentionJobEmploymentType | ''>('');

  const [salaryMin, setSalaryMin] = useState('');
  const [salaryMax, setSalaryMax] = useState('');
  const [salaryCurrency, setSalaryCurrency] = useState<CurrencyCode>('USD');
  const [salaryInterval, setSalaryInterval] = useState<MentionJobSalaryInterval>('year');

  const [skillDraft, setSkillDraft] = useState('');
  const [skills, setSkills] = useState<string[]>([]);

  const [applicationMode, setApplicationMode] = useState<MentionJobApplicationMode>('mention');
  const [externalApplyUrl, setExternalApplyUrl] = useState('');

  const addSkill = useCallback(() => {
    const value = skillDraft.trim();
    if (!value) return;
    setSkills((prev) => (prev.includes(value) ? prev : [...prev, value]));
    setSkillDraft('');
  }, [skillDraft]);

  const removeSkill = useCallback((value: string) => {
    setSkills((prev) => prev.filter((s) => s !== value));
  }, []);

  const buildPayload = useCallback(
    (publish: boolean): CreateMentionJobRequest | null => {
      if (!employer) return null;
      const trimmedTitle = title.trim();
      const trimmedDescription = description.trim();
      if (!trimmedTitle || !trimmedDescription) return null;

      const hasSalary = salaryMin.trim().length > 0 || salaryMax.trim().length > 0;
      const min = salaryMin.trim() ? Number(salaryMin) : undefined;
      const max = salaryMax.trim() ? Number(salaryMax) : undefined;

      return {
        employerOxyUserId: employer.accountId,
        title: trimmedTitle,
        description: trimmedDescription,
        location: jobLocationInputFrom(location),
        workplaceType: workplaceType || undefined,
        employmentType: employmentType || undefined,
        salary: hasSalary
          ? {
              min: Number.isFinite(min) ? min : undefined,
              max: Number.isFinite(max) ? max : undefined,
              currency: salaryCurrency,
              interval: salaryInterval,
            }
          : undefined,
        skills: skills.length > 0 ? skills : undefined,
        applicationMode,
        externalApplyUrl: applicationMode === 'external' ? externalApplyUrl.trim() || undefined : undefined,
        publish,
      };
    },
    [
      employer,
      title,
      description,
      location,
      workplaceType,
      employmentType,
      salaryMin,
      salaryMax,
      salaryCurrency,
      salaryInterval,
      skills,
      applicationMode,
      externalApplyUrl,
    ],
  );

  const createMutation = useMutation({
    mutationFn: (payload: CreateMentionJobRequest) => jobsService.create(payload),
    onSuccess: async ({ job }) => {
      await queryClient.invalidateQueries({ queryKey: viewerQueryKeys.jobsMine(user?.id) });
      if (job.status === 'published') {
        toast.success(t('jobs.create.published', { defaultValue: 'Job published' }));
        try {
          router.replace((new URL(job.canonicalUrl).pathname || `/jobs/${job.id}`) as Href);
          return;
        } catch {
          router.replace(`/jobs/${job.id}`);
          return;
        }
      }
      toast.success(t('jobs.create.savedDraft', { defaultValue: 'Draft saved' }));
      router.replace('/jobs/mine');
    },
    onError: (error) => {
      logger.error('[jobs/create] Failed to create job', error);
      // A 402 entitlement refusal ("This account cannot publish a job right
      // now") is a real, if currently rare, failure — surfaced with the
      // backend's own message rather than swallowed or generic-ized.
      const fallback = isJobEntitlementError(error)
        ? t('jobs.create.entitlementFailed', { defaultValue: 'This account cannot publish a job right now' })
        : t('jobs.create.failed', { defaultValue: 'Could not save this job' });
      toast.error(getJobErrorMessage(error, fallback));
    },
  });

  const submit = useCallback(
    (publish: boolean) => {
      const payload = buildPayload(publish);
      if (!payload) return;
      createMutation.mutate(payload);
    },
    [buildPayload, createMutation],
  );

  const canSubmitBase = Boolean(employer && title.trim() && description.trim() && !isJobLocationIncomplete(location));
  const canPublish = canSubmitBase && (applicationMode !== 'external' || externalApplyUrl.trim().length > 0);
  const publishingIntent = createMutation.variables?.publish === true;

  return (
    <View className="flex-1">
      <PageHeader
        title={t('jobs.create.title', { defaultValue: 'Create job' })}
        onBack={() => safeBack()}
        backLabel={t('common.back', { defaultValue: 'Back' })}
      />

      <SignInRequired
        label={t('jobs.signInRequired', { defaultValue: 'Sign in to publish jobs' })}
        description={t('jobs.signInRequiredDesc', {
          defaultValue: 'Jobs are published by an organization or project account you operate.',
        })}
      >
        <ScrollView contentContainerClassName="px-4 pb-16 pt-2" keyboardShouldPersistTaps="handled">
          {/* Employer picker */}
          <Text className="text-sm text-muted-foreground mb-1.5 font-primary">
            {t('jobs.create.employer', { defaultValue: 'Publish as' })}
          </Text>
          <View className="border border-border rounded-[14px] overflow-hidden bg-card">
            <Item
              onPress={() => setEmployerPickerOpen(true)}
              leading={
                employer ? (
                  <Avatar source={employer.account.avatar} size={36} variant={MEDIA_VARIANT_AVATAR} />
                ) : undefined
              }
              title={
                employer
                  ? displayNameOrHandle(employer.account.name?.displayName, `@${employer.account.username}`)
                  : accountsLoading
                    ? t('common.loading', { defaultValue: 'Loading…' })
                    : t('jobs.create.selectEmployer', { defaultValue: 'Select an organization or project' })
              }
              subtitle={employer ? `@${employer.account.username}` : undefined}
            />
          </View>
          <EmployerPickerDialog
            open={employerPickerOpen}
            accounts={eligibleAccounts}
            selectedId={employer?.accountId ?? null}
            onSelect={(account) => {
              setEmployer(account);
              setEmployerPickerOpen(false);
            }}
            onClose={() => setEmployerPickerOpen(false)}
          />

          {/* Title */}
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

          {/* Description */}
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

          {/* Location — a Clarity place or a country, never free text */}
          <View className="mt-4">
            <JobLocationField value={location} onChange={setLocation} />
          </View>

          {/* Workplace type */}
          <View className="mt-4">
            <Text className="text-sm text-muted-foreground mb-1.5 font-primary">
              {t('jobs.create.workplaceType', { defaultValue: 'Workplace type' })}
            </Text>
            <SegmentedControl
              label={t('jobs.create.workplaceType', { defaultValue: 'Workplace type' })}
              type="radio"
              value={workplaceType || 'unset'}
              onChange={(value) => setWorkplaceType(value === 'unset' ? '' : (value as MentionJobWorkplaceType))}
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

          {/* Employment type — a chip row rather than a SegmentedControl: six
              values would cram into an unreadable pill row on a phone width. */}
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

          {/* Salary */}
          <View className="mt-4">
            <Text className="text-sm text-muted-foreground mb-1.5 font-primary">
              {t('jobs.create.salary', { defaultValue: 'Salary (optional)' })}
            </Text>
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

          {/* Skills */}
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
              <Button appearance="subtle" tone="neutral" size="medium" onPress={addSkill} disabled={!skillDraft.trim()}>
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

          {/* Application mode */}
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
            ) : (
              <Text className="text-muted-foreground text-xs mt-2">
                {t('jobs.create.applyViaMentionHint', {
                  defaultValue: 'Applicants apply through Mention, and you’ll review applications from your dashboard.',
                })}
              </Text>
            )}
          </View>

          {/* Submit */}
          <View className="flex-row gap-3 mt-6">
            <Button
              appearance="subtle" tone="neutral"
              size="large"
              style={{ flex: 1 }}
              loading={createMutation.isPending && !publishingIntent}
              disabled={!canSubmitBase || createMutation.isPending}
              onPress={() => submit(false)}
            >
              {t('jobs.create.saveDraft', { defaultValue: 'Save draft' })}
            </Button>
            <Button
              appearance="solid" tone="accent"
              size="large"
              style={{ flex: 1 }}
              loading={createMutation.isPending && publishingIntent}
              disabled={!canPublish || createMutation.isPending}
              onPress={() => submit(true)}
            >
              {t('jobs.create.publish', { defaultValue: 'Publish' })}
            </Button>
          </View>
          {accountsLoading ? (
            <View className="items-center mt-4">
              <Loading className="text-primary" size="small" />
            </View>
          ) : null}
        </ScrollView>
      </SignInRequired>
    </View>
  );
}
