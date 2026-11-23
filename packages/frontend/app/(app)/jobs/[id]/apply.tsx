import { FormSkeleton } from '@/components/loading/ContentSkeleton';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useLocalSearchParams } from '@/lib/navigation/router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Chip } from '@oxy.so/bloom/chip';
import { useScreenBack } from '@oxy.so/bloom/screen';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { logger } from '@oxy.so/core/logger';
import type { User } from '@oxy.so/core';
import { displayNameOrHandle } from '@/utils/displayName';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { jobsService, recordJobMetric } from '@/services/jobsService';
import { jobApplicationsService, getJobErrorMessage } from '@/services/jobApplicationsService';
import {
  Button as LButton,
  Embed,
  Field as LField,
  HStack,
  Header,
  InputGroup,
  InputGroupAddon,
  RawText,
  ScrollView,
  Text as LText,
  TextEditor,
  TextField as LTextField,
  VStack,
  toElement,
  Card as LCard,
  Embed as LEmbed,
  toElement as LtoElement,
} from '@oxy.so/bloom-language';

import { screen as Lscreen } from '@oxy.so/bloom-language/router';

/**
 * The Mention-native apply flow (OxyHQ/Mention#952) for a job whose
 * `applicationMode` is `'mention'` — `app/(app)/jobs/[id].tsx`'s Apply button
 * routes here. Two steps in one screen (`step` state), not two routes: "Before
 * submit, show exactly what will be shared" (issue #952) is a REVIEW of the
 * same values, not a second form, so keeping them in one component means the
 * summary can never drift from what the edit step actually holds.
 */
