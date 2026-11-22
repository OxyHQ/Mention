import { ListSkeleton } from '@/components/loading/ContentSkeleton';
import { memo, useCallback } from 'react';
import { FlatList, type ViewStyle } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@oxy.so/bloom/badge';
import { useAuth } from '@oxy.so/services/ui/client';
import type { AccountNode } from '@oxy.so/core';
import type { MentionJobPosting, MentionJobStatus } from '@mention/shared-types';
import { jobsService } from '@/services/jobsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { displayNameOrHandle } from '@/utils/displayName';
import type { JobAttachmentData } from '@/hooks/useJobAttachmentManager';
import { Embed, RawText, Row, VStack, toElement } from '@oxy.so/bloom-language';

/** The sheet's list stops growing at 340pt (`max-h-[340px]`): the jobs scroll inside it. */
const LIST_STYLE = { maxHeight: 340 } satisfies ViewStyle;

const STATUS_TONE: Record<
  MentionJobStatus,
  'default' | 'primary' | 'success' | 'warning' | 'error' | 'info'
> = {
  draft: 'default',
  published: 'success',
  paused: 'warning',
  closed: 'error',
  expired: 'error',
};

function toJobAttachmentData(job: MentionJobPosting, employerName: string): JobAttachmentData {
  return {
    mentionJobId: job.id,
    title: job.title,
    employerName,
    employerOxyUserId: job.employerOxyUserId,
    status: job.status,
    canonicalUrl: job.canonicalUrl,
    location: job.location,
    workplaceType: job.workplaceType,
    employmentType: job.employmentType,
  };
}

interface JobPickerSheetProps {
  /** The account this post is publishing as — only an org/project operator has jobs to attach (`components/Compose/ComposeScreen.tsx` gates this). */
  employer: AccountNode;
  onSelect: (job: JobAttachmentData) => void;
  onClose: () => void;
}

/**
 * Compose job-attachment picker: the composing account's OWN jobs
 * (`jobsService.getMine()`, filtered to `employer.accountId`), selecting one
 * attaches it. Mirrors `PodcastPickerSheet.tsx`'s sheet shape; no search box
 * — an account's own job list is small enough to show in full, unlike the
 * external Syra podcast catalog.
 */
const JobPickerSheet = memo(function JobPickerSheet({
  employer,
  onSelect,
  onClose,
}: JobPickerSheetProps) {
  const { t } = useTranslation();
  const { user, canUsePrivateApi } = useAuth();

  const { data, isLoading, isError } = useQuery({
    queryKey: viewerQueryKeys.jobsMine(user?.id),
    queryFn: () => jobsService.getMine(),
    // GET /jobs/mine is caller-scoped and private — same guard `mine.tsx`
    // uses, so this picker never fires during the SSO-restore window.
    enabled: canUsePrivateApi,
  });

  const employerName = displayNameOrHandle(
    employer.account.name?.displayName,
    `@${employer.account.username}`,
  );
  const jobs = (data?.jobs ?? []).filter((job) => job.employerOxyUserId === employer.accountId);

  const handleSelect = useCallback(
    (job: MentionJobPosting) => {
      onSelect(toJobAttachmentData(job, employerName));
      onClose();
    },
    [onSelect, onClose, employerName],
  );

  return toElement(
    VStack(
      RawText(t('compose.job.title', { defaultValue: 'Attach a job' }))
        .foreground('foreground')
        .font('18')
        .leading('28px')
        .weight('bold')
        .margin('bottom', 'md'),
      VStack(
        Embed(
          isLoading ? (
            <ListSkeleton />
          ) : isError ? (
            toElement(
              RawText(t('compose.job.loadError', { defaultValue: 'Could not load your jobs' }))
                .padding('vertical', '4xl')
                .foreground('muted')
                .font('md')
                .textAlign('center'),
            )
          ) : jobs.length === 0 ? (
            toElement(
              RawText(
                t('compose.job.empty', {
                  defaultValue:
                    '{{employer}} has no job listings yet. Create one from your Jobs dashboard first.',
                  employer: employerName,
                }),
              )
                .padding('vertical', '4xl')
                .padding('horizontal', 'lg')
                .foreground('muted')
                .font('md')
                .textAlign('center'),
            )
          ) : (
            <FlatList
              data={jobs}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) =>
                toElement(
                  Row(item.title)
                    .onPress(() => handleSelect(item))
                    .trailing(
                      Embed(
                        <Badge
                          content={item.status}
                          color={STATUS_TONE[item.status]}
                          variant="subtle"
                          size="sm"
                        />,
                      ),
                    ),
                )
              }
              style={LIST_STYLE}
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
            />
          ),
        ),
      ).frame({ minHeight: '120' }),
    )
      .padding('horizontal', 'lg')
      .padding('top', 'md')
      .padding('bottom', 'sm')
      .background('background'),
  );
});

export default JobPickerSheet;
