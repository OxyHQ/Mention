import React, { memo, useCallback } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Badge } from '@oxy.so/bloom/badge';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { useAuth } from '@oxy.so/services/ui/client';
import type { AccountNode } from '@oxy.so/core';
import type { MentionJobPosting, MentionJobStatus } from '@mention/shared-types';
import { jobsService } from '@/services/jobsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { displayNameOrHandle } from '@/utils/displayName';
import type { JobAttachmentData } from '@/hooks/useJobAttachmentManager';

const STATUS_TONE: Record<MentionJobStatus, 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info'> = {
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
    location: job.location?.raw,
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
const JobPickerSheet = memo(function JobPickerSheet({ employer, onSelect, onClose }: JobPickerSheetProps) {
  const { t } = useTranslation();
  const { user } = useAuth();

  const { data, isLoading, isError } = useQuery({
    queryKey: viewerQueryKeys.jobsMine(user?.id),
    queryFn: () => jobsService.getMine(),
  });

  const employerName = displayNameOrHandle(employer.account.name?.displayName, `@${employer.account.username}`);
  const jobs = (data?.jobs ?? []).filter((job) => job.employerOxyUserId === employer.accountId);

  const handleSelect = useCallback(
    (job: MentionJobPosting) => {
      onSelect(toJobAttachmentData(job, employerName));
      onClose();
    },
    [onSelect, onClose, employerName],
  );

  return (
    <View className="bg-background px-4 pt-3 pb-2">
      <Text className="text-foreground text-lg font-bold mb-3">
        {t('compose.job.title', { defaultValue: 'Attach a job' })}
      </Text>

      <View className="min-h-[120px]">
        {isLoading ? (
          <View className="items-center justify-center py-10">
            <Loading className="text-primary" size="small" style={{ flex: undefined }} />
          </View>
        ) : isError ? (
          <Text className="text-muted-foreground text-[15px] text-center py-10">
            {t('compose.job.loadError', { defaultValue: 'Could not load your jobs' })}
          </Text>
        ) : jobs.length === 0 ? (
          <Text className="text-muted-foreground text-[15px] text-center py-10 px-4">
            {t('compose.job.empty', {
              defaultValue: '{{employer}} has no job listings yet. Create one from your Jobs dashboard first.',
              employer: employerName,
            })}
          </Text>
        ) : (
          <FlatList
            data={jobs}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <Item
                onPress={() => handleSelect(item)}
                title={item.title}
                trailing={<Badge content={item.status} color={STATUS_TONE[item.status]} variant="subtle" size="small" />}
              />
            )}
            className="max-h-[340px]"
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
          />
        )}
      </View>
    </View>
  );
});

export default JobPickerSheet;