export default Lscreen(function JobApplyScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const jobId = String(id);
  const { t } = useTranslation();
  const { user, oxyServices, showBottomSheet } = useAuth();
  const back = useScreenBack();
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
    queryFn: () => oxyServices.users.get(job!.employerOxyUserId),
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
          setResumeFileName(
            file.filename ?? t('jobs.apply.resumeAttached', { defaultValue: 'Resume attached' }),
          );
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
      toast(
        getJobErrorMessage(
          error,
          t('jobs.apply.failed', { defaultValue: 'Could not submit your application' }),
        ),
        { type: 'error' },
      );
    },
  });

  const header = toElement(
    Header(t('jobs.apply.title', { defaultValue: 'Apply' }))
      .onBack(() => (step === 'review' ? setStep('edit') : back?.()))
      .backLabel(t('common.back', { defaultValue: 'Back' }))
      .inPage(),
  );

  if (jobQuery.isLoading) {
    return ScrollView(Embed(<FormSkeleton />)).header(Embed(header));
  }

  if (!job || job.applicationMode !== 'mention') {
    return VStack(
      RawText(
        t('jobs.apply.unavailable', {
          defaultValue: 'This job cannot be applied to on Mention',
        }),
      )
        .foreground('muted')
        .font('16')
        .leading('normal')
        .textAlign('center'),
    )
      .padding('horizontal', '3xl')
      .flex('1')
      .align('center')
      .justify('center')
      .header(Embed(header));
  }

  // The backend refuses a submission on anything but a published job — same
  // rule shown here up front rather than let the reader fill out a form for a
  // request that will 400.
  if (job.status !== 'published') {
    return VStack(
      RawText(
        t('jobs.apply.notAccepting', {
          defaultValue: 'This job is not currently accepting applications',
        }),
      )
        .foreground('muted')
        .font('16')
        .leading('normal')
        .textAlign('center'),
    )
      .padding('horizontal', '3xl')
      .flex('1')
      .align('center')
      .justify('center')
      .header(Embed(header));
  }

  if (step === 'review') {
    return ScrollView(
      RawText(t('jobs.apply.reviewTitle', { defaultValue: 'Review what you are sharing' }))
        .foreground('foreground')
        .font('18')
        .leading('28px')
        .weight('bold')
        .margin('bottom', 'xs'),
      RawText(
        t('jobs.apply.reviewSubtitle', {
          defaultValue:
            'This is exactly what {{employer}} will see. Nothing else about your Mention account is shared.',
          employer: employerName,
        }),
      )
        .foreground('muted')
        .font('14')
        .leading('20px')
        .margin('bottom', 'lg'),
      Embed(
        LtoElement(
          LCard(
            LEmbed(
              toElement(
                VStack(
                  RawText(t('jobs.apply.displayName', { defaultValue: 'Name' }))
                    .font('xs')
                    .leading('16px')
                    .foreground('muted'),
                  RawText(
                    displayName.trim() ||
                      t('jobs.apply.notProvided', { defaultValue: 'Not provided' }),
                  )
                    .foreground('foreground')
                    .font('md'),
                ),
              ),
            ),
            LEmbed(
              toElement(
                VStack(
                  RawText(t('jobs.apply.contactMethod', { defaultValue: 'Contact method' }))
                    .font('xs')
                    .leading('16px')
                    .foreground('muted'),
                  RawText(
                    contactMethod.trim() ||
                      t('jobs.apply.notProvided', { defaultValue: 'Not provided' }),
                  )
                    .foreground('foreground')
                    .font('md'),
                ),
              ),
            ),
            LEmbed(
              toElement(
                VStack(
                  RawText(t('jobs.apply.coverNote', { defaultValue: 'Cover note' }))
                    .font('xs')
                    .leading('16px')
                    .foreground('muted'),
                  RawText(
                    coverNote.trim() ||
                      t('jobs.apply.notProvided', { defaultValue: 'Not provided' }),
                  )
                    .foreground('foreground')
                    .font('md'),
                ),
              ),
            ),
            LEmbed(
              toElement(
                VStack(
                  RawText(t('jobs.apply.portfolio', { defaultValue: 'Portfolio links' }))
                    .font('xs')
                    .leading('16px')
                    .foreground('muted'),
                  Embed(
                    portfolioLinks.length > 0
                      ? portfolioLinks.map((link) =>
                          toElement(RawText(link).foreground('foreground').font('md'), link),
                        )
                      : toElement(
                          RawText(t('jobs.apply.notProvided', { defaultValue: 'Not provided' }))
                            .foreground('foreground')
                            .font('md'),
                        ),
                  ),
                ),
              ),
            ),
            LEmbed(
              toElement(
                VStack(
                  RawText(t('jobs.apply.resume', { defaultValue: 'Resume' }))
                    .font('xs')
                    .leading('16px')
                    .foreground('muted'),
                  RawText(
                    resumeFileName || t('jobs.apply.notProvided', { defaultValue: 'Not provided' }),
                  )
                    .foreground('foreground')
                    .font('md'),
                ),
              ),
            ),
          )
            .style('outline')
            .radius('lg')
            .padding('all', 'lg')
            .spacing('md'),
        ),
      ),
      HStack(
        LButton(LText(t('jobs.apply.backToEdit', { defaultValue: 'Edit' })))
          .style('subtle')
          .tint('neutral')
          .size('lg')
          .grow()
          .onPress(() => setStep('edit'))
          .disabled(submitMutation.isPending),
        LButton(LText(t('jobs.apply.submit', { defaultValue: 'Submit application' })))
          .style('solid')
          .tint('accent')
          .size('lg')
          .grow()
          .loading(submitMutation.isPending)
          .onPress(() => submitMutation.mutate()),
      )
        .spacing('md')
        .margin('top', '2xl'),
    )
      .contentView((v) =>
        v.padding('horizontal', 'lg').padding('bottom', '64').padding('top', 'sm'),
      )
      .header(Embed(header));
  }

  const canContinue = displayName.trim().length > 0 || contactMethod.trim().length > 0;

  return ScrollView(
    RawText(job.title)
      .foreground('foreground')
      .font('18')
      .leading('28px')
      .weight('bold')
      .margin('bottom', 'xs'),
    RawText(
      t('jobs.apply.privacyNote', {
        defaultValue:
          'Only the fields you fill in here are shared with the employer — never your posts, follows, likes or DMs.',
      }),
    )
      .foreground('muted')
      .font('14')
      .leading('20px')
      .margin('bottom', 'lg'),
    VStack(
      LTextField(
        [displayName, setDisplayName],
        t('jobs.apply.displayName', { defaultValue: 'Name' }),
      ).maxLength(200),
    ).margin('top', 'xs'),
    VStack(
      LTextField(
        [contactMethod, setContactMethod],
        t('jobs.apply.contactMethod', {
          defaultValue: 'Contact method (email, etc.)',
        }),
      ).maxLength(200),
    ).margin('top', 'md'),
    VStack(
      TextEditor([coverNote, setCoverNote])
        .label(
          t('jobs.apply.coverNote', {
            defaultValue: 'Cover note (optional)',
          }),
        )
        .placeholder(t('jobs.apply.coverNote', { defaultValue: 'Cover note (optional)' }))
        .rows(5),
    ).margin('top', 'md'),
    /* Not a TagField: a link needs the URL keyboard and no auto-capitalisation,
              which TagField's caret does not take, and a comma is legal in a URL. */ VStack(
      LField(
        t('jobs.apply.portfolio', { defaultValue: 'Portfolio links (optional)' }),
        InputGroup(
          LTextField(
            [portfolioLinkDraft, setPortfolioLinkDraft],
            t('jobs.apply.addLink', { defaultValue: 'Add a link' }),
          )
            .onSubmit(addPortfolioLink)
            .autocapitalize('none')
            .autocorrect(false)
            .keyboard('url')
            .submitLabel('done'),
          InputGroupAddon(
            LButton(LText(t('common.add', { defaultValue: 'Add' })))
              .style('plain')
              .tint('neutral')
              .size('sm')
              .onPress(addPortfolioLink)
              .disabled(!portfolioLinkDraft.trim()),
          )
            .divider()
            .flush(),
        ),
      ),
      portfolioLinks.length > 0
        ? HStack(
            Embed(
              portfolioLinks.map((link) => (
                <Chip key={link} onClose={() => removePortfolioLink(link)}>
                  {link}
                </Chip>
              )),
            ),
          )
            .wrap()
            .spacing('sm')
            .margin('top', 'sm')
        : null,
    ).margin('top', 'lg'),
    LField(
      t('jobs.apply.resume', { defaultValue: 'Resume (optional)' }),
      resumeFileName
        ? Embed(
            LtoElement(
              LCard(
                LEmbed(
                  toElement(
                    RawText(resumeFileName).foreground('foreground').font('14').flex('1').lines(1),
                  ),
                ),
                LEmbed(
                  toElement(
                    LButton(LText(t('common.remove', { defaultValue: 'Remove' })))
                      .style('plain')
                      .tint('neutral')
                      .size('sm')
                      .onPress(removeResume),
                  ),
                ),
              )
                .style('outline')
                .radius('lg')
                .axis('horizontal')
                .padding('horizontal', 'lg')
                .padding('vertical', 'md')
                .align('center')
                .justify('between'),
            ),
          )
        : LButton(LText(t('jobs.apply.attachResume', { defaultValue: 'Attach a resume' })))
            .style('subtle')
            .tint('neutral')
            .size('md')
            .alignSelf('start')
            .onPress(openResumePicker),
    ).margin('top', 'lg'),
    VStack(
      LButton(LText(t('jobs.apply.review', { defaultValue: 'Review and submit' })))
        .style('solid')
        .tint('accent')
        .size('lg')
        .disabled(!canContinue)
        .onPress(() => setStep('review')),
    ).margin('top', '2xl'),
  )
    .contentView((v) => v.padding('horizontal', 'lg').padding('bottom', '64').padding('top', 'sm'))
    .keyboardTaps('handled')
    .header(Embed(header));
});
