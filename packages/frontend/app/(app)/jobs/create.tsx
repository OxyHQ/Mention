import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import type { Href } from '@/lib/navigation/router';
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from '@/lib/navigation/router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@oxy.so/bloom/avatar';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { Dialog } from '@oxy.so/bloom/dialog';
import { Field } from '@oxy.so/bloom/field';
import { Item } from '@oxy.so/bloom/item';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import type { AccountNode } from '@oxy.so/core';
import { logger } from '@oxy.so/core/logger';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';
import type { CreateMentionJobRequest } from '@mention/shared-types';
import { MENTION_JOB_ELIGIBLE_EMPLOYER_KINDS } from '@mention/shared-types/job';
import { displayNameOrHandle } from '@/utils/displayName';
import { jobsService, getJobErrorMessage, isJobEntitlementError } from '@/services/jobsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { SignInRequired } from '@/components/common/SignInRequired';
import { JobFormFields, useJobForm } from '@/components/Jobs/JobFormFields';
import { jobLocationInputFrom } from '@/components/Jobs/JobLocationField';

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
            defaultValue:
              'You do not operate an organization or project account yet. Create one to publish a job.',
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
            title={displayNameOrHandle(
              account.account.name?.displayName,
              `@${account.account.username}`,
            )}
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
  const router = useRouter();
  const { t } = useTranslation();
  const { user, oxyServices, canUsePrivateApi } = useAuth();
  const queryClient = useQueryClient();

  const { data: accounts = [], isLoading: accountsLoading } = useQuery<AccountNode[]>({
    queryKey: viewerQueryKeys.operatedAccounts(user?.id),
    queryFn: () => oxyServices.accounts.list(),
    enabled: canUsePrivateApi,
  });

  const eligibleAccounts = useMemo(
    () => accounts.filter((account) => ELIGIBLE_KINDS.includes(account.kind)),
    [accounts],
  );

  const [employerPickerOpen, setEmployerPickerOpen] = useState(false);
  const [employer, setEmployer] = useState<AccountNode | null>(null);

  const form = useJobForm();

  const buildPayload = (publish: boolean): CreateMentionJobRequest | null => {
    if (!employer || !form.isComplete) return null;
    return {
      employerOxyUserId: employer.accountId,
      title: form.title.trim(),
      description: form.description.trim(),
      location: jobLocationInputFrom(form.location),
      workplaceType: form.workplaceType || undefined,
      employmentType: form.employmentType || undefined,
      salary: form.salary,
      skills: form.skills.length > 0 ? form.skills : undefined,
      applicationMode: form.applicationMode,
      externalApplyUrl:
        form.applicationMode === 'external' ? form.externalApplyUrl.trim() || undefined : undefined,
      publish,
    };
  };

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
        ? t('jobs.create.entitlementFailed', {
            defaultValue: 'This account cannot publish a job right now',
          })
        : t('jobs.create.failed', { defaultValue: 'Could not save this job' });
      toast.error(getJobErrorMessage(error, fallback));
    },
  });

  const submit = (publish: boolean) => {
    const payload = buildPayload(publish);
    if (!payload) return;
    createMutation.mutate(payload);
  };

  const canSubmitBase = Boolean(employer && form.isComplete);
  const canPublish = canSubmitBase && form.isApplyReady;
  const publishingIntent = createMutation.variables?.publish === true;

  return (
    <Screen
      header={
        <PageHeader
          title={t('jobs.create.title', { defaultValue: 'Create job' })}
          backLabel={t('common.back', { defaultValue: 'Back' })}
        />
      }
    >
      <SignInRequired
        label={t('jobs.signInRequired', { defaultValue: 'Sign in to publish jobs' })}
        description={t('jobs.signInRequiredDesc', {
          defaultValue: 'Jobs are published by an organization or project account you operate.',
        })}
      >
        <ScreenScrollView
          contentContainerClassName="px-4 pb-16 pt-2"
          keyboardShouldPersistTaps="handled"
        >
          {/* Employer picker */}
          <Field label={t('jobs.create.employer', { defaultValue: 'Publish as' })}>
            <Card border="thin" elevation="none" radius="radius-16">
              <Item
                onPress={() => setEmployerPickerOpen(true)}
                leading={
                  employer ? (
                    <Avatar
                      source={employer.account.avatar}
                      size={36}
                      variant={MEDIA_VARIANT_AVATAR}
                    />
                  ) : undefined
                }
                title={
                  employer
                    ? displayNameOrHandle(
                        employer.account.name?.displayName,
                        `@${employer.account.username}`,
                      )
                    : accountsLoading
                      ? t('common.loading', { defaultValue: 'Loading…' })
                      : t('jobs.create.selectEmployer', {
                          defaultValue: 'Select an organization or project',
                        })
                }
                subtitle={employer ? `@${employer.account.username}` : undefined}
              />
            </Card>
          </Field>
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

          <JobFormFields form={form} />

          {/* Submit */}
          <View className="flex-row gap-3 mt-6">
            <Button
              appearance="subtle"
              tone="neutral"
              size="lg"
              style={{ flex: 1 }}
              loading={createMutation.isPending && !publishingIntent}
              disabled={!canSubmitBase || createMutation.isPending}
              onPress={() => submit(false)}
            >
              {t('jobs.create.saveDraft', { defaultValue: 'Save draft' })}
            </Button>
            <Button
              appearance="solid"
              tone="accent"
              size="lg"
              style={{ flex: 1 }}
              loading={createMutation.isPending && publishingIntent}
              disabled={!canPublish || createMutation.isPending}
              onPress={() => submit(true)}
            >
              {t('jobs.create.publish', { defaultValue: 'Publish' })}
            </Button>
          </View>
          {accountsLoading ? <ListSkeleton count={2} /> : null}
        </ScreenScrollView>
      </SignInRequired>
    </Screen>
  );
}
