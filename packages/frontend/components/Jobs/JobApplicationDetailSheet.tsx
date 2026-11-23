import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { useCallback, useState } from 'react';
import { ScrollView, type ViewStyle } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useColorTokens } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { logger } from '@oxy.so/core/logger';
import type { MentionJobApplication, MentionJobApplicationStatus } from '@mention/shared-types';
import { MENTION_JOB_APPLICATION_STATUSES } from '@mention/shared-types/job';
import { openExternalLink } from '@/utils/openExternalLink';
import { formatTimeAgo } from '@/utils/dateUtils';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { jobApplicationsService, getJobErrorMessage } from '@/services/jobApplicationsService';
import {
  Badge as LBadge,
  Button as LButton,
  Chip as LChip,
  Embed,
  HStack,
  Loading as LLoading,
  RawText,
  Text as LText,
  VStack,
  toElement,
  TextField as LTextField,
  toElement as LtoElement,
} from '@oxy.so/bloom-language';

/** The sheet's scroll: 16pt sides, 12pt top, at most 90% of the window. */
const SHEET_SCROLL_STYLE: ViewStyle = { paddingHorizontal: 16, paddingTop: 12, maxHeight: '90%' };

const STATUS_TONE: Record<
  MentionJobApplicationStatus,
  'default' | 'primary' | 'success' | 'warning' | 'error' | 'info'
> = {
  new: 'info',
  reviewing: 'primary',
  interview: 'warning',
  hired: 'success',
  rejected: 'error',
  withdrawn: 'default',
};

interface JobApplicationDetailSheetProps {
  jobId: string;
  application: MentionJobApplication;
  /** Notified after a successful status change, so the list behind this sheet can update without a second fetch. */
  onStatusChanged: (updated: MentionJobApplication) => void;
}

/**
 * The employer's full view of one application — every disclosed field, a
 * status changer, and the internal notes thread (never shown to the
 * applicant; see `jobApplications.controller.ts`'s privacy invariant). Opened
 * from `app/(app)/jobs/[id]/applications.tsx` with `presentSheet`.
 */
