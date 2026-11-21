import { DetailSkeleton } from '@/components/loading/ContentSkeleton';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/common/EmptyState';
import { RiLockLine } from '@oxy.so/bloom/icons/RiLockLine';
import { useSupervisionState } from '@/hooks/useSupervisionState';

/** Unreviewed product surfaces are unavailable, not a request to weaken protection. */
export function SupervisedFeatureGate({
  children,
  allowSupervised = false,
}: {
  children: ReactNode;
  /** Only for a reviewed surface; this never replaces the live server decision. */
  allowSupervised?: boolean;
}) {
  const { t } = useTranslation();
  const state = useSupervisionState();
  if (state.failed)
    return (
      <EmptyState
        error={{
          title: t('safety.checkFailed'),
          message: t('safety.retryDescription'),
          onRetry: async () => {
            await state.refresh();
          },
        }}
      />
    );
  if (!state.ready) return <DetailSkeleton />;
  if (state.supervised && !allowSupervised)
    return (
      <EmptyState
        icon={RiLockLine}
        title={t('safety.unavailableTitle')}
        subtitle={t('safety.unavailableDescription')}
      />
    );
  return children;
}
