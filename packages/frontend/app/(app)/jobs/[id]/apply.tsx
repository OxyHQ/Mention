import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { Chip } from '@oxy.so/bloom/chip';
import { Loading } from '@oxy.so/bloom/loading';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { logger } from '@oxy.so/core/logger';
import type { User } from '@oxy.so/core';
import { useSafeBack } from '@/hooks/useSafeBack';
import { displayNameOrHandle } from '@/utils/displayName';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { jobsService, recordJobMetric } from '@/services/jobsService';
import { jobApplicationsService, getJobErrorMessage } from '@/services/jobApplicationsService';

/**
 * The Mention-native apply flow (OxyHQ/Mention#952) for a job whose
 * `applicationMode` is `'mention'` — `app/(app)/jobs/[id].tsx`'s Apply button
 * routes here. Two steps in one screen (`step` state), not two routes: "Before
 * submit, show exactly what will be shared" (issue #952) is a REVIEW of the
 * same values, not a second form, so keeping them in one component means the
 * summary can never drift from what the edit step actually holds.
 */
export default function JobApplyScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const jobId = String(id);
  const { t } = useTranslation();
  const { user, oxyServices, showBottomSheet } = useAuth();
  const safeBack = useSafeBack();
  const queryClient = useQueryClient();

  const jobQuery = useQuery({
    queryKey: viewerQueryKeys.jobDetail(user?.id, jobId),
    queryFn: () => jobsService.get(jobId),
    enabled: Boolean(jobId),
  });
  const job = jobQuery.data?.job;

  // One `apply_start` per job whose apply screen this mount actually opened.
  const startedJobIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!job || startedJobIdRef.current === job.id) return;
    startedJobIdRef.current = job.id;
    recordJobMetric(job.id, 'apply_start');
  }, [job]);

  const employerQuery = useQuery<User>({
    queryKey: viewerQueryKeys.jobEmployerProfile(user?.id, job?.employerOxyUserId),
    queryFn: () => oxyServices.getUserById(job!.employerOxyUserId),
    enabled: Boolean(job?.employerOxyUserId),
  });
  const employerName = employerQuery.data
    ? displayNameOrHandle(employerQuery.data.name?.displayName, employerQuery.data.username)
    : t('jobs.apply.thisEmployer', { defaultValue: 'this employer' });

  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [displayName, setDisplayName] = useState(user?.name?.displayName ?? '');
  const [contactMethod, setContactMethod] = useState('');
  const [coverNote, setCoverNote] = useState('');
  const [portfolioLinkDraft, setPortfolioLinkDraft] = useState('');
  const [portfolioLinks, setPortfolioLinks] = useState<string[]>([]);
  const [resumeFileId, setResumeFileId] = useState<string | null>(null);
  const [resumeFileName, setResumeFileName] = useState<string | null>(null);

  const addPortfolioLink = useCallback(() => {
    const value = portfolioLinkDraft.trim();
    if (!value) return;
    setPortfolioLinks((prev) => (prev.includes(value) ? prev : [...prev, value]));
    setPortfolioLinkDraft('');
  }, [portfolioLinkDraft]);

  const removePortfolioLink = useCallback((value: string) => {
    setPortfolioLinks((prev) => prev.filter((link) => link !== value));
  }, []);

  const openResumePicker = useCallback(() => {
    // Same "Oxy file manager" bottom sheet every file attachment in this app
    // goes through (see `hooks/useMediaPicker.ts`, `BannerSection.tsx`) —
    // `disabledMimeTypes` excludes the media types, leaving documents (PDF,
    // Word, …) pickable.
    showBottomSheet?.({
      screen: 'FileManagement',
      props: {
        selectMode: true,
        multiSelect: false,
        disabledMimeTypes: ['image/', 'video/', 'audio/'],
        afterSelect: 'back',
        onSelect: async (file: { id: string; filename?: string }) => {
          setResumeFileId(file.id);
          setResumeFileName(file.filename ?? t('jobs.apply.resumeAttached', { defaultValue: 'Resume attached' }));
        },
      },
    });
  }, [showBottomSheet, t]);

  const removeResume = useCallback(() => {
    setResumeFileId(null);
    setResumeFileName(null);
  }, []);

  const submitMutation = useMutation({
    mutationFn: () =>
      jobApplicationsService.submit(jobId, {
        displayName: displayName.trim() || undefined,
        contactMethod: contactMethod.trim() || undefined,
        coverNote: coverNote.trim() || undefined,
        portfolioLinks: portfolioLinks.length > 0 ? portfolioLinks : undefined,
        resumeFileId: resumeFileId ?? undefined,
      }),
    onSuccess: async () => {
      recordJobMetric(jobId, 'application_completed');
      await queryClient.invalidateQueries({ queryKey: viewerQueryKeys.jobDetail(user?.id, jobId) });
      toast(t('jobs.apply.submitted', { defaultValue: 'Application sent' }), { type: 'success' });
      router.replace(`/jobs/${jobId}`);
    },
    onError: (error) => {
      logger.error('[jobs/apply] Failed to submit application', error);
      toast(getJobErrorMessage(error, t('jobs.apply.failed', { defaultValue: 'Could not submit your application' })), { type: 'error' });
    },
  });

  const header = (
    <PageHeader
      title={t('jobs.apply.title', { defaultValue: 'Apply' })}
      onBack={() => (step === 'review' ? setStep('edit') : safeBack())}
      backLabel={t('common.back', { defaultValue: 'Back' })}
    />
  );

  if (jobQuery.isLoading) {
    return (
      <View className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center">
          <Loading className="text-primary" size="large" />
        </View>
      </View>
    );
  }

  if (!job || job.applicationMode !== 'mention') {
    return (
      <View className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-muted-foreground text-base text-center">
            {t('jobs.apply.unavailable', { defaultValue: 'This job cannot be applied to on Mention' })}
          </Text>
        </View>
      </View>
    );
  }

  // The backend refuses a submission on anything but a published job — same
  // rule shown here up front rather than let the reader fill out a form for a
  // request that will 400.
  if (job.status !== 'published') {
    return (
      <View className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center px-8">
          <Text className="text-muted-foreground text-base text-center">
            {t('jobs.apply.notAccepting', { defaultValue: 'This job is not currently accepting applications' })}
          </Text>
        </View>
      </View>
    );
  }

  if (step === 'review') {
    return (
      <View className="flex-1">
        {header}
        <ScrollView contentContainerClassName="px-4 pb-16 pt-2">
          <Text className="text-foreground text-lg font-bold mb-1">
            {t('jobs.apply.reviewTitle', { defaultValue: 'Review what you are sharing' })}
          </Text>
          <Text className="text-muted-foreground text-sm mb-4">
            {t('jobs.apply.reviewSubtitle', {
              defaultValue: 'This is exactly what {{employer}} will see. Nothing else about your Mention account is shared.',
              employer: employerName,
            })}
          </Text>

          <View className="border border-border rounded-[14px] p-4 gap-3">
            <View>
              <Text className="text-xs text-muted-foreground font-primary">{t('jobs.apply.displayName', { defaultValue: 'Name' })}</Text>
              <Text className="text-foreground text-[15px]">{displayName.trim() || t('jobs.apply.notProvided', { defaultValue: 'Not provided' })}</Text>
            </View>
            <View>
              <Text className="text-xs text-muted-foreground font-primary">{t('jobs.apply.contactMethod', { defaultValue: 'Contact method' })}</Text>
              <Text className="text-foreground text-[15px]">{contactMethod.trim() || t('jobs.apply.notProvided', { defaultValue: 'Not provided' })}</Text>
            </View>
            <View>
              <Text className="text-xs text-muted-foreground font-primary">{t('jobs.apply.coverNote', { defaultValue: 'Cover note' })}</Text>
              <Text className="text-foreground text-[15px]">{coverNote.trim() || t('jobs.apply.notProvided', { defaultValue: 'Not provided' })}</Text>
            </View>
            <View>
              <Text className="text-xs text-muted-foreground font-primary">{t('jobs.apply.portfolio', { defaultValue: 'Portfolio links' })}</Text>
              {portfolioLinks.length > 0 ? (
                portfolioLinks.map((link) => (
                  <Text key={link} className="text-foreground text-[15px]">{link}</Text>
                ))
              ) : (
                <Text className="text-foreground text-[15px]">{t('jobs.apply.notProvided', { defaultValue: 'Not provided' })}</Text>
              )}
            </View>
            <View>
              <Text className="text-xs text-muted-foreground font-primary">{t('jobs.apply.resume', { defaultValue: 'Resume' })}</Text>
              <Text className="text-foreground text-[15px]">{resumeFileName || t('jobs.apply.notProvided', { defaultValue: 'Not provided' })}</Text>
            </View>
          </View>

          <View className="flex-row gap-3 mt-6">
            <Button variant="secondary" size="large" style={{ flex: 1 }} onPress={() => setStep('edit')} disabled={submitMutation.isPending}>
              {t('jobs.apply.backToEdit', { defaultValue: 'Edit' })}
            </Button>
            <Button
              variant="primary"
              size="large"
              style={{ flex: 1 }}
              loading={submitMutation.isPending}
              onPress={() => submitMutation.mutate()}
            >
              {t('jobs.apply.submit', { defaultValue: 'Submit application' })}
            </Button>
          </View>
        </ScrollView>
      </View>
    );
  }

  const canContinue = displayName.trim().length > 0 || contactMethod.trim().length > 0;

  return (
    <View className="flex-1">
      {header}
      <ScrollView contentContainerClassName="px-4 pb-16 pt-2" keyboardShouldPersistTaps="handled">
        <Text className="text-foreground text-lg font-bold mb-1">{job.title}</Text>
        <Text className="text-muted-foreground text-sm mb-4">
          {t('jobs.apply.privacyNote', {
            defaultValue: 'Only the fields you fill in here are shared with the employer — never your posts, follows, likes or DMs.',
          })}
        </Text>

        <View className="mt-1">
          <TextField>
            <TextFieldInput
              label={t('jobs.apply.displayName', { defaultValue: 'Name' })}
              value={displayName}
              onChangeText={setDisplayName}
              maxLength={200}
            />
          </TextField>
        </View>

        <View className="mt-3">
          <TextField>
            <TextFieldInput
              label={t('jobs.apply.contactMethod', { defaultValue: 'Contact method (email, etc.)' })}
              value={contactMethod}
              onChangeText={setContactMethod}
              maxLength={200}
            />
          </TextField>
        </View>

        <View className="mt-3">
          <TextField>
            <TextFieldInput
              label={t('jobs.apply.coverNote', { defaultValue: 'Cover note (optional)' })}
              value={coverNote}
              onChangeText={setCoverNote}
              multiline
              numberOfLines={5}
              style={{ minHeight: 100, textAlignVertical: 'top' }}
            />
          </TextField>
        </View>

        <View className="mt-4">
          <Text className="text-sm text-muted-foreground mb-1.5 font-primary">
            {t('jobs.apply.portfolio', { defaultValue: 'Portfolio links (optional)' })}
          </Text>
          <View className="flex-row gap-2 items-start">
            <View className="flex-1">
              <TextField>
                <TextFieldInput
                  label={t('jobs.apply.addLink', { defaultValue: 'Add a link' })}
                  value={portfolioLinkDraft}
                  onChangeText={setPortfolioLinkDraft}
                  onSubmitEditing={addPortfolioLink}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  returnKeyType="done"
                />
              </TextField>
            </View>
            <Button variant="secondary" size="medium" onPress={addPortfolioLink} disabled={!portfolioLinkDraft.trim()}>
              {t('common.add', { defaultValue: 'Add' })}
            </Button>
          </View>
          {portfolioLinks.length > 0 ? (
            <View className="flex-row flex-wrap gap-2 mt-2">
              {portfolioLinks.map((link) => (
                <Chip key={link} onClose={() => removePortfolioLink(link)}>
                  {link}
                </Chip>
              ))}
            </View>
          ) : null}
        </View>

        <View className="mt-4">
          <Text className="text-sm text-muted-foreground mb-1.5 font-primary">
            {t('jobs.apply.resume', { defaultValue: 'Resume (optional)' })}
          </Text>
          {resumeFileName ? (
            <View className="flex-row items-center justify-between border border-border rounded-[14px] px-4 py-3">
              <Text className="text-foreground text-[14px] flex-1" numberOfLines={1}>{resumeFileName}</Text>
              <Button variant="ghost" size="small" onPress={removeResume}>
                {t('common.remove', { defaultValue: 'Remove' })}
              </Button>
            </View>
          ) : (
            <Button variant="secondary" size="medium" onPress={openResumePicker} style={{ alignSelf: 'flex-start' }}>
              {t('jobs.apply.attachResume', { defaultValue: 'Attach a resume' })}
            </Button>
          )}
        </View>

        <View className="mt-6">
          <Button variant="primary" size="large" disabled={!canContinue} onPress={() => setStep('review')}>
            {t('jobs.apply.review', { defaultValue: 'Review and submit' })}
          </Button>
        </View>
      </ScrollView>
    </View>
  );
}