const JobApplicationDetailSheet = ({
  jobId,
  application,
  onStatusChanged,
}: JobApplicationDetailSheetProps) => {
  const { t } = useTranslation();
  const colorTokens = useColorTokens();
  const { user, oxyServices, canUsePrivateApi } = useAuth();
  const queryClient = useQueryClient();
  const [noteDraft, setNoteDraft] = useState('');

  const notesQuery = useQuery({
    queryKey: viewerQueryKeys.jobApplicationNotes(user?.id, jobId, application.id),
    queryFn: () => jobApplicationsService.listNotes(jobId, application.id),
    // Employer-only endpoint (GET /jobs/:id/applications/:applicationId/notes)
    // — gate on `canUsePrivateApi`, matching every other private query in
    // this feature (docs/frontend-rules.md).
    enabled: canUsePrivateApi,
  });

  const statusMutation = useMutation({
    mutationFn: (status: MentionJobApplicationStatus) =>
      jobApplicationsService.updateStatus(jobId, application.id, status),
    onSuccess: ({ application: updated }) => {
      onStatusChanged(updated);
      toast(t('jobs.applications.statusUpdated', { defaultValue: 'Status updated' }), {
        type: 'success',
      });
    },
    onError: (error) => {
      logger.error('[applications] Failed to update status', error);
      toast(
        getJobErrorMessage(
          error,
          t('jobs.applications.statusFailed', { defaultValue: 'Could not update status' }),
        ),
        { type: 'error' },
      );
    },
  });

  const addNoteMutation = useMutation({
    mutationFn: (note: string) => jobApplicationsService.addNote(jobId, application.id, note),
    onSuccess: async () => {
      setNoteDraft('');
      await queryClient.invalidateQueries({
        queryKey: viewerQueryKeys.jobApplicationNotes(user?.id, jobId, application.id),
      });
    },
    onError: (error) => {
      logger.error('[applications] Failed to add note', error);
      toast(
        getJobErrorMessage(
          error,
          t('jobs.applications.noteFailed', { defaultValue: 'Could not add this note' }),
        ),
        { type: 'error' },
      );
    },
  });

  const openResume = useCallback(() => {
    // The resume is an Oxy file id (`resumeFileId`), never a URL — resolved
    // through the ONE canonical chokepoint every Oxy-hosted file in this app
    // goes through (`oxyServices.assets.publicUrl`), never a hand-rolled
    // per-app URL (see the Oxy engineering docs' "canonical
    // media" rule).
    if (!application.resumeFileId) return;
    void openExternalLink(oxyServices.assets.publicUrl(application.resumeFileId));
  }, [application.resumeFileId, oxyServices]);

  const submitNote = useCallback(() => {
    const trimmed = noteDraft.trim();
    if (!trimmed) return;
    addNoteMutation.mutate(trimmed);
  }, [noteDraft, addNoteMutation]);

  return (
    <ScrollView
      style={[SHEET_SCROLL_STYLE, { backgroundColor: colorTokens.background }]}
      contentContainerStyle={{ paddingBottom: 24 }}
    >
      {toElement(
        HStack(
          RawText(
            application.displayName ||
              t('jobs.applications.unnamed', { defaultValue: 'Applicant' }),
          )
            .flex('1')
            .foreground('foreground')
            .font('18')
            .leading('28px')
            .weight('bold'),
          LBadge(application.status)
            .style('subtle')
            .color(STATUS_TONE[application.status])
            .size('sm'),
        )
          .align('start')
          .justify('between')
          .spacing('sm')
          .margin('bottom', 'sm'),
      )}
      {toElement(
        RawText(
          t('jobs.applications.appliedAgo', {
            defaultValue: 'Applied {{time}}',
            time: formatTimeAgo(application.createdAt),
          }),
        )
          .foreground('muted')
          .font('xs')
          .leading('16px')
          .margin('bottom', 'lg'),
      )}
      {application.contactMethod
        ? toElement(
            VStack(
              RawText(t('jobs.applications.contact', { defaultValue: 'Contact' }))
                .font('14')
                .leading('20px')
                .foreground('muted')
                .margin('bottom', 'xs'),
              RawText(application.contactMethod).foreground('foreground').font('md'),
            ).margin('bottom', 'md'),
          )
        : null}
      {application.coverNote
        ? toElement(
            VStack(
              RawText(t('jobs.applications.coverNote', { defaultValue: 'Cover note' }))
                .font('14')
                .leading('20px')
                .foreground('muted')
                .margin('bottom', 'xs'),
              RawText(application.coverNote).foreground('foreground').font('md').leading('20px'),
            ).margin('bottom', 'md'),
          )
        : null}
      {application.portfolioLinks && application.portfolioLinks.length > 0
        ? toElement(
            VStack(
              RawText(t('jobs.applications.portfolio', { defaultValue: 'Portfolio links' }))
                .font('14')
                .leading('20px')
                .foreground('muted')
                .margin('bottom', 'xs'),
              application.portfolioLinks.map((link) =>
                RawText(link)
                  .foreground('primary')
                  .font('14')
                  .lines(1)
                  .onPress(() => void openExternalLink(link))
                  .id(link),
              ),
            ).margin('bottom', 'md'),
          )
        : null}
      {application.resumeFileId
        ? toElement(
            VStack(
              LButton(LText(t('jobs.applications.viewResume', { defaultValue: 'View resume' })))
                .style('subtle')
                .tint('neutral')
                .size('sm')
                .alignSelf('start')
                .onPress(openResume),
            ).margin('bottom', 'md'),
          )
        : null}
      {application.answers && application.answers.length > 0
        ? toElement(
            VStack(
              Embed(
                application.answers.map((answer, index) =>
                  toElement(
                    VStack(
                      RawText(answer.question).font('14').leading('20px').foreground('muted'),
                      RawText(answer.answer).foreground('foreground').font('md'),
                    ),
                    `${answer.question}-${index}`,
                  ),
                ),
              ),
            )
              .margin('bottom', 'md')
              .spacing('sm'),
          )
        : null}
      {toElement(
        VStack(
          RawText(t('jobs.applications.changeStatus', { defaultValue: 'Change status' }))
            .font('14')
            .leading('20px')
            .foreground('muted')
            .margin('bottom', '6'),
          HStack(
            Embed(
              MENTION_JOB_APPLICATION_STATUSES.map((status) =>
                toElement(
                  LChip(LText(status))
                    .selected(application.status === status)
                    .onPress(() => statusMutation.mutate(status)),
                  status,
                ),
              ),
            ),
          )
            .wrap()
            .spacing('sm'),
          statusMutation.isPending ? LLoading().size('sm').margin('top', 'sm') : null,
        )
          .margin('top', 'sm')
          .margin('bottom', 'lg'),
      )}
      {toElement(
        VStack(
          RawText(
            t('jobs.applications.internalNotes', {
              defaultValue: 'Internal notes (never shown to the applicant)',
            }),
          )
            .font('14')
            .leading('20px')
            .foreground('muted')
            .margin('bottom', 'sm'),
          Embed(
            notesQuery.isLoading ? (
              <ListSkeleton count={2} />
            ) : (
              toElement(
                VStack(
                  Embed(
                    (notesQuery.data?.notes ?? []).map((note) =>
                      toElement(
                        VStack(
                          RawText(note.note).foreground('foreground').font('14'),
                          RawText(formatTimeAgo(note.createdAt))
                            .foreground('muted')
                            .font('11')
                            .margin('top', 'xs'),
                        )
                          .padding('all', 'md')
                          .background('mutedFill')
                          .corner('md'),
                        note.id,
                      ),
                    ),
                  ),
                  (notesQuery.data?.notes ?? []).length === 0
                    ? RawText(t('jobs.applications.noNotes', { defaultValue: 'No notes yet' }))
                        .foreground('muted')
                        .font('sm')
                    : null,
                )
                  .spacing('sm')
                  .margin('bottom', 'md'),
              )
            ),
          ),
          Embed(
            LtoElement(
              LTextField(
                [noteDraft, setNoteDraft],
                t('jobs.applications.addNote', { defaultValue: 'Add a note' }),
              ).multiline(),
            ),
          ),
          LButton(LText(t('common.add', { defaultValue: 'Add' })))
            .style('subtle')
            .tint('neutral')
            .size('sm')
            .alignSelf('end')
            .margin('top', 'sm')
            .loading(addNoteMutation.isPending)
            .disabled(!noteDraft.trim())
            .onPress(submitNote),
        )
          .padding('top', 'md')
          .border('border', 'thin', 'top'),
      )}
    </ScrollView>
  );
};

export default JobApplicationDetailSheet;
