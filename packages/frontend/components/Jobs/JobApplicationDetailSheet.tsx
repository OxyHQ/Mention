import React, { useCallback, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@oxy.so/bloom/badge';
import { Button } from '@oxy.so/bloom/button';
import { Chip } from '@oxy.so/bloom/chip';
import { Loading } from '@oxy.so/bloom/loading';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { toast } from '@oxy.so/bloom/toast';
import { useAuth } from '@oxy.so/services/ui/client';
import { logger } from '@oxy.so/core/logger';
import {
  MENTION_JOB_APPLICATION_STATUSES,
  type MentionJobApplication,
  type MentionJobApplicationStatus,
} from '@mention/shared-types';
import { openExternalLink } from '@/utils/openExternalLink';
import { formatTimeAgo } from '@/utils/dateUtils';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { jobApplicationsService, getJobErrorMessage } from '@/services/jobApplicationsService';

const STATUS_TONE: Record<MentionJobApplicationStatus, 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info'> = {
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
 * from `app/(app)/jobs/[id]/applications.tsx` via `BottomSheetContext`.
 */
const JobApplicationDetailSheet = ({ jobId, application, onStatusChanged }: JobApplicationDetailSheetProps) => {
  const { t } = useTranslation();
  const { user, oxyServices } = useAuth();
  const queryClient = useQueryClient();
  const [noteDraft, setNoteDraft] = useState('');

  const notesQuery = useQuery({
    queryKey: viewerQueryKeys.jobApplicationNotes(user?.id, jobId, application.id),
    queryFn: () => jobApplicationsService.listNotes(jobId, application.id),
  });

  const statusMutation = useMutation({
    mutationFn: (status: MentionJobApplicationStatus) => jobApplicationsService.updateStatus(jobId, application.id, status),
    onSuccess: ({ application: updated }) => {
      onStatusChanged(updated);
      toast(t('jobs.applications.statusUpdated', { defaultValue: 'Status updated' }), { type: 'success' });
    },
    onError: (error) => {
      logger.error('[applications] Failed to update status', error);
      toast(getJobErrorMessage(error, t('jobs.applications.statusFailed', { defaultValue: 'Could not update status' })), { type: 'error' });
    },
  });

  const addNoteMutation = useMutation({
    mutationFn: (note: string) => jobApplicationsService.addNote(jobId, application.id, note),
    onSuccess: async () => {
      setNoteDraft('');
      await queryClient.invalidateQueries({ queryKey: viewerQueryKeys.jobApplicationNotes(user?.id, jobId, application.id) });
    },
    onError: (error) => {
      logger.error('[applications] Failed to add note', error);
      toast(getJobErrorMessage(error, t('jobs.applications.noteFailed', { defaultValue: 'Could not add this note' })), { type: 'error' });
    },
  });

  const openResume = useCallback(() => {
    // The resume is an Oxy file id (`resumeFileId`), never a URL — resolved
    // through the ONE canonical chokepoint every Oxy-hosted file in this app
    // goes through (`oxyServices.getFileDownloadUrl`), never a hand-rolled
    // per-app URL (see `~/Oxy/docs/frontend-conventions.md`'s "canonical
    // media" rule).
    if (!application.resumeFileId) return;
    void openExternalLink(oxyServices.getFileDownloadUrl(application.resumeFileId));
  }, [application.resumeFileId, oxyServices]);

  const submitNote = useCallback(() => {
    const trimmed = noteDraft.trim();
    if (!trimmed) return;
    addNoteMutation.mutate(trimmed);
  }, [noteDraft, addNoteMutation]);

  return (
    <ScrollView className="bg-background px-4 pt-3" style={{ maxHeight: '90%' }} contentContainerStyle={{ paddingBottom: 24 }}>
      <View className="flex-row items-start justify-between gap-2 mb-2">
        <Text className="flex-1 text-foreground text-lg font-bold">
          {application.displayName || t('jobs.applications.unnamed', { defaultValue: 'Applicant' })}
        </Text>
        <Badge content={application.status} color={STATUS_TONE[application.status]} variant="subtle" size="small" />
      </View>

      <Text className="text-muted-foreground text-xs mb-4">
        {t('jobs.applications.appliedAgo', { defaultValue: 'Applied {{time}}', time: formatTimeAgo(application.createdAt) })}
      </Text>

      {application.contactMethod ? (
        <View className="mb-3">
          <Text className="text-sm text-muted-foreground mb-1 font-primary">
            {t('jobs.applications.contact', { defaultValue: 'Contact' })}
          </Text>
          <Text className="text-foreground text-[15px]">{application.contactMethod}</Text>
        </View>
      ) : null}

      {application.coverNote ? (
        <View className="mb-3">
          <Text className="text-sm text-muted-foreground mb-1 font-primary">
            {t('jobs.applications.coverNote', { defaultValue: 'Cover note' })}
          </Text>
          <Text className="text-foreground text-[15px] leading-5">{application.coverNote}</Text>
        </View>
      ) : null}

      {application.portfolioLinks && application.portfolioLinks.length > 0 ? (
        <View className="mb-3">
          <Text className="text-sm text-muted-foreground mb-1 font-primary">
            {t('jobs.applications.portfolio', { defaultValue: 'Portfolio links' })}
          </Text>
          {application.portfolioLinks.map((link) => (
            <Text
              key={link}
              className="text-primary text-[14px]"
              numberOfLines={1}
              onPress={() => void openExternalLink(link)}
            >
              {link}
            </Text>
          ))}
        </View>
      ) : null}

      {application.resumeFileId ? (
        <View className="mb-3">
          <Button variant="secondary" size="small" onPress={openResume} style={{ alignSelf: 'flex-start' }}>
            {t('jobs.applications.viewResume', { defaultValue: 'View resume' })}
          </Button>
        </View>
      ) : null}

      {application.answers && application.answers.length > 0 ? (
        <View className="mb-3 gap-2">
          {application.answers.map((answer, index) => (
            <View key={`${answer.question}-${index}`}>
              <Text className="text-sm text-muted-foreground font-primary">{answer.question}</Text>
              <Text className="text-foreground text-[15px]">{answer.answer}</Text>
            </View>
          ))}
        </View>
      ) : null}

      <View className="mt-2 mb-4">
        <Text className="text-sm text-muted-foreground mb-1.5 font-primary">
          {t('jobs.applications.changeStatus', { defaultValue: 'Change status' })}
        </Text>
        <View className="flex-row flex-wrap gap-2">
          {MENTION_JOB_APPLICATION_STATUSES.map((status) => (
            <Chip
              key={status}
              selected={application.status === status}
              onPress={() => statusMutation.mutate(status)}
            >
              {status}
            </Chip>
          ))}
        </View>
        {statusMutation.isPending ? <Loading className="text-primary mt-2" size="small" /> : null}
      </View>

      <View className="pt-3 border-t border-border">
        <Text className="text-sm text-muted-foreground mb-2 font-primary">
          {t('jobs.applications.internalNotes', { defaultValue: 'Internal notes (never shown to the applicant)' })}
        </Text>

        {notesQuery.isLoading ? (
          <Loading className="text-primary" size="small" />
        ) : (
          <View className="gap-2 mb-3">
            {(notesQuery.data?.notes ?? []).map((note) => (
              <View key={note.id} className="bg-muted rounded-xl p-3">
                <Text className="text-foreground text-[14px]">{note.note}</Text>
                <Text className="text-muted-foreground text-[11px] mt-1">{formatTimeAgo(note.createdAt)}</Text>
              </View>
            ))}
            {(notesQuery.data?.notes ?? []).length === 0 ? (
              <Text className="text-muted-foreground text-[13px]">
                {t('jobs.applications.noNotes', { defaultValue: 'No notes yet' })}
              </Text>
            ) : null}
          </View>
        )}

        <TextField>
          <TextFieldInput
            label={t('jobs.applications.addNote', { defaultValue: 'Add a note' })}
            value={noteDraft}
            onChangeText={setNoteDraft}
            multiline
          />
        </TextField>
        <Button
          variant="secondary"
          size="small"
          style={{ alignSelf: 'flex-end', marginTop: 8 }}
          loading={addNoteMutation.isPending}
          disabled={!noteDraft.trim()}
          onPress={submitNote}
        >
          {t('common.add', { defaultValue: 'Add' })}
        </Button>
      </View>
    </ScrollView>
  );
};

export default JobApplicationDetailSheet;
